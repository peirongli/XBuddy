import { fuyao, FuyaoError, isAuthError } from './fuyao.js';
import { mock } from './mock.js';
import { DEFAULT_BUDGET } from './config.js';
import * as store from './harness/store.js';

/**
 * 工具注册表：每个工具声明
 *  - name / description / params(JSON Schema 简化版)
 *  - permission: 'read'（自动执行）| 'approval'（需用户审批后执行）
 *  - api_calls: 预估上游调用数（用于预算/停止规则）
 *  - handler(args, ctx): ctx = { run, emit, mode }，返回 { data, meta, summary }
 * handler 抛 FuyaoError 且是鉴权错误时，自动降级到 DEMO 演示数据并标记。
 */

function withDemoFallback(realFn, demoFn) {
  return async (args, ctx) => {
    try {
      return await realFn(args);
    } catch (e) {
      const authFail = e?.nokey || isAuthError(e) || (e instanceof FuyaoError && [2001, 2003].includes(e.code));
      if (!authFail) throw e;
      if (!ctx.mode.demo) {
        ctx.mode.demo = true;
        ctx.emit('mode_switch', { mode: 'demo', reason: `扶摇鉴权失败(code=${e.code ?? 'NO_KEY'})，本次运行降级为演示数据` });
      }
      const r = demoFn(args);
      r.meta.fallback_reason = `real_api_failed:${e.code ?? 'NO_KEY'}`;
      return r;
    }
  };
}

function pctRanks(arr, v) {
  if (!arr.length) return null;
  return +(arr.filter(x => x <= v).length / arr.length * 100).toFixed(1);
}

export const TOOLS = {
  search_ticker: {
    name: 'search_ticker',
    description: '按名称/代码检索标的，消歧并返回标准 thscode。研究目标里的公司名必须先经过该工具解析。',
    params: { q: 'string (必需，公司名或代码关键词)' },
    permission: 'read', api_calls: 1,
    handler: withDemoFallback(
      async ({ q }) => fuyao.searchTickers(q),
      ({ q }) => mock.searchTickers(q),
    ),
  },
  price_snapshot: {
    name: 'price_snapshot',
    description: '获取 A 股最新行情快照：最新价、涨跌幅、开高低、成交量额。',
    params: { thscodes: 'string (必需，逗号分隔，如 600519.SH,000858.SZ)' },
    permission: 'read', api_calls: 1,
    handler: withDemoFallback(
      async ({ thscodes }) => fuyao.snapshot(thscodes),
      ({ thscodes }) => mock.snapshot(thscodes),
    ),
  },
  price_history: {
    name: 'price_history',
    description: '获取单只 A 股近一年日 K（前复权），用于趋势/波动/估值分位计算。',
    params: { thscode: 'string (必需，单只)' },
    permission: 'read', api_calls: 1,
    handler: withDemoFallback(
      async ({ thscode }) => {
        const end = Date.now();
        const start = end - 365 * 86400_000;
        return fuyao.historical(thscode, { start, end });
      },
      ({ thscode }) => mock.historical(thscode),
    ),
  },
  financials: {
    name: 'financials',
    description: '获取单只 A 股最近 4 期年度三大报表（利润表/资产负债表/现金流量表），一次调用完成。',
    params: { thscode: 'string (必需，单只)' },
    permission: 'read', api_calls: 3,
    handler: withDemoFallback(
      async ({ thscode }) => {
        const [income, balance, cashflow] = await Promise.all([
          fuyao.incomeStatements(thscode, {}), fuyao.balanceSheets(thscode, {}), fuyao.cashFlowStatements(thscode, {}),
        ]);
        return {
          data: { income: income.data?.item || [], balance: balance.data?.item || [], cashflow: cashflow.data?.item || [] },
          meta: { endpoint: 'financials(3 endpoints)', request_id: [income.meta?.request_id, balance.meta?.request_id, cashflow.meta?.request_id], latency_ms: [income.meta?.latency_ms, balance.meta?.latency_ms, cashflow.meta?.latency_ms], ts: Date.now() },
        };
      },
      ({ thscode }) => { const m = mock.financials(thscode); return { data: { income: m.income.data.item, balance: m.balance.data.item, cashflow: m.cashflow.data.item }, meta: { endpoint: 'financials(3 endpoints, demo)', request_id: m.income.meta.request_id, latency_ms: m.income.meta.latency_ms, ts: Date.now(), demo: true, fallback_reason: m.income.meta.fallback_reason } }; },
    ),
  },
  trading_calendar: {
    name: 'trading_calendar',
    description: '获取 A 股近一年交易日序列，用于对账数据时点。',
    params: {},
    permission: 'read', api_calls: 1,
    handler: withDemoFallback(async () => fuyao.tradingDays(), () => mock.tradingDays()),
  },
  index_constituents: {
    name: 'index_constituents',
    description: '获取指数（如同花顺行业指数 886xxx.TI、沪深300 000300.SH）当前成分股列表。',
    params: { thscode: 'string (必需，指数代码)' },
    permission: 'read', api_calls: 1,
    handler: withDemoFallback(
      async ({ thscode }) => fuyao.indexConstituents(thscode),
      ({ thscode }) => ({ data: { timestamp: Date.now(), item: Object.entries({ '600519.SH': '贵州茅台', '000858.SZ': '五粮液', '601318.SH': '中国平安' }).map(([thscode, name]) => ({ thscode, ticker: thscode.split('.')[0], name })) }, meta: { endpoint: '/api/a-share-index/constituents/ths-stock-list', request_id: `demo-${Date.now()}`, latency_ms: 20, ts: Date.now(), demo: true } }),
    ),
  },
  limit_up_pool: {
    name: 'limit_up_pool',
    description: '获取当日涨停股票池（盘面情绪复盘）。',
    params: {},
    permission: 'read', api_calls: 1,
    handler: withDemoFallback(async () => fuyao.limitUpPool(), () => mock.marketBoard().limitUp),
  },
  hot_stock_list: {
    name: 'hot_stock_list',
    description: '获取 A 股热股榜 Top30（市场关注度）。',
    params: {},
    permission: 'read', api_calls: 1,
    handler: withDemoFallback(async () => fuyao.hotStockList(), () => mock.marketBoard().hot),
  },
  dragon_tiger: {
    name: 'dragon_tiger',
    description: '获取最近交易日龙虎榜（席位与净买入）。',
    params: { board_type: 'string (可选: all/org/hot_money)' },
    permission: 'read', api_calls: 1,
    handler: withDemoFallback(
      async (args) => fuyao.dragonTiger(args),
      () => mock.marketBoard().dragon,
    ),
  },
  derive_metrics: {
    name: 'derive_metrics',
    description: '纯本地计算（无外部调用）：基于已取到的 K 线与财务数据，推导区间涨跌幅、年化波动率、均线状态、PE 隐含值与估值分位等派生指标。',
    params: { note: '无需参数，自动复用本 run 中 price_history 与 financials 步骤的证据' },
    permission: 'read', api_calls: 0,
    handler: async (_args, ctx) => {
      const evidence = ctx.run.evidence.filter(e => ['price_history', 'financials', 'price_snapshot'].includes(e.tool))
        .map(e => store.getEvidence(e.id)).filter(Boolean);
      const out = { computed_from: evidence.map(e => ({ tool: e.tool, evidence_id: e.id })), metrics: {}, gaps: [] };
      const kEv = evidence.find(e => e.tool === 'price_history');
      if (kEv?.data?.item?.length >= 30) {
        const bars = kEv.data.item;
        const closes = bars.map(b => b.close_price);
        const first = closes[0]; const last = closes[closes.length - 1];
        const rets = closes.slice(1).map((c, i) => c / closes[i] - 1);
        const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
        const vol = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1)) * Math.sqrt(244);
        const ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
        const ma60 = closes.slice(-60).reduce((a, b) => a + b, 0) / Math.min(60, closes.length);
        out.metrics.price = {
          window_days: bars.length, first_close: first, last_close: last,
          period_return_pct: +((last / first - 1) * 100).toFixed(2),
          annualized_volatility_pct: +(vol * 100).toFixed(2),
          ma20: +ma20.toFixed(2), ma60: +ma60.toFixed(2),
          ma20_above_ma60: ma20 > ma60,
          last_vs_ma60_pct: +((last / ma60 - 1) * 100).toFixed(2),
          high_52w: Math.max(...bars.map(b => b.high_price)), low_52w: Math.min(...bars.map(b => b.low_price)),
          source: { evidence_id: kEv.id, as_of: kEv.meta?.ts, adjust: 'forward(前复权)', unit: 'CNY' },
        };
      } else out.gaps.push('price_history 证据缺失或不足 30 根，价格类派生指标未计算');
      const finEv = evidence.find(e => e.tool === 'financials');
      const inc = finEv?.data?.income || [];
      if (inc.length >= 2) {
        const sorted = [...inc].sort((a, b) => a.fiscal_year - b.fiscal_year);
        const latest = sorted[sorted.length - 1]; const prev = sorted[sorted.length - 2];
        const snapEv = evidence.find(e => e.tool === 'price_snapshot');
        const m = { years: sorted.map(x => x.fiscal_year), unit: 'CNY', source: { evidence_id: finEv.id, as_of: finEv.meta?.ts, caliber: '合并报表·年度' } };
        m.revenue_latest = latest.operating_income;
        m.revenue_yoy_pct = prev.operating_income ? +((latest.operating_income / prev.operating_income - 1) * 100).toFixed(2) : null;
        m.net_profit_latest = latest.net_profit;
        m.net_profit_yoy_pct = prev.net_profit ? +((latest.net_profit / prev.net_profit - 1) * 100).toFixed(2) : null;
        m.net_margin_pct = latest.operating_income ? +((latest.net_profit / latest.operating_income) * 100).toFixed(2) : null;
        const bal = finEv.data.balance?.find(b => b.fiscal_year === latest.fiscal_year);
        if (bal) m.debt_to_equity_pct = bal.holder_equity_total ? +((bal.total_debt / bal.holder_equity_total) * 100).toFixed(2) : null;
        const cf = finEv.data.cashflow?.find(c => c.fiscal_year === latest.fiscal_year);
        if (cf) m.ocf_to_net_profit_pct = latest.net_profit ? +((cf.act_cash_flow_net / latest.net_profit) * 100).toFixed(2) : null;
        if (snapEv?.data?.item?.length && bal) {
          const px = snapEv.data.item[0].last_price;
          const eps = latest.basic_eps;
          if (eps > 0) m.implied_pe_ttm_approx = +(px / eps).toFixed(2);
          m.implied_pb_approx = bal.holder_equity_total ? +(px / (bal.holder_equity_total / 1.256e9)).toFixed(2) : null;
          m.valuation_note = 'PE/PB 为「最新收盘价 ÷ 最近年报 EPS/BPS」的近似值，与行情软件 TTM 口径存在差异，仅作量级参考';
        }
        out.metrics.fundamentals = m;
      } else out.gaps.push('financials 证据缺失或不足 2 期，财务派生指标未计算');
      const meta = { endpoint: 'local:derive_metrics', request_id: null, latency_ms: 1, ts: Date.now(), demo: ctx.mode.demo || undefined };
      return { data: out, meta };
    },
  },
};

export const TOOL_NAMES = Object.keys(TOOLS);

/** 计划中引用的未知工具名 → 执行期兜底 */
export function getTool(name) { return TOOLS[name] || null; }

export function estimatePlanCost(steps) {
  return steps.reduce((acc, s) => acc + (TOOLS[s.tool]?.api_calls ?? 1), 0);
}

export { DEFAULT_BUDGET };

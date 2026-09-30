import { llmChat, parseJsonLoose } from '../llm.js';
import { llmAvailable } from '../config.js';

/**
 * 上下文管理：
 *  - digestOf: 把工具原始输出压缩为紧凑摘要（确定性，规则先行）
 *  - compressContext: 多步骤上下文超预算时，LLM 摘要压缩（失败则截断保留最新）
 * 预算按“近似 token ≈ 字符数/2.2”估算，中文友好。
 */

const approxTokens = (s) => Math.ceil(String(s).length / 2.2);
const STEP_CTX_BUDGET = 6000; // tokens

const fmtYi = (v) => (typeof v === 'number' ? (v >= 1e8 ? `${(v / 1e8).toFixed(1)}亿` : v >= 1e4 ? `${(v / 1e4).toFixed(1)}万` : String(v)) : '-');

/** 确定性摘要：不同工具不同压缩策略（规则优先，不依赖 LLM，保证可降级） */
export function digestOf(tool, data) {
  try {
    if (tool === 'price_snapshot') {
      return (data.item || []).map(i => `${i.thscode} 最新 ${i.last_price} 涨跌 ${i.price_change} (${i.price_change_ratio_pct}%) 量 ${fmtYi(i.volume)} 额 ${fmtYi(i.turnover)}`).join('；');
    }
    if (tool === 'price_history') {
      const b = data.item || [];
      if (!b.length) return '（空）';
      const closes = b.map(x => x.close_price);
      return `K线 ${b.length} 根：首收 ${closes[0]} → 末收 ${closes[closes.length - 1]}，区间高 ${Math.max(...b.map(x => x.high_price))} 低 ${Math.min(...b.map(x => x.low_price))}（前复权，单位 CNY）`;
    }
    if (tool === 'financials') {
      // 三张报表字段各归其位：利润表行无资产负债/现金流字段，不能混印（否则输出 undefined 并误导下游摘要/报告）
      const fy = (r) => `${r.fiscal_year}FY`;
      const pickIncome = (rows) => (rows || []).slice(0, 4).map(r => `${fy(r)} 营收 ${fmtYi(r.operating_income)} 净利 ${fmtYi(r.net_profit)} EPS ${r.basic_eps ?? '-'}`);
      const pickBalance = (rows) => (rows || []).slice(0, 4).map(r => `${fy(r)} 总资产 ${fmtYi(r.assets_total)} 归母权益 ${fmtYi(r.holder_equity_total)} 总负债 ${fmtYi(r.total_debt)}`);
      const pickCash = (rows) => (rows || []).slice(0, 4).map(r => `${fy(r)} 经营现金流 ${fmtYi(r.act_cash_flow_net)}`);
      return [...pickIncome(data.income), ...pickBalance(data.balance), ...pickCash(data.cashflow)].join('；');
    }
    if (tool === 'search_ticker') {
      return (data.item || []).slice(0, 5).map(i => `${i.thscode} ${i.name}(${i.asset_type},${i.exchange})`).join('；') || '（无匹配结果）';
    }
    if (tool === 'trading_calendar') return `近 ${data.item?.length ?? 0} 个交易日，最新 ${data.item?.at(-1)?.date ?? '-'}`;
    if (tool === 'index_constituents') return `成分股 ${data.item?.length ?? 0} 只：${(data.item || []).slice(0, 8).map(i => i.name).join('、')} 等`;
    if (tool === 'dragon_tiger') return `龙虎榜 ${data.trade_date || ''} 共 ${data.stock_count ?? data.stock_items?.length ?? 0} 只：${(data.stock_items || []).slice(0, 6).map(s => `${s.name}(净买 ${fmtYi(s.net_value)}, ${s.limit_reason || ''})`).join('；')}`;
    if (Array.isArray(data.item)) {
      return `${(data.item[0]?.hot_rank !== undefined ? '热股榜' : '列表')} ${data.item.length} 条：${data.item.slice(0, 8).map(i => i.name || i.thscode).join('、')}`;
    }
    return JSON.stringify(data).slice(0, 400);
  } catch { return JSON.stringify(data).slice(0, 400); }
}

/** LLM 结构化事实提取（每步执行后）；失败回退到 digestOf */
export async function summarizeStep(tool, args, digest, rawSnippet) {
  if (!llmAvailable()) return { text: digest, facts: [], mode: 'digest' };
  try {
    const { content } = await llmChat([
      { role: 'system', content: '你是投研数据摘要器。把工具返回压缩为 ≤150 字的事实要点。只陈述数据字段体现的事实（含数值/单位/时点），不做推断、不给建议、不预测。输出 JSON：{"text":"一句话概述","facts":[{"k":"字段","v":"值+单位","t":"时点/期次"}]}' },
      { role: 'user', content: `工具: ${tool}\n参数: ${JSON.stringify(args)}\n摘要: ${digest}\n原始样例: ${String(rawSnippet).slice(0, 1200)}` },
    ], { jsonMode: true, maxTokens: 500, temperature: 0.1 });
    const j = parseJsonLoose(content);
    if (j?.text) return { text: j.text, facts: Array.isArray(j.facts) ? j.facts.slice(0, 8) : [], mode: 'llm' };
    throw new Error('bad json');
  } catch {
    return { text: digest, facts: [], mode: 'digest' };
  }
}

/** 组装“执行某步骤”时的上下文；超出预算则压缩最旧步骤摘要 */
export async function buildStepContext(run, stepTitle) {
  const done = Object.entries(run.steps).filter(([, s]) => s.status === 'completed');
  let parts = done.map(([sid, s]) => `[${sid} ${s.title}] ${s.summary?.text || ''}${s.degraded ? '（该步骤数据缺失/降级）' : ''}`);
  const header = `研究目标：${run.goal}\n当前执行：${stepTitle}\n`;
  let ctx = header + parts.join('\n');
  if (approxTokens(ctx) > STEP_CTX_BUDGET && parts.length > 3 && llmAvailable()) {
    try {
      const old = parts.slice(0, -3).join('\n');
      const { content } = await llmChat([
        { role: 'system', content: '压缩多步骤研究中间结果：保留所有关键数值/时点/单位，删除重复，输出 ≤300 字。' },
        { role: 'user', content: old },
      ], { maxTokens: 600, temperature: 0.1 });
      parts = [`[历史步骤压缩摘要] ${content.trim()}`, ...parts.slice(-3)];
      ctx = header + parts.join('\n');
      return { context: ctx, compressed: true };
    } catch { /* fallthrough */ }
  }
  // 兜底：仅保留最近 6 步
  if (parts.length > 6) parts = ['[更早步骤已截断]', ...parts.slice(-6)];
  return { context: header + parts.join('\n'), compressed: false };
}

/** 合规约束注入（综合阶段） */
export const COMPLIANCE_PROMPT = `硬性合规约束（违反即重写）：
1. 不得输出确定性涨跌预测、收益承诺或直接买卖建议（禁止“建议买入/卖出/会涨/会跌/目标价”等表述）。
2. 必须区分【事实】（工具返回的字段）与【推断】（你的分析），推断需给出依据。
3. 每个数值结论标注来源证据编号（如 [ev_xx]），并保留时点与单位。
4. 数据缺失/降级的步骤必须如实列出，不得虚构补齐。`;

/**
 * DEMO 演示数据模式：扶摇 key 缺失或鉴权失败时自动启用。
 * 生成确定性的构造数据（随机种子按标的派生），所有返回都带 meta.demo=true，
 * 事件流与报告中会显式标注“演示数据”，绝不冒充真实行情（合规要求）。
 */

function seedRand(seedStr) {
  let h = 2166136261;
  for (const ch of seedStr) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return () => { h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return ((h ^= h >>> 16) >>> 0) / 4294967296; };
}
const now = () => Date.now();
const DAYS = 250;

function tradingDayList() {
  const out = []; const d = new Date();
  while (out.length < DAYS) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) out.push(new Date(d));
    d.setDate(d.getDate() - 1);
  }
  return out.reverse();
}
const tradingDays = tradingDayList();

const UNIVERSE = {
  '600519.SH': { name: '贵州茅台', base: 1500, pe: 22, listDate: '2001-08-27' },
  '000858.SZ': { name: '五粮液', base: 130, pe: 16, listDate: '1998-04-27' },
  '300750.SZ': { name: '宁德时代', base: 260, pe: 25, listDate: '2018-06-11' },
  '002594.SZ': { name: '比亚迪', base: 90, pe: 20, listDate: '2011-09-28' },
  '601318.SH': { name: '中国平安', base: 55, pe: 9, listDate: '2007-03-01' },
  '000001.SZ': { name: '平安银行', base: 11, pe: 5, listDate: '1991-04-03' },
  '600036.SH': { name: '招商银行', base: 38, pe: 7, listDate: '2002-04-09' },
  '688981.SH': { name: '中芯国际', base: 50, pe: 60, listDate: '2020-07-16' },
};

function nameLookup(q) {
  const hits = Object.entries(UNIVERSE).filter(([code, v]) => code.includes(q) || v.name.includes(q));
  if (hits.length) return hits;
  // 未收录标的：按查询确定性构造演示标的（名称=查询本身），不随机冒充某只真实股票
  const rnd = seedRand(q);
  const num = 100000 + Math.floor(rnd() * 899999);
  const suffix = rnd() > 0.5 ? 'SZ' : 'SH';
  return [[`${num}.${suffix}`, { name: q, base: Math.round(15 + rnd() * 135), pe: 15, listDate: '2000-01-01' }]];
}

export const mock = {
  searchTickers(q) {
    return {
      data: { timestamp: now(), item: nameLookup(q).map(([thscode, v]) => ({ thscode, ticker: thscode.split('.')[0], name: v.name, exchange: thscode.split('.')[1], asset_type: 'a-share', currency: 'CNY', list_date: v.listDate })) },
      meta: { endpoint: '/api/meta/tickers/search', request_id: `demo-${Date.now()}`, latency_ms: 20, ts: now(), demo: true },
    };
  },

  snapshot(thscodes) {
    const codes = (thscodes || '600519.SH').split(',');
    return {
      data: { timestamp: now(), total: codes.length, item: codes.map(code => {
        const r = seedRand('snap' + code + new Date().toDateString());
        // 与 historical 共享同一价格序列末端，保证演示数据自洽
        const kline = this.historical(code).data.item;
        const prev = kline[kline.length - 1].close_price;
        const last = +(prev * (1 + (r() - 0.48) * 0.04)).toFixed(2);
        return { thscode: code, ticker: code.split('.')[0], last_price: last, prev_price: prev, price_change: +(last - prev).toFixed(2), price_change_ratio_pct: +(((last - prev) / prev) * 100).toFixed(3), open_price: +(prev * (1 + (r() - 0.5) * 0.01)).toFixed(2), high_price: +(last * 1.012).toFixed(2), low_price: +(prev * 0.99).toFixed(2), volume: Math.floor(1e6 + r() * 9e6), turnover: Math.floor((1e6 + r() * 9e6) * last) };
      }) },
      meta: { endpoint: '/api/a-share/prices/snapshot', request_id: `demo-${Date.now()}`, latency_ms: 25, ts: now(), demo: true },
    };
  },

  historical(thscode) {
    const u = UNIVERSE[thscode] || { base: 50 };
    const r = seedRand('k' + thscode);
    let px = u.base * 0.8; const item = [];
    for (let i = 0; i < DAYS; i++) {
      px = Math.max(1, px * (1 + (r() - 0.485) * 0.035));
      const d = tradingDays[i];
      const open = +(px * (1 + (r() - 0.5) * 0.012)).toFixed(2);
      const close = +px.toFixed(2);
      item.push({ date_ms: d.getTime(), open_price: open, close_price: close, high_price: +(Math.max(open, close) * (1 + r() * 0.015)).toFixed(2), low_price: +(Math.min(open, close) * (1 - r() * 0.015)).toFixed(2), volume: Math.floor(8e5 + r() * 8e6), turnover: Math.floor((8e5 + r() * 8e6) * close) });
    }
    return { data: { timestamp: now(), item }, meta: { endpoint: '/api/a-share/prices/historical', request_id: `demo-${Date.now()}`, latency_ms: 30, ts: now(), demo: true } };
  },

  financials(thscode) {
    const u = UNIVERSE[thscode] || { base: 50, pe: 15 };
    const r = seedRand('fin' + thscode);
    const rev0 = u.base * 4e7;
    const item = [3, 2, 1, 0].map(k => {
      const year = 2025 - k;
      const growth = 1 + (r() * 0.25 - 0.05);
      const opInc = rev0 * Math.pow(growth, 3 - k);
      const netProfit = opInc * (0.25 + r() * 0.15);
      const reportMs = Date.UTC(year, 2, 30);
      return {
        income: { thscode, ticker: thscode.split('.')[0], period: 'annual', fiscal_year: year, fiscal_period: 'FY', report_date_ms: reportMs, period_end_ms: reportMs, currency: 'CNY', operating_income: Math.round(opInc), operating_costs: Math.round(opInc * (0.3 + r() * 0.1)), operating_profit: Math.round(opInc * 0.4), net_profit: Math.round(netProfit), parent_holder_net_profit: Math.round(netProfit * 0.97), basic_eps: +(netProfit / 1.256e9).toFixed(2) },
        balance: { thscode, ticker: thscode.split('.')[0], period: 'annual', fiscal_year: year, fiscal_period: 'FY', report_date_ms: reportMs, period_end_ms: reportMs, currency: 'CNY', assets_total: Math.round(opInc * 1.2), total_current_assets: Math.round(opInc * 0.7), cash: Math.round(opInc * 0.35), accounts_receivable: Math.round(opInc * 0.05), total_debt: Math.round(opInc * 0.2), holder_equity_total: Math.round(opInc * 0.85) },
        cashflow: { thscode, ticker: thscode.split('.')[0], period: 'annual', fiscal_year: year, fiscal_period: 'FY', report_date_ms: reportMs, period_end_ms: reportMs, currency: 'CNY', act_cash_flow_net: Math.round(netProfit * (1.0 + r() * 0.3)), invest_cash_flow_net: -Math.round(opInc * 0.08), financing_cash_flow_net: -Math.round(netProfit * 0.6), pay_dividends_profits_interest_cash: Math.round(netProfit * 0.55) },
      };
    });
    return {
      income: { data: { timestamp: now(), item: item.map(x => x.income) }, meta: { endpoint: '/api/a-share/financials/income-statements', request_id: `demo-${Date.now()}`, latency_ms: 28, ts: now(), demo: true } },
      balance: { data: { timestamp: now(), item: item.map(x => x.balance) }, meta: { endpoint: '/api/a-share/financials/balance-sheets', request_id: `demo-${Date.now()}`, latency_ms: 26, ts: now(), demo: true } },
      cashflow: { data: { timestamp: now(), item: item.map(x => x.cashflow) }, meta: { endpoint: '/api/a-share/financials/cash-flow-statements', request_id: `demo-${Date.now()}`, latency_ms: 27, ts: now(), demo: true } },
    };
  },

  tradingDays() {
    return { data: { timestamp: now(), item: tradingDays.slice(-60).map(d => ({ date_ms: d.getTime(), date: d.toISOString().slice(0, 10).replaceAll('-', '') })) }, meta: { endpoint: '/api/a-share/calendar/trading-days', request_id: `demo-${Date.now()}`, latency_ms: 18, ts: now(), demo: true } };
  },

  marketBoard() {
    const r = seedRand('board' + new Date().toDateString());
    const names = Object.entries(UNIVERSE);
    const mk = n => Array.from({ length: n }, (_, i) => { const [thscode, v] = names[Math.floor(r() * names.length)]; return { thscode, ticker: thscode.split('.')[0], name: v.name }; });
    return {
      limitUp: { data: { timestamp: now(), item: mk(8) }, meta: { endpoint: '/api/a-share/special-data/limit-up-pool', request_id: `demo-${Date.now()}`, latency_ms: 22, ts: now(), demo: true } },
      hot: { data: { timestamp: now(), item: mk(10).map((x, i) => ({ ...x, hot_rank: i + 1 })) }, meta: { endpoint: '/api/a-share/special-data/hot-stock-list', request_id: `demo-${Date.now()}`, latency_ms: 24, ts: now(), demo: true } },
      dragon: { data: { timestamp: now(), board_type: 'all', trade_date: new Date().toISOString().slice(0, 10), stock_items: mk(6).map(x => ({ ...x, net_value: Math.round(r() * 2e9), net_rate: +(r() * 0.2).toFixed(4), limit_reason: '演示概念：构造数据' })) }, meta: { endpoint: '/api/a-share/special-data/dragon-tiger-list', request_id: `demo-${Date.now()}`, latency_ms: 26, ts: now(), demo: true } },
    };
  },
};

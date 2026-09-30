import { config } from './config.js';

/**
 * 扶摇金融数据 REST 客户端。
 * - 统一 ApiResponse 信封解包（code=0 为成功，其余为业务错误）
 * - 超时 / 指数退避重试（429/4001 限流与网络错误）
 * - 返回 { data, meta }，meta 携带 request_id/endpoint/latency/ts，用于证据链
 */
export const FuyaoError = class extends Error {
  constructor(code, message, meta) { super(message || `FUYAO_${code}`); this.code = code; this.meta = meta; }
};

async function rawCall(endpoint, params, { apiKey, timeoutMs = 15_000, retries = 2 } = {}) {
  const url = new URL(endpoint, config.fuyaoBase);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const key = apiKey || config.fuyaoApiKey;
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      const res = await fetch(url, { signal: controller.signal, headers: { 'X-api-key': key } });
      const body = await res.json().catch(() => null);
      const meta = { endpoint: url.pathname, request_id: body?.request_id || null, http_status: res.status, latency_ms: Date.now() - t0, ts: Date.now(), url: url.toString() };
      if (body && typeof body.code === 'number') {
        if (body.code === 0) return { data: body.data, meta };
        // 限流：退避重试
        if ((body.code === 4001 || res.status === 429) && attempt < retries) {
          lastErr = new FuyaoError(body.code, 'RATE_LIMITED', meta);
          await new Promise(r => setTimeout(r, 800 * 2 ** attempt));
          continue;
        }
        throw new FuyaoError(body.code, body.message || 'BUSINESS_ERROR', meta);
      }
      if (!res.ok) {
        if ((res.status === 429 || res.status >= 500) && attempt < retries) {
          lastErr = new FuyaoError(res.status, 'HTTP_ERROR', meta);
          await new Promise(r => setTimeout(r, 800 * 2 ** attempt));
          continue;
        }
        throw new FuyaoError(res.status, `HTTP_${res.status}`, meta);
      }
      throw new FuyaoError(-1, 'UNEXPECTED_ENVELOPE', meta);
    } catch (e) {
      if (e instanceof FuyaoError && e.code !== 4001) throw e;
      lastErr = e;
      if (attempt < retries) { await new Promise(r => setTimeout(r, 800 * 2 ** attempt)); continue; }
      throw new FuyaoError(e?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK', String(e?.message || e), { endpoint: url.pathname, latency_ms: Date.now() - t0, ts: Date.now() });
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new FuyaoError(-1, 'UNKNOWN');
}

/** 判断 key 有效性：缺失或 2001/2003 视为不可用，调用方切换 DEMO 模式 */
export function isAuthError(err) { return err instanceof FuyaoError && [2001, 2003].includes(err.code); }

export async function fuyaoGet(endpoint, params, opts = {}) {
  if (!config.fuyaoApiKey) { const e = new FuyaoError(2003, 'MISSING_API_KEY'); e.nokey = true; throw e; }
  return rawCall(endpoint, params, opts);
}

/* ------- 业务封装：每个函数返回 { data, meta } ------- */

export const fuyao = {
  searchTickers: (q, opts) => fuyaoGet('/api/meta/tickers/search', { q, limit: 10 }, opts),
  snapshot: (thscodes, opts) => fuyaoGet('/api/a-share/prices/snapshot', { thscodes }, opts),
  historical: (thscode, { start, end, adjust = 'forward', interval = '1d' }, opts) =>
    fuyaoGet('/api/a-share/prices/historical', { thscode, interval, start, end, adjust }, opts),
  incomeStatements: (thscode, { period = 'annual', limit = 4 }, opts) =>
    fuyaoGet('/api/a-share/financials/income-statements', { thscode, period, limit }, opts),
  balanceSheets: (thscode, { period = 'annual', limit = 4 }, opts) =>
    fuyaoGet('/api/a-share/financials/balance-sheets', { thscode, period, limit }, opts),
  cashFlowStatements: (thscode, { period = 'annual', limit = 4 }, opts) =>
    fuyaoGet('/api/a-share/financials/cash-flow-statements', { thscode, period, limit }, opts),
  tradingDays: (opts) => fuyaoGet('/api/a-share/calendar/trading-days', {}, opts),
  indexConstituents: (thscode, opts) => fuyaoGet('/api/a-share-index/constituents/ths-stock-list', { thscode }, opts),
  limitUpPool: (opts) => fuyaoGet('/api/a-share/special-data/limit-up-pool', {}, opts),
  limitDownPool: (opts) => fuyaoGet('/api/a-share/special-data/limit-down-pool', {}, opts),
  hotStockList: (opts) => fuyaoGet('/api/a-share/special-data/hot-stock-list', {}, opts),
  skyrocketList: (opts) => fuyaoGet('/api/a-share/special-data/skyrocket-list', {}, opts),
  dragonTiger: ({ board_type = 'all', date } = {}, opts) =>
    fuyaoGet('/api/a-share/special-data/dragon-tiger-list', { board_type, date }, opts),
};

import { config, LLM_PRICE, llmAvailable } from './config.js';

/**
 * DeepSeek 客户端：JSON 模式优先，失败时由调用方走确定性 fallback。
 * 记录 token 用量与成本，供可观测性面板展示。
 */
export const llmStats = { calls: 0, prompt_tokens: 0, completion_tokens: 0, cost_cny: 0, failures: 0 };

export class LlmError extends Error {}

export async function llmChat(messages, { jsonMode = false, maxTokens = 2048, temperature = 0.3, timeoutMs = 60_000, onUsage = null } = {}) {
  if (!llmAvailable()) throw new LlmError('LLM_NOT_CONFIGURED');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${config.deepseekBase}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.deepseekKey}` },
      body: JSON.stringify({
        model: config.deepseekModel,
        messages,
        max_tokens: maxTokens,
        temperature,
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
    if (!res.ok) throw new LlmError(`HTTP_${res.status}`);
    const body = await res.json();
    const msg = body?.choices?.[0]?.message;
    if (!msg) throw new LlmError('EMPTY_RESPONSE');
    const u = body.usage || {};
    llmStats.calls += 1;
    llmStats.prompt_tokens += u.prompt_tokens || 0;
    llmStats.completion_tokens += u.completion_tokens || 0;
    llmStats.cost_cny += ((u.prompt_tokens || 0) / 1e6) * LLM_PRICE.input + ((u.completion_tokens || 0) / 1e6) * LLM_PRICE.output;
    if (onUsage) onUsage(u);
    return { content: msg.content || '', usage: u };
  } catch (e) {
    llmStats.failures += 1;
    throw e instanceof LlmError ? e : new LlmError(String(e?.message || e));
  } finally {
    clearTimeout(timer);
  }
}

/** 解析 LLM 返回的 JSON；容错截取首个 {...} 块 */
export function parseJsonLoose(text) {
  try { return JSON.parse(text); } catch { /* try extract */ }
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* give up */ } }
  return null;
}

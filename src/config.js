import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data');
for (const sub of ['', 'runs', 'threads', 'memory', 'artifacts', 'evidence']) {
  fs.mkdirSync(path.join(DATA_DIR, sub), { recursive: true });
}

function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
loadEnv();

export const config = {
  port: Number(process.env.PORT || 3721),
  fuyaoApiKey: process.env.FUYAO_API_KEY || '',
  fuyaoBase: 'https://fuyao.aicubes.cn',
  deepseekKey: process.env.DEEPSEEK_API_KEY || '',
  deepseekBase: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  deepseekModel: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
};

/** 运行级预算/停止规则默认值（可被前端请求覆盖，审批可延长） */
export const DEFAULT_BUDGET = {
  max_tool_calls: 16,        // 单次 run 最多工具调用数
  max_llm_tokens: 120_000,   // 单次 run 累计 LLM token 预算
  max_duration_ms: 8 * 60_000, // 单次 run 最长墙钟时间
  tool_timeout_ms: 15_000,   // 单次工具调用超时
  llm_timeout_ms: 60_000,
  plan_approval_threshold: 9, // 计划工具调用数超过该值 → 需用户审批计划
};

/** LLM 成本估算（元/百万 token，用于成本观测；以 DeepSeek 定价量级估算） */
export const LLM_PRICE = { input: 2.0, output: 8.0 }; // CNY per 1M tokens

export function llmAvailable() { return Boolean(config.deepseekKey); }
export function fuyaoAvailable() { return Boolean(config.fuyaoApiKey); }

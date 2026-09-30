import { llmChat, parseJsonLoose, LlmError } from '../llm.js';
import { TOOL_NAMES, TOOLS, estimatePlanCost } from '../tools.js';
import { loadMemory } from './store.js';

/**
 * Planner：LLM 优先（JSON 模式输出计划），失败/不可用时走确定性模板规划器。
 * 计划 = { research_type, entities:[], steps:[{id,title,tool,args,depends_on,why}] }
 */

const TOOL_CATALOG = TOOL_NAMES.map(n => `- ${n}: ${TOOLS[n].description} 参数: ${JSON.stringify(TOOLS[n].params)} (上游调用数 ${TOOLS[n].api_calls})`).join('\n');

const PLANNER_SYSTEM = `你是投资研究助理的规划器。把用户的研究目标编译成可执行计划（不回答问题本身）。
可用工具：
${TOOL_CATALOG}

规则：
1. 公司/股票必须先用 search_ticker 消歧得到 thscode，后续步骤的 args 可用 {{step_id.item[0].thscode}} 形式引用前置步骤输出。
2. 步骤数控制在 4~10 步；derive_metrics 放在取数步骤之后用于派生计算（无外部调用）。
3. 只输出 JSON：{"research_type":"single_stock|comparison|market_sentiment|other","entities":[],"steps":[{"id":"s1","title":"...","tool":"工具名","args":{},"depends_on":[],"why":"一句话"}]}
4. 遵守投资合规：计划目标仅限研究分析，不得包含预测涨跌或买卖建议类步骤。`;

export async function plan(goal, { onEvent } = {}) {
  // ---- LLM 规划 ----
  try {
    const mem = loadMemory().entries.slice(0, 12).map(e => `[${e.kind}] ${e.text}`).join('\n');
    const { content } = await llmChat([
      { role: 'system', content: PLANNER_SYSTEM },
      { role: 'user', content: `研究目标：${goal}\n${mem ? `已知长期记忆：\n${mem}` : ''}` },
    ], { jsonMode: true, maxTokens: 1600, temperature: 0.2 });
    const plan = parseJsonLoose(content);
    if (plan?.steps?.length && plan.steps.every(s => TOOL_NAMES.includes(s.tool))) {
      plan.planner = 'llm';
      plan.steps = normalizeSteps(plan.steps);
      return plan;
    }
    throw new LlmError('INVALID_PLAN');
  } catch (e) {
    onEvent?.('planner_fallback', { reason: String(e?.message || e) });
    // ---- 确定性模板规划 ----
    const plan = templatePlan(goal);
    plan.planner = 'template';
    return plan;
  }
}

function normalizeSteps(steps) {
  return steps.map((s, i) => ({
    id: String(s.id || `s${i + 1}`),
    title: String(s.title || s.tool),
    tool: s.tool,
    args: s.args && typeof s.args === 'object' ? s.args : {},
    depends_on: Array.isArray(s.depends_on) ? s.depends_on.map(String) : [],
    why: String(s.why || ''),
  }));
}

/** 确定性模板规划：按目标类型路由 */
export function templatePlan(goal) {
  const g = goal || '';
  const sentimentRe = /涨停|热榜|情绪|龙虎榜|复盘|板块|大盘|市场热度/;
  const cmpRe = /对比|比较|vs|VS|和.{2,12}(哪个|相比)|与.{2,12}(哪个|相比)/;
  const type = sentimentRe.test(g) ? 'market_sentiment' : cmpRe.test(g) ? 'comparison' : 'single_stock';

  if (type === 'market_sentiment') {
    return {
      research_type: type, entities: [],
      steps: [
        { id: 's1', title: '获取涨停股票池', tool: 'limit_up_pool', args: {}, depends_on: [], why: '盘面情绪核心信号' },
        { id: 's2', title: '获取热股榜', tool: 'hot_stock_list', args: {}, depends_on: [], why: '市场关注度分布' },
        { id: 's3', title: '获取龙虎榜', tool: 'dragon_tiger', args: { board_type: 'all' }, depends_on: [], why: '席位资金动向' },
        { id: 's4', title: '行情快照交叉验证', tool: 'price_snapshot', args: {}, depends_on: ['s1'], why: '对涨停池标的做价格校验' },
      ],
    };
  }
  if (type === 'comparison') {
    return {
      research_type: type, entities: [],
      steps: [
        { id: 's1', title: '检索标的 A', tool: 'search_ticker', args: { q: firstEntity(g) }, depends_on: [], why: '消歧标的 A' },
        { id: 's2', title: '检索标的 B', tool: 'search_ticker', args: { q: secondEntity(g) }, depends_on: [], why: '消歧标的 B' },
        { id: 's3', title: '标的 A 行情与估值基础', tool: 'price_snapshot', args: { thscodes: '{{s1.item[0].thscode}}' }, depends_on: ['s1'], why: '最新价与涨跌幅' },
        { id: 's4', title: '标的 B 行情与估值基础', tool: 'price_snapshot', args: { thscodes: '{{s2.item[0].thscode}}' }, depends_on: ['s2'], why: '最新价与涨跌幅' },
        { id: 's5', title: '标的 A 财务三表', tool: 'financials', args: { thscode: '{{s1.item[0].thscode}}' }, depends_on: ['s1'], why: '盈利与资产负债' },
        { id: 's6', title: '标的 B 财务三表', tool: 'financials', args: { thscode: '{{s2.item[0].thscode}}' }, depends_on: ['s2'], why: '盈利与资产负债' },
        { id: 's7', title: '派生指标对比计算', tool: 'derive_metrics', args: {}, depends_on: ['s3', 's4', 's5', 's6'], why: '增长率/利润率/隐含估值对比' },
      ],
    };
  }
  const ent = firstEntity(g) || extractCode(g) || '贵州茅台';
  return {
    research_type: 'single_stock', entities: [ent],
    steps: ent.match(/^[0-9]{6}\.(SH|SZ|BJ)$/i)
      ? [
          { id: 's1', title: '行情快照', tool: 'price_snapshot', args: { thscodes: ent.toUpperCase() }, depends_on: [], why: '最新价与涨跌幅' },
          { id: 's2', title: '近一年日 K', tool: 'price_history', args: { thscode: ent.toUpperCase() }, depends_on: [], why: '趋势与波动' },
          { id: 's3', title: '财务三表', tool: 'financials', args: { thscode: ent.toUpperCase() }, depends_on: [], why: '基本面' },
          { id: 's4', title: '派生指标计算', tool: 'derive_metrics', args: {}, depends_on: ['s1', 's2', 's3'], why: '估值分位/波动率/盈利质量' },
        ]
      : [
          { id: 's1', title: `检索「${ent}」`, tool: 'search_ticker', args: { q: ent }, depends_on: [], why: '消歧得 thscode' },
          { id: 's2', title: '行情快照', tool: 'price_snapshot', args: { thscodes: '{{s1.item[0].thscode}}' }, depends_on: ['s1'], why: '最新价与涨跌幅' },
          { id: 's3', title: '近一年日 K', tool: 'price_history', args: { thscode: '{{s1.item[0].thscode}}' }, depends_on: ['s1'], why: '趋势与波动' },
          { id: 's4', title: '财务三表', tool: 'financials', args: { thscode: '{{s1.item[0].thscode}}' }, depends_on: ['s1'], why: '基本面' },
          { id: 's5', title: '派生指标计算', tool: 'derive_metrics', args: {}, depends_on: ['s2', 's3', 's4'], why: '估值/波动/盈利质量' },
        ],
  };
}

function extractCode(g) { const m = g.match(/\d{6}(\.(SH|SZ|BJ))?/i); return m ? m[0] : null; }
function firstEntity(g) {
  if (extractCode(g)) return extractCode(g);
  let m = g.match(/(?:分析|研究|看看|调研|了解)[一下]*\s*《?([\u4e00-\u9fa5A-Za-z0-9]{2,10})》?/);
  if (!m) m = g.match(/^([\u4e00-\u9fa5A-Za-z0-9]{2,10})\s*(?:的|最近|近|最新|基本|估值|财务)/);
  if (m) {
    let e = m[1].replace(/^(对比|比较)/, '');
    // 剥离贪婪捕获吞进来的研究语境词（如「贵州茅台近一年基本面」→「贵州茅台」）
    e = e.replace(/(近[一二三]?年|最近|最新|基本面|估值|财务|水位|表现|情况|动向|年报|盈利|现金流|对比).*$/, '');
    // 对比语境下双标的可能粘在一起（如「宁德时代和比亚迪」）→ 取连接词前半
    const c = e.match(/^([\u4e00-\u9fa5A-Za-z0-9]{2,8})\s*(?:与|和|跟)/);
    if (c) e = c[1];
    return e || null;
  }
  return g.match(/对比\s*([\u4e00-\u9fa5A-Za-z0-9]{2,10})/)?.[1] || null;
}
function secondEntity(g) {
  const m = g.match(/(?:与|和|跟)[\u4e00-\u9fa5A-Za-z0-9]{2,10}?(对比|比较|相比|哪个)/);
  if (m) {
    const inner = g.match(/(?:与|和|跟)\s*([\u4e00-\u9fa5A-Za-z0-9]{2,10})/);
    if (inner) return inner[1];
  }
  const m3 = g.match(/([\u4e00-\u9fa5A-Za-z0-9]{2,10})\s*(?:与|和|vs|VS)\s*([\u4e00-\u9fa5A-Za-z0-9]{2,10})/);
  return m3 ? m3[2] : null;
}

export { estimatePlanCost };

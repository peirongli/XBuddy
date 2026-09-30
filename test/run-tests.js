/**
 * XBuddy 单元/契约测试（不依赖外部网络与 API key）
 * 运行：npm test
 */
import assert from 'node:assert';
import { scanViolations, redact } from '../src/harness/guard.js';
import { digestOf } from '../src/harness/context.js';
import { templatePlan } from '../src/harness/planner.js';
import { resolveArg } from '../src/harness/executor.js';
import { estimatePlanCost, TOOLS } from '../src/tools.js';
import { mock } from '../src/mock.js';

let passed = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}\n     ${e.message}`); }
};

console.log('== 合规守卫 ==');
test('识别买卖建议类违规', () => {
  const v = scanViolations('综合分析后建议买入该股');
  assert.ok(v.some(x => x.why === '直接买卖建议'));
});
test('识别确定性涨跌预测', () => {
  assert.ok(scanViolations('该股必涨无疑').length > 0);
  assert.ok(scanViolations('预计会涨到新高').length > 0);
});
test('识别收益承诺', () => {
  assert.ok(scanViolations('此策略稳赚不赔').length > 0);
});
test('正常分析文本不误伤', () => {
  assert.strictEqual(scanViolations('净利润同比增长 15%，毛利率保持稳定').length, 0);
});
test('机械改写后无残留违规', () => {
  const bad = '建议买入，该股必涨，稳赚；目标价：3000元';
  const fixed = redact(bad);
  assert.strictEqual(scanViolations(fixed).length, 0, `残留: ${fixed}`);
});

console.log('== 规划器（确定性模板） ==');
test('单标的研究目标 → single_stock 计划', () => {
  const p = templatePlan('分析贵州茅台近一年基本面与估值水位');
  assert.strictEqual(p.research_type, 'single_stock');
  assert.ok(p.steps.length >= 4);
  assert.ok(p.steps[0].tool === 'search_ticker');
});
test('直接给代码的研究目标跳过检索', () => {
  const p = templatePlan('调研 600519.SH 的盈利质量');
  assert.ok(p.steps.every(s => s.tool !== 'search_ticker'));
});
test('对比类目标 → comparison 计划（含双标的）', () => {
  const p = templatePlan('对比宁德时代和比亚迪的最新财务表现');
  assert.strictEqual(p.research_type, 'comparison');
  const tools = p.steps.map(s => s.tool);
  assert.ok(tools.filter(t => t === 'financials').length >= 2);
});
test('盘面情绪类目标 → market_sentiment 计划', () => {
  const p = templatePlan('复盘今日 A 股涨停与热股榜情绪');
  assert.strictEqual(p.research_type, 'market_sentiment');
});
test('计划成本估算与工具注册表一致', () => {
  const p = templatePlan('分析贵州茅台近一年基本面与估值水位');
  assert.ok(estimatePlanCost(p.steps) > 0);
});

console.log('== 工具注册表 ==');
test('所有工具具备 schema/权限/成本声明', () => {
  for (const t of Object.values(TOOLS)) {
    assert.ok(t.name && t.description && ['read', 'approval'].includes(t.permission) && typeof t.api_calls === 'number');
    assert.ok(typeof t.handler === 'function');
  }
});

console.log('== 上下文压缩（确定性摘要） ==');
test('行情快照摘要包含关键数值', () => {
  const d = mock.snapshot('600519.SH').data;
  const s = digestOf('price_snapshot', d);
  assert.ok(s.includes('600519.SH') && s.includes('最新'));
});
test('K线摘要包含区间统计', () => {
  const d = mock.historical('600519.SH').data;
  const s = digestOf('price_history', d);
  assert.ok(s.includes('250 根') && s.includes('前复权'));
});
test('财务摘要包含期次', () => {
  const d = mock.financials('600519.SH');
  const s = digestOf('financials', { income: d.income.data.item, balance: d.balance.data.item, cashflow: d.cashflow.data.item });
  assert.ok(s.includes('FY'));
});
test('财务摘要按表分组打印字段，不输出 undefined（回归：跨表字段混印）', () => {
  const d = mock.financials('600519.SH');
  const s = digestOf('financials', { income: d.income.data.item, balance: d.balance.data.item, cashflow: d.cashflow.data.item });
  assert.ok(!s.includes('undefined'), `digest: ${s}`);
  assert.ok(s.includes('营收') && s.includes('总资产') && s.includes('经营现金流'));
  // 利润表段不含资产负债字段，资产负债表段不含营收字段
  const parts = s.split('；');
  assert.ok(parts.slice(0, 4).every(p => p.includes('营收') && !p.includes('总资产')));
  assert.ok(parts.slice(4, 8).every(p => p.includes('总资产') && !p.includes('营收')));
});

console.log('== DEMO 数据自洽性 ==');
test('快照 prev_price 与 K 线末收一致（口径自洽）', () => {
  const k = mock.historical('600519.SH').data.item;
  const snap = mock.snapshot('600519.SH').data.item[0];
  assert.ok(Math.abs(snap.prev_price - k[k.length - 1].close_price) < 0.01);
});
test('DEMO 证据显式携带 demo 标记', () => {
  assert.strictEqual(mock.searchTickers('茅台').meta.demo, true);
});

console.log('== 参数引用解析 ==');
test('整串单引用解析并保留类型', () => {
  const run = { steps: { s1: { status: 'completed', evidence_ids: ['ev_x'] } } };
  const getEv = (id) => id === 'ev_x' ? { data: { item: [{ last_price: 12.34 }] } } : null;
  assert.strictEqual(resolveArg('{{s1.item[0].last_price}}', run, getEv), 12.34);
});
test('多引用/内嵌模板逐段解析（回归：2026-09-30 盘面情绪 run s5 透传模板 bug）', () => {
  const ev = { data: { item: [{ thscode: '000002.SZ' }, { thscode: '600519.SH' }] } };
  const run = { steps: { s3: { status: 'completed', evidence_ids: ['ev_h'] } } };
  const getEv = (id) => id === 'ev_h' ? ev : null;
  const r = resolveArg('{{s3.item[0].thscode}},{{s3.item[1].thscode}}', run, getEv);
  assert.strictEqual(r, '000002.SZ,600519.SH');
});
test('多引用中失败段被丢弃且不残留多余逗号', () => {
  const ev = { data: { item: [{ thscode: '000002.SZ' }] } };
  const run = { steps: { s3: { status: 'completed', evidence_ids: ['ev_h'] } } };
  const getEv = (id) => id === 'ev_h' ? ev : null;
  const r = resolveArg('{{s3.item[0].thscode}},{{s3.item[5].thscode}},{{s3.item[9].thscode}}', run, getEv);
  assert.strictEqual(r, '000002.SZ');
});
test('整串引用解析失败保留模板原样（显式暴露，不静默）', () => {
  assert.strictEqual(resolveArg('{{s9.close_price}}', { steps: {} }, () => null), '{{s9.close_price}}');
});

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);

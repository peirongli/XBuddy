/**
 * 合规守卫：输出层事后扫描 + 机械降级改写。
 * 规则即代码：即使 LLM 忽略约束，禁用表述也会被拦截。
 */
const FORBIDDEN = [
  { re: /建议(买入|卖出|加仓|减仓|清仓|建仓|配置|申购|赎回)/g, why: '直接买卖建议' },
  { re: /(强烈)?推荐(买入|购买|关注并买)/g, why: '推荐交易' },
  { re: /(必|肯定|确定|一定|势必)?(会)?(大涨|暴涨|必涨|必跌|会涨|会跌|要涨|要跌|翻倍)/g, why: '确定性涨跌预测' },
  { re: /稳赚|保本|无风险|躺赚|暴富/g, why: '收益承诺' },
  { re: /目标价(位)?[:：]?/g, why: '目标价' },
  { re: /(抄底|逃顶|满仓|梭哈|全仓押注)/g, why: '交易指令性表述' },
];

export function scanViolations(text) {
  const hits = [];
  for (const { re, why } of FORBIDDEN) {
    const m = text.match(re);
    if (m) hits.push({ pattern: re.source, why, samples: [...new Set(m)].slice(0, 3) });
  }
  return hits;
}

/** 机械降级：把禁用表述替换为合规中性表述 */
export function redact(text) {
  let out = text;
  out = out.replace(/建议(买入|卖出|加仓|减仓|清仓|建仓)/g, '（合规提示：本平台不提供交易建议，此处已隐去）');
  out = out.replace(/(必|肯定|确定|一定)?(会)?(大涨|暴涨|必涨|必跌|会涨|会跌|要涨|要跌|翻倍)/g, '（此处含预测性表述，已按合规要求移除）');
  out = out.replace(/稳赚|保本|无风险|躺赚|暴富/g, '（收益承诺类表述已移除）');
  out = out.replace(/目标价(位)?[:：]?/g, '（价格预期类表述已按合规移除）');
  out = out.replace(/抄底|逃顶|满仓|梭哈|全仓押注/g, '（交易指令性表述已移除）');
  out = out.replace(/(强烈)?推荐(买入|购买)/g, '（推荐交易类表述已移除）');
  return out;
}

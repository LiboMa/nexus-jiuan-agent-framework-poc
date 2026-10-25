/** 冒烟测试的判定：从结论里取 Agent 引用的知识库规则编号，核对一张用例的结果是否符合预期。不依赖九安的代码。 */
const RULE_ID = /\b(C\d{2}-(?:\d+\.\d+|NOTE)|G-\d{2})\b/g;
export const TIME_LIMIT_MS = 120_000;   // review_advice@1 的 limits.timeoutMs

/** 规则依据里引用的知识库编号（ref 开头写编号，见审核 Agent 提示词第 9 条），去重、按出现顺序。 */
export function citedRuleIds(output) {
  const ids = new Set();
  for (const item of output?.basis ?? []) if (item?.kind === 'rule') for (const match of String(item.ref).matchAll(RULE_ID)) ids.add(match[1]);
  return [...ids];
}

/** 一张用例的结果是否符合预期：返回不符合的地方（空表就是符合）。 */
export function judge(expect, outcome) {
  if (outcome.error) return [`调用失败：${outcome.error}`];
  const problems = [];
  if (outcome.status !== expect.status) problems.push(`status 是 ${outcome.status}，应为 ${expect.status}`);
  if (expect.result && outcome.output?.result !== expect.result) problems.push(`result 是 ${outcome.output?.result}，应为 ${expect.result}`);
  if (expect.rules) {
    const cited = citedRuleIds(outcome.output);
    if (!cited.length) problems.push('没有引用任何知识库规则');
    else if (!expect.rules.some(id => cited.includes(id))) problems.push(`引用的规则 ${cited.join('、')} 里没有 ${expect.rules.join(' 或 ')}`);
  }
  if (outcome.latencyMs > TIME_LIMIT_MS) problems.push(`用时 ${outcome.latencyMs} 毫秒，超过 120 秒`);
  return problems;
}

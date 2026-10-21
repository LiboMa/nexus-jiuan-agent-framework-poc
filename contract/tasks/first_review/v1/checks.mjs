/**
 * first_review@1 的一致性检查：task.json 里 checks 列出的、JSON Schema 管不到的三条。
 * 只依赖语言本身，九安的适配层在 output.schema.json 之后调用。
 *
 * check(result, request) → 问题列表，空数组表示通过。
 * result 是已经过 result.schema.json、output.schema.json 的结果信封；declined 的不带 output，直接通过。
 */
const key = rule => `${rule.ruleId}@${rule.ruleVersion}`;

export function check(result, request) {
  if (result?.status !== 'completed') return [];
  const problems = [];
  const asked = new Map((request?.input?.rules || []).map(rule => [key(rule), rule]));
  const answered = result.output?.rules || [];

  const counts = new Map();
  for (const rule of answered) counts.set(key(rule), (counts.get(key(rule)) || 0) + 1);
  for (const id of asked.keys()) {
    if (!counts.has(id)) problems.push(`rules-covered：请求里的规则 ${id} 没有结果`);
    else if (counts.get(id) > 1) problems.push(`rules-covered：规则 ${id} 有 ${counts.get(id)} 条结果，只能有一条`);
  }
  for (const id of counts.keys()) {
    if (!asked.has(id)) problems.push(`rules-covered：结果里的规则 ${id} 不在请求里`);
  }

  for (const rule of answered) {
    const engine = asked.get(key(rule))?.engine;
    if (asked.get(key(rule))?.kind !== 'field_match' || !engine) continue;
    const expected = engine.result === 'fail' ? 'fail' : 'pass';
    if (rule.result !== expected) problems.push(`engine-consistent：规则 ${key(rule)} 引擎是 ${engine.result}，结论应为 ${expected}`);
  }

  if (answered.some(rule => rule.result === 'fail') && result.output?.result !== 'fail') {
    problems.push('any-fail-fails：有规则不通过，综合结论必须是 fail');
  }
  return problems;
}

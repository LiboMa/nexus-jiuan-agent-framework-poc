import test from 'node:test';
import assert from 'node:assert/strict';
import { citedRuleIds, judge } from '../../scripts/smoke-judge.mjs';

const rule = ref => ({ kind: 'rule', ref, note: '…' });

test('从规则依据的 ref 里取出知识库编号，别的依据不算', () => {
  const output = { basis: [rule('C05-3.4 费控报销特殊事项 · 九安 / 柯顿 · 单笔＞1 万'), rule('G-08 金额分档'),
    { kind: 'field', ref: 'C05-9.9', note: '字段名碰巧像编号' }, rule('C05-3.4 重复引用')] };
  assert.deepEqual(citedRuleIds(output), ['C05-3.4', 'G-08']);
  assert.deepEqual(citedRuleIds(null), []);
});

test('符合预期：状态、结论对，引用了预期规则之一，120 秒以内', () => {
  const outcome = { status: 'completed', output: { result: 'pass', basis: [rule('C05-2.2 费控报销')] }, latencyMs: 80_000 };
  assert.deepEqual(judge({ status: 'completed', result: 'pass', rules: ['C05-3.4', 'C05-2.2'] }, outcome), []);
});

test('不符合预期时逐项说明：结论反了、没引用规则、超时、调用失败', () => {
  const wrong = { status: 'completed', output: { result: 'pass', basis: [] }, latencyMs: 130_000 };
  const problems = judge({ status: 'completed', result: 'fail', rules: ['C05-2.3'] }, wrong);
  assert.equal(problems.length, 3);
  assert.match(problems[0], /result 是 pass，应为 fail/);
  assert.match(problems[1], /没有引用任何知识库规则/);
  assert.match(problems[2], /超过 120 秒/);
  assert.match(judge({ status: 'completed', rules: ['C05-2.3'] }, { status: 'completed', output: { result: 'fail', basis: [rule('C05-2.6 费控报销')] } })[0], /里没有 C05-2.3/);
  assert.match(judge({ status: 'declined' }, { error: 'AI_INVALID_RESPONSE {}' })[0], /调用失败/);
  assert.deepEqual(judge({ status: 'declined' }, { status: 'declined', output: null, latencyMs: 20_000 }), []);
});

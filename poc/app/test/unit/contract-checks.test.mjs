import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const TASK = new URL('../../../../contract/tasks/first_review/v1/', import.meta.url);
const example = async name => JSON.parse(await readFile(new URL(`examples/${name}`, TASK), 'utf8'));
const { check } = await import(new URL('checks.mjs', TASK));

const copy = value => structuredClone(value);

test('first_review checks.mjs：契约里的例子都没有问题（通过、不通过、declined）', async () => {
  assert.deepEqual(check(await example('result-pass.json'), await example('request.json')), []);
  assert.deepEqual(check(await example('result-fail.json'), await example('request-no-evidence.json')), []);
  assert.deepEqual(check(await example('result-declined.json'), await example('request-misrouted.json')), []);
});

test('first_review checks.mjs：rules-covered：漏了、重复了、多出来的规则都报出来', async () => {
  const request = await example('request.json');
  const missing = copy(await example('result-pass.json'));
  missing.output.rules.pop();
  assert.match(check(missing, request).join('\n'), /rules-covered.*rule-mc-period@1/);

  const duplicated = copy(await example('result-pass.json'));
  duplicated.output.rules.push(copy(duplicated.output.rules[0]));
  assert.match(check(duplicated, request).join('\n'), /rules-covered.*rule-fm-expense-type@1/);

  const extra = copy(await example('result-pass.json'));
  extra.output.rules[0].ruleVersion = 9;
  const problems = check(extra, request).join('\n');
  assert.match(problems, /rules-covered.*rule-fm-expense-type@9/);
  assert.match(problems, /rules-covered.*rule-fm-expense-type@1/);
});

test('first_review checks.mjs：engine-consistent：字段核对类的结论要和引擎一致', async () => {
  const request = copy(await example('request.json'));
  const result = copy(await example('result-pass.json'));
  request.input.rules[0].engine.result = 'fail';
  assert.match(check(result, request).join('\n'), /engine-consistent.*rule-fm-expense-type@1/);

  request.input.rules[0].engine.result = 'not_applicable';
  assert.deepEqual(check(result, request), []);

  result.output.rules[0].result = 'fail';
  result.output.result = 'fail';
  assert.match(check(result, request).join('\n'), /engine-consistent.*rule-fm-expense-type@1/);
});

test('first_review checks.mjs：any-fail-fails：有一条不通过，综合结论就得是不通过', async () => {
  const result = copy(await example('result-fail.json'));
  result.output.result = 'pass';
  assert.match(check(result, await example('request-no-evidence.json')).join('\n'), /any-fail-fails/);
});

test('envelope 例子 a2a-request.json：contextId 按接口文档 4.1 的规则算得出来（任务名不带版本、不分区写空串、输入指纹是键名递归排序且不带空格的 JSON）', async () => {
  const { createHash } = await import('node:crypto');
  const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]`
    : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`
    : JSON.stringify(value);
  const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');
  const rpc = JSON.parse(await readFile(new URL('../../../../contract/envelope/v1/examples/a2a-request.json', import.meta.url), 'utf8'));
  const { message } = rpc.params;
  const envelope = message.parts.find(part => part.kind === 'data').data;
  const { tenantId, companyId, subject } = envelope.context;
  const parts = [tenantId, companyId ?? '', envelope.task, subject?.id ?? '', subject?.version ?? '', '', sha(stable(envelope.input)), 1];
  assert.equal(message.contextId, `jag-${sha(parts.join('|')).slice(0, 32)}`);
  const sse = await readFile(new URL('../../../../contract/envelope/v1/examples/stream.sse.txt', import.meta.url), 'utf8');
  assert.ok(sse.includes(message.contextId), 'stream.sse.txt 用的是同一个 contextId');
});

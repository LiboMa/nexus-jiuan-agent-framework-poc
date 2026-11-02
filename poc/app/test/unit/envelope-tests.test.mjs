import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createEnvelopeChecks } from '../../envelope-tests.mjs';

// 用构建出来的九安 v0.7.10 副本里的契约（deploy.sh 先构建再跑这些测试）
const here = path.dirname(fileURLToPath(import.meta.url));
const contractDir = path.resolve(process.env.JIUAN_DIR || path.join(here, '../../../../.build/jiuan'), 'src/agent-contract');
const contractChecks = await import(pathToFileURL(path.join(contractDir, 'checks.mjs')).href);
const checks = createEnvelopeChecks({ contract: contractChecks.loadContract(), contractDir,
  extractResultObject: contractChecks.extractResultObject, checkResultEnvelope: contractChecks.checkResultEnvelope,
  scope: { tenantId: 'fake-tenant-jiuan07', companyId: 'co-jiuan' }, firstTasks: ['review_advice@1'] });

test('模板：契约里的每个任务一份示例请求，审批流的任务排最前；有示例用示例，没有示例的（describe@1）给最小请求；示例都合契约', () => {
  const items = checks.templates();
  assert.equal(items[0].task, 'review_advice@1');
  assert.deepEqual(items.map(item => item.task).sort(), ['describe@1', 'first_review@1', 'review_advice@1']);
  for (const item of items) {
    assert.ok(item.title && Number.isSafeInteger(item.timeoutMs), item.task);
    assert.deepEqual(checks.checkRequest(item.request), [], `${item.task} 的模板要合契约`);
    assert.equal(item.request.context.tenantId, 'fake-tenant-jiuan07');
  }
  assert.equal(items.find(item => item.task === 'describe@1').request.context.subject, null);
});

test('查请求：信封、任务输入都按契约查，查不过的地方逐条列出', () => {
  const [advice] = checks.templates();
  assert.deepEqual(checks.checkRequest({ ...advice.request, task: 'nope' }).map(problem => problem.path), ['/task']);
  const problems = checks.checkRequest({ ...advice.request, input: {} });
  assert.ok(problems.length > 0 && problems.every(problem => problem.path.startsWith('/input') && problem.message));
  assert.ok(checks.checkRequest({ ...advice.request, requestId: 'x' }).some(problem => problem.path === '/requestId'));
});

test('判回答：恰好一个结果信封 JSON（可以包一层 ```json）、和请求对得上、output 合任务契约才算合格；否则列出问题', () => {
  const describe = checks.templates().find(item => item.task === 'describe@1').request;
  const good = { envelope: 'jiuan.agent/v1', task: 'describe', taskVersion: 1, requestId: describe.requestId, status: 'completed',
    output: { tasks: [{ task: 'review_advice', versions: [1], title: '单据审核建议', summary: '对公付款单的审核建议' }] }, agentVersion: 'v-1' };
  const verdict = checks.judge(describe, '```json\n' + JSON.stringify(good) + '\n```');
  assert.deepEqual([verdict.ok, verdict.problems], [true, []], JSON.stringify(verdict.problems));
  assert.equal(verdict.value.agentVersion, 'v-1');
  assert.deepEqual(checks.judge(describe, '好的').problems.map(problem => problem.code), ['ANSWER_NOT_ONE_OBJECT']);
  assert.ok(checks.judge(describe, JSON.stringify({ ...good, requestId: '00000000-0000-4000-8000-000000000000' })).problems.some(problem => problem.path === '/requestId'));
});

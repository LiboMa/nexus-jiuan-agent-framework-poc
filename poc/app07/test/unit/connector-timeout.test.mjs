/**
 * 一轮 AI 独立建议由九安合同的时限掐表（review_advice@1 的 limits.timeoutMs，测试台补丁 0006：180 秒）；调用中间件给 nexus-a2a 的时限
 * （补丁 0007：200 秒）比它长，到点时是 A2A 适配层先停、报 AI_UNAVAILABLE，不是中间件的 CONNECTOR_TIMEOUT（两个都是 180 秒时，中间件的
 * 计时器早几毫秒起，总是它先到）。用构建出来的九安副本核对（默认 ../../.build/jiuan07，可用 JIUAN07_DIR 指到别处）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createEnvelopeChecks } from '../../envelope-tests.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const JIUAN = path.resolve(process.env.JIUAN07_DIR || path.join(here, '../../../../.build/jiuan07'));
const load = relative => import(pathToFileURL(path.join(JIUAN, relative)).href);
const [middleware, contractChecks] = await Promise.all(['src/platform/call-middleware.mjs', 'src/agent-contract/checks.mjs'].map(load));
const contract = contractChecks.loadContract();
const limitOf = task => contract.tasks.get(task).manifest.limits.timeoutMs;
const shell = name => readFile(path.join(here, '../..', name), 'utf8');

test('connector_outlasts_review：nexus-a2a 的中间件时限（200 秒）长过 review_advice@1 的合同时限（180 秒），也长过经它发出的每个任务；上下限放得下这个默认值', () => {
  const connector = middleware.DEFAULT_POLICIES['nexus-a2a'].timeoutMs;
  assert.equal(limitOf('review_advice@1'), 180_000, '补丁 0006');
  assert.equal(connector, 200_000, '补丁 0007');
  assert.ok(connector > limitOf('review_advice@1'), `中间件 ${connector} 毫秒要长过 review_advice@1 的 ${limitOf('review_advice@1')} 毫秒`);
  for (const [key, entry] of contract.tasks) assert.ok(connector > entry.manifest.limits.timeoutMs, `${key}：${entry.manifest.limits.timeoutMs}`);
  const [, max] = middleware.POLICY_BOUNDS['nexus-a2a'].timeoutMs;
  assert.ok(max >= connector, '上下限放得下默认值');
  assert.equal(middleware.validatePolicy('nexus-a2a', {}).timeoutMs, connector, '没有设置时用的就是它');
  // 其他连接器不动
  for (const id of ['hly-prod', 'sap-mcp', 'ai-relay']) assert.deepEqual(middleware.POLICY_BOUNDS[id].timeoutMs, [1000, 180000], id);
});

test('外壳照九安的默认策略建网关（不另给 policies / policyBounds），单据测试经它发、不另给时限：一轮由适配层按任务清单的 180 秒掐表', async () => {
  const server = await shell('server.mjs');
  assert.match(server, /const gateway = J\.callMiddleware\.createCallGateway\(\{ store: platformStore, registry, lockPool, processTag: 'analysis-server' \}\);/);
  assert.doesNotMatch(server, /policyBounds|policies:/);
  // 「Agent 接入」页的单据测试：经中间件的 agentTask，不带 timeoutMs（适配层用任务清单的时限）
  const documentTest = server.slice(server.indexOf('callAgent: ('), server.indexOf('// 「Agent 接入」页的调用记录'));
  assert.match(documentTest, /gateway\.govern\('nexus-a2a'/);
  assert.doesNotMatch(documentTest, /timeoutMs/);
});

test('「Agent 接入」页的请求信封测试按任务清单的时限等（review_advice@1 是 180 秒，短过中间件的 200 秒）；文本测试 120 秒', async () => {
  const contractDir = path.join(JIUAN, 'src/agent-contract');
  const checks = createEnvelopeChecks({ contract, contractDir, extractResultObject: contractChecks.extractResultObject,
    checkResultEnvelope: contractChecks.checkResultEnvelope, scope: { tenantId: 'fake-tenant-jiuan07', companyId: 'co-jiuan' }, firstTasks: ['review_advice@1'] });
  const connector = middleware.DEFAULT_POLICIES['nexus-a2a'].timeoutMs;
  for (const template of checks.templates()) {
    assert.equal(template.timeoutMs, limitOf(template.task), template.task);
    assert.ok(template.timeoutMs < connector, template.task);
  }
  assert.equal(checks.templates().find(item => item.task === 'review_advice@1').timeoutMs, 180_000);
  assert.match(await shell('agent-tests.mjs'), /TEXT_TIMEOUT_MS = 120_000;/);
});

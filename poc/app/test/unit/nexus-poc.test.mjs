import test from 'node:test';
import assert from 'node:assert/strict';
import { POC_SAFE_ERRORS, approvalTone, defaultReturnNote, pollDelay, requiresReason, traceText } from '../../public-src/nexus-poc.js';
import { APPROVAL_STATUS, requiresReason as serverRequiresReason } from '../../approval/workflow.mjs';

test('前端的 requiresReason 与服务端逐项一致', () => {
  for (const decision of ['approve', 'return', 'other']) {
    for (const recommendation of ['PASS_CANDIDATE', 'ATTENTION', 'RETURN_DRAFT', 'MANUAL_REVIEW', undefined]) {
      assert.equal(requiresReason(decision, recommendation), serverRequiresReason(decision, recommendation), `${decision} / ${recommendation}`);
    }
  }
});

test('每个审批状态都有颜色约定；未知状态不上色', () => {
  for (const status of Object.keys(APPROVAL_STATUS)) assert.equal(typeof approvalTone(status), 'string', status);
  assert.equal(approvalTone('approved'), 'green');
  assert.equal(approvalTone('returned'), 'red');
  assert.equal(approvalTone('nope'), '');
});

test('退回说明默认带出待补事项与未解决的问题，最多 8 条、2000 字', () => {
  assert.equal(defaultReturnNote(null), '');
  assert.equal(defaultReturnNote({ requiredActions: ['补充酒店发票'], unresolvedQuestions: [' 培训通知是否已审批 ', ''] }),
    '请补充或说明以下事项后重新提交：\n1. 补充酒店发票\n2. 培训通知是否已审批');
  const long = defaultReturnNote({ requiredActions: Array.from({ length: 20 }, (_, index) => `事项 ${index} ${'很'.repeat(400)}`) });
  assert.ok(long.length <= 2000);
  assert.ok((long.match(/^\d+\. /gm) ?? []).length <= 8);
});

test('审批卡片的轮询会持续到服务端 5 分钟超时之后（九安自己的卡片只等 30 秒）', () => {
  assert.equal(pollDelay(1), 2000);
  assert.equal(pollDelay(16), 2000);
  assert.equal(pollDelay(31), 5000);
  assert.equal(pollDelay(121), null);
  let total = 0;
  for (let attempt = 1; pollDelay(attempt) !== null; attempt += 1) total += pollDelay(attempt);
  assert.ok(total > 5 * 60_000, `总时长 ${total} 毫秒`);
});

test('留痕的追溯信息带版本、哈希、发布、模型与用时', () => {
  assert.equal(traceText({ sourceVersion: 'a'.repeat(64), precheckHash: 'b'.repeat(64), publishId: 'pub_x', model: 'nexus-a2a:pub_x', latencyMs: 45_000 }),
    `单据版本 ${'a'.repeat(12)} · 预审 ${'b'.repeat(12)} · 发布 pub_x · 模型 nexus-a2a:pub_x · 用时 45.0 秒`);
});

test('PoC 的错误码都有中文提示', () => {
  for (const [code, message] of Object.entries(POC_SAFE_ERRORS)) {
    assert.match(code, /^[A-Z_]+$/);
    assert.ok(message.length > 4, code);
  }
});

test('hidden 属性在 PoC 的表单块上真的生效（九安的 .field 设了 display:flex，会盖过浏览器默认的 [hidden]）', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../../public-src/nexus-poc.css', import.meta.url), 'utf8');
  for (const scope of ['.poc-approval', '.poc-invoke', '.poc-login-form']) {
    assert.match(css, new RegExp(`\\${scope} \\[hidden\\][^{]*\\{[^}]*display:\\s*none\\s*!important`), scope);
  }
});

test('页面上的说明不再提 SSM：密钥一律写在 infra/secrets.env', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../../public-src/nexus-poc.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /SSM|ssm put-parameter/);
  assert.match(source, /secrets\.env/);
});

test('单据卡片上的审批：状态、AI 初审结论、风险，来单自动发起的标一下；进行中的要接着刷新', async () => {
  const { approvalChips, needsPolling } = await import('../../public-src/nexus-poc.js');
  const ui = { tag: (text, tone = '') => ({ text, tone }) };
  const chips = approvalChips({ status: 'pending_review', label: '待人工复核', auto: true,
    advice: { modelRecommendation: 'RETURN_DRAFT', riskLevel: 'high', summary: '缺少酒店发票（虚构）' } }, ui);
  assert.deepEqual(chips.map(chip => chip.text), ['审批：待人工复核', 'AI 初审：建议退回', '风险：高', '来单自动发起']);
  assert.equal(chips[1].tone, 'red');
  assert.deepEqual(approvalChips({ status: 'not_started', label: '未发起', auto: false, advice: null }, ui).map(chip => chip.text), ['审批：未发起']);
  assert.equal(needsPolling({ a: { status: 'approved' }, b: { status: 'ai_running' } }), true);
  assert.equal(needsPolling({ a: { status: 'approved' }, b: { status: 'pending_review' } }), false);
});

test('审批流卡片是一步人工复核：没有复核人确认、驳回那一套了', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../../public-src/nexus-poc.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /pending_check|checkForm|act\('confirm'|act\('reject'/);
  assert.match(source, /人工复核/);
  assert.match(source, /\/poc\/intake/);
});

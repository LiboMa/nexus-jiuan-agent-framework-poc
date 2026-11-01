/**
 * 人从单据页发起 AI 独立建议时附上这个人的「我的规则」（custom-rules-advice.mjs）。
 * 前半：九安真实的 review-advice-state + 假任务服务（start → 几次 await / setImmediate / setTimeout → assemble）+ 假组装器，测外壳的规矩。
 * 后半：发起人能不能从 reviewAdvice.start 一路传到组装器，用九安 v0.7.10 副本里真实的 agent-task-service（start → begin → assemble）、
 *   review-advice-state、review-advice 组装器和契约来证明；九安以外只有假库（结果从一个与请求无关的定时器里回来）、假网关、假启用记录，
 *   规则用 Task 7 真实的「我的规则」存储（临时目录）。规则正文、单据都是虚构的。
 * 九安构件默认在 ../../.build/jiuan07（相对 poc/app07），可用 JIUAN07_DIR 指到别处。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withAdviceActor, withCustomRules } from '../../custom-rules-advice.mjs';
import { createCustomRules } from '../../custom-rules.mjs';
import { COMPANIES, REPORTS, TENANT_ID } from '../../fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const JIUAN = path.resolve(process.env.JIUAN07_DIR || path.join(here, '../../../../.build/jiuan07'));
const load = relative => import(pathToFileURL(path.join(JIUAN, relative)).href);
const [{ createAgentTaskService, authorizePersonRun, agentTaskKey }, { createReviewAdviceState }, { createReviewAdviceAssembler }, { loadContract }, { SYSTEM_PIPELINE }] = await Promise.all([
  'src/agent-task-service.mjs', 'src/agent-tasks/review-advice-state.mjs', 'src/agent-tasks/review-advice.mjs', 'src/agent-contract/checks.mjs',
  'src/platform/service-identity.mjs'].map(load));
const contract = loadContract();
const task = contract.tasks.get('review_advice@1');
const MAX = task.manifest.limits.maxRequestChars;

const size = request => [...JSON.stringify(request)].length;
const chars = text => [...text].length;
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]));
  return value;
}
// 九安 review-advice.mjs 的算法：sha256(JSON.stringify(sortKeys(request.input)))
const fingerprintOf = input => createHash('sha256').update(JSON.stringify(sortKeys(input))).digest('hex');
// 九安 providers/nexus-a2a.mjs 的 contextId：同一张单、同一版本时只由 inputFingerprint 区分
const contextIdOf = (request, inputFingerprint, attempt = 1) => 'jag-' + createHash('sha256').update([request.context.tenantId, request.context.companyId ?? '',
  request.task, request.context.subject?.id ?? '', request.context.subject?.version ?? '', '', inputFingerprint, String(attempt)].join('|')).digest('hex').slice(0, 32);
const valid = request => contract.envelope.validateRequest(request).ok && task.validateInput(request.input).ok;
const tick = () => new Promise(resolve => setImmediate(resolve));
const later = () => new Promise(resolve => setTimeout(resolve, 1));
const withoutRules = input => { const { customRules, ...rest } = input; return rest; };

const person = (id, role) => ({ id, name: `${id}（虚构）`, role, companyIds: COMPANIES.map(company => company.id), mode: 'local',
  principalId: `account:${id}`, principal: `account:${id}`, assertActive: () => {} });
const REVIEWER = person('poc-reviewer', 'admin'), CHECKER = person('poc-checker', 'analyst');
const RULES = Object.freeze({ 'poc-reviewer': { owner: 'poc-reviewer', items: [
  { title: '虚构房租补充要求.md', text: '虚构规则：九安板块的房租类对公付款，须附出租方的房产证明；没有的不予通过。' },
  { title: '虚构差旅说明.docx', text: '虚构规则：差旅住宿不超过虚构标准。\n超出部分须附说明。' },
] } });
const fakeRules = (table = RULES) => ({ async forRequest(accountId) { await tick(); return table[accountId] ? structuredClone(table[accountId]) : null; } });
const ruleChars = custom => custom.items.reduce((sum, item) => sum + chars(item.text), 0);
const thousands = number => number.toLocaleString('en-US');
/** 九安 fit() 最多能去到的那一步：原件的页文字一页不留（原件的编号、文件名还在），去过页时 truncated 是 true。 */
function floorSize(request) {
  const probe = structuredClone(request);
  const files = probe.input.evidence.files;
  if (files.some(file => file.pages.length)) { for (const file of files) file.pages = []; probe.input.evidence.truncated = true; }
  return size(probe);
}
const tooLong = (chars, documentId = DOC.id) => ({ code: 'CUSTOM_RULES_TOO_LONG',
  message: `我的规则合计 ${thousands(chars)} 字，加上单据后超过了九安单次请求的上限（约 8.7 万字），请删减我的规则后再发起。`,
  log: `POC_CUSTOM_RULES_TOO_LONG ${documentId} poc-reviewer ${chars}` });

// ---------- 前半：假任务服务、假组装器 ----------

const DOC = Object.freeze({ id: 'doc-f07-001', companyId: COMPANIES[0].id, version: 'a'.repeat(64), type: 'corporate_payment' });
const DOC2 = Object.freeze({ id: 'doc-f07-002', companyId: COMPANIES[1].id, version: 'b'.repeat(64), type: 'corporate_payment' });
const subjectOf = document => ({ tenantId: TENANT_ID, companyId: document.companyId, documentId: document.id, version: document.version });

/** 一份合契约的请求，像九安的组装器 fit 过的那样；pages(file) 给每份原件的页。 */
function requestFor({ documentId, companyId, version }, { fields = [{ label: '支付金额', value: 'CNY 36,000.00' }], lines = [], files = [] } = {}) {
  return { envelope: 'jiuan.agent/v1', task: 'review_advice', taskVersion: 1, requestId: 'fa4e0700-0000-4000-8000-00000000a001',
    context: { tenantId: TENANT_ID, scope: 'company', companyId, subject: { kind: 'document', id: documentId, version }, locale: 'zh-CN' },
    input: { document: { number: `DGZF-${documentId}`, formName: '常规对公付款单-关联单合同', fields, lines },
      evidence: { status: files.length ? 'available' : 'not_acquired', truncated: false, files } } };
}
const smallFiles = () => [{ fileId: 'file-1', name: '虚构合同.pdf', pages: [{ page: 1, text: '虚构合同第 1 页' }, { page: 2, text: '虚构合同第 2 页' }] }];

function fakeAssembler({ build = subject => requestFor(subject, { files: smallFiles() }) } = {}) {
  const calls = [];
  return { calls,
    async assemble(subject) {
      calls.push(subject);
      await tick();
      const request = build(subject);
      return { request, inputFingerprint: fingerprintOf(request.input), routingFacts: { documentType: 'corporate_payment' }, basis: { evidenceFingerprint: 'fp-虚构' }, ruleMap: null };
    },
    async basis(subject) { return { evidenceFingerprint: `basis-${subject.documentId}` }; },
  };
}

/** 照九安 agent-task-service 的形状：start → begin（authorize、读状态各是一次异步）→ assemble；run 是流水线那条。 */
function fakeTasks(assembler, { afterAssemble = async () => {} } = {}) {
  const sent = [];
  async function begin({ actor, subject }) {
    await tick();
    await later();
    await Promise.resolve();
    const assembled = await assembler.assemble({ tenantId: TENANT_ID, companyId: subject.companyId, documentId: subject.id, version: subject.version });
    sent.push({ actor, assembled });
    await afterAssemble({ actor, subject });
    return assembled;
  }
  return { sent, enabled: () => true, view: async ({ subject }) => ({ status: 'not_run', subject: subject.id }),
    async start(args) { const assembled = await begin(args); return { receipt: { status: 'running' }, done: Promise.resolve(assembled) }; },
    run: args => begin(args) };
}

function harness({ rules = fakeRules(), assembler = fakeAssembler(), afterAssemble, task: taskOf = task } = {}) {
  const logs = [];
  const wrapped = withCustomRules(assembler, { rules, contract, task: taskOf, log: line => logs.push(line) });
  const tasks = fakeTasks(wrapped, { afterAssemble });
  const state = withAdviceActor(createReviewAdviceState({ tasks }));
  return { logs, wrapped, tasks, state, assembler };
}

test('system_run_untouched：不经 withAdviceActor 直接组装、流水线身份发起，请求与指纹和九安的一字不差，不记日志', async () => {
  const h = harness();
  const plain = await h.assembler.assemble(subjectOf(DOC));
  assert.deepEqual(await h.wrapped.assemble(subjectOf(DOC)), plain);
  // 流水线：九安的 audit.ai-advice 适配器直接调任务服务的 run（不经单据页那条 start）
  await h.tasks.run({ actor: SYSTEM_PIPELINE, task: 'review_advice', subject: { kind: 'document', id: DOC.id, companyId: DOC.companyId, version: DOC.version } });
  // 就算有人经 withAdviceActor 以流水线身份发起（九安的字符串身份，或 principal 是 system:pipeline 的对象），也不附
  await h.state.start({ actor: SYSTEM_PIPELINE, document: DOC });
  await h.state.start({ actor: { ...REVIEWER, principal: SYSTEM_PIPELINE }, document: DOC });
  assert.equal(h.tasks.sent.length, 3);
  for (const { assembled } of h.tasks.sent) {
    assert.deepEqual(assembled, plain);
    assert.equal(Object.hasOwn(assembled.request.input, 'customRules'), false);
  }
  assert.deepEqual(h.logs, []);
});

test('person_run_attached：poc-reviewer 有两份规则 → input.customRules 就是 forRequest 的结果，指纹按九安的算法重算，日志行有账号和字数、不带正文', async () => {
  const h = harness();
  const started = await h.state.start({ actor: REVIEWER, document: DOC });
  assert.deepEqual(started.receipt, { status: 'running' });
  const [{ assembled }] = h.tasks.sent;
  const expected = await fakeRules().forRequest('poc-reviewer');
  const plain = await h.assembler.assemble(subjectOf(DOC));
  assert.deepEqual(assembled.request.input.customRules, expected);
  assert.ok(valid(assembled.request));
  assert.notEqual(assembled.inputFingerprint, plain.inputFingerprint);
  assert.equal(assembled.inputFingerprint, fingerprintOf(assembled.request.input));
  // 只多了 customRules：单据、原件、信封、路由事实、basis、ruleMap 都照九安的
  assert.deepEqual(withoutRules(assembled.request.input), plain.request.input);
  assert.deepEqual({ ...assembled.request, input: null }, { ...plain.request, input: null });
  assert.deepEqual([assembled.routingFacts, assembled.basis, assembled.ruleMap], [plain.routingFacts, plain.basis, plain.ruleMap]);
  assert.deepEqual(h.logs, [`POC_CUSTOM_RULES ${DOC.id} poc-reviewer ${ruleChars(expected)}`]);
  assert.ok(!h.logs.some(line => line.includes('虚构规则')));

  // poc-checker 没有规则：照九安原样，不记日志
  await h.state.start({ actor: CHECKER, document: DOC });
  assert.deepEqual(h.tasks.sent[1].assembled, plain);
  assert.equal(h.logs.length, 1);
});

// 附规则这一层按九安的请求上限 fit()（从原件末尾逐页去，不裁规则）。规则合计 5,000 字（字数不设上限，这里只是一份不短的规则）；
// 单据字段与付款明细已经占到契约的上限（30 个字段、12 行 × 8 列），要让 5,000 字的规则加进来整份请求就超、而且去两轮原件，
// 这里把请求上限调到正好是九安组装出来的那么大（契约真实的上限 MAX 见 too_long_fails_before_nexus 和后半九安真实的链）
const capped = maxRequestChars => ({ ...task, manifest: { ...task.manifest, limits: { ...task.manifest.limits, maxRequestChars } } });
const LONG_RULES = Object.freeze({ 'poc-reviewer': { owner: 'poc-reviewer', items: [
  { title: '虚构甲.md', text: '虚构规则甲。'.repeat(500) }, { title: '虚构乙.docx', text: '虚构规则乙。'.repeat(333) + '乙乙' }] } });

test('trims_originals_not_rules：原件 3 份各 5 页、规则合计 5,000 字、请求上限正好是九安组装出来的大小 → 按九安 fit() 从末尾逐页去原件，规则全文不动；单据已经占满上限时 CUSTOM_RULES_TOO_LONG，不发', async () => {
  const fields = Array.from({ length: 30 }, (_, index) => ({ label: `虚构字段${index + 1}`, value: '虚'.repeat(500) }));
  const lines = Array.from({ length: 12 }, () => ({ fields: Array.from({ length: 8 }, (_, index) => ({ label: `虚构列${index + 1}`, value: '构'.repeat(200) })) }));
  const page = (file, number) => ({ page: number, text: `虚构原件 ${file} 第 ${number} 页\n`.padEnd(800, '文字\n') });
  const files = () => [1, 2, 3].map(file => ({ fileId: `file-${file}`, name: `虚构原件${file}.pdf`, pages: [1, 2, 3, 4, 5].map(number => page(file, number)) }));
  const assembler = fakeAssembler({ build: subject => requestFor(subject, { fields, lines, files: files() }) });
  assert.equal(ruleChars(LONG_RULES['poc-reviewer']), 5_000);

  const plain = await assembler.assemble(subjectOf(DOC));
  const cap = size(plain.request);
  assert.ok(valid(plain.request) && cap <= MAX, '九安组装出来的本来就在契约的上限内');
  assert.ok(size({ ...plain.request, input: { ...plain.request.input, customRules: LONG_RULES['poc-reviewer'] } }) > cap, '加上规则才超');
  const h = harness({ rules: fakeRules(LONG_RULES), assembler, task: capped(cap) });

  await h.state.start({ actor: REVIEWER, document: DOC });
  const { request, inputFingerprint } = h.tasks.sent[0].assembled;
  assert.ok(size(request) <= cap);
  assert.ok(valid(request));
  assert.deepEqual(request.input.customRules, LONG_RULES['poc-reviewer']);
  assert.equal(request.input.evidence.truncated, true);
  assert.deepEqual(request.input.document, plain.request.input.document);
  const counts = request.input.evidence.files.map(file => file.pages.length);
  assert.ok(counts.reduce((sum, count) => sum + count, 0) < 15 - 3, `去了不止一轮：${counts}`);
  // 每份原件留下的是开头那几页；九安的次序：一轮从最后一份往前各去一页，所以前面的不少于后面的、最多差一页
  request.input.evidence.files.forEach((file, index) => assert.deepEqual(file.pages, plain.request.input.evidence.files[index].pages.slice(0, file.pages.length)));
  assert.ok(counts.every((count, index) => index === 0 || count <= counts[index - 1]) && Math.max(...counts) - Math.min(...counts) <= 1, String(counts));
  // 去够就停：最后去掉的那一页（页数最少的里排最前的那份）放回去就超
  const last = counts.indexOf(Math.min(...counts));
  const back = structuredClone(request);
  back.input.evidence.files[last].pages.push(plain.request.input.evidence.files[last].pages[counts[last]]);
  assert.ok(size(back) > cap);
  assert.equal(inputFingerprint, fingerprintOf(request.input));
  assert.equal(plain.request.input.evidence.files.every(file => file.pages.length === 5), true, '九安给的那份不被改动');

  // 单据字段与付款明细已经占满请求上限（原件只有一页）：原件全去掉也放不下 5,000 字的规则 → CUSTOM_RULES_TOO_LONG（上限照任务清单说），不发
  const crowded = fakeAssembler({ build: subject => requestFor(subject, { fields, lines, files: [{ fileId: 'file-1', name: '虚构原件1.pdf', pages: [page(1, 1)] }] }) });
  const full = size((await crowded.assemble(subjectOf(DOC))).request);
  const huge = harness({ rules: fakeRules(LONG_RULES), assembler: crowded, task: capped(full) });
  await assert.rejects(huge.state.start({ actor: REVIEWER, document: DOC }), error => {
    assert.equal(error.code, 'CUSTOM_RULES_TOO_LONG');
    assert.equal(error.message, `我的规则合计 5,000 字，加上单据后超过了九安单次请求的上限（约 ${(full / 10_000).toFixed(1)} 万字），请删减我的规则后再发起。`);
    return true;
  });
  assert.deepEqual(huge.tasks.sent, []);
  assert.deepEqual(huge.logs, [`POC_CUSTOM_RULES_TOO_LONG ${DOC.id} poc-reviewer 5000`]);
});

test('加上规则后过不了契约校验 → AGENT_ASSEMBLY_FAILED，不发', async () => {
  const picky = { ...task, validateInput: input => (Object.hasOwn(input, 'customRules') ? { ok: false, errors: [{ path: '/customRules' }] } : task.validateInput(input)) };
  const assembler = fakeAssembler();
  const logs = [];
  const wrapped = withCustomRules(assembler, { rules: fakeRules(), contract, task: picky, log: line => logs.push(line) });
  const state = withAdviceActor(createReviewAdviceState({ tasks: fakeTasks(wrapped) }));
  await assert.rejects(state.start({ actor: REVIEWER, document: DOC }), error => error.code === 'AGENT_ASSEMBLY_FAILED');
  assert.deepEqual(logs, []);
});

test('读不出这个人的规则 → 这一轮不发（CUSTOM_RULES_UNAVAILABLE），日志只有错误码', async () => {
  const broken = { async forRequest() { throw Object.assign(new Error('虚构规则正文不该出现'), { code: 'EACCES' }); } };
  const h = harness({ rules: broken });
  await assert.rejects(h.state.start({ actor: REVIEWER, document: DOC }), error => error.code === 'CUSTOM_RULES_UNAVAILABLE');
  assert.deepEqual(h.tasks.sent, []);
  assert.deepEqual(h.logs, ['POC_CUSTOM_RULES_FAILED EACCES']);
});

// 合计字数不设上限（custom-rules.mjs），只受九安单次请求大小（契约真实的 maxRequestChars）的限制：规则加上单据字段与付款明细、
// 原件一页文字都不留（九安 fit() 最多去到这一步）仍放不下 → CUSTOM_RULES_TOO_LONG，什么都不发（Nexus 那次调用不付钱）；放得下就整份附上
test('too_long_fails_before_nexus：规则加上单据、原件一页不留正好是 maxRequestChars → 整份附上（原件的页去光）；多一个字 → CUSTOM_RULES_TOO_LONG，什么都不发，日志只有字数；字数按 Unicode 字符', async () => {
  // 两份合计；一份是 BMP 以外的字（UTF-16 里各占两个码元），数的是 Unicode 字符，不是 .length
  const rulesOf = extra => ({ 'poc-reviewer': { owner: 'poc-reviewer', items: [
    { title: '虚构甲.md', text: '𠀀'.repeat(2_500) }, { title: '虚构乙.docx', text: '虚'.repeat(extra) }] } });
  const plain = (await fakeAssembler().assemble(subjectOf(DOC))).request;
  const floorWith = extra => floorSize({ ...plain, input: { ...plain.input, customRules: rulesOf(extra)['poc-reviewer'] } });
  const fits = MAX - floorWith(0);   // 每多一个「虚」请求多一个字
  assert.equal(floorWith(fits), MAX);
  assert.ok(fits > 80_000, `正好放得下的规则有 ${fits + 2_500} 字`);

  const over = harness({ rules: fakeRules(rulesOf(fits + 1)) });
  const expected = tooLong(2_500 + fits + 1);
  await assert.rejects(over.state.start({ actor: REVIEWER, document: DOC }), error => {
    assert.equal(error.code, expected.code);
    assert.equal(error.message, expected.message);
    return true;
  });
  assert.deepEqual(over.tasks.sent, [], '什么都不发');
  assert.deepEqual(over.logs, [expected.log]);
  assert.ok(!over.logs.some(line => line.includes('虚虚')), '日志不带规则正文');

  const at = harness({ rules: fakeRules(rulesOf(fits)) });
  await at.state.start({ actor: REVIEWER, document: DOC });
  const [{ assembled }] = at.tasks.sent;
  assert.deepEqual(assembled.request.input.customRules, rulesOf(fits)['poc-reviewer'], '规则全文不裁');
  assert.equal(size(assembled.request), MAX);
  assert.ok(valid(assembled.request));
  assert.deepEqual(assembled.request.input.evidence.files.map(file => [file.fileId, file.name, file.pages.length]), [['file-1', '虚构合同.pdf', 0]], '原件的页去光，编号和文件名还在');
  assert.equal(assembled.request.input.evidence.truncated, true);
  assert.equal(assembled.inputFingerprint, fingerprintOf(assembled.request.input));
  assert.deepEqual(at.logs, [`POC_CUSTOM_RULES ${DOC.id} poc-reviewer ${2_500 + fits}`]);
});

test('long_rules_attached_in_full：两万字的规则放得下 → 整份附上，原件不动（不用去页），日志照常 POC_CUSTOM_RULES <单据> <账号> <字数>', async () => {
  const LONG = { 'poc-reviewer': { owner: 'poc-reviewer', items: [
    { title: '虚构长规则一.md', text: '虚构规则：本条只用来量请求大小。\n'.repeat(1_000) }, { title: '虚构长规则二.docx', text: '构'.repeat(3_000) }] } };
  assert.equal(ruleChars(LONG['poc-reviewer']), 20_000);
  const h = harness({ rules: fakeRules(LONG) });
  await h.state.start({ actor: REVIEWER, document: DOC });
  const [{ assembled }] = h.tasks.sent;
  const plain = await h.assembler.assemble(subjectOf(DOC));
  assert.deepEqual(assembled.request.input.customRules, LONG['poc-reviewer']);
  assert.deepEqual(withoutRules(assembled.request.input), plain.request.input, '原件和单据都是九安给的那份');
  assert.ok(size(assembled.request) <= MAX && valid(assembled.request));
  assert.deepEqual(h.logs, [`POC_CUSTOM_RULES ${DOC.id} poc-reviewer 20000`]);
});

test('agent_tests_path_untouched：「Agent 接入」页的单据测试直接调 assemble，不附规则（人刚发起过一轮也一样）', async () => {
  const h = harness();
  await h.state.start({ actor: REVIEWER, document: DOC });
  const direct = await h.wrapped.assemble(subjectOf(DOC));
  assert.equal(Object.hasOwn(direct.request.input, 'customRules'), false);
  assert.deepEqual(direct, await h.assembler.assemble(subjectOf(DOC)));
  assert.equal(h.logs.length, 1);
});

test('发起人只管自己那一轮：同一个异步上下文里后来的组装（别的单、同一张单的第二次）都不附', async () => {
  const late = [];
  let wrapped;
  // 发起的这一轮在上下文里顺带起了后台的事（定时器继承上下文），那里再组装别的单和这张单
  const h = harness({ afterAssemble: async () => {
    await new Promise(resolve => setTimeout(async () => {
      late.push(await wrapped.assemble(subjectOf(DOC2)), await wrapped.assemble(subjectOf(DOC)));
      resolve();
    }, 1));
  } });
  wrapped = h.wrapped;
  await h.state.start({ actor: REVIEWER, document: DOC });
  assert.equal(Object.hasOwn(h.tasks.sent[0].assembled.request.input, 'customRules'), true);
  assert.equal(late.length, 2);
  for (const assembled of late) assert.equal(Object.hasOwn(assembled.request.input, 'customRules'), false);
  assert.equal(h.logs.length, 1);
});

test('withAdviceActor 其余方法原样转发；withCustomRules 的 basis 原样转发；配置不全时立刻报错', async () => {
  const h = harness();
  assert.deepEqual(await h.wrapped.basis(subjectOf(DOC)), { evidenceFingerprint: `basis-${DOC.id}` });
  assert.deepEqual(Object.keys(h.state).sort(), ['list', 'start', 'view']);
  assert.deepEqual(await h.state.view(DOC), { required: true, applicable: true, view: { status: 'not_run', subject: DOC.id } });
  assert.deepEqual(Object.keys(await h.state.list({ documents: [DOC, DOC2] })), [DOC.id, DOC2.id]);
  assert.equal(withAdviceActor(null), null);
  assert.throws(() => withCustomRules(h.assembler, { rules: null, contract, task, log: () => {} }), { code: 'AGENT_CONFIGURATION' });
  assert.throws(() => withCustomRules({}, { rules: fakeRules(), contract, task, log: () => {} }), { code: 'AGENT_CONFIGURATION' });
  assert.throws(() => withCustomRules(h.assembler, { rules: fakeRules(), contract, task: null, log: () => {} }), { code: 'AGENT_CONFIGURATION' });
});

// ---------- 后半：九安真实的 start → begin → assemble ----------

const DOCS = REPORTS.slice(0, 3).map((raw, index) => Object.freeze({ id: `doc-f07-00${index + 1}`, companyId: COMPANIES[index].id, version: String(index + 1).repeat(64),
  type: 'corporate_payment', raw }));

/** 九安的任务服务、状态、组装器、契约都是真的；库的结果从一个在测试里先起好的定时器回来（不在任何一轮的异步上下文里）。 */
async function jiuanChain({ rules } = {}) {
  const pending = [];
  const pump = setInterval(() => { for (const resolve of pending.splice(0)) resolve(); }, 1);
  const db = () => new Promise(resolve => pending.push(resolve));
  const documents = new Map(DOCS.map(document => [document.id, document]));
  const analysisStore = {
    async getDocument({ id }) {
      await db();
      const document = documents.get(id);
      return document && { id, environment: 'prod', tenantId: TENANT_ID, companyId: document.companyId, version: document.version, type: document.type, number: document.raw.businessCode };
    },
    async getDocumentSource({ id }) { await db(); return { raw: documents.get(id).raw, collectedAt: '2026-10-20T08:00:00.000Z' }; },
  };
  // 原件：可以拦一下，让几轮同时停在组装器里，再由最后到的那一轮按倒序放行（放行的人不是等的人）
  let gate = null;
  const readEvidence = async ({ documentId }) => {
    await db();
    if (gate) await gate(documentId);
    return { status: 'ready', observedScopeComplete: true, fingerprint: `fp-${documentId}`, truncated: false,
      files: [{ id: `${documentId}-contract`, name: '虚构合同.pdf', pages: [{ page: 1, text: `虚构合同（${documentId}）第 1 页` }, { page: 2, text: '虚构合同第 2 页' }] }] };
  };
  const plain = createReviewAdviceAssembler({ analysisStore, readEvidence, contract, newId: () => 'fa4e0700-0000-4000-8000-00000000a002' });
  const logs = [];
  const assemblers = { 'review_advice@1': withCustomRules(plain, { rules, contract, task, log: line => logs.push(line) }) };
  const states = new Map();
  const store = {
    async readState(key) { await db(); return states.has(key) ? structuredClone(states.get(key)) : null; },
    async compareAndWriteState(key, { expectedRevision, value }) {
      await db();
      if ((states.get(key)?.revision ?? 0) !== expectedRevision) throw Object.assign(new Error('conflict'), { status: 409 });
      states.set(key, structuredClone(value));
      return value;
    },
  };
  const sent = [];
  const gateway = { govern: () => ({ async agentTask({ request, attempt, inputFingerprint }) {
    // 九安 providers/nexus-a2a.mjs 发出前在本机核对的几项
    sent.push({ request: structuredClone(request), inputFingerprint, contextId: contextIdOf(request, inputFingerprint, attempt), valid: valid(request), chars: size(request) });
    await db();
    return { status: 'completed', output: { verdict: 'pass', note: '虚构' }, call: null };
  } }) };
  const config = { instance: 'test', scope: { tenantId: TENANT_ID, companyId: COMPANIES[0].id, allCompaniesInTenant: true },
    agents: { tasks: { review_advice: { enabled: true, routes: [{ publishId: 'pub-fake-review', when: { documentType: 'corporate_payment' } }] } } } };
  const tasks = createAgentTaskService({ store, gateway, getConfig: () => config, assemblers, authorize: authorizePersonRun, sleep: async () => {},
    enablement: { publication: async () => ({ status: 'active', card: { tasks: ['review_advice@1'] } }) } });
  const state = withAdviceActor(createReviewAdviceState({ tasks }));
  // 九安存的这一轮（view() 不给发起人和指纹，直接读状态）
  const round = document => states.get(agentTaskKey({ tenantId: TENANT_ID, companyId: document.companyId, task: 'review_advice', subject: subjectFor(document) }))?.current ?? null;
  return { tasks, state, plain, assemblers, sent, logs, round, setGate: value => { gate = value; }, close: () => clearInterval(pump) };
}
const subjectFor = document => ({ kind: 'document', id: document.id, companyId: document.companyId, version: document.version });

async function reviewerRules(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'custom-rules-advice-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const rules = createCustomRules({ dir, docxToText: async () => { throw new Error('这里不转 .docx'); } });
  await rules.add('poc-reviewer', { fileName: '虚构房租补充要求.md', bytes: Buffer.from('虚构规则：九安板块的房租类对公付款，须附出租方的房产证明；没有的不予通过。\n') });
  await rules.add('poc-reviewer', { fileName: '虚构付款时限.md', bytes: Buffer.from('# 虚构付款时限\n\n虚构规则：合同约定的付款日之前 5 天内才可发起。') });
  return rules;
}

test('九安真实的链 person_run_attached / system_run_untouched：单据页发起带上发起人的规则，流水线那一轮不带', async t => {
  const rules = await reviewerRules(t);
  const chain = await jiuanChain({ rules });
  t.after(chain.close);
  const [doc] = DOCS;
  const pipeline = await chain.tasks.run({ actor: SYSTEM_PIPELINE, task: 'review_advice', subject: subjectFor(doc) });
  assert.equal(pipeline.status, 'completed');
  const started = await chain.state.start({ actor: REVIEWER, document: doc });
  assert.equal(started.receipt.status, 'running');
  assert.equal((await started.done).status, 'completed');

  const [system, manual] = chain.sent;
  assert.equal(Object.hasOwn(system.request.input, 'customRules'), false);
  assert.equal(system.inputFingerprint, fingerprintOf(system.request.input));
  assert.deepEqual(manual.request.input.customRules, await rules.forRequest('poc-reviewer'));
  assert.equal(manual.request.input.customRules.items.length, 2);
  assert.ok(manual.valid && manual.chars <= MAX);
  assert.equal(manual.inputFingerprint, fingerprintOf(manual.request.input));
  assert.notEqual(manual.inputFingerprint, system.inputFingerprint);
  assert.notEqual(manual.contextId, system.contextId);
  assert.deepEqual(withoutRules(manual.request.input), system.request.input);
  // 九安记下的这一轮：发起人是 poc-reviewer，指纹是发出去的那份
  const round = chain.round(doc);
  assert.deepEqual([round.round, round.requestedBy, round.trigger, round.status], [2, 'account:poc-reviewer', 'manual', 'completed']);
  assert.equal(round.inputFingerprint, manual.inputFingerprint);
  assert.deepEqual(chain.logs, [`POC_CUSTOM_RULES ${doc.id} poc-reviewer ${ruleChars(manual.request.input.customRules)}`]);
});

test('九安真实的链 two_reviewers_concurrently：A（有规则）、B（没有）和流水线同时发起三张单，各轮只有自己的', async t => {
  const rules = await reviewerRules(t);
  const chain = await jiuanChain({ rules });
  t.after(chain.close);
  const [docA, docB, docP] = DOCS;
  const baseline = new Map();
  for (const document of DOCS) baseline.set(document.id, await chain.plain.assemble({ tenantId: TENANT_ID, companyId: document.companyId, documentId: document.id, version: document.version }));

  // 三轮都停在组装器（读原件）里，等齐了由最后到的那一轮按倒序放行
  const waiting = [];
  chain.setGate(documentId => new Promise(resolve => {
    waiting.push({ documentId, resolve });
    if (waiting.length === 3) for (const item of [...waiting].reverse()) item.resolve();
  }));
  const [a, b, p] = await Promise.all([
    chain.state.start({ actor: REVIEWER, document: docA }),
    chain.state.start({ actor: CHECKER, document: docB }),
    chain.tasks.run({ actor: SYSTEM_PIPELINE, task: 'review_advice', subject: subjectFor(docP) }),
  ]);
  chain.setGate(null);
  assert.deepEqual(waiting.map(item => item.documentId).sort(), [docA.id, docB.id, docP.id]);
  assert.equal((await a.done).status, 'completed');
  assert.equal((await b.done).status, 'completed');
  assert.equal(p.status, 'completed');

  const byDoc = new Map(chain.sent.map(item => [item.request.context.subject.id, item]));
  const sentA = byDoc.get(docA.id), sentB = byDoc.get(docB.id), sentP = byDoc.get(docP.id);
  assert.deepEqual(sentA.request.input.customRules, await rules.forRequest('poc-reviewer'));
  assert.notEqual(sentA.inputFingerprint, baseline.get(docA.id).inputFingerprint);
  assert.equal(Object.hasOwn(sentB.request.input, 'customRules'), false);
  assert.equal(sentB.inputFingerprint, baseline.get(docB.id).inputFingerprint);
  assert.equal(Object.hasOwn(sentP.request.input, 'customRules'), false);
  assert.equal(sentP.inputFingerprint, baseline.get(docP.id).inputFingerprint);
  assert.notEqual(sentA.inputFingerprint, sentB.inputFingerprint);
  assert.deepEqual(chain.logs, [`POC_CUSTOM_RULES ${docA.id} poc-reviewer ${ruleChars(sentA.request.input.customRules)}`]);

  // 同一张单：A 发起过之后 B 再发起，B 那一轮没有 A 的规则，指纹、Nexus 会话（contextId）都和 A 的不同
  const again = await chain.state.start({ actor: CHECKER, document: docA });
  assert.equal((await again.done).status, 'completed');
  const sentB2 = chain.sent.at(-1);
  assert.equal(sentB2.request.context.subject.id, docA.id);
  assert.equal(Object.hasOwn(sentB2.request.input, 'customRules'), false);
  assert.equal(sentB2.inputFingerprint, baseline.get(docA.id).inputFingerprint);
  assert.notEqual(sentB2.inputFingerprint, sentA.inputFingerprint);
  assert.notEqual(sentB2.contextId, sentA.contextId);
  assert.equal(chain.logs.length, 1);
});

test('九安真实的链 agent_tests_path_untouched：「Agent 接入」页的测试（server.mjs 直接调 assemblers 里的 assemble）不附规则', async t => {
  const rules = await reviewerRules(t);
  const chain = await jiuanChain({ rules });
  t.after(chain.close);
  const [doc] = DOCS;
  await (await chain.state.start({ actor: REVIEWER, document: doc })).done;
  const subject = { tenantId: TENANT_ID, companyId: doc.companyId, documentId: doc.id, version: doc.version };
  const direct = await chain.assemblers['review_advice@1'].assemble(subject);
  assert.equal(Object.hasOwn(direct.request.input, 'customRules'), false);
  assert.deepEqual(direct, await chain.plain.assemble(subject));
  assert.equal(chain.logs.length, 1);
});

test('九安真实的链 too_long / long_rules：存了 9 万字的规则（上传不拦）→ 这一轮按 CUSTOM_RULES_TOO_LONG 记为失败，什么都不发；换成 2 万字的再发起，整份附上发出', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'custom-rules-advice-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const rules = createCustomRules({ dir, docxToText: async () => { throw new Error('这里不转 .docx'); } });
  // 合计字数不设上限：上传照收（单个文件 2 MB 以内）
  const huge = await rules.add('poc-reviewer', { fileName: '虚构九万字.md', bytes: Buffer.from('虚构的填充规则。'.repeat(11_250)) });
  assert.equal(huge.chars, 90_000);
  const chain = await jiuanChain({ rules });
  t.after(chain.close);
  const [doc] = DOCS;

  const started = await chain.state.start({ actor: REVIEWER, document: doc });
  assert.equal(started.receipt.status, 'failed');
  assert.equal(started.receipt.errorCode, 'CUSTOM_RULES_TOO_LONG');
  assert.deepEqual(chain.sent, [], '什么都不发');
  assert.deepEqual(chain.logs, [tooLong(90_000, doc.id).log]);
  // 九安记下的这一轮：失败、错误码就是它（消息不进轮次记录，页面按错误码说明）
  const failed = chain.round(doc);
  assert.deepEqual([failed.status, failed.errorCode, failed.requestedBy], ['failed', 'CUSTOM_RULES_TOO_LONG', 'account:poc-reviewer']);

  // 删掉、传一份 2 万字的（虚构）再发起：整份附上发出，请求在契约的上限内
  await rules.remove('poc-reviewer', huge.id);
  const long = await rules.add('poc-reviewer', { fileName: '虚构两万字.md', bytes: Buffer.from('虚构规则：本条只用来量请求大小。\n'.repeat(1_176) + '虚'.repeat(8)) });
  assert.equal(long.chars, 20_000);
  const again = await chain.state.start({ actor: REVIEWER, document: doc });
  assert.equal((await again.done).status, 'completed');
  assert.equal(chain.sent.length, 1);
  assert.deepEqual(chain.sent[0].request.input.customRules, await rules.forRequest('poc-reviewer'));
  assert.equal(ruleChars(chain.sent[0].request.input.customRules), long.chars, '规则全文不裁');
  assert.ok(chain.sent[0].valid && chain.sent[0].chars <= MAX);
  assert.deepEqual(chain.logs.at(-1), `POC_CUSTOM_RULES ${doc.id} poc-reviewer ${long.chars}`);
});

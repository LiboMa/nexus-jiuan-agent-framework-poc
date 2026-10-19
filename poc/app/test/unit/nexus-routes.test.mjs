import test from 'node:test';
import assert from 'node:assert/strict';
import { nexusRoutes } from '../../nexus/routes.mjs';
import { createRunLog } from '../../nexus/runs.mjs';
import { governanceEnv } from '../../nexus/governance.mjs';
import { PASSWORDS, advisoryResult, startApp } from './helpers/app.mjs';
import { answerEvents, rejectJson, startFakeA2a, writeEvents } from './helpers/fake-a2a.mjs';
import { waitUntil } from './helpers/wait.mjs';

async function setup(t, { source = 'user', enabled = true, answer = JSON.stringify(advisoryResult()), samples, handler } = {}) {
  const fake = await startFakeA2a(handler ?? (({ res }) => writeEvents(res, answerEvents(answer))));
  t.after(() => fake.close());
  const invalid = [];
  const me = { credentialFor: async (user, id) => (enabled && id === 'pub_test' ? { key: `nxa_${source}_key`, rpcUrl: fake.url, source } : null),
    markInvalid: async (user, id) => { invalid.push([user.id, id]); } };
  const runLog = createRunLog();
  const env = await startApp(t, { plugins: [nexusRoutes({ me, runLog, governanceEnv: governanceEnv(), ...(samples ? { samples } : {}) })] });
  const http = env.client();
  await http.login('poc-reviewer', PASSWORDS.get('poc-reviewer'));
  return { ...env, fake, http, runLog, invalid };
}
const invoke = (http, body) => http.api('/poc/nexus/invoke', { method: 'POST', body });
const finished = (http, runId) => waitUntil(async () => {
  const response = await http.api(`/poc/nexus/runs/${runId}`);
  return response.body.data.status !== 'running' && response.body.data;
});

test('自由文本调用：立即返回 202 和运行记录编号，结果带原始返回', async t => {
  const { http, fake } = await setup(t, { answer: 'OK' });
  const started = await invoke(http, { publishId: 'pub_test', mode: 'text', text: '请只回复 OK' });
  assert.equal(started.status, 202);
  const run = await finished(http, started.body.data.runId);
  assert.equal(run.status, 'ok');
  assert.equal(run.rawText, 'OK');
  assert.equal(run.validation, 'not_applicable');
  assert.equal(run.source, 'invoke');
  assert.equal(run.actor, '审核员（虚构）');
  assert.equal(fake.requests[0].body.params.message.parts[0].text, '请只回复 OK');
});

test('审批建议调用：按九安的格式组装这张单据的输入，并用九安的校验函数检查输出', async t => {
  const { http, app, fake } = await setup(t);
  const document = app.documents.find(item => item.number === 'FYBX-POC-004');
  const started = await invoke(http, { publishId: 'pub_test', mode: 'advisory', documentId: document.id });
  const run = await finished(http, started.body.data.runId);
  assert.equal(run.status, 'ok');
  assert.equal(run.validation, 'passed');
  assert.equal(run.documentNumber, 'FYBX-POC-004');
  const prompt = fake.requests[0].body.params.message.parts[0].text;
  assert.match(prompt, /<output_schema>/);
  assert.match(prompt, /FYBX-POC-004/);
});

test('没启用、也不是系统提供：409 POC_AGENT_NOT_ENABLED，不发请求', async t => {
  const { http, fake } = await setup(t, { enabled: false });
  const response = await invoke(http, { publishId: 'pub_test', mode: 'text', text: 'x' });
  assert.deepEqual([response.status, response.body.error.code], [409, 'POC_AGENT_NOT_ENABLED']);
  assert.equal(fake.requests.length, 0);
});

test('调用测试每个账号每分钟最多 5 次', async t => {
  const { http } = await setup(t, { answer: 'OK' });
  for (let index = 0; index < 5; index += 1) assert.equal((await invoke(http, { publishId: 'pub_test', mode: 'text', text: `第 ${index + 1} 次` })).status, 202);
  const limited = await invoke(http, { publishId: 'pub_test', mode: 'text', text: '第 6 次' });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, 'POC_INVOKE_RATE_LIMIT');
});

test('参数不对是 400，没启用的发布是 409', async t => {
  const { http } = await setup(t);
  assert.equal((await invoke(http, { publishId: 'pub_test', mode: 'text', text: '' })).status, 400);
  assert.equal((await invoke(http, { publishId: 'pub_test', mode: 'shell', text: 'x' })).status, 400);
  assert.equal((await invoke(http, { publishId: 'pub_test', mode: 'text', text: 'x', extra: 1 })).status, 400);
  assert.equal((await invoke(http, { publishId: 'pub_other', mode: 'text', text: 'x' })).status, 409);   // 既没启用、也不是系统提供
});

test('运行记录列表与附件规则', async t => {
  const { http } = await setup(t, { answer: 'OK' });
  const policy = await http.api('/poc/nexus/attachment-policy');
  assert.equal(policy.status, 200);
  assert.equal(policy.body.data.attachmentPolicy.maxFiles, 5);
  const started = await invoke(http, { publishId: 'pub_test', mode: 'text', text: 'x' });
  await finished(http, started.body.data.runId);
  const runs = await http.api('/poc/nexus/runs?limit=5');
  assert.equal(runs.body.data.items.length, 1);
  assert.equal(runs.body.data.items[0].rawText, undefined);
  assert.equal(runs.body.data.items[0].hasRawText, true);
  assert.equal((await http.api('/poc/nexus/runs/run_none_1')).status, 404);
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PDF = Buffer.from('%PDF-1.7\n% fictitious invoice\n');
const attach = (name, bytes) => ({ name, type: 'application/octet-stream', data: bytes.toString('base64') });

test('自由文本带附件：作为文件 Part 发给 Nexus；运行记录只记名称、类型、大小与 sha256', async t => {
  const { http, fake } = await setup(t, { answer: 'OK' });
  const started = await invoke(http, { publishId: 'pub_test', mode: 'text', text: '请看附件', attachments: [attach('发票.png', PNG)] });
  assert.equal(started.status, 202);
  const run = await finished(http, started.body.data.runId);
  assert.equal(run.status, 'ok');
  const [, file] = fake.requests[0].body.params.message.parts;
  assert.deepEqual(file, { kind: 'file', file: { name: '发票.png', mimeType: 'image/png', bytes: PNG.toString('base64') } });
  assert.equal(run.attachments.length, 1);
  assert.deepEqual(Object.keys(run.attachments[0]).sort(), ['mimeType', 'name', 'sha256', 'size']);
  assert.equal(run.attachments[0].size, PNG.length);
  const listed = (await http.api('/poc/nexus/runs?limit=5')).body.data.items[0];
  assert.equal(listed.attachments[0].name, '发票.png');
});

test('审批建议也能带附件，输出照样过九安校验', async t => {
  const { http, app, fake } = await setup(t);
  const document = app.documents.find(item => item.number === 'FYBX-POC-001');
  const started = await invoke(http, { publishId: 'pub_test', mode: 'advisory', documentId: document.id, attachments: [attach('住宿发票.pdf', PDF)] });
  const run = await finished(http, started.body.data.runId);
  assert.equal(run.validation, 'passed');
  assert.equal(fake.requests[0].body.params.message.parts[1].file.mimeType, 'application/pdf');
  assert.equal(run.attachments[0].name, '住宿发票.pdf');
});

test('附件不合规：400 和对应的错误码，不发请求，也不占每分钟的次数', async t => {
  const { http, fake } = await setup(t, { answer: 'OK' });
  const cases = [[[attach('setup.exe', Buffer.from('MZ'))], 'POC_ATTACHMENT_TYPE_NOT_SUPPORTED'], [[attach('发票.png', PDF)], 'POC_ATTACHMENT_TYPE_MISMATCH'],
    [Array.from({ length: 6 }, (_, index) => attach(`${index}.txt`, Buffer.from('x'))), 'POC_ATTACHMENT_TOO_MANY'], [[{ name: 'a.txt', data: '%%' }], 'POC_ATTACHMENT_INVALID'],
    [[attach('a.txt', Buffer.from('x'))].concat([{ name: 'b.txt', data: 'eA==', url: 'x' }]), 'POC_ATTACHMENT_INVALID']];
  for (const [attachments, code] of cases) {
    const rejected = await invoke(http, { publishId: 'pub_test', mode: 'text', text: 'x', attachments });
    assert.equal(rejected.status, 400, code);
    assert.equal(rejected.body.error.code, code);
  }
  assert.equal(fake.requests.length, 0);
  assert.equal((await invoke(http, { publishId: 'pub_test', mode: 'text', text: '合规的一次' })).status, 202);
});

test('请求体：带附件时上限放宽到合计附件的 base64 大小再加一些余量；超过返回 413', async t => {
  const { http } = await setup(t, { answer: 'OK' });
  const near = Buffer.concat([PDF, Buffer.alloc(4 * 1024 * 1024)]);
  assert.equal((await invoke(http, { publishId: 'pub_test', mode: 'text', text: 'x', attachments: [attach('大.pdf', near)] })).status, 202);
  const huge = 'x'.repeat(9 * 1024 * 1024);
  assert.equal((await invoke(http, { publishId: 'pub_test', mode: 'text', text: huge })).status, 413);
});

test('文本是 {"task": …} 的 JSON 时，运行记录的任务记成 task:<任务名>', async t => {
  const { http } = await setup(t, { answer: '{"task":"describe"}' });
  const started = await invoke(http, { publishId: 'pub_test', mode: 'text', text: JSON.stringify({ task: 'describe' }) });
  assert.equal((await finished(http, started.body.data.runId)).task, 'task:describe');
  const plain = await invoke(http, { publishId: 'pub_test', mode: 'text', text: '{"task": "Robert\'); DROP TABLE"}' });
  assert.equal((await finished(http, plain.body.data.runId)).task, 'text');
});

test('附件规则单独下发，前端按它限制可选文件', async t => {
  const { http } = await setup(t);
  const policy = (await http.api('/poc/nexus/attachment-policy')).body.data.attachmentPolicy;
  assert.equal(policy.maxFiles, 5);
  assert.match(policy.accept, /\.xlsx/);
});

test('示例附件：列表不带内容；取单个时给 base64 内容；不认识的编号是 404', async t => {
  const samples = { list: () => [{ id: 'invoice-png', name: '发票.png', mimeType: 'image/png', size: PNG.length, description: '虚构发票' }],
    get: id => (id === 'invoice-png' ? { id, name: '发票.png', mimeType: 'image/png', size: PNG.length, description: '虚构发票', data: PNG.toString('base64') } : null) };
  const { http } = await setup(t, { samples });
  const list = await http.api('/poc/nexus/samples');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.data.items.map(item => item.id), ['invoice-png']);
  assert.equal(list.body.data.items[0].data, undefined);
  const one = await http.api('/poc/nexus/samples/invoice-png');
  assert.equal(one.body.data.data, PNG.toString('base64'));
  assert.equal((await http.api('/poc/nexus/samples/none')).status, 404);
  assert.equal((await http.api('/poc/nexus/samples/..%2Fsecrets')).status, 404);
});

test('用我启用的调用密钥调用；记下 actorId 与来源；系统提供的用系统密钥', async t => {
  const mine = await setup(t, { source: 'user', answer: 'OK' });
  const run = await finished(mine.http, (await invoke(mine.http, { publishId: 'pub_test', mode: 'text', text: 'x' })).body.data.runId);
  assert.equal(mine.fake.requests[0].headers.authorization, 'Bearer nxa_user_key');
  assert.deepEqual([run.actorId, run.credentialSource], ['poc-reviewer', 'user']);
  const system = await setup(t, { source: 'system', answer: 'OK' });
  await finished(system.http, (await invoke(system.http, { publishId: 'pub_test', mode: 'text', text: 'x' })).body.data.runId);
  assert.equal(system.fake.requests[0].headers.authorization, 'Bearer nxa_system_key');
});

test('调用时 Nexus 回 401：把我的启用标成密钥失效；回 404（例如发布暂停）不标（Review Focus 4）；系统密钥不标', async t => {
  const reject = status => ({ res }) => rejectJson(res, status, status === 401 ? 'credential_invalid' : 'publication_not_found');
  const unauthorized = await setup(t, { handler: reject(401) });
  await finished(unauthorized.http, (await invoke(unauthorized.http, { publishId: 'pub_test', mode: 'text', text: 'x' })).body.data.runId);
  await waitUntil(() => unauthorized.invalid.length === 1);
  assert.deepEqual(unauthorized.invalid, [['poc-reviewer', 'pub_test']]);
  const paused = await setup(t, { handler: reject(404) });
  await finished(paused.http, (await invoke(paused.http, { publishId: 'pub_test', mode: 'text', text: 'x' })).body.data.runId);
  assert.deepEqual(paused.invalid, []);
  const system = await setup(t, { source: 'system', handler: reject(401) });
  await finished(system.http, (await invoke(system.http, { publishId: 'pub_test', mode: 'text', text: 'x' })).body.data.runId);
  assert.deepEqual(system.invalid, []);
});

test('运行记录按账号过滤：复核人看不到审核员的调用测试（列表与单条都是）', async t => {
  const { http, client } = await setup(t, { answer: 'OK' });
  const runId = (await invoke(http, { publishId: 'pub_test', mode: 'text', text: 'x' })).body.data.runId;
  await finished(http, runId);
  const checker = client();
  await checker.login('poc-checker', PASSWORDS.get('poc-checker'));
  assert.deepEqual((await checker.api('/poc/nexus/runs?limit=5')).body.data.items, []);
  assert.equal((await checker.api(`/poc/nexus/runs/${runId}`)).status, 404);
  assert.equal((await http.api('/poc/nexus/runs?limit=5')).body.data.items.length, 1);
});

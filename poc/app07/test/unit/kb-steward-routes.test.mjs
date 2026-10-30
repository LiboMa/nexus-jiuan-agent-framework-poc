import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModelError } from '../../../app/nexus/a2a-client.mjs';
import { createKbStewardClient } from '../../kb-steward-client.mjs';
import { createKbStewardRoutes } from '../../kb-steward-routes.mjs';

// S3 Vectors 方式的「公司制度」接口：经 A2A 调文档管家（kb.rules/v1）。call、credentialFor、markInvalid 都是假的，不出网、不碰真钥匙。
const BASE = '/api/analysis/v1/poc/kb';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const FIXTURE = await readFile(fileURLToPath(new URL('../../../../kb/tests/fixtures/sample-matrix.docx', import.meta.url)));
const SHA = createHash('sha256').update(FIXTURE).digest('hex');
const PUB = 'pub_0123456789abcdef';
const KEY = `nxa_${'f'.repeat(43)}`;
const ORIGIN = 'https://nexus.example';
const REPORT = { general: 3, chapter_notes: 3, matrix: 12, total: 18, chapters: [{ no: 1, title: '一、立项审批', rows: 4 }], duplicates: [], without_path: [] };
const INGESTED = { success: true, status: 'ingested', source_id: 'sample-matrix', source_version: 'V4.0', rules_total: 18, written: 18, removed: 0, unchanged: 0, conflicts: [], report: REPORT };
const reply = value => (typeof value === 'string' ? value : JSON.stringify(value));

/** 后台入库有文件读写：按条件等，不数事件循环的轮数。 */
async function until(check, ms = 3000) {
  for (const started = Date.now(); !(await check()); ) {
    if (Date.now() - started > ms) throw new Error('等太久了');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

/** answer(args) 给出文档管家这一轮回的文字（或抛错）；key 是「Agent 接入」页里这个发布的钥匙（null = 没启用）。 */
async function harness({ answer = () => reply(INGESTED), key = KEY, uploadsDir } = {}) {
  const dir = uploadsDir ?? await mkdtemp(path.join(tmpdir(), 'kb-s3v-'));
  const calls = [], invalid = [], requests = [];
  const state = { key };
  const call = async args => { calls.push(args); return { text: await answer(args, calls.length), taskId: 't', timings: {} }; };
  const client = createKbStewardClient({ origin: ORIGIN, publishId: PUB, call,
    credentialFor: async id => (id === PUB ? state.key : null),
    markInvalid: async (id, reason) => { invalid.push([id, reason]); state.key = null; } });
  const spied = { ...client, request: (...args) => { requests.push(args); return client.request(...args); } };
  let clock = Date.parse('2026-10-29T08:00:00.000Z');
  const logs = [];
  const routes = createKbStewardRoutes({ client: spied, uploadsDir: dir, log: line => logs.push(line), now: () => (clock += 1500) });
  const ask = async (method, route, { role = 'admin', body = null, headers = {} } = {}) => {
    const req = Object.assign(Readable.from([body ?? Buffer.alloc(0)]), { method, headers });
    let status = null, payload = null;
    const res = { writeHead(code) { status = code; return this; }, setHeader() {}, end(text) { payload = text ? JSON.parse(text) : null; } };
    const handled = await routes.handle({ req, path: `${BASE}${route}`, session: role ? { user: { id: 'poc-reviewer', role } } : null, res, body: undefined });
    return { handled, status, payload };
  };
  const upload = ({ query = 'sourceId=sample-matrix&sourceVersion=V4.0&title=' + encodeURIComponent('仿真办法'), bytes = FIXTURE, name = '仿真办法.docx', type = DOCX, role } = {}) =>
    ask('POST', `/sources?${query}`, { role, body: bytes, headers: { 'content-type': type, 'x-file-name': encodeURIComponent(name) } });
  const item = async id => (await ask('GET', `/uploads/${id}`)).payload?.data;
  const settled = async id => { await until(async () => (await item(id))?.status !== 'ingesting'); return item(id); };
  return { dir, calls, invalid, requests, state, logs, routes, ask, upload, item, settled, done: () => rm(dir, { recursive: true, force: true }) };
}

test('ingest_flow：上传回 202，后台 ingest 只调一次（文字、数据 Part、文件 Part、5 分钟时限），历史从 ingesting 变 ingested，条数来自回复；原文件 0600', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = await harness({ answer: async () => { await gate; return reply(INGESTED); } });
  t.after(h.done);
  const started = await h.upload();
  assert.equal(started.status, 202, JSON.stringify(started.payload));
  assert.deepEqual(started.payload.data, { id: 1, status: 'ingesting' });
  assert.equal((await h.item(1)).status, 'ingesting');
  // 同一时间只跑一个入库
  const busy = await h.upload();
  assert.deepEqual([busy.status, busy.payload.error.code], [409, 'KB_INGEST_BUSY']);
  release();
  const done = await h.settled(1);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.requests, [['ingest', { source_id: 'sample-matrix', source_version: 'V4.0', title: '仿真办法' }, { name: '仿真办法.docx', bytes: FIXTURE }]]);
  const [sent] = h.calls;
  assert.equal(sent.url, `${ORIGIN}/a2a/${PUB}`);
  assert.equal(sent.key, KEY);
  assert.equal(sent.text, 'kb.rules/v1 · ingest：只调用对应的工具一次，原样返回工具的 JSON。');
  assert.deepEqual(sent.data, [{ op: 'ingest', source_id: 'sample-matrix', source_version: 'V4.0', title: '仿真办法' }]);
  assert.equal(sent.files.length, 1);
  assert.deepEqual([sent.files[0].name, sent.files[0].mimeType, Buffer.compare(sent.files[0].bytes, FIXTURE)], ['仿真办法.docx', DOCX, 0]);
  assert.equal(sent.timeoutMs, 300_000);
  assert.deepEqual({ status: done.status, fileName: done.fileName, by: done.by, sourceId: done.sourceId, sourceVersion: done.sourceVersion, title: done.title,
    rulesTotal: done.rulesTotal, written: done.written, removed: done.removed, unchanged: done.unchanged, conflicts: done.conflicts, error: done.error, sha256: done.sha256 },
  { status: 'ingested', fileName: '仿真办法.docx', by: 'poc-reviewer', sourceId: 'sample-matrix', sourceVersion: 'V4.0', title: '仿真办法',
    rulesTotal: 18, written: 18, removed: 0, unchanged: 0, conflicts: [], error: null, sha256: SHA });
  assert.equal(done.at, '2026-10-29T08:00:01.500Z');
  assert.ok(Number.isInteger(done.elapsedMs) && done.elapsedMs > 0, '用时');
  assert.deepEqual(done.report, REPORT);
  assert.equal((await stat(path.join(h.dir, `${SHA}.docx`))).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(h.dir, 'history.json'))).mode & 0o777, 0o600, '历史里有文件名和解析报告，和原文件一样只给服务自己读');
  const list = (await h.ask('GET', '/uploads')).payload.data.items;
  assert.deepEqual(list.map(entry => [entry.id, entry.status]), [[1, 'ingested']]);
  // 同一份文件再传、文档管家回 skipped：历史记 skipped；新的一条排在前面
  const again = await harness({ uploadsDir: h.dir, answer: () => reply({ ...INGESTED, status: 'skipped', written: 0, unchanged: 18 }) });
  await again.routes.start();
  assert.equal((await again.upload()).status, 202);
  assert.deepEqual([(await again.settled(2)).status, (await again.item(2)).unchanged], ['skipped', 18]);
  assert.deepEqual((await again.ask('GET', '/uploads')).payload.data.items.map(entry => [entry.id, entry.status]), [[2, 'skipped'], [1, 'ingested']], '历史存在 history.json，换一个实例也读得到');
});

test('reply_invalid：回复不是 JSON、是另一种操作的形状 → 历史标 failed（KB_AGENT_REPLY_INVALID），call 只调一次；带 ```json 围栏的合格 JSON 照样成功', async t => {
  for (const bad of ['好的，已入库', reply({ sources: [] }), reply({ success: true, sources: [] }), `${reply(INGESTED)}\n已入库。`]) {
    const h = await harness({ answer: () => bad });
    t.after(h.done);
    assert.equal((await h.upload()).status, 202);
    const entry = await h.settled(1);
    assert.equal(entry.status, 'failed', bad);
    assert.deepEqual(entry.error, { code: 'KB_AGENT_REPLY_INVALID', message: '文档管家的回复不合格，这次没有完成' });
    assert.equal(h.calls.length, 1, '写操作不重试');
    assert.ok(!h.logs.some(line => line.includes('已入库') || line.includes('sources')), '日志里不写回复的内容');
  }
  const fenced = await harness({ answer: () => `\`\`\`json\n${reply(INGESTED)}\n\`\`\`` });
  t.after(fenced.done);
  await fenced.upload();
  assert.deepEqual([(await fenced.settled(1)).status, (await fenced.item(1)).rulesTotal], ['ingested', 18]);
  // 同步的操作：回复不合格 → 502，页面说「文档管家的回复不合格」
  const sync = await harness({ answer: () => reply(INGESTED) });
  t.after(sync.done);
  const listed = await sync.ask('GET', '/sources');
  assert.deepEqual([listed.status, listed.payload.error.code, listed.payload.error.message], [502, 'KB_AGENT_REPLY_INVALID', '文档管家的回复不合格，这次没有完成']);
  assert.equal(sync.calls.length, 1);
  // 另一份制度的回复（source_id 对不上）也不合格
  const other = await harness({ answer: () => reply({ success: true, source_id: 'other-doc', affected: 3 }) });
  t.after(other.done);
  assert.equal((await other.ask('POST', '/sources/sample-matrix/delete')).status, 502);
  // 工具自己的失败回复（success=false）是合格的回复，原样给页面
  const missing = { success: false, error_type: 'source_not_found', message: '规则库里没有制度「sample-matrix」', suggestion: '请用 action=list 查看已有的制度' };
  const failed = await harness({ answer: () => reply(missing) });
  t.after(failed.done);
  const detail = await failed.ask('GET', '/sources/sample-matrix');
  assert.deepEqual([detail.status, detail.payload.data], [200, missing]);
});

test('not_enabled_and_rejected：没启用时 /mode 是 ready:false、操作回 409 KB_AGENT_NOT_READY 且不发调用；Nexus 回 401 时 markInvalid 一次、回 409 KB_AGENT_KEY_REJECTED，之后不再发', async t => {
  const h = await harness({ key: null });
  t.after(h.done);
  assert.deepEqual((await h.ask('GET', '/mode')).payload.data, { mode: 's3vectors', ready: false });
  const listed = await h.ask('GET', '/sources');
  assert.deepEqual([listed.status, listed.payload.error.code, listed.payload.error.message], [409, 'KB_AGENT_NOT_READY', '先在『Agent 接入』页启用知识库文档管家']);
  const uploaded = await h.upload();
  assert.deepEqual([uploaded.status, uploaded.payload.error.code], [409, 'KB_AGENT_NOT_READY']);
  assert.equal(h.calls.length, 0);
  assert.deepEqual((await h.ask('GET', '/uploads')).payload.data.items, [], '没启用时上传不留记录');
  assert.deepEqual((await readdir(h.dir)).filter(name => name.endsWith('.docx')), [], '也不存原文件');

  const rejected = await harness({ answer: () => { throw new ModelError('AI_AUTH_INVALID', 'AI 服务拒绝了请求。', { status: 401, code: 'api_key_invalid' }); } });
  t.after(rejected.done);
  assert.deepEqual((await rejected.ask('GET', '/mode')).payload.data, { mode: 's3vectors', ready: true });
  const refused = await rejected.ask('GET', '/sources');
  assert.deepEqual([refused.status, refused.payload.error.code, refused.payload.error.message], [409, 'KB_AGENT_KEY_REJECTED', 'Nexus 不认这把调用密钥，请在『Agent 接入』页换钥匙']);
  assert.deepEqual(rejected.invalid, [[PUB, 'AI_AUTH_INVALID']]);
  assert.equal(rejected.calls.length, 1);
  assert.equal((await rejected.ask('GET', '/sources')).payload.error.code, 'KB_AGENT_NOT_READY', '标记失效后不反复重试');
  assert.equal(rejected.calls.length, 1);
  assert.deepEqual((await rejected.ask('GET', '/mode')).payload.data.ready, false);

  // 入库时被拒：历史标 failed（KB_AGENT_KEY_REJECTED）；credential_invalid 也算钥匙被拒
  const ingest = await harness({ answer: () => { throw new ModelError('AI_REQUEST_INVALID', 'AI 服务拒绝了请求。', { status: 403, code: 'credential_invalid' }); } });
  t.after(ingest.done);
  await ingest.upload();
  assert.deepEqual((await ingest.settled(1)).error, { code: 'KB_AGENT_KEY_REJECTED', message: 'Nexus 不认这把调用密钥，请在『Agent 接入』页换钥匙' });
  assert.deepEqual(ingest.invalid, [[PUB, 'AI_AUTH_INVALID']]);

  // 404、超时等只算这次没成，不标记钥匙失效
  const down = await harness({ answer: () => { throw new ModelError('AI_UNAVAILABLE', 'Nexus 在限定时间内没有答完。', { reason: 'timeout', timeoutMs: 120_000 }); } });
  t.after(down.done);
  const unavailable = await down.ask('GET', '/sources');
  assert.deepEqual([unavailable.status, unavailable.payload.error.code], [503, 'KB_UNAVAILABLE']);
  assert.deepEqual(down.invalid, []);
});

test('conflict_recorded：回复 success:false 带 conflicts 时历史标 failed，带上冲突编号（KB_RULE_CONFLICT，沿用现有文案）；别的工具失败记工具的说明', async t => {
  const h = await harness({ answer: () => reply({ success: false, error_type: 'rule_conflict', message: '1 条规则编号已属于别的制度（other-doc），整份没有写入',
    suggestion: '确认是不是同一份制度', source_id: 'sample-matrix', conflicts: ['C01-1.1'], report: REPORT }) });
  t.after(h.done);
  await h.upload();
  const entry = await h.settled(1);
  assert.equal(entry.status, 'failed');
  assert.deepEqual(entry.conflicts, ['C01-1.1']);
  assert.deepEqual([entry.error.code, entry.error.message], ['KB_RULE_CONFLICT', '有规则编号已属于库里另一份文档，入库会覆盖那份文档的规则，所以不能入库。']);
  const parse = await harness({ answer: () => reply({ success: false, error_type: 'not_a_matrix', message: '文件「仿真办法.docx」没有找到审批矩阵表格：文档结构与解析器不匹配，没有写入', suggestion: '审批矩阵每章一张表', report: REPORT }) });
  t.after(parse.done);
  await parse.upload();
  const failed = await parse.settled(1);
  assert.deepEqual([failed.status, failed.error.code, failed.error.type, failed.conflicts], ['failed', 'KB_INGEST_FAILED', 'not_a_matrix', []]);
  assert.match(failed.error.message, /文档结构与解析器不匹配/);
});

test('admin_only：分析员访问任何一个接口都是 403，不发调用；别的路径交还九安', async t => {
  const h = await harness();
  t.after(h.done);
  for (const [method, route] of [['GET', '/mode'], ['GET', '/uploads'], ['GET', '/uploads/1'], ['GET', '/sources'], ['GET', '/sources/sample-matrix'],
    ['POST', '/sources/sample-matrix/deactivate'], ['POST', '/sources/sample-matrix/restore'], ['POST', '/sources/sample-matrix/delete'], ['GET', '/search?q=x']]) {
    const answer = await h.ask(method, route, { role: 'analyst' });
    assert.deepEqual([answer.status, answer.payload.error.code], [403, 'KB_FORBIDDEN'], `${method} ${route}`);
    assert.equal((await h.ask(method, route, { role: null })).status, 403);
  }
  assert.equal((await h.upload({ role: 'analyst' })).status, 403);
  assert.equal(h.calls.length, 0);
  assert.equal(await h.routes.handle({ req: { method: 'GET', headers: {} }, path: '/api/analysis/v1/poc/intake/templates', session: { user: { role: 'admin' } }, res: {} }), false);
});

test('清单、详情、下线、恢复、删除、检索：各一次 request（2 分钟时限），原样返回工具结果；检索参数不合规 400，空的板块和金额不传', async t => {
  const results = {
    list: { success: true, sources: [{ source_id: 'sample-matrix', title: '仿真办法', source_version: 'V4.0', rules_total: 18, status: 'active' }] },
    detail: { success: true, source: { source_id: 'sample-matrix', title: '仿真办法', rules_total: 18 }, rule_ids: ['C01-1.1', 'G-01'] },
    deactivate: { success: true, source_id: 'sample-matrix', affected: 18 },
    restore: { success: true, source_id: 'sample-matrix', affected: 18 },
    delete: { success: true, source_id: 'sample-matrix', affected: 18 },
    search: { success: true, filter: { active: { $eq: true } }, results: [{ rule_id: 'C05-5.2', source_id: 'sample-matrix', text: '…', distance: 0.21 }] },
  };
  const h = await harness({ answer: args => reply(results[args.data[0].op]) });
  t.after(h.done);
  assert.deepEqual((await h.ask('GET', '/sources')).payload.data, results.list);
  assert.deepEqual((await h.ask('GET', '/sources/sample-matrix')).payload.data, results.detail);
  for (const op of ['deactivate', 'restore', 'delete']) {
    const answer = await h.ask('POST', `/sources/sample-matrix/${op}`);
    assert.deepEqual([answer.status, answer.payload.data], [200, results[op]], op);
  }
  // 别处入库的制度标识（大写、点、下划线）也能管理
  await h.ask('POST', '/sources/Fin_approval.v2/deactivate');
  const search = await h.ask('GET', `/search?q=${encodeURIComponent('供应商 货款 单笔 2 万')}&segment=${encodeURIComponent('九安')}&amount=200000&k=5`);
  assert.deepEqual(search.payload.data, results.search);
  await h.ask('GET', `/search?q=${encodeURIComponent('立项')}&segment=&amount=`);
  assert.deepEqual(h.requests, [['list', {}], ['detail', { source_id: 'sample-matrix' }], ['deactivate', { source_id: 'sample-matrix' }], ['restore', { source_id: 'sample-matrix' }],
    ['delete', { source_id: 'sample-matrix' }], ['deactivate', { source_id: 'Fin_approval.v2' }],
    ['search', { question: '供应商 货款 单笔 2 万', segment: '九安', amount: 200000, top_k: 5 }], ['search', { question: '立项', top_k: 8 }]]);
  assert.ok(h.calls.every(sent => sent.timeoutMs === 120_000 && sent.files.length === 0));
  assert.deepEqual(h.calls.map(sent => sent.text.split('：')[0]), ['list', 'detail', 'deactivate', 'restore', 'delete', 'deactivate', 'search', 'search'].map(op => `kb.rules/v1 · ${op}`));
  assert.deepEqual(h.calls[0].data, [{ op: 'list' }]);
  const before = h.calls.length;
  for (const query of ['q=', `q=${'字'.repeat(2001)}`, 'q=x&k=0', 'q=x&k=21', 'q=x&amount=abc', 'q=x&amount=-5', `q=x&segment=${'板'.repeat(41)}`]) {
    const answer = await h.ask('GET', `/search?${query}`);
    assert.deepEqual([answer.status, answer.payload.error.code], [400, 'KB_QUESTION_INVALID'], query);
  }
  assert.equal((await h.ask('GET', '/sources/bad%20id')).status, 400);
  assert.equal((await h.ask('GET', '/uploads/99')).status, 404);
  assert.equal(h.calls.length, before);
});

test('上传校验：制度标识、版本、文档名不合规 400；不是 .docx、zip 不对 400；超过 20 MB 413；都不发调用、不留记录', async t => {
  const h = await harness();
  t.after(h.done);
  for (const query of ['', 'sourceId=Bad Tag!', 'sourceId=a', `sourceId=ok-tag&sourceVersion=${'v'.repeat(65)}`, `sourceId=ok-tag&title=${'题'.repeat(201)}`]) {
    const answer = await h.upload({ query });
    assert.deepEqual([answer.status, answer.payload.error.code], [400, 'KB_REQUEST_INVALID'], query);
  }
  assert.equal((await h.upload({ name: '仿真办法.pdf' })).payload.error.code, 'KB_UPLOAD_INVALID');
  assert.equal((await h.upload({ type: 'application/pdf' })).payload.error.code, 'KB_UPLOAD_INVALID');
  assert.equal((await h.upload({ bytes: Buffer.from('not a zip at all, just text') })).payload.error.code, 'KB_UPLOAD_INVALID');
  const large = await h.upload({ bytes: Buffer.alloc(20 * 1024 * 1024 + 1, 0x50) });
  assert.deepEqual([large.status, large.payload.error.code], [413, 'KB_UPLOAD_TOO_LARGE']);
  assert.equal(h.calls.length, 0);
  assert.deepEqual((await h.ask('GET', '/uploads')).payload.data.items, []);
  // 校验失败不占着「入库中」：接着就能正常上传
  assert.equal((await h.upload()).status, 202);
  assert.equal((await h.settled(1)).status, 'ingested');
});

test('启动时把中断的入库（外壳重启时还是 ingesting）改成失败', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = await harness({ answer: async () => { await gate; return reply(INGESTED); } });
  t.after(async () => { release(); await h.settled(1); await h.done(); });
  await h.upload();
  assert.equal((await h.item(1)).status, 'ingesting');
  const restarted = await harness({ uploadsDir: h.dir });
  await restarted.routes.start();
  const entry = await restarted.item(1);
  assert.deepEqual([entry.status, entry.error.code], ['failed', 'KB_INGEST_INTERRUPTED']);
  assert.ok(restarted.logs.includes('POC_KB_S3V_RECOVERED 1'));
});

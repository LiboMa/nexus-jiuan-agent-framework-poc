import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { access, chmod, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModelError } from '../../lib/a2a-client.mjs';
import { createKbStewardClient } from '../../kb-steward-client.mjs';
import { createKbStewardRoutes } from '../../kb-steward-routes.mjs';

// 「公司制度」接口（两种知识库方式共用）：经 A2A 调知识库 Agent（kb.rules/v1）——pg 方式是 PG 知识库 Agent，s3vectors 方式是知识库文档管家。
// call、credentialFor、markInvalid 都是假的，不出网、不碰真钥匙。
const BASE = '/api/analysis/v1/poc/kb';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const FIXTURE = await readFile(fileURLToPath(new URL('../../../../kb/tests/fixtures/sample-matrix.docx', import.meta.url)));
const SHA = createHash('sha256').update(FIXTURE).digest('hex');
const PUB = 'pub_0123456789abcdef';
const KEY = `nxa_${'f'.repeat(43)}`;
const ORIGIN = 'https://nexus.example';
const MINUTE = 60_000;
const REPORT = { general: 3, chapter_notes: 3, matrix: 12, total: 18, chapters: [{ no: 1, title: '一、立项审批', rows: 4 }], duplicates: [], without_path: [] };
const INGESTED = { success: true, status: 'ingested', source_id: 'sample-matrix', source_version: 'V4.0', rules_total: 18, written: 18, removed: 0, unchanged: 0, conflicts: [], report: REPORT };
const ALL_OPS = ['describe', 'ingest', 'list', 'detail', 'deactivate', 'restore', 'delete', 'check', 'search'];
const PG_OPS = ['describe', 'ingest', 'list', 'detail', 'delete', 'check', 'search'];
const DESCRIBED = { success: true, protocol: 'kb.rules/v1', backend: 's3vectors', ops: ALL_OPS };
const reply = value => (typeof value === 'string' ? value : JSON.stringify(value));
const rejectKey = () => { throw new ModelError('AI_AUTH_INVALID', 'AI 服务拒绝了请求。', { status: 401, code: 'api_key_invalid' }); };
const timeout = () => { throw new ModelError('AI_UNAVAILABLE', 'Nexus 在限定时间内没有答完。', { reason: 'timeout', timeoutMs: 120_000 }); };

/** 后台入库有文件读写：按条件等，不数事件循环的轮数。 */
async function until(check, ms = 3000) {
  for (const started = Date.now(); !(await check()); ) {
    if (Date.now() - started > ms) throw new Error('等太久了');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

/**
 * answer(args) 给出知识库 Agent 这一轮回的文字（或抛错），describe(args) 是 describe 那一轮的；key 是「Agent 接入」页里这个发布的钥匙（null = 没启用）；
 * publishId 是部署配置里的发布编号（null = 没配）。state.clock 是客户端的时钟（describe 的缓存按它算），later(ms) 往后拨。
 */
async function harness({ mode = 's3vectors', answer = () => reply(INGESTED), describe = () => reply(DESCRIBED), key = KEY, publishId = PUB, uploadsDir } = {}) {
  const dir = uploadsDir ?? await mkdtemp(path.join(tmpdir(), 'kb-steward-'));
  const calls = [], invalid = [], requests = [], lookups = [];
  const state = { key, clock: Date.parse('2026-10-29T08:00:00.000Z') };
  const logs = [];
  const call = async args => {
    calls.push(args);
    const text = args.data[0].op === 'describe' ? await describe(args) : await answer(args, calls.length);
    return { text, taskId: 't', timings: {} };
  };
  const client = createKbStewardClient({ origin: ORIGIN, publishId, mode, call, now: () => state.clock, log: line => logs.push(line),
    credentialFor: async id => { lookups.push(id); return id === PUB ? state.key : null; },
    markInvalid: async (id, reason) => { invalid.push([id, reason]); state.key = null; } });
  const spied = { ...client, request: (...args) => { requests.push(args); return client.request(...args); } };
  let clock = Date.parse('2026-10-29T08:00:00.000Z');
  const routes = createKbStewardRoutes({ mode, client: spied, uploadsDir: dir, log: line => logs.push(line), now: () => (clock += 1500) });
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
  const ops = () => calls.map(sent => sent.data[0].op);
  const later = ms => { state.clock += ms; };
  return { dir, calls, ops, invalid, requests, lookups, state, logs, client, routes, ask, upload, item, settled, later,
    done: () => rm(dir, { recursive: true, force: true }) };
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
  // 同一份文件再传、Agent 回 skipped：历史记 skipped；新的一条排在前面。PG 方式一样走这一套
  const again = await harness({ mode: 'pg', uploadsDir: h.dir, answer: () => reply({ ...INGESTED, status: 'skipped', written: 0, unchanged: 18 }) });
  await again.routes.start();
  assert.equal((await again.upload()).status, 202);
  assert.deepEqual([(await again.settled(2)).status, (await again.item(2)).unchanged], ['skipped', 18]);
  assert.deepEqual((await again.ask('GET', '/uploads')).payload.data.items.map(entry => [entry.id, entry.status]), [[2, 'skipped'], [1, 'ingested']], '历史存在 history.json，换一个实例也读得到');
  assert.deepEqual(again.ops(), ['ingest'], '上传不问 describe');
});

test('reply_invalid：回复不是 JSON、是另一种操作的形状 → 历史标 failed（KB_AGENT_REPLY_INVALID），call 只调一次；带 ```json 围栏的合格 JSON 照样成功', async t => {
  for (const bad of ['好的，已入库', reply({ sources: [] }), reply({ success: true, sources: [] }), `${reply(INGESTED)}\n已入库。`]) {
    const h = await harness({ answer: () => bad });
    t.after(h.done);
    assert.equal((await h.upload()).status, 202);
    const entry = await h.settled(1);
    assert.equal(entry.status, 'failed', bad);
    assert.deepEqual(entry.error, { code: 'KB_AGENT_REPLY_INVALID', message: '知识库文档管家的回复不合格，这次没有完成' });
    assert.equal(h.calls.length, 1, '写操作不重试');
    assert.ok(!h.logs.some(line => line.includes('已入库') || line.includes('sources')), '日志里不写回复的内容');
  }
  const fenced = await harness({ answer: () => `\`\`\`json\n${reply(INGESTED)}\n\`\`\`` });
  t.after(fenced.done);
  await fenced.upload();
  assert.deepEqual([(await fenced.settled(1)).status, (await fenced.item(1)).rulesTotal], ['ingested', 18]);
  // 调工具前先说一句（A2A 把各段文字拼在一起）：短引导语 + 完整 JSON 照样收下，记一行不带内容的警告；引导语太长、带 { }、JSON 后还有字的仍不合格
  for (const [answer, chars] of [[`首先确认附件路径。${reply(INGESTED)}`, 9], [`我先确认附件路径，再调用入库工具。\n\`\`\`json\n${reply(INGESTED)}\n\`\`\``, 17]]) {
    const led = await harness({ answer: () => answer });
    t.after(led.done);
    await led.upload();
    assert.deepEqual([(await led.settled(1)).status, (await led.item(1)).rulesTotal], ['ingested', 18]);
    assert.ok(led.logs.includes(`POC_KB_AGENT_REPLY_LEADIN ingest ${chars}`), led.logs.join('\n'));
    assert.ok(!led.logs.some(line => line.includes('附件路径')), '日志里不写引导语的内容');
  }
  for (const bad of [`${'说'.repeat(201)}${reply(INGESTED)}`, `参数 {source_id} 如下：${reply(INGESTED)}`, `先说一句。${reply(INGESTED)}\n已入库。`]) {
    const h = await harness({ answer: () => bad });
    t.after(h.done);
    await h.upload();
    assert.deepEqual([(await h.settled(1)).status, (await h.settled(1)).error.code], ['failed', 'KB_AGENT_REPLY_INVALID'], bad.slice(0, 20));
  }
  // 同步的操作：回复不合格 → 502，页面说「…的回复不合格」
  const sync = await harness({ answer: () => reply(INGESTED) });
  t.after(sync.done);
  const listed = await sync.ask('GET', '/sources');
  assert.deepEqual([listed.status, listed.payload.error.code, listed.payload.error.message], [502, 'KB_AGENT_REPLY_INVALID', '知识库文档管家的回复不合格，这次没有完成']);
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

test('not_enabled_and_rejected：没启用时 /mode 是 ready:false、ops 为空，操作回 409 KB_AGENT_NOT_READY 且不发调用；Nexus 回 401 时 markInvalid 一次、回 409 KB_AGENT_KEY_REJECTED，之后不再发', async t => {
  const h = await harness({ key: null });
  t.after(h.done);
  assert.deepEqual((await h.ask('GET', '/mode')).payload.data, { mode: 's3vectors', configured: true, ready: false, ops: [] });
  const listed = await h.ask('GET', '/sources');
  assert.deepEqual([listed.status, listed.payload.error.code, listed.payload.error.message], [409, 'KB_AGENT_NOT_READY', '先在『Agent 接入』页启用知识库文档管家']);
  assert.equal((await h.ask('POST', '/sources/sample-matrix/deactivate')).payload.error.code, 'KB_AGENT_NOT_READY', '查 ops 也要钥匙');
  const uploaded = await h.upload();
  assert.deepEqual([uploaded.status, uploaded.payload.error.code], [409, 'KB_AGENT_NOT_READY']);
  assert.equal(h.calls.length, 0);
  assert.deepEqual((await h.ask('GET', '/uploads')).payload.data.items, [], '没启用时上传不留记录');
  assert.deepEqual((await readdir(h.dir)).filter(name => name.endsWith('.docx')), [], '也不存原文件');

  const rejected = await harness({ answer: rejectKey });
  t.after(rejected.done);
  assert.deepEqual((await rejected.ask('GET', '/mode')).payload.data, { mode: 's3vectors', configured: true, ready: true, ops: ALL_OPS });
  const refused = await rejected.ask('GET', '/sources');
  assert.deepEqual([refused.status, refused.payload.error.code, refused.payload.error.message], [409, 'KB_AGENT_KEY_REJECTED', 'Nexus 不认这把调用密钥，请在『Agent 接入』页换钥匙']);
  assert.deepEqual(rejected.invalid, [[PUB, 'AI_AUTH_INVALID']]);
  assert.deepEqual(rejected.ops(), ['describe', 'list']);
  assert.equal((await rejected.ask('GET', '/sources')).payload.error.code, 'KB_AGENT_NOT_READY', '标记失效后不反复重试');
  assert.deepEqual((await rejected.ask('GET', '/mode')).payload.data, { mode: 's3vectors', configured: true, ready: false, ops: [] });
  assert.deepEqual(rejected.ops(), ['describe', 'list']);

  // describe 那一轮就被拒：/mode 回 409 KB_AGENT_KEY_REJECTED，标记一次；再问就是没启用
  const early = await harness({ mode: 'pg', describe: rejectKey });
  t.after(early.done);
  const first = await early.ask('GET', '/mode');
  assert.deepEqual([first.status, first.payload.error.code], [409, 'KB_AGENT_KEY_REJECTED']);
  assert.deepEqual(early.invalid, [[PUB, 'AI_AUTH_INVALID']]);
  assert.deepEqual((await early.ask('GET', '/mode')).payload.data, { mode: 'pg', configured: true, ready: false, ops: [] });
  assert.equal(early.calls.length, 1);

  // 入库时被拒：历史标 failed（KB_AGENT_KEY_REJECTED）；credential_invalid 也算钥匙被拒
  const ingest = await harness({ answer: () => { throw new ModelError('AI_REQUEST_INVALID', 'AI 服务拒绝了请求。', { status: 403, code: 'credential_invalid' }); } });
  t.after(ingest.done);
  await ingest.upload();
  assert.deepEqual((await ingest.settled(1)).error, { code: 'KB_AGENT_KEY_REJECTED', message: 'Nexus 不认这把调用密钥，请在『Agent 接入』页换钥匙' });
  assert.deepEqual(ingest.invalid, [[PUB, 'AI_AUTH_INVALID']]);

  // 404、超时等只算这次没成，不标记钥匙失效
  const down = await harness({ answer: timeout });
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

test('admin_only：分析员访问任何一个接口都是 403，不发调用；别的路径交还九安；PG 直连时代的旧路由（/documents、/search-log）不再有', async t => {
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
  for (const [method, route] of [['POST', '/documents'], ['GET', '/documents'], ['GET', '/documents/1'], ['POST', '/documents/1/ingest'], ['GET', '/search-log']]) {
    assert.equal((await h.ask(method, route)).handled, false, `${method} ${route}`);
  }
  assert.equal(h.calls.length, 0);
});

test('清单、详情、下线、恢复、删除、检索：各一次 request（2 分钟时限），原样返回工具结果；下线前查一次 describe；检索参数不合规 400，空的板块和金额不传', async t => {
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
  assert.deepEqual(h.ops(), ['list', 'detail', 'describe', 'deactivate', 'restore', 'delete', 'deactivate', 'search', 'search'], 'describe 只问一次（缓存）');
  assert.ok(h.calls.every(sent => sent.timeoutMs === 120_000 && sent.files.length === 0 && sent.url === `${ORIGIN}/a2a/${PUB}`));
  assert.deepEqual(h.calls.map(sent => sent.text), h.ops().map(op => `kb.rules/v1 · ${op}：只调用对应的工具一次，原样返回工具的 JSON。`));
  assert.deepEqual(h.calls[0].data, [{ op: 'list' }]);
  assert.deepEqual(h.calls[2].data, [{ op: 'describe' }]);
  const before = h.calls.length;
  for (const query of ['q=', `q=${'字'.repeat(2001)}`, 'q=x&k=0', 'q=x&k=21', 'q=x&amount=abc', 'q=x&amount=-5', `q=x&segment=${'板'.repeat(41)}`]) {
    const answer = await h.ask('GET', `/search?${query}`);
    assert.deepEqual([answer.status, answer.payload.error.code], [400, 'KB_QUESTION_INVALID'], query);
  }
  assert.equal((await h.ask('GET', '/sources/bad%20id')).status, 400);
  assert.equal((await h.ask('POST', '/sources/bad%20id/restore')).status, 400);
  assert.equal((await h.ask('GET', '/uploads/99')).status, 404);
  assert.equal(h.calls.length, before);
});

test('delete_marks_history：经知识库页删除成功（Agent 回 success:true）后，这个制度标识的每一条上传历史记 removedAt（写进 history.json）；Agent 回失败不记；之后再传的一条不带；写不进去照样回 200、记一行日志', async t => {
  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  let removal = () => ({ success: false, error_type: 'source_not_found', message: '规则库里没有制度「sample-matrix」' });
  const h = await harness({ answer: args => { const { op, source_id } = args.data[0]; return reply(op === 'ingest' ? { ...INGESTED, source_id } : removal(source_id)); } });
  t.after(async () => { await chmod(h.dir, 0o700); await h.done(); });
  for (const [id, query] of [[1], [2], [3, 'sourceId=other-rules&sourceVersion=V1&title=x']]) { await h.upload(query ? { query } : {}); await h.settled(id); }
  const refused = await h.ask('POST', '/sources/sample-matrix/delete');
  assert.deepEqual([refused.status, refused.payload.data.success], [200, false]);
  assert.ok((await h.routes.historyList()).every(item => !Object.hasOwn(item, 'removedAt')), 'Agent 没删成：不记');
  removal = id => ({ success: true, source_id: id, affected: 18 });
  const removed = await h.ask('POST', '/sources/sample-matrix/delete');
  assert.deepEqual([removed.status, removed.payload.data], [200, { success: true, source_id: 'sample-matrix', affected: 18 }], '回复照旧原样给页面');
  const list = await h.routes.historyList();
  assert.deepEqual(list.map(item => [item.id, item.sourceId, item.status]), [[3, 'other-rules', 'ingested'], [2, 'sample-matrix', 'ingested'], [1, 'sample-matrix', 'ingested']], '全部历史，新的在前');
  assert.equal(list[0].removedAt, undefined, '别的制度不动');
  assert.match(list[1].removedAt, ISO);
  assert.equal(list[2].removedAt, list[1].removedAt);
  const saved = JSON.parse(await readFile(path.join(h.dir, 'history.json'), 'utf8'));
  assert.deepEqual(saved.items.map(item => item.removedAt ?? null), [list[2].removedAt, list[1].removedAt, null], '写进 history.json');
  assert.equal((await h.ask('GET', '/uploads')).payload.data.items[1].removedAt, list[1].removedAt, '上传历史页也看得到');
  // 同一个制度再传一次：新的一条不带 removedAt，旧的照旧
  await h.upload();
  await h.settled(4);
  const after = await h.routes.historyList();
  assert.deepEqual(after.map(item => item.removedAt ?? null), [null, null, list[1].removedAt, list[1].removedAt]);
  assert.deepEqual(h.requests.map(([op, input]) => [op, input.source_id]), [['ingest', 'sample-matrix'], ['ingest', 'sample-matrix'], ['ingest', 'other-rules'],
    ['delete', 'sample-matrix'], ['delete', 'sample-matrix'], ['ingest', 'sample-matrix']]);
  // 历史写不进去（目录只读）：删除照样回 200，内存里记上，日志一行。root 不受目录权限限制，写得进去，这一段跳过
  if (process.getuid?.() === 0) return;
  await chmod(h.dir, 0o500);
  const unwritable = await h.ask('POST', '/sources/other-rules/delete');
  assert.equal(unwritable.status, 200);
  assert.match((await h.routes.historyList())[1].removedAt, ISO);
  assert.ok(h.logs.includes('POC_KB_HISTORY_WRITE_FAILED delete'), h.logs.join('\n'));
});

test('delete_during_ingest：同一个制度还在入库时删除——已入完的那几条记 removedAt，正在入库的那条不记（没有 finishedAt）；它入完之后不带 removedAt', async t => {
  let release, ingests = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const h = await harness({ answer: async args => {
    const { op, source_id } = args.data[0];
    if (op === 'delete') return reply({ success: true, source_id, affected: 18 });
    ingests += 1;
    if (ingests === 2) await gate;
    return reply({ ...INGESTED, source_id });
  } });
  t.after(async () => { release(); await h.settled(2).catch(() => {}); await h.done(); });
  await h.upload();
  await h.settled(1);
  await h.upload();
  assert.equal((await h.item(2)).status, 'ingesting');
  assert.equal((await h.ask('POST', '/sources/sample-matrix/delete')).status, 200);
  assert.deepEqual((await h.routes.historyList()).map(item => [item.id, item.status, typeof item.removedAt]), [[2, 'ingesting', 'undefined'], [1, 'ingested', 'string']]);
  release();
  const finished = await h.settled(2);
  assert.deepEqual([finished.status, finished.removedAt], ['ingested', undefined]);
  const saved = JSON.parse(await readFile(path.join(h.dir, 'history.json'), 'utf8'));
  assert.deepEqual(saved.items.map(item => [item.id, item.status, item.removedAt ?? null]), [[1, 'ingested', saved.items[0].removedAt], [2, 'ingested', null]]);
  assert.ok(saved.items[0].removedAt);
});

test('status / historyList：给工作台用——方式、有没有发布编号、「Agent 接入」页有没有钥匙；不调 Agent（describe、request 都不发）', async t => {
  const h = await harness();
  t.after(h.done);
  assert.deepEqual(await h.routes.status(), { mode: 's3vectors', configured: true, ready: true });
  h.state.key = null;
  assert.deepEqual(await h.routes.status(), { mode: 's3vectors', configured: true, ready: false });
  assert.deepEqual(await h.routes.historyList(), []);
  assert.deepEqual([h.calls.length, h.requests.length], [0, 0]);
  const off = await harness({ mode: 'pg', publishId: null });
  t.after(off.done);
  assert.deepEqual(await off.routes.status(), { mode: 'pg', configured: false, ready: false });
  assert.deepEqual([off.calls.length, off.lookups.length], [0, 0], '没配置：不取钥匙');
});

/** 把 zip 中央目录里第一个条目的「解压后大小」改成 4 GB：模拟 zip 炸弹（不真的造一个）。 */
function inflateClaim(buffer) {
  const copy = Buffer.from(buffer);
  const eocd = copy.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  copy.writeUInt32LE(0xfffffff0, copy.readUInt32LE(eocd + 16) + 24);
  return copy;
}

test('上传校验：制度标识、版本、文档名不合规 400；不是 .docx、zip 不对、zip 炸弹 400；超过 20 MB 413；都不发调用、不留记录', async t => {
  const h = await harness();
  t.after(h.done);
  for (const query of ['', 'sourceId=Bad Tag!', 'sourceId=a', `sourceId=ok-tag&sourceVersion=${'v'.repeat(65)}`, `sourceId=ok-tag&title=${'题'.repeat(201)}`]) {
    const answer = await h.upload({ query });
    assert.deepEqual([answer.status, answer.payload.error.code], [400, 'KB_REQUEST_INVALID'], query);
  }
  assert.equal((await h.upload({ name: '仿真办法.pdf' })).payload.error.code, 'KB_UPLOAD_INVALID');
  assert.equal((await h.upload({ type: 'application/pdf' })).payload.error.code, 'KB_UPLOAD_INVALID');
  assert.equal((await h.upload({ bytes: Buffer.from('not a zip at all, just text') })).payload.error.code, 'KB_UPLOAD_INVALID');
  const bomb = await h.upload({ bytes: inflateClaim(FIXTURE) });
  assert.deepEqual([bomb.status, bomb.payload.error.code, bomb.payload.error.message],
    [400, 'KB_UPLOAD_INVALID', '只收审批矩阵格式的 Word 文档（.docx）：这个文件不是有效的 .docx，或者解压后太大、条目太多。']);
  const large = await h.upload({ bytes: Buffer.alloc(20 * 1024 * 1024 + 1, 0x50) });
  assert.deepEqual([large.status, large.payload.error.code, large.payload.error.message], [413, 'KB_UPLOAD_TOO_LARGE', '文件超过 20 MB。']);
  assert.equal(h.calls.length, 0);
  assert.deepEqual((await h.ask('GET', '/uploads')).payload.data.items, []);
  assert.deepEqual((await readdir(h.dir)).filter(name => name.endsWith('.docx')), []);
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
  assert.ok(restarted.logs.includes('POC_KB_RECOVERED 1'));
});

test('describe_gates_ops：describe 的 ops 里没有 deactivate / restore 时，那两条路由回 409 KB_OP_UNSUPPORTED、不发那次调用；/mode 的 ops 照 describe（不认识的不给页面）；删除照常', async t => {
  const pgDescribed = { success: true, protocol: 'kb.rules/v1', backend: 'pg', ops: [...PG_OPS, 'reindex'] };
  const h = await harness({ mode: 'pg', describe: () => reply(pgDescribed), answer: () => reply({ success: true, source_id: 'sample-matrix', affected: 18 }) });
  t.after(h.done);
  // 没先问 /mode 也照样拦：先 describe 一次，再回 409
  for (const op of ['deactivate', 'restore']) {
    const answer = await h.ask('POST', `/sources/sample-matrix/${op}`);
    assert.deepEqual([answer.status, answer.payload.error.code, answer.payload.error.message], [409, 'KB_OP_UNSUPPORTED', '这个知识库 Agent 不支持这个操作'], op);
  }
  assert.deepEqual(h.ops(), ['describe'], '那两次调用没发出');
  assert.deepEqual(h.requests, []);
  const mode = await h.ask('GET', '/mode');
  assert.deepEqual([mode.status, mode.payload.data], [200, { mode: 'pg', configured: true, ready: true, ops: PG_OPS }]);
  const removed = await h.ask('POST', '/sources/sample-matrix/delete');
  assert.deepEqual([removed.status, removed.payload.data.affected], [200, 18]);
  assert.deepEqual(h.ops(), ['describe', 'delete']);
  assert.deepEqual(h.calls[0].url, `${ORIGIN}/a2a/${PUB}`);
});

test('describe_cached：describe 的结果缓存 5 分钟（同时来的几次也只问一次）；钥匙被拒、回复不合格后清缓存，下次重新问；没问成的不缓存', async t => {
  const replies = {
    describe: () => reply(DESCRIBED),
    list: () => reply({ success: true, sources: [] }),
    deactivate: () => reply({ success: true, source_id: 'sample-matrix', affected: 18 }),
  };
  const h = await harness({ describe: () => replies.describe(), answer: args => replies[args.data[0].op]() });
  t.after(h.done);
  const describes = () => h.ops().filter(op => op === 'describe').length;
  const both = await Promise.all([h.ask('GET', '/mode'), h.ask('GET', '/mode')]);
  assert.deepEqual(both.map(answer => [answer.status, answer.payload.data.ops]), [[200, ALL_OPS], [200, ALL_OPS]]);
  assert.equal(describes(), 1, '同时来的两次只问一次');
  h.later(5 * MINUTE - 1);
  await h.ask('GET', '/mode');
  assert.equal((await h.ask('POST', '/sources/sample-matrix/deactivate')).status, 200);
  assert.equal(describes(), 1, '5 分钟内用缓存（下线前查 ops 也用它）');
  h.later(1);
  await h.ask('GET', '/mode');
  assert.equal(describes(), 2, '满 5 分钟重新问');

  // 钥匙被拒（哪一种调用都算）：清缓存；人在「Agent 接入」页换了钥匙之后，不到 5 分钟也重新问
  replies.list = rejectKey;
  assert.equal((await h.ask('GET', '/sources')).payload.error.code, 'KB_AGENT_KEY_REJECTED');
  assert.deepEqual(h.invalid, [[PUB, 'AI_AUTH_INVALID']]);
  h.state.key = `nxa_${'e'.repeat(43)}`;
  assert.equal((await h.ask('GET', '/mode')).status, 200);
  assert.equal(describes(), 3, '钥匙被拒后重新问');

  // 别的操作回复不合格：也清缓存
  replies.list = () => reply({ success: true, rule_ids: [] });
  assert.equal((await h.ask('GET', '/sources')).status, 502);
  await h.ask('GET', '/mode');
  assert.equal(describes(), 4, '回复不合格后重新问');

  // describe 自己不合格（protocol 不是 kb.rules/v1、工具失败、ops 不对、不是 JSON）或连不上：/mode 回错误，不缓存，下次接着问
  h.later(5 * MINUTE);
  for (const [bad, status, code] of [
    [() => reply({ ...DESCRIBED, protocol: 'kb.rules/v2' }), 502, 'KB_AGENT_REPLY_INVALID'],
    [() => reply({ success: true, backend: 'pg', ops: ALL_OPS }), 502, 'KB_AGENT_REPLY_INVALID'],
    [() => reply({ success: false, error_type: 'internal_error', message: '规则库暂时读不了' }), 502, 'KB_AGENT_REPLY_INVALID'],
    [() => reply({ ...DESCRIBED, ops: 'list' }), 502, 'KB_AGENT_REPLY_INVALID'],
    [() => reply({ ...DESCRIBED, ops: [1] }), 502, 'KB_AGENT_REPLY_INVALID'],
    [() => reply({ ...DESCRIBED, backend: undefined }), 502, 'KB_AGENT_REPLY_INVALID'],
    [() => '好的，支持这些操作', 502, 'KB_AGENT_REPLY_INVALID'],
    [timeout, 503, 'KB_UNAVAILABLE'],
  ]) {
    replies.describe = bad;
    const before = describes();
    const answer = await h.ask('GET', '/mode');
    assert.deepEqual([answer.status, answer.payload.error.code], [status, code], String(bad));
    assert.equal(describes(), before + 1, '不缓存失败');
  }
  // describe 没问成时，下线也不发
  const blocked = await h.ask('POST', '/sources/sample-matrix/deactivate');
  assert.deepEqual([blocked.status, blocked.payload.error.code], [503, 'KB_UNAVAILABLE']);
  assert.equal(h.ops().filter(op => op === 'deactivate').length, 1);
  replies.describe = () => reply(DESCRIBED);
  assert.deepEqual((await h.ask('GET', '/mode')).payload.data, { mode: 's3vectors', configured: true, ready: true, ops: ALL_OPS });
  assert.equal(h.invalid.length, 1, '不合格、连不上都不标记钥匙失效');
});

test('not_configured：部署配置里没有发布编号（publishId=null）时 /mode 是 configured:false，别的接口 409 KB_AGENT_NOT_CONFIGURED；不发调用、不拿 null 取钥匙、不存文件', async t => {
  for (const mode of ['pg', 's3vectors']) {
    const h = await harness({ mode, publishId: null });
    t.after(h.done);
    const answer = await h.ask('GET', '/mode');
    assert.deepEqual([answer.status, answer.payload.data], [200, { mode, configured: false, ready: false, ops: [] }]);
    for (const [method, route] of [['GET', '/uploads'], ['GET', '/uploads/1'], ['GET', '/sources'], ['GET', '/sources/sample-matrix'],
      ['POST', '/sources/sample-matrix/deactivate'], ['POST', '/sources/sample-matrix/restore'], ['POST', '/sources/sample-matrix/delete'], ['GET', '/search?q=x']]) {
      const refused = await h.ask(method, route);
      assert.deepEqual([refused.status, refused.payload.error.code, refused.payload.error.message],
        [409, 'KB_AGENT_NOT_CONFIGURED', '知识库 Agent 还没配置：部署配置里缺发布编号'], `${mode} ${method} ${route}`);
    }
    const uploaded = await h.upload();
    assert.deepEqual([uploaded.status, uploaded.payload.error.code], [409, 'KB_AGENT_NOT_CONFIGURED']);
    assert.deepEqual((await readdir(h.dir)).filter(name => name.endsWith('.docx')), [], '不存原文件');
    assert.equal((await h.ask('GET', '/mode', { role: 'analyst' })).status, 403, '仍然只给管理员');
    assert.equal((await h.ask('GET', '/search-log')).handled, false, '不认识的路径照样交还九安');
    // 客户端本身：ready() 回 false，describe / request 抛 KB_AGENT_NOT_CONFIGURED（不会发到 /a2a/null）
    assert.equal(h.client.configured, false);
    assert.equal(await h.client.ready(), false);
    await assert.rejects(h.client.describe(), { code: 'KB_AGENT_NOT_CONFIGURED' });
    await assert.rejects(h.client.request('list', {}), { code: 'KB_AGENT_NOT_CONFIGURED' });
    assert.deepEqual([h.calls.length, h.lookups.length], [0, 0], '不发调用，也不拿 null 去取钥匙');
  }
  const configured = await harness();
  t.after(configured.done);
  assert.equal(configured.client.configured, true);
});

test('mode_names：错误文案里的 Agent 名字按方式——pg「知识库 Agent」、s3vectors「知识库文档管家」；没配置、不支持这两条两种方式一样', async t => {
  const TEXT = {
    pg: {
      KB_AGENT_NOT_READY: '先在『Agent 接入』页启用知识库 Agent',
      KB_AGENT_REPLY_INVALID: '知识库 Agent 的回复不合格，这次没有完成',
      KB_UNAVAILABLE: '知识库 Agent 暂时连不上，或没在限定时间内答完：稍后再试（入库的话先看一下制度清单，可能已经写完）。',
      KB_INGEST_INTERRUPTED: '外壳在入库途中重启了：知识库 Agent 那边可能已经写完，先看一下制度清单，没有就重新上传。',
    },
    s3vectors: {
      KB_AGENT_NOT_READY: '先在『Agent 接入』页启用知识库文档管家',
      KB_AGENT_REPLY_INVALID: '知识库文档管家的回复不合格，这次没有完成',
      KB_UNAVAILABLE: '知识库文档管家暂时连不上，或没在限定时间内答完：稍后再试（入库的话先看一下制度清单，可能已经写完）。',
      KB_INGEST_INTERRUPTED: '外壳在入库途中重启了：知识库文档管家那边可能已经写完，先看一下制度清单，没有就重新上传。',
    },
  };
  const said = async (h, method, route) => { const answer = await h.ask(method, route); return [answer.payload.error.code, answer.payload.error.message]; };
  for (const mode of ['pg', 's3vectors']) {
    const want = TEXT[mode];
    const off = await harness({ mode, key: null });
    t.after(off.done);
    assert.deepEqual((await off.ask('GET', '/mode')).payload.data.mode, mode);
    assert.deepEqual(await said(off, 'GET', '/sources'), ['KB_AGENT_NOT_READY', want.KB_AGENT_NOT_READY]);
    assert.deepEqual((await off.upload()).payload.error.message, want.KB_AGENT_NOT_READY);
    const bad = await harness({ mode, answer: () => '好的' });
    t.after(bad.done);
    assert.deepEqual(await said(bad, 'GET', '/sources'), ['KB_AGENT_REPLY_INVALID', want.KB_AGENT_REPLY_INVALID]);
    await bad.upload();
    assert.deepEqual((await bad.settled(1)).error, { code: 'KB_AGENT_REPLY_INVALID', message: want.KB_AGENT_REPLY_INVALID }, '上传历史里的也一样');
    const down = await harness({ mode, answer: timeout });
    t.after(down.done);
    assert.deepEqual(await said(down, 'GET', '/search?q=x'), ['KB_UNAVAILABLE', want.KB_UNAVAILABLE]);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const slow = await harness({ mode, answer: async () => { await gate; return reply(INGESTED); } });
    t.after(async () => { release(); await slow.settled(1); await slow.done(); });
    await slow.upload();
    const restarted = await harness({ mode, uploadsDir: slow.dir });
    await restarted.routes.start();
    assert.deepEqual((await restarted.item(1)).error, { code: 'KB_INGEST_INTERRUPTED', message: want.KB_INGEST_INTERRUPTED });
    // 两条新文案两种方式一样
    const narrow = await harness({ mode, describe: () => reply({ ...DESCRIBED, ops: ['describe', 'list'] }) });
    t.after(narrow.done);
    assert.deepEqual(await said(narrow, 'POST', '/sources/sample-matrix/restore'), ['KB_OP_UNSUPPORTED', '这个知识库 Agent 不支持这个操作']);
    const unset = await harness({ mode, publishId: null });
    t.after(unset.done);
    assert.deepEqual(await said(unset, 'GET', '/sources'), ['KB_AGENT_NOT_CONFIGURED', '知识库 Agent 还没配置：部署配置里缺发布编号']);
  }
  assert.ok(Object.values(TEXT.pg).every(text => !text.includes('文档管家')), 'PG 方式不提文档管家');
  assert.throws(() => createKbStewardRoutes({ mode: 'mongo', client: {}, uploadsDir: tmpdir() }), TypeError);
  assert.throws(() => createKbStewardClient({ origin: ORIGIN, publishId: PUB, mode: undefined, credentialFor: async () => KEY, markInvalid: async () => {} }), TypeError);
});

test('describe_fallback（R18）：Agent 不认识 describe（success:false、invalid_parameter）时用这种方式的缺省操作，和 describe 的结果一样缓存 5 分钟；PG 方式的缺省没有下线 / 恢复', async t => {
  const unknown = () => reply({ success: false, error_type: 'invalid_parameter', message: '不支持的规则请求：describe' });
  const affected = args => reply({ success: true, source_id: args.data[0].source_id, affected: 18 });
  for (const [mode, ops] of [['s3vectors', ALL_OPS], ['pg', PG_OPS]]) {
    const h = await harness({ mode, describe: unknown, answer: affected });
    t.after(h.done);
    const describes = () => h.ops().filter(op => op === 'describe').length;
    const first = await h.ask('GET', '/mode');
    assert.deepEqual([first.status, first.payload.data], [200, { mode, configured: true, ready: true, ops }], mode);
    h.later(5 * MINUTE - 1);
    assert.deepEqual((await h.ask('GET', '/mode')).payload.data.ops, ops);
    for (const op of ['deactivate', 'restore']) {
      const answer = await h.ask('POST', `/sources/sample-matrix/${op}`);
      if (mode === 'pg') assert.deepEqual([answer.status, answer.payload.error.code], [409, 'KB_OP_UNSUPPORTED'], `${mode} ${op}`);
      else assert.deepEqual([answer.status, answer.payload.data.affected], [200, 18], `${mode} ${op}`);
    }
    assert.deepEqual(h.ops(), mode === 'pg' ? ['describe'] : ['describe', 'deactivate', 'restore'], `${mode}：5 分钟内只问一次；PG 的缺省不发下线 / 恢复`);
    h.later(1);
    await h.ask('GET', '/mode');
    assert.equal(describes(), 2, `${mode}：满 5 分钟重新问`);
    assert.equal((await h.ask('POST', '/sources/sample-matrix/delete')).status, 200);
    assert.ok(!h.logs.some(line => line.startsWith('POC_KB_BACKEND_MISMATCH')), '缺省的 backend 就是这种方式');
  }
});

test('backend_mismatch：describe 回的 backend 和方式对不上时记一行 POC_KB_BACKEND_MISMATCH <方式> <backend>（缓存期间不重复记），行为不变；对得上不记', async t => {
  const h = await harness({ mode: 'pg', describe: () => reply({ ...DESCRIBED, backend: 's3vectors' }) });
  t.after(h.done);
  const answer = await h.ask('GET', '/mode');
  assert.deepEqual([answer.status, answer.payload.data], [200, { mode: 'pg', configured: true, ready: true, ops: ALL_OPS }]);
  await h.ask('GET', '/mode');
  assert.deepEqual(h.logs, ['POC_KB_BACKEND_MISMATCH pg s3vectors']);
  const odd = await harness({ describe: () => reply({ ...DESCRIBED, backend: 'pg vector\nPOC_FAKE ' + 'x'.repeat(60) }) });
  t.after(odd.done);
  assert.equal((await odd.ask('GET', '/mode')).status, 200);
  assert.equal(odd.logs.length, 1);
  assert.match(odd.logs[0], /^POC_KB_BACKEND_MISMATCH s3vectors pg\?vector\?POC_FAKE\?x+$/);
  assert.ok(odd.logs[0].length <= 'POC_KB_BACKEND_MISMATCH s3vectors '.length + 40, 'backend 只取 40 字、换掉别的字符');
  const same = await harness({ mode: 's3vectors' });
  t.after(same.done);
  await same.ask('GET', '/mode');
  assert.deepEqual(same.logs, []);
});

test('server_wiring：外壳两种方式都挂这一套接口（方式和发布编号取 settings.kb）；PG 直连的路由、子进程和它们的文件都没了', async () => {
  const here = fileURLToPath(new URL('../../', import.meta.url));
  const server = await readFile(path.join(here, 'server.mjs'), 'utf8');
  assert.match(server, /createKbStewardRoutes\(\{ mode: settings\.kb\.mode, client: createKbStewardClient\(\{ origin: config\.agents\.nexusOrigin, publishId: settings\.kb\.publishId,\n  mode: settings\.kb\.mode, log,/);
  assert.match(server, /\|\| \(await kb\.handle\(args\)\) \|\|/, '无条件挂上');
  for (const gone of ['kb-routes', 'kb-runner', 'kb-s3v', 'createKbS3v', "settings.kb.mode === 's3vectors'", 'POC_KB_PG_AGENT_NOT_WIRED', 'kb ? await kb.handle']) {
    assert.ok(!server.includes(gone), `server.mjs 里还有 ${gone}`);
  }
  for (const file of ['kb-routes.mjs', 'kb-runner.mjs', 'kb-s3v-client.mjs', 'kb-s3v-routes.mjs', 'test/unit/kb-routes.test.mjs']) {
    await assert.rejects(access(path.join(here, file)), { code: 'ENOENT' }, file);
  }
});

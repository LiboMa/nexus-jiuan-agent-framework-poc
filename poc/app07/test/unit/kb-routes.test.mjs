import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKbRoutes } from '../../kb-routes.mjs';
import { createKbRunner } from '../../kb-runner.mjs';
import { readSettings } from '../../settings.mjs';

// 「规则库 › 制度知识库」页的接口：上传 .docx → 校验 → 解析 → 入库预览 → 确认入库；历史、检索、检索日志。runner 是假的。
const BASE = '/api/analysis/v1/poc/kb';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const FIXTURE = await readFile(fileURLToPath(new URL('../../../../kb/tests/fixtures/sample-matrix.docx', import.meta.url)));
const REPORT = { general: 3, chapter_notes: 3, matrix: 12, total: 18, chapters: [{ no: 1, title: '一、立项审批', rows: 4 }], duplicates: [], without_path: [] };
const PREVIEW = { inserted: 0, updated: 0, retagged: 0, unchanged: 12, pruned: 0, pruned_ids: [] };
/** 后台入库有文件读写：按条件等，不数事件循环的轮数。 */
async function until(check, ms = 3000) {
  for (const started = Date.now(); !check(); ) {
    if (Date.now() - started > ms) throw new Error('等太久了');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function fakeRunner({ parse = async () => ({ code: 0, report: REPORT, message: '' }), ingest = async () => ({ inserted: 0, updated: 0, retagged: 0, unchanged: 12, pruned: 0 }),
  tags = [{ source_tag: 'sample-matrix', source_doc: '仿真办法.docx', source_version: '', rows: 12 }], preview = async () => PREVIEW } = {}) {
  const calls = [], previews = [];
  let nextId = 1;
  const rows = new Map();
  return { calls, rows, previews,
    parse: async (file, out) => { calls.push(['parse', path.basename(file)]); const result = await parse(file, out); if (!result.code) await import('node:fs/promises').then(fs => fs.writeFile(out, JSON.stringify([{ rule_id: 'C01-1.1', business_item: '新产品立项', segment: '甲板块', amount_tier: '总投资≤50 万' }]))); return result; },
    preview: async (rules, meta) => { calls.push(['preview', meta.sourceTag]); previews.push(meta); return preview(rules, meta); },
    ingest: async (rules, meta) => { calls.push(['ingest', meta.sourceTag, meta.sourceDoc]); return ingest(rules, meta); },
    admin: async args => {
      calls.push(['admin', ...args.filter(arg => !String(arg).startsWith('/'))]);
      const [command, ...rest] = args;
      if (command === 'record') { const id = nextId++; rows.set(id, { id, file_name: rest[rest.indexOf('--name') + 1], status: 'parsed' }); return { id }; }
      if (command === 'status') { const row = rows.get(Number(rest[0])); row.status = rest[rest.indexOf('--status') + 1]; if (rest.includes('--error')) row.error = rest[rest.indexOf('--error') + 1]; return { ok: true }; }
      if (command === 'show') return { item: rows.get(Number(rest[0])) ?? null };
      if (command === 'history') return { items: [...rows.values()].reverse() };
      if (command === 'tags') return { items: tags };
      if (command === 'recover') return { recovered: 0 };
      if (command === 'search') return { items: [{ rule_id: 'C05-5.2', score: 0.81 }] };
      if (command === 'search-log') return { items: [{ caller: 'agent', question: '…' }] };
      throw new Error(`unexpected ${command}`);
    } };
}

async function harness(options) {
  const uploadsDir = await mkdtemp(path.join(tmpdir(), 'kb-uploads-'));
  const runner = fakeRunner(options);
  const routes = createKbRoutes({ runner, uploadsDir, log: () => {} });
  const ask = async (method, route, { role = 'admin', body = null, headers = {}, json } = {}) => {
    const raw = json ? Buffer.from(JSON.stringify(json)) : body ?? Buffer.alloc(0);
    const req = Object.assign(Readable.from([raw]), { method, headers: { ...(json ? { 'content-type': 'application/json' } : {}), ...headers } });
    let status = null, payload = null;
    const res = { writeHead(code) { status = code; return this; }, setHeader() {}, end(text) { payload = text ? JSON.parse(text) : null; } };
    const handled = await routes.handle({ req, path: `${BASE}${route}`, session: { user: { id: 'poc-reviewer', role } }, res, body: undefined });
    return { handled, status, payload };
  };
  const upload = (bytes = FIXTURE, name = '仿真办法.docx', type = DOCX, role) => ask('POST', '/documents', { role, body: bytes, headers: { 'content-type': type, 'x-file-name': encodeURIComponent(name) } });
  return { uploadsDir, runner, routes, ask, upload, done: () => rm(uploadsDir, { recursive: true, force: true }) };
}

/** 把 zip 中央目录里第一个条目的「解压后大小」改成 4 GB：模拟 zip 炸弹（不真的造一个）。 */
function inflateClaim(buffer) {
  const copy = Buffer.from(buffer);
  const eocd = copy.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const start = copy.readUInt32LE(eocd + 16);
  copy.writeUInt32LE(0xfffffff0, start + 24);
  return copy;
}

test('上传：只有管理员；不是 .docx、文件头不对、zip 条目或解压后太大、超过 20 MB 都拒收，不起解析进程', async t => {
  const h = await harness();
  t.after(h.done);
  assert.equal((await h.upload(FIXTURE, '仿真办法.docx', DOCX, 'analyst')).status, 403);
  assert.equal((await h.upload(FIXTURE, '仿真办法.pdf')).status, 400);
  assert.equal((await h.upload(FIXTURE, '仿真办法.docx', 'application/pdf')).status, 400);
  assert.equal((await h.upload(Buffer.from('not a zip at all, just text'), '假的.docx')).status, 400);
  const bomb = await h.upload(inflateClaim(FIXTURE));
  assert.equal(bomb.status, 400);
  assert.equal(bomb.payload.error.code, 'KB_UPLOAD_INVALID');
  assert.equal((await h.upload(Buffer.alloc(20 * 1024 * 1024 + 1, 0x50))).status, 413);
  assert.deepEqual(h.runner.calls.filter(call => call[0] === 'parse'), []);
});

test('上传成功：原文件存成 <sha256>.docx（0600），解析报告和入库预览一起回来；标签默认取库里同一文档的标签', async t => {
  const h = await harness();
  t.after(h.done);
  const result = await h.upload();
  assert.equal(result.status, 201, JSON.stringify(result.payload));
  const data = result.payload.data;
  assert.deepEqual([data.id, data.fileName, data.suggestedTag, data.docTitle], [1, '仿真办法.docx', 'sample-matrix', '仿真办法']);
  assert.deepEqual(data.report, REPORT);
  assert.deepEqual(data.preview, PREVIEW);
  const sha = (await import('node:crypto')).createHash('sha256').update(FIXTURE).digest('hex');
  assert.equal((await stat(path.join(h.uploadsDir, `${sha}.docx`))).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(h.uploadsDir, '1.rules.json'))).mode & 0o777, 0o600, '解析结果出自制度原文，和原文件一样只给服务自己读');
  assert.deepEqual(h.runner.calls.find(call => call[0] === 'preview'), ['preview', 'sample-matrix']);
  const other = await harness({ tags: [] });
  t.after(other.done);
  assert.equal((await other.upload()).payload.data.suggestedTag, `doc-${sha.slice(0, 8)}`);
});

test('不是审批矩阵格式：422，历史里记成解析失败并写上解析器的说明', async t => {
  const h = await harness({ parse: async () => ({ code: 3, report: { matrix: 0 }, message: '解析结果为空或有重复 rule_id：文档结构与解析器不匹配' }) });
  t.after(h.done);
  const result = await h.upload();
  assert.equal(result.status, 422);
  assert.equal(result.payload.error.code, 'KB_PARSE_FAILED');
  assert.match(result.payload.error.message, /文档结构与解析器不匹配/);
  assert.deepEqual([h.runner.rows.get(1).status, h.runner.rows.get(1).error], ['failed', '解析结果为空或有重复 rule_id：文档结构与解析器不匹配']);
});

test('换标签重新预览；确认入库先回 202，跑完记成已入库；跑的时候再来一个回 409；入库出错记成失败', async t => {
  const h = await harness();
  t.after(h.done);
  await h.upload();
  const preview = await h.ask('POST', '/documents/1/preview', { json: { sourceTag: 'other-tag' } });
  assert.equal(preview.status, 200);
  assert.deepEqual(h.runner.calls.filter(call => call[0] === 'preview').at(-1), ['preview', 'other-tag']);
  assert.equal((await h.ask('POST', '/documents/1/ingest', { json: { sourceTag: 'Bad Tag!', docTitle: 'x', sourceVersion: '' } })).status, 400);
  // 入库只认最近一次预览过的标签和版本：没看过预览就入库，可能按新标签删掉另一份文档的规则
  const stale = await h.ask('POST', '/documents/1/ingest', { json: { sourceTag: 'sample-matrix', docTitle: '仿真办法', sourceVersion: 'V1' } });
  assert.deepEqual([stale.status, stale.payload.error.code], [409, 'KB_PREVIEW_STALE']);
  await h.ask('POST', '/documents/1/preview', { json: { sourceTag: 'sample-matrix', sourceVersion: 'V1' } });
  assert.deepEqual([h.runner.previews.at(-1).sourceTag, h.runner.previews.at(-1).sourceVersion], ['sample-matrix', 'V1'], '预览用页面上填的版本');
  const started = await h.ask('POST', '/documents/1/ingest', { json: { sourceTag: 'sample-matrix', docTitle: '仿真办法', sourceVersion: 'V1' } });
  assert.equal(started.status, 202);
  assert.equal((await h.ask('POST', '/documents/1/ingest', { json: { sourceTag: 'sample-matrix', docTitle: '仿真办法', sourceVersion: 'V1' } })).status, 409);
  await until(() => h.runner.rows.get(1).status === 'ingested');
  assert.deepEqual(h.runner.calls.find(call => call[0] === 'ingest'), ['ingest', 'sample-matrix', '仿真办法.docx']);
  const failing = await harness({ ingest: async () => { throw new Error('Bedrock 拒绝'); } });
  t.after(failing.done);
  await failing.upload();
  await failing.ask('POST', '/documents/1/ingest', { json: { sourceTag: 'sample-matrix', docTitle: '仿真办法', sourceVersion: '' } });
  await until(() => failing.runner.rows.get(1).status === 'failed');
  assert.deepEqual([failing.runner.rows.get(1).status, failing.runner.rows.get(1).error], ['failed', 'Bedrock 拒绝']);
});

test('预览里规则编号和另一份文档冲突就不能入库（409）；同一份文件再传：标签和版本说明都取库里现有的，预览才会是「不变」', async t => {
  const h = await harness({ preview: async (rules, meta) => (meta.sourceTag === 'other-doc' ? { ...PREVIEW, conflicts: 3, conflict_ids: ['C01-1.1'] } : PREVIEW),
    tags: [{ source_tag: 'sample-matrix', source_doc: '仿真办法.docx', source_version: 'V4.0 正式签批版', rows: 12 }] });
  t.after(h.done);
  const data = (await h.upload()).payload.data;
  assert.deepEqual([data.suggestedTag, data.sourceVersion], ['sample-matrix', 'V4.0 正式签批版']);
  assert.equal(h.runner.previews[0].sourceVersion, 'V4.0 正式签批版');
  await h.ask('POST', '/documents/1/preview', { json: { sourceTag: 'other-doc', sourceVersion: '' } });
  const refused = await h.ask('POST', '/documents/1/ingest', { json: { sourceTag: 'other-doc', docTitle: '仿真办法', sourceVersion: '' } });
  assert.deepEqual([refused.status, refused.payload.error.code], [409, 'KB_RULE_CONFLICT']);
  assert.ok(!h.runner.calls.some(call => call[0] === 'ingest'));
});

test('历史、详情（带这一版的规则）、检索、检索日志；启动时把中断的入库改成失败；空问题 400；别的路径交还九安', async t => {
  const h = await harness();
  t.after(h.done);
  await h.routes.start();
  assert.ok(h.runner.calls.some(call => call[0] === 'admin' && call[1] === 'recover'));
  await h.upload();
  assert.equal((await h.ask('GET', '/documents')).payload.data.items.length, 1);
  const detail = (await h.ask('GET', '/documents/1')).payload.data;
  assert.deepEqual(detail.rules.map(rule => rule.rule_id), ['C01-1.1']);
  const search = await h.ask('GET', `/search?q=${encodeURIComponent('供应商 货款 单笔 2 万')}&k=5`);
  assert.deepEqual(search.payload.data.items, [{ rule_id: 'C05-5.2', score: 0.81 }]);
  assert.deepEqual(h.runner.calls.at(-1), ['admin', 'search', '供应商 货款 单笔 2 万', '--k', '5']);
  assert.equal((await h.ask('GET', '/search?q=')).status, 400);
  assert.equal((await h.ask('GET', `/search?q=${'字'.repeat(2001)}`)).status, 400);
  assert.equal((await h.ask('GET', '/search-log')).payload.data.items[0].caller, 'agent');
  assert.equal((await h.ask('GET', '/documents', { role: 'analyst' })).status, 403);
  let status = null;
  const other = await h.routes.handle({ req: { method: 'GET', headers: {} }, path: '/api/analysis/v1/poc/intake/templates', session: { user: { role: 'admin' } }, res: { writeHead(code) { status = code; } } });
  assert.equal(other, false);
});

test('runner：解析读 REPORT 行；入库和预览用 --embed sql，密码只以 --password-file 传；设置里没有知识库主机就不开这个功能', async () => {
  const calls = [];
  const execFile = async (file, args) => {
    calls.push([file, ...args]);
    if (args.some(arg => arg.endsWith('parse_rules.py'))) return { code: 0, stdout: `general=3\nREPORT ${JSON.stringify(REPORT)}\n`, stderr: '' };
    return { code: 0, stdout: `progress\n${JSON.stringify(PREVIEW)}\n`, stderr: '' };
  };
  const runner = createKbRunner({ python: '/opt/venv/bin/python', dir: '/opt/kb', pg: { host: '10.0.1.10', port: 5432, db: 'nexus', user: 'nexus', passwordFile: '/etc/kb_pg_password' }, execFile });
  assert.deepEqual(await runner.parse('/u/a.docx', '/u/a.json'), { code: 0, report: REPORT, message: '' });
  assert.deepEqual(await runner.preview('/u/a.json', { sourceTag: 't', sourceDoc: 'a.docx', sourceVersion: 'V1' }), PREVIEW);
  const preview = calls.at(-1);
  for (const flag of ['--embed', 'sql', '--dry-run', '--prune', '--password-file', '/etc/kb_pg_password', '--host', '10.0.1.10', '--source-tag', 't']) assert.ok(preview.includes(flag), flag);
  assert.ok(preview.includes('-I'), '以隔离模式跑 Python');
  await runner.ingest('/u/a.json', { sourceTag: 't', sourceDoc: 'a.docx', sourceVersion: 'V1' });
  assert.ok(!calls.at(-1).includes('--dry-run'));
  assert.equal(readSettings({ POC07_ORIGIN: 'https://jiuan.example', NEXUS_ORIGIN: 'https://nexus.example', NEXUS_OPERATOR: '/opt/nexus.py' }).kb, null);
  const kb = readSettings({ POC07_ORIGIN: 'https://jiuan.example', NEXUS_ORIGIN: 'https://nexus.example', NEXUS_OPERATOR: '/opt/nexus.py', POC07_KB_PG_HOST: '10.0.1.10',
    POC07_KB_DIR: '/opt/andon-finance/current/kb', POC07_KB_PYTHON: '/opt/andon-finance/kb-venv/bin/python' }).kb;
  assert.deepEqual(kb, { dir: '/opt/andon-finance/current/kb', python: '/opt/andon-finance/kb-venv/bin/python', uploadsDir: '/var/lib/jiuan07/kb-uploads',
    pg: { host: '10.0.1.10', port: 5432, db: 'nexus', user: 'nexus', passwordFile: '/etc/andon-finance/jiuan07/kb_pg_password' } });
});

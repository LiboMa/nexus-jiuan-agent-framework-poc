import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../../../bench/build-jiuan07.sh', import.meta.url));
const SOURCE = fileURLToPath(new URL('../../../../source/九安自助审核平台-测试环境开发包-v0.7.10', import.meta.url));
// 开发包里这两个目录含真实数据：测试只核对它们没进构件，不读内容
const SENSITIVE = new Set(['seeds', 'database']);

async function build(out) {
  const { stdout } = await run('bash', [SCRIPT, '--out', out], { maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim().split('\n').at(-1);
}

async function files(dir, skip = new Set()) {
  const found = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const relative = path.relative(dir, full);
      if (skip.has(relative)) continue;
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) found.push(relative);
    }
  }
  await walk(dir);
  return found.sort();
}

async function digestTree(dir) {
  const lines = [];
  for (const file of await files(dir, SENSITIVE)) lines.push(`${file} ${createHash('sha256').update(await readFile(path.join(dir, file))).digest('hex')}`);
  return lines.join('\n');
}

const exists = file => stat(file).then(() => true, () => false);

test('九安 v0.7.10 构件：只带运行时要的文件和锁定版本的 mysql2', async t => {
  const out = path.join(await mkdtemp(path.join(tmpdir(), 'jiuan07-')), 'jiuan07');
  t.after(() => rm(path.dirname(out), { recursive: true, force: true }));
  assert.equal(await build(out), `JIUAN07_BUILD_OK ${out}`);
  for (const file of ['analysis-server.mjs', 'package.json', 'providers/nexus-a2a.mjs', 'public/analysis.js',
    'src/agent-contract/tasks/review_advice/v1/task.json', 'src/agent-contract/envelope/v1/card-requirements.json']) {
    assert.ok(await exists(path.join(out, file)), `缺 ${file}`);
  }
  const mysql2 = JSON.parse(await readFile(path.join(out, 'node_modules/mysql2/package.json'), 'utf8'));
  assert.equal(mysql2.version, '3.14.3');
});

test('构件里没有种子、数据库、测试、部署、脚本和旧版入口', async t => {
  const out = path.join(await mkdtemp(path.join(tmpdir(), 'jiuan07-')), 'jiuan07');
  t.after(() => rm(path.dirname(out), { recursive: true, force: true }));
  await build(out);
  for (const name of ['seeds', 'database', 'tests', 'deploy', '.gitea', 'scripts', 'server.mjs', 'stage-server.mjs', 'README.md',
    'compose.yaml', 'Dockerfile', 'public/index.html', 'public/app.js', 'public/stage.html', 'public/attachment-viewer.html']) {
    assert.equal(await exists(path.join(out, name)), false, `不该有 ${name}`);
  }
  const shipped = (await files(out)).filter(file => !file.startsWith('node_modules/'));
  assert.deepEqual(shipped.filter(file => /hly-config-seed|\.sql(\.gz)?$|tenant-companies|\.env(\.|$)|\.(pem|key|pfx|dpapi)$/.test(file)), []);
  assert.ok(shipped.every(file => /^(analysis-server\.mjs|package\.json|src\/|providers\/|public\/)/.test(file)), '构件里只能有清单里的文件');
});

test('构建不改 source/ 下的开发包', async t => {
  const out = path.join(await mkdtemp(path.join(tmpdir(), 'jiuan07-')), 'jiuan07');
  t.after(() => rm(path.dirname(out), { recursive: true, force: true }));
  const before = await digestTree(SOURCE);
  await build(out);
  assert.equal(await digestTree(SOURCE), before);
});

// 页面测试用的最小 DOM：只够 platform-ops.js 画「Agent 接入」页、点按钮
class FakeNode {
  constructor(tag) { Object.assign(this, { tagName: tag.toUpperCase(), children: [], attributes: {}, listeners: {}, className: '', hidden: false, value: '', own: '' }); }
  get classList() { return { add: (...names) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...names])].join(' '); } }; }
  append(...nodes) { for (const node of nodes) this.children.push(typeof node === 'string' ? Object.assign(new FakeNode('#text'), { own: node }) : node); }
  replaceChildren(...nodes) { this.children = []; this.own = ''; this.append(...nodes); }
  set textContent(value) { this.children = []; this.own = String(value); }
  get textContent() { return this.own + this.children.map(child => child.textContent).join(''); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
  async click() { for (const listener of this.listeners.click ?? []) await listener(); }
  focus() {} scrollIntoView() {}
  all(test, found = []) { if (test(this)) found.push(this); for (const child of this.children) child.all(test, found); return found; }
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

async function builtPage(t) {
  const out = path.join(await mkdtemp(path.join(tmpdir(), 'jiuan07-')), 'jiuan07');
  t.after(() => rm(path.dirname(out), { recursive: true, force: true }));
  await build(out);
  return out;
}

test('补丁 0001–0002：「Agent 接入」页的接口都接上，九安的写请求白名单放行连接、断开 Nexus 和测试', async t => {
  const out = await builtPage(t);
  const analysis = await readFile(path.join(out, 'public/analysis.js'), 'utf8');
  for (const call of ["status: () => api('/platform/agent-access/nexus')", "publications: () => api('/platform/agent-access/publications'",
    "calls: () => api('/platform/agent-access/calls')", "documents: () => api('/platform/agent-access/test-documents')",
    'start: (publishId, body) => api(`/platform/agent-access/${id(publishId)}/test`', "templates: () => api('/platform/agent-access/test-templates')",
    'onApprove: ({ publishId, reason }) => write(`/${id(publishId)}/approve`', 'onUnapprove: ({ publishId, reason }) => write(`/${id(publishId)}/unapprove`']) assert.ok(analysis.includes(call), `缺 ${call}`);
  // 九安对 /platform 下的写请求有白名单（analysis-server.mjs），不在上面的 POST 回 404（页面显示「这项内容当前不可用…」）
  const server = await readFile(path.join(out, 'analysis-server.mjs'), 'utf8');
  assert.match(server, /path === PREFIX \+ '\/platform\/agent-access\/nexus' \|\| path === PREFIX \+ '\/platform\/agent-access\/nexus\/disconnect'/);
  assert.ok(server.includes(String.raw`/^\/api\/analysis\/v1\/platform\/agent-access\/pub_[A-Za-z0-9_-]{4,80}\/test$/u.test(path)`));
  assert.ok(server.includes('(?:rotate|disable|refresh|approve|unapprove)'), '设为 / 取消审批 Agent 也在白名单里（补丁 0003）');
  const ops = await readFile(path.join(out, 'public/platform-ops.js'), 'utf8');
  assert.doesNotMatch(ops, /'启用一个发布'/, '不再有手填发布编号的启用表单');
  assert.match(await readFile(path.join(out, 'public/platform-center.css'), 'utf8'), /\.platform-access-agent\{/);
  for (const file of ['analysis-server.mjs', 'public/platform-ops.js', 'public/analysis.js']) await run('node', ['--check', path.join(out, file)]);
  const { publishIdFrom } = await import(pathToFileURL(path.join(out, 'public/platform-ops.js')).href);
  assert.equal(publishIdFrom('https://nxs-beine1013.tinyboat.blog/a2a/pub_5c53e70d8dc7ddea'), 'pub_5c53e70d8dc7ddea');
  assert.equal(publishIdFrom(' https://nxs-beine1013.tinyboat.blog/a2a/pub_5c53e70d8dc7ddea/.well-known/agent-card.json '), 'pub_5c53e70d8dc7ddea');
  assert.equal(publishIdFrom('pub_5c53e70d8dc7ddea'), 'pub_5c53e70d8dc7ddea');
  assert.equal(publishIdFrom('https://example.invalid/whatever'), '');
});

test('补丁 0002：一张表列出 Nexus 上的发布和已启用的 Agent，每张卡只给合用的操作；启用只贴调用密钥，原因自动填', async t => {
  const out = await builtPage(t);
  globalThis.document = { createElement: tag => new FakeNode(tag), body: null };
  t.after(() => { delete globalThis.document; });
  const { renderPlatformOps } = await import(pathToFileURL(path.join(out, 'public/platform-ops.js')).href);
  const enabled = [];
  const active = { publishId: 'pub_audit0001', status: 'active', approval: true, fingerprint: 'ab12cd34', verifiedAt: '2026-10-26T01:00:00Z',
    card: { name: '九安审核AI（PoC）', tasks: ['review_advice@1'], declaredTasks: ['review_advice@1'] } };
  const approval = { publishId: 'pub_audit0001' };
  const opts = { platformAdmin: true,
    reload: async () => ({ records: [active], audit: [], approval }),
    onEnable: async input => { enabled.push(input); return { fingerprint: 'ff00ff00' }; }, onApprove: async () => ({}), onUnapprove: async () => ({}),
    calls: async () => ({ items: [{ at: '2026-10-26T01:02:00Z', number: 'DGZF-F07-001', publishId: 'pub_audit0001', trigger: 'upstream', status: 'completed', result: 'pass', latencyMs: 61000,
      note: '核对一致', basis: [{ kind: 'rule', ref: 'C05-3.4', page: null, note: '…' }, { kind: 'evidence', ref: 'c5921eaca9973a799e6d05941907dae167127694165eb1f153033b7bde5a6f41', page: 1, note: '税务事项通知书' }] }] }),
    agentTest: { documents: async () => ({ items: [] }), start: async () => ({}), view: async () => ({}) },
    nexus: { status: async () => ({ connected: true, user: 'admin' }), publications: async () => ({ items: [
      { publishId: 'pub_audit0001', name: '九安审核AI（PoC）', tasks: ['review_advice@1'], enableable: true, a2aReady: true, problems: [] },
      { publishId: 'pub_newagent01', name: '新发布的 Agent', tasks: [], enableable: true, a2aReady: true, problems: [] },
      { publishId: 'pub_broken0001', name: '不合契约的', tasks: [], enableable: false, a2aReady: true, problems: ['不支持流式'] },
    ] }) } };
  const page = renderPlatformOps('agentAccess', { records: [active], audit: [], approval }, opts);
  await settle(); await settle();
  const cards = page.all(node => node.className === 'platform-access-agent');
  assert.equal(cards.length, 3, '同一个发布只出现一次');
  const shown = card => card.all(node => node.tagName === 'BUTTON').map(node => node.textContent);
  assert.deepEqual(cards.map(shown), [['测试', '取消审批 Agent', '停用', '复核'], ['启用'], []]);
  assert.match(cards[0].textContent, /九安审核AI（PoC）就绪审批 Agentpub_audit0001.*审批流调用它.*密钥指纹 ab12cd34/s);
  assert.match(cards[1].textContent, /未启用.*名片没有声明任务/s, '名片只差契约 / 任务两行的照样能启用');
  assert.match(page.textContent, /审批流调用「九安审核AI（PoC）」/);
  assert.match(cards[2].textContent, /不能启用：不支持流式/);
  assert.match(page.textContent, /已连接 Nexus.*admin/s);
  assert.match(page.textContent, /调用记录.*DGZF-F07-001.*九安审核AI（PoC）.*建议通过/s, '调用记录里「发给」写 Agent 的名称');
  // 查看反馈：原件依据只显示哈希的前 12 位
  await page.all(node => node.tagName === 'BUTTON' && node.textContent === '查看反馈')[0].click();
  assert.match(page.textContent, /原件c5921eaca997…1税务事项通知书/);
  assert.doesNotMatch(page.textContent, /c5921eaca9973a799e6d0594/);
  // 启用：只贴调用密钥，发布编号来自卡片，原因自动填；密钥框提交后清空
  await cards[1].all(node => node.textContent === '启用' && node.tagName === 'BUTTON')[0].click();
  const key = cards[1].all(node => node.tagName === 'INPUT')[0];
  assert.equal(key.type, 'password');
  const pasted = 'nxa_' + 'g'.repeat(43);
  key.value = ` ${pasted} `;
  await cards[1].all(node => node.textContent === '验证并启用')[0].click();
  assert.deepEqual(enabled, [{ publishId: 'pub_newagent01', key: pasted, reason: '在「Agent 接入」页启用' }]);
  assert.equal(key.value, '');
});

test('补丁 0002：停用先确认再提交，换钥匙只在密钥失效时出现，复核用已存的密钥；原因都自动填', async t => {
  const out = await builtPage(t);
  globalThis.document = { createElement: tag => new FakeNode(tag), body: null };
  t.after(() => { delete globalThis.document; });
  const { renderPlatformOps } = await import(pathToFileURL(path.join(out, 'public/platform-ops.js')).href);
  const writes = [];
  const records = [{ publishId: 'pub_audit0001', status: 'active', approval: false, fingerprint: 'ab12cd34', card: { name: '审核', tasks: [], declaredTasks: ['review_advice@1'] } },
    { publishId: 'pub_stale00001', status: 'invalid', invalidReason: 'AGENT_KEY_REJECTED', fingerprint: '0badc0de', card: { name: '过期的', tasks: ['review_advice@1'] } }];
  const record = kind => async input => { writes.push([kind, input]); return {}; };
  const page = renderPlatformOps('agentAccess', { records, audit: [] }, { platformAdmin: true, reload: async () => ({ records, audit: [] }),
    onDisable: record('disable'), onRotate: record('rotate'), onRefresh: record('refresh') });
  await settle();
  const [active, stale] = page.all(node => node.className === 'platform-access-agent');
  const press = async (card, label) => card.all(node => node.tagName === 'BUTTON' && node.textContent === label)[0].click();
  assert.deepEqual(stale.all(node => node.tagName === 'BUTTON').map(node => node.textContent), ['换钥匙', '停用']);
  assert.match(stale.textContent, /密钥失效.*失效原因：Nexus 不认这把密钥/s);
  await press(active, '停用');
  assert.equal(writes.length, 0, '点「停用」只打开确认');
  assert.match(active.textContent, /停用后九安不再调用「审核」/);
  await press(active, '确认停用');
  await press(active, '复核');
  await settle();
  await press(stale, '换钥匙');
  const key = stale.all(node => node.tagName === 'INPUT')[0];
  key.value = 'nxa_' + 'r'.repeat(43);
  await press(stale, '验证并更换');
  assert.deepEqual(writes, [['disable', { publishId: 'pub_audit0001', reason: '在「Agent 接入」页停用' }], ['refresh', { publishId: 'pub_audit0001', reason: '在「Agent 接入」页复核' }],
    ['rotate', { publishId: 'pub_stale00001', key: 'nxa_' + 'r'.repeat(43), reason: '在「Agent 接入」页换钥匙' }]]);
});

test('补丁 0002：手动添加从 A2A 地址认出发布编号；地址认不出时不清空密钥框，真正提交时读出来马上清空', async t => {
  const out = await builtPage(t);
  globalThis.document = { createElement: tag => new FakeNode(tag), body: null };
  t.after(() => { delete globalThis.document; });
  const { renderPlatformOps } = await import(pathToFileURL(path.join(out, 'public/platform-ops.js')).href);
  const enabled = [];
  const page = renderPlatformOps('agentAccess', { records: [], audit: [] }, { platformAdmin: true, reload: async () => ({ records: [], audit: [] }),
    onEnable: async input => { enabled.push(input); return {}; } });
  await settle();
  await page.all(node => node.tagName === 'BUTTON' && node.textContent === '手动添加 Agent')[0].click();
  const [address, key] = page.all(node => node.tagName === 'INPUT');
  const go = page.all(node => node.tagName === 'BUTTON' && node.textContent === '验证并添加')[0];
  const pasted = 'nxa_' + 'm'.repeat(43);
  address.value = 'https://example.invalid/whatever'; key.value = pasted;
  await go.click();
  assert.equal(key.value, pasted, '只是地址认不出，不清空密钥框');
  assert.match(page.textContent, /认不出发布/);
  address.value = 'https://nxs.example/a2a/pub_manual000001/.well-known/agent-card.json';
  await go.click();
  assert.equal(key.value, '');
  assert.deepEqual(enabled, [{ publishId: 'pub_manual000001', key: pasted, reason: '在「Agent 接入」页手动添加（A2A 地址 + 调用密钥）' }]);
});

test('补丁 0002：页面后台刷新（读 Nexus 上的发布）回来时，正在用的卡片（测试进行中、正在贴密钥）原样保留，不被重画', async t => {
  const out = await builtPage(t);
  globalThis.document = { createElement: tag => new FakeNode(tag), body: null };
  t.after(() => { delete globalThis.document; });
  const { renderPlatformOps } = await import(pathToFileURL(path.join(out, 'public/platform-ops.js')).href);
  const active = { publishId: 'pub_audit0001', status: 'active', fingerprint: 'ab12cd34', card: { name: '审核', tasks: ['review_advice@1'] } };
  let release;
  const late = new Promise(resolve => { release = resolve; });
  const page = renderPlatformOps('agentAccess', { records: [active], audit: [] }, { platformAdmin: true, reload: async () => ({ records: [active], audit: [] }),
    agentTest: { documents: async () => ({ items: [{ id: 'd3', number: 'DGZF-F07-003', title: '税款' }] }), start: async () => ({}), view: async () => ({}) },
    nexus: { status: async () => ({ connected: true, user: 'admin' }), publications: async () => { await late; return { items: [
      { publishId: 'pub_audit0001', name: '审核', tasks: ['review_advice@1'], enableable: true, a2aReady: true, problems: [] },
      { publishId: 'pub_newagent01', name: '新发布的 Agent', tasks: [], enableable: true, a2aReady: true, problems: [] }] }; } } });
  await settle();
  const before = page.all(node => node.className === 'platform-access-agent')[0];
  await before.all(node => node.tagName === 'BUTTON' && node.textContent === '测试')[0].click();
  await settle();
  release(); await settle(); await settle();
  const cards = page.all(node => node.className === 'platform-access-agent');
  assert.equal(cards.length, 2, '刷新后列出了 Nexus 上的发布');
  assert.equal(cards[0], before, '打开着的卡片原样保留');
  assert.equal(cards[0].all(node => node.tagName === 'TEXTAREA').length, 1, '测试表单还在');
});

test('补丁 0002：审批流只调审批 Agent——就绪的卡上「设为审批 Agent」（替换旧的要先确认，写明换掉谁）、「取消审批 Agent」；没有审批 Agent 时页面上说清', async t => {
  const out = await builtPage(t);
  globalThis.document = { createElement: tag => new FakeNode(tag), body: null };
  t.after(() => { delete globalThis.document; });
  const { renderPlatformOps } = await import(pathToFileURL(path.join(out, 'public/platform-ops.js')).href);
  const writes = [];
  const records = [{ publishId: 'pub_audit0001', status: 'active', approval: true, card: { name: '审核AI', tasks: ['review_advice@1'], declaredTasks: [] } },
    { publishId: 'pub_knowledge1', status: 'active', approval: false, card: { name: '知识Agent', tasks: [], declaredTasks: [] } }];
  const page = renderPlatformOps('agentAccess', { records, audit: [], approval: { publishId: 'pub_audit0001' } }, { platformAdmin: true,
    reload: async () => ({ records, audit: [], approval: { publishId: 'pub_audit0001' } }),
    onApprove: async input => { writes.push(['approve', input]); return {}; }, onUnapprove: async input => { writes.push(['unapprove', input]); return {}; } });
  await settle();
  const [audit, knowledge] = page.all(node => node.className === 'platform-access-agent');
  assert.match(knowledge.textContent, /就绪.*供前端工作流调用（不进审批流）/s);
  const press = async (card, label) => card.all(node => node.tagName === 'BUTTON' && node.textContent === label)[0].click();
  await press(knowledge, '设为审批 Agent');
  assert.equal(writes.length, 0, '先确认');
  assert.match(knowledge.textContent, /审批流以后只调「知识Agent」，不再调「审核AI」/);
  await press(knowledge, '确认设为审批 Agent');
  await press(audit, '取消审批 Agent');
  assert.match(audit.textContent, /取消后审批流没有 Agent/);
  await press(audit, '确认取消');
  assert.deepEqual(writes, [['approve', { publishId: 'pub_knowledge1', reason: '在「Agent 接入」页设为审批 Agent' }],
    ['unapprove', { publishId: 'pub_audit0001', reason: '在「Agent 接入」页取消审批 Agent' }]]);
  const none = renderPlatformOps('agentAccess', { records: [records[1]], audit: [], approval: null }, { platformAdmin: true });
  await settle();
  assert.match(none.textContent, /审批流还没有审批 Agent/);
});

test('补丁 0002：测试分三种——文本（原样发一段话看回复）、请求信封（按契约预填示例，JSON 写错不发，合格 / 不合格和原始回答都看得到）、单据', async t => {
  const out = await builtPage(t);
  globalThis.document = { createElement: tag => new FakeNode(tag), body: null };
  t.after(() => { delete globalThis.document; });
  const { renderPlatformOps } = await import(pathToFileURL(path.join(out, 'public/platform-ops.js')).href);
  const started = [];
  const request = { envelope: 'jiuan.agent/v1', task: 'describe', taskVersion: 1, requestId: 'r-1', context: { subject: null }, input: {} };
  const answers = { text: { status: 'completed', mode: 'text', input: '你好', reply: '你好，我能回答制度问题。', publishId: 'pub_knowledge1', trigger: 'test', latencyMs: 3000 },
    envelope: { status: 'completed', mode: 'envelope', task: 'describe@1', conforms: false, problems: [{ path: '/requestId', message: 'requestId 必须与请求一致' }], reply: '{"status":"completed"}', publishId: 'pub_knowledge1', trigger: 'test' } };
  const records = [{ publishId: 'pub_knowledge1', status: 'active', approval: false, card: { name: '知识Agent', tasks: [], declaredTasks: [] } }];
  const page = renderPlatformOps('agentAccess', { records, audit: [], approval: null }, { platformAdmin: true, reload: async () => ({ records, audit: [], approval: null }),
    agentTest: { documents: async () => ({ items: [] }), templates: async () => ({ items: [{ task: 'describe@1', title: '能力清单', request }] }),
      start: async (publishId, body) => { started.push([publishId, body]); return answers[body.mode]; }, view: async () => ({}) } });
  await settle();
  const card = page.all(node => node.className === 'platform-access-agent')[0];
  const press = async label => card.all(node => node.tagName === 'BUTTON' && node.textContent === label)[0].click();
  await press('测试');
  assert.deepEqual(card.all(node => node.attributes.role === 'tab').map(node => node.textContent), ['文本', '请求信封', '单据']);
  card.all(node => node.tagName === 'TEXTAREA')[0].value = '  你好 ';
  await press('发送');
  assert.deepEqual(started[0], ['pub_knowledge1', { mode: 'text', text: '你好' }]);
  assert.match(card.textContent, /已回复.*你好，我能回答制度问题。/s);
  await press('请求信封'); await settle();
  const json = card.all(node => node.tagName === 'TEXTAREA')[0];
  assert.deepEqual(JSON.parse(json.value), request, '按契约预填示例');
  json.value = '{ 不是 JSON';
  await press('发送');
  assert.equal(started.length, 1, 'JSON 写错不发');
  assert.match(card.textContent, /不是合法的 JSON/);
  json.value = JSON.stringify(request);
  await press('发送');
  assert.deepEqual(started[1], ['pub_knowledge1', { mode: 'envelope', request }]);
  assert.match(card.textContent, /不合格.*requestId 必须与请求一致.*原始回答/s);
});

const KB_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

test('补丁 0004：「规则库」顶上分「审核要点」「制度知识库」两个页签（管理员有；补丁 0005 起分析员也有）；kb-page.js 登记进静态文件白名单和页面', async t => {
  const out = await builtPage(t);
  const analysis = await readFile(path.join(out, 'public/analysis.js'), 'utf8');
  const tabs = analysis.slice(analysis.indexOf('function rulesTabs('), analysis.indexOf('function rulesTabs(') + 900);
  assert.ok(tabs.length > 100, 'analysis.js 里要有 rulesTabs');
  assert.match(tabs, /platformAdmin === true/);
  assert.match(tabs, /#rules\?view=kb/);
  assert.match(analysis, /new CustomEvent\('kb-page:mount'/);
  assert.match(await readFile(path.join(out, 'public/route-model.js'), 'utf8'), /rules: \['family', 'view'\]/);
  assert.ok((await readFile(path.join(out, 'analysis-server.mjs'), 'utf8')).includes("'/kb-page.js':'kb-page.js'"));
  assert.ok((await readFile(path.join(out, 'public/analysis.html'), 'utf8')).includes('<script type="module" src="/kb-page.js"></script>'));
  assert.match(await readFile(path.join(out, 'public/platform-center.css'), 'utf8'), /\.kb-drop\{/);
  for (const file of ['public/kb-page.js', 'public/analysis.js', 'public/route-model.js', 'analysis-server.mjs']) await run('node', ['--check', path.join(out, file)]);
});

// ---- 补丁 0005：「制度知识库」页的「公司制度」块（只给管理员）两种知识库方式共用：都经知识库 Agent（pg 是 PG 知识库 Agent，
// s3vectors 是知识库文档管家），按 /mode 的 ops 显示按钮；能进这一页的人都有「我的规则」块 ----
const kbReply = (data, code = 200) => ({ ok: code < 400, status: code, json: async () => (code < 400 ? { data } : { error: data }) });
// describe 的 ops：PG 知识库 Agent 约定里必须有的（没有下线 / 恢复）、文档管家的全部
const KB_PG_OPS = ['describe', 'ingest', 'list', 'detail', 'delete', 'check', 'search'];
const KB_ALL_OPS = ['describe', 'ingest', 'list', 'detail', 'deactivate', 'restore', 'delete', 'check', 'search'];
async function kbPageModule(t, built = null) {
  const out = built ?? await builtPage(t);
  globalThis.document = { createElement: tag => new FakeNode(tag), body: null };
  t.after(() => { delete globalThis.document; });
  return import(pathToFileURL(path.join(out, 'public/kb-page.js')).href);
}
function kbHelpers(root) {
  const until = async check => { for (let index = 0; index < 80 && !check(); index += 1) await settle(); assert.ok(check(), root.textContent.slice(0, 600)); };
  const buttons = (scope, label) => scope.all(node => node.tagName === 'BUTTON' && node.textContent === label);
  const press = async (label, scope = root) => buttons(scope, label)[0].click();
  const row = (text, scope = root) => scope.all(node => node.tagName === 'TR' && node.textContent.includes(text))[0];
  const block = name => root.all(node => node.attributes?.['data-kb-block'] === name)[0];
  const input = name => root.all(node => node.tagName === 'INPUT' && node.name === name)[0];
  return { until, buttons, press, row, block, input };
}
/** 「我的规则」接口的假实现（内存里一份，按账号的上传先后）。 */
function ownRulesFake(initial = []) {
  let rules = [...initial];
  const list = () => ({ items: rules.map(({ text, ...rest }) => rest), usedChars: rules.reduce((sum, rule) => sum + rule.chars, 0), limitChars: 20000, limitFiles: 10 });
  return (method, url, init) => {
    if (url.endsWith('/poc/custom-rules') && method === 'GET') return kbReply(list());
    if (url.endsWith('/poc/custom-rules') && method === 'POST') {
      const name = decodeURIComponent(init.headers['X-File-Name']);
      if (name === '太长的规则.md') return kbReply({ code: 'CUSTOM_RULES_CHAR_LIMIT', message: '每人的规则合计不超过 20,000 字：这份有 19,500 字，现在还剩 18,800 字。' }, 409);
      const rule = { id: `r-${rules.length + 2}`, title: name, format: name.endsWith('.docx') ? 'docx' : 'md', chars: 300, uploadedAt: '2026-10-29T09:00:00Z', text: '对公付款单金额超过 10 万元须附合同。' };
      rules.push(rule);
      return kbReply(rule, 201);
    }
    const one = /\/poc\/custom-rules\/([a-z0-9-]+)(\/delete)?$/.exec(url);
    if (one && method === 'GET' && !one[2]) { const rule = rules.find(item => item.id === one[1]); return rule ? kbReply(rule) : kbReply({ code: 'CUSTOM_RULES_NOT_FOUND', message: '找不到这份规则，刷新后再试。' }, 404); }
    if (one && method === 'POST' && one[2]) { rules = rules.filter(item => item.id !== one[1]); return kbReply({ id: one[1], deleted: true }); }
    return null;
  };
}

test('补丁 0005：「制度知识库」页签对管理员和分析员都显示（公司制度块在 kb-page.js 里只给管理员）', async t => {
  const out = await builtPage(t);
  const analysis = await readFile(path.join(out, 'public/analysis.js'), 'utf8');
  const tabs = analysis.slice(analysis.indexOf('function rulesTabs('), analysis.indexOf('function rulesTabs(') + 900);
  assert.match(tabs, /if \(state\.session\?\.capabilities\?\.platformAdmin === true \|\| state\.session\?\.user\?\.role === 'analyst'\) \{/);
  assert.ok(analysis.includes("const kbView = state.routeParams.view === 'kb' && (state.session.capabilities?.platformAdmin === true || state.session.user?.role === 'analyst');"),
    '分析员打开 #rules?view=kb 也进「制度知识库」');
  const page = await readFile(path.join(out, 'public/kb-page.js'), 'utf8');
  assert.match(page, /export function mountKbPage\(\{ root, csrfToken = \(\) => '', user = null, fetcher = /);
  assert.match(await readFile(path.join(out, 'public/platform-center.css'), 'utf8'), /\.kb-own-text\{/);
  for (const file of ['public/kb-page.js', 'public/analysis.js']) await run('node', ['--check', path.join(out, file)]);
});

test('补丁 0005：分析员只看到「我的规则」——不问公司制度的接口；上传超限显示服务端的中文提示；上传成功显示转出来的文字；查看全文、删除；「已用」随列表更新', async t => {
  const { mountKbPage } = await kbPageModule(t);
  const calls = [];
  const own = ownRulesFake([{ id: 'r-1', title: '房租补充要求.md', format: 'md', chars: 1200, uploadedAt: '2026-10-28T08:00:00Z', text: '九安板块的房租对公付款须附出租方的房产证明。' }]);
  const fetcher = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push([method, url, init.headers || {}, init.body]);
    return own(method, url, init) ?? kbReply({ message: '没有这个接口' }, 404);
  };
  const root = new FakeNode('div');
  mountKbPage({ root, csrfToken: () => 'tok', user: { id: 'poc-reviewer', role: 'analyst' }, fetcher, pollMs: 0 });
  const { until, press, row, block, input } = kbHelpers(root);
  await until(() => root.textContent.includes('房租补充要求.md'));
  assert.match(root.textContent, /已用 1,200 \/ 20,000 字/);
  assert.deepEqual(calls.filter(call => call[1].includes('/poc/kb/')), [], '分析员连 /poc/kb/mode 都不问');
  assert.equal(block('company'), undefined, '没有「公司制度」块');
  assert.ok(block('own'), '有「我的规则」块');
  assert.doesNotMatch(root.textContent, /上传制度文档|上传历史|上传记录|检索日志|制度清单/);
  assert.deepEqual(row('房租补充要求.md').all(node => node.tagName === 'TD').slice(0, 2).map(node => node.textContent), ['房租补充要求.md', '1,200']);

  const file = input('ownFile');
  assert.match(file.accept, /\.md/);
  assert.match(file.accept, /\.docx/);
  // 不是 .md / .docx：不发请求
  let before = calls.length;
  file.files = [new File(['x'], '规则.txt', { type: 'text/plain' })];
  await file.listeners.change[0]();
  assert.equal(calls.length, before);
  assert.match(root.textContent, /只收 Markdown（\.md）或 Word（\.docx）文件/);
  // 服务端拒绝（合计超过 20,000 字）：原样显示它的中文提示，「已用」不变
  file.files = [new File(['很长'], '太长的规则.md', { type: 'text/markdown' })];
  await file.listeners.change[0]();
  await until(() => /这份有 19,500 字，现在还剩 18,800 字/.test(root.textContent));
  assert.match(root.textContent, /已用 1,200 \/ 20,000 字/);
  // 上传成功：显示转出来的文字，列表和「已用」刷新
  file.files = [new File(['对公付款单金额超过 10 万元须附合同。'], '合同要求.md', { type: 'text/markdown' })];
  await file.listeners.change[0]();
  await until(() => /已用 1,500 \/ 20,000 字/.test(root.textContent));
  const upload = calls.findLast(call => call[0] === 'POST' && call[1].endsWith('/poc/custom-rules'));
  assert.deepEqual([upload[2]['X-File-Name'], upload[2]['X-CSRF-Token']], [encodeURIComponent('合同要求.md'), 'tok']);
  assert.equal(upload[3], file.files[0], '请求体是文件原文');
  assert.match(root.textContent, /已上传「合同要求\.md」：300 字[\s\S]*对公付款单金额超过 10 万元须附合同。/, '上传成功后显示转出来的文字');
  assert.doesNotMatch(root.textContent, /还剩 18,800 字/, '上一次的错误提示收起');
  // 查看全文
  await press('查看全文', row('房租补充要求.md'));
  await until(() => root.textContent.includes('须附出租方的房产证明'));
  assert.ok(calls.some(call => call[0] === 'GET' && call[1].endsWith('/poc/custom-rules/r-1')));
  // 删除：发 POST …/r-1/delete，列表和「已用」跟着变
  await press('删除', row('房租补充要求.md'));
  await until(() => /已用 300 \/ 20,000 字/.test(root.textContent));
  const removal = calls.find(call => call[0] === 'POST' && call[1].endsWith('/poc/custom-rules/r-1/delete'));
  assert.equal(removal[2]['X-CSRF-Token'], 'tok');
  assert.equal(row('房租补充要求.md'), undefined);
  assert.ok(row('合同要求.md'));
});

test('补丁 0005：S3 Vectors 方式、文档管家还没在「Agent 接入」页启用（ready=false）：「公司制度」块只有一句提示，不发别的请求', async t => {
  const { mountKbPage } = await kbPageModule(t);
  const calls = [];
  const own = ownRulesFake();
  const fetcher = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push(`${method} ${url}`);
    if (url.endsWith('/poc/kb/mode')) return kbReply({ mode: 's3vectors', configured: true, ready: false, ops: [] });
    return own(method, url, init) ?? kbReply({ message: '没有这个接口' }, 404);
  };
  const root = new FakeNode('div');
  mountKbPage({ root, csrfToken: () => 'tok', user: { id: 'poc-admin', role: 'admin' }, fetcher, pollMs: 0 });
  const { until, block } = kbHelpers(root);
  await until(() => root.textContent.includes('先在『Agent 接入』页启用知识库文档管家') && root.textContent.includes('已用 0 / 20,000 字'));
  for (let index = 0; index < 10; index += 1) await settle();
  assert.deepEqual(calls.sort(), ['GET /api/analysis/v1/poc/custom-rules', 'GET /api/analysis/v1/poc/kb/mode']);
  const company = block('company');
  assert.equal(company.all(node => ['BUTTON', 'INPUT', 'TABLE'].includes(node.tagName)).length, 0, '整块只有那句提示');
  assert.equal(company.textContent.replace('公司制度', ''), '先在『Agent 接入』页启用知识库文档管家');
  assert.ok(block('own'));
});

test('补丁 0005：S3 Vectors 方式（ready=true）：上传带制度标识（按文件名预填）、版本、文档名，轮询上传记录到入库完成后刷新清单；下线 / 恢复 / 删除（删除先确认）；data.success=false 照失败显示；按问题检索带板块和金额', async t => {
  const { mountKbPage } = await kbPageModule(t);
  const calls = [];
  const own = ownRulesFake();
  let sources = [
    { source_id: 'sample-matrix', title: '仿真办法', source_version: 'V3', file_name: '仿真办法.docx', doc_hash: 'ab', rules_total: 18, status: 'active', ingested_at: '2026-10-20T08:00:00Z', updated_at: '2026-10-20T08:00:00Z' },
    { source_id: 'old-policy', title: '旧制度', source_version: 'V1', file_name: 'old.docx', doc_hash: 'cd', rules_total: 5, status: 'inactive', ingested_at: '2026-10-01T08:00:00Z', updated_at: '2026-10-02T08:00:00Z' },
  ];
  const uploads = [];
  let polls = 0, release = null;
  const gate = new Promise(resolve => { release = resolve; });
  const fetcher = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push([method, url, init.headers || {}, init.body]);
    const where = new URL(url, 'http://bench.test');
    const route = where.pathname.replace('/api/analysis/v1/poc/kb', '');
    if (route === '/mode') return kbReply({ mode: 's3vectors', configured: true, ready: true, ops: KB_ALL_OPS });
    if (route === '/sources' && method === 'GET') return kbReply({ success: true, sources });
    if (route === '/uploads') return kbReply({ items: [...uploads].reverse() });
    if (route === '/sources' && method === 'POST') {
      const p = where.searchParams;
      uploads.push({ id: 1, at: '2026-10-29T08:00:00Z', fileName: decodeURIComponent(init.headers['X-File-Name']), by: 'poc-admin', sourceId: p.get('sourceId'),
        sourceVersion: p.get('sourceVersion'), title: p.get('title'), status: 'ingesting', rulesTotal: null, written: null, removed: null, unchanged: null, conflicts: [], elapsedMs: null, error: null });
      return kbReply({ id: 1, status: 'ingesting' }, 202);
    }
    if (route === '/uploads/1') {
      polls += 1;
      if (polls >= 2 && uploads[0].status === 'ingesting') {
        Object.assign(uploads[0], { status: 'ingested', rulesTotal: 18, written: 2, removed: 1, unchanged: 16, finishedAt: '2026-10-29T08:01:30Z', elapsedMs: 90000 });
        sources = sources.map(source => (source.source_id === 'sample-matrix' ? { ...source, source_version: 'V4', updated_at: '2026-10-29T08:01:30Z' } : source));
      }
      return kbReply(uploads[0]);
    }
    if (route === '/sources/sample-matrix/deactivate') {
      await gate;
      sources = sources.map(source => (source.source_id === 'sample-matrix' ? { ...source, status: 'inactive' } : source));
      return kbReply({ success: true, source_id: 'sample-matrix', affected: 18 });
    }
    if (route === '/sources/old-policy/restore') return kbReply({ success: false, error_type: 'source_not_found', message: '规则库里没有制度「old-policy」', suggestion: '请用 action=list 查看已有的制度' });
    if (route === '/sources/old-policy/delete') { sources = sources.filter(source => source.source_id !== 'old-policy'); return kbReply({ success: true, source_id: 'old-policy', affected: 5 }); }
    if (route === '/search' && where.searchParams.get('q') === '不在线') return kbReply({ code: 'KB_AGENT_NOT_READY', message: '先在『Agent 接入』页启用知识库文档管家' }, 409);
    if (route === '/search') return kbReply({ success: true, filter: { active: { $eq: true } }, results: [{ rule_id: 'C05-3.4', rule_type: 'matrix', chapter_no: 5, segments: ['九安'], amt_kind: 'range', source_id: 'sample-matrix', text: '房租（年度框架合同）由财务经理审批', distance: 0.21 }] });
    return own(method, url, init) ?? kbReply({ message: '没有这个接口' }, 404);
  };
  const root = new FakeNode('div');
  mountKbPage({ root, csrfToken: () => 'tok', user: { id: 'poc-admin', role: 'admin' }, fetcher, pollMs: 0 });
  const { until, buttons, press, row: anyRow, block, input } = kbHelpers(root);
  // 制度清单里的一行（上传记录里也有制度标识，所以限定在清单那张卡片里找）
  const row = text => (block('sources') ? anyRow(text, block('sources')) : undefined);
  await until(() => Boolean(row('old-policy')) && root.textContent.includes('已用 0 / 20,000 字'));
  // 清单：标题、标识、版本、条数、状态、时间
  assert.deepEqual(row('sample-matrix').all(node => node.tagName === 'TD').slice(0, 5).map(node => node.textContent), ['仿真办法', 'sample-matrix', 'V3', '18', '有效']);
  assert.match(row('old-policy').textContent, /已下线/);
  assert.ok(buttons(row('sample-matrix'), '下线').length && !buttons(row('sample-matrix'), '恢复').length);
  assert.ok(buttons(row('old-policy'), '恢复').length && !buttons(row('old-policy'), '下线').length);
  assert.ok(calls.every(call => !/\/poc\/kb\/(documents|search-log)/.test(call[1])), 'S3 Vectors 方式没有 PG 的上传历史和检索日志');
  assert.doesNotMatch(block('company').textContent, /检索日志/);
  assert.ok(block('own'), '管理员也有「我的规则」');

  // 上传：按文件名预填（清单里有同名文件的制度就用它的标识和标题），标识不合格不发
  const file = input('file');
  file.files = [new File([new Uint8Array([0x50, 0x4b, 3, 4])], '仿真办法.docx', { type: KB_DOCX })];
  await file.listeners.change[0]();
  await until(() => Boolean(input('sourceId')));
  assert.equal(input('sourceId').value, 'sample-matrix');
  assert.equal(input('docTitle').value, '仿真办法');
  assert.ok(block('company').all(node => /kb-warn/.test(node.className) && !node.hidden && /作为它的新版本/.test(node.textContent)).length, '标识已在库里：提醒会作为它的新版本');
  input('sourceId').value = 'Bad_ID';
  let before = calls.length;
  await press('上传并入库');
  assert.equal(calls.length, before, '制度标识不合格不发请求');
  assert.match(root.textContent, /制度标识只能用小写字母、数字和连字符/);
  input('sourceId').value = 'sample-matrix';
  input('sourceVersion').value = 'V4 正式签批版';
  const listsBefore = calls.filter(call => call[0] === 'GET' && call[1].endsWith('/poc/kb/sources')).length;
  await press('上传并入库');
  await until(() => /入库完成/.test(root.textContent) && /V4/.test(row('sample-matrix')?.textContent ?? ''));
  const upload = calls.find(call => call[0] === 'POST' && call[1].includes('/poc/kb/sources?'));
  const params = new URL(upload[1], 'http://bench.test').searchParams;
  assert.deepEqual([params.get('sourceId'), params.get('sourceVersion'), params.get('title')], ['sample-matrix', 'V4 正式签批版', '仿真办法']);
  assert.deepEqual([upload[2]['X-File-Name'], upload[2]['X-CSRF-Token'], upload[2]['Content-Type']], [encodeURIComponent('仿真办法.docx'), 'tok', KB_DOCX]);
  assert.equal(upload[3], file.files[0]);
  assert.ok(polls >= 2, '轮询上传记录到 ingested');
  assert.match(root.textContent, /入库完成[\s\S]*18 条规则[\s\S]*写入 2[\s\S]*删除 1[\s\S]*不变 16/);
  assert.ok(calls.filter(call => call[0] === 'GET' && call[1].endsWith('/poc/kb/sources')).length > listsBefore, '入库完成后刷新清单');
  assert.match(anyRow('V4 正式签批版', block('uploads'))?.textContent ?? '', /仿真办法\.docx[\s\S]*poc-admin[\s\S]*sample-matrix[\s\S]*已入库/, '上传记录刷新');

  // 下线：进行中显示「正在处理（约 10–20 秒）」、按钮不可用；做完刷新清单
  const pending = press('下线', row('sample-matrix'));
  await settle();
  const sourcesCard = block('sources');
  assert.match(sourcesCard.textContent, /正在处理（约 10–20 秒）/);
  const cardButtons = sourcesCard.all(node => node.tagName === 'BUTTON');
  assert.ok(cardButtons.length >= 4 && cardButtons.every(node => node.disabled === true), '处理中清单的按钮都不可用');
  release();
  await pending;
  await until(() => /已下线「仿真办法」/.test(root.textContent) && buttons(row('sample-matrix') ?? root, '恢复').length > 0);
  assert.ok(calls.some(call => call[0] === 'POST' && call[1].endsWith('/poc/kb/sources/sample-matrix/deactivate') && call[2]['X-CSRF-Token'] === 'tok'));

  // 恢复：工具自己失败（HTTP 200、data.success=false）照失败显示
  await press('恢复', row('old-policy'));
  await until(() => root.textContent.includes('规则库里没有制度「old-policy」'));
  assert.doesNotMatch(root.textContent, /已恢复/);

  // 删除：先确认，确认了才发
  before = calls.length;
  await press('删除', row('old-policy'));
  assert.equal(calls.length, before, '先确认');
  assert.match(sourcesCard.textContent, /不能恢复/);
  await press('确认删除', sourcesCard);
  await until(() => /已删除「旧制度」/.test(root.textContent) && !row('old-policy'));
  assert.ok(calls.some(call => call[0] === 'POST' && call[1].endsWith('/poc/kb/sources/old-policy/delete')));

  // 按问题检索：板块、金额可空，空的不传
  input('question').value = '房租 年度框架合同';
  input('segment').value = '九安';
  input('amount').value = '300000';
  await press('检索');
  await until(() => root.textContent.includes('房租（年度框架合同）由财务经理审批'));
  const search = new URL(calls.findLast(call => call[1].includes('/poc/kb/search?'))[1], 'http://bench.test').searchParams;
  assert.deepEqual([search.get('q'), search.get('segment'), search.get('amount'), search.get('k')], ['房租 年度框架合同', '九安', '300000', '8']);
  assert.match(anyRow('C05-3.4').textContent, /C05-3\.4[\s\S]*九安[\s\S]*sample-matrix/);
  input('segment').value = '';
  input('amount').value = '';
  await press('检索');
  await settle();
  const plain = calls.findLast(call => call[1].includes('/poc/kb/search?'))[1];
  assert.ok(!plain.includes('segment=') && !plain.includes('amount='), plain);
  // 文档管家的钥匙中途没了：整块换成那句提示
  input('question').value = '不在线';
  await press('检索');
  await until(() => block('company').textContent.replace('公司制度', '') === '先在『Agent 接入』页启用知识库文档管家');
});

/**
 * 「公司制度」接口的假实现（两种方式同一套）：/mode 回 fake.mode（是函数就调它）；清单、上传（POST 回 202，轮询 /uploads/<id> 时
 * 等测试调 release() 才算入库完成）、下线 / 恢复 / 删除、检索。
 */
function companyFake({ mode = { mode: 'pg', configured: true, ready: true, ops: KB_PG_OPS }, sources = [] } = {}) {
  const fake = { mode, sources: sources.map(source => ({ ...source })), uploads: [], polls: 0, release: null };
  const gate = new Promise(resolve => { fake.release = resolve; });
  fake.handle = async (method, url, init) => {
    const where = new URL(url, 'http://bench.test');
    if (!where.pathname.startsWith('/api/analysis/v1/poc/kb/')) return null;
    const route = where.pathname.slice('/api/analysis/v1/poc/kb'.length);
    if (route === '/mode') return typeof fake.mode === 'function' ? fake.mode() : kbReply(fake.mode);
    if (route === '/sources' && method === 'GET') return kbReply({ success: true, sources: fake.sources });
    if (route === '/uploads') return kbReply({ items: [...fake.uploads].reverse() });
    if (route === '/sources' && method === 'POST') {
      const p = where.searchParams;
      fake.uploads.push({ id: fake.uploads.length + 1, at: '2026-10-30T08:00:00Z', fileName: decodeURIComponent(init.headers['X-File-Name']), by: 'poc-admin',
        sourceId: p.get('sourceId'), sourceVersion: p.get('sourceVersion'), title: p.get('title'), status: 'ingesting', rulesTotal: null, written: null, removed: null,
        unchanged: null, conflicts: [], elapsedMs: null, error: null });
      return kbReply({ id: fake.uploads.length, status: 'ingesting' }, 202);
    }
    const entry = /^\/uploads\/(\d+)$/.exec(route);
    if (entry) {
      fake.polls += 1;
      await gate;
      const item = fake.uploads[Number(entry[1]) - 1];
      if (item.status === 'ingesting') {
        Object.assign(item, { status: 'ingested', rulesTotal: 121, written: 3, removed: 2, unchanged: 118, elapsedMs: 75000 });
        fake.sources = fake.sources.map(source => (source.source_id === item.sourceId ? { ...source, source_version: item.sourceVersion, rules_total: 121 } : source));
      }
      return kbReply(item);
    }
    const one = /^\/sources\/([^/]+)\/(deactivate|restore|delete)$/.exec(route);
    if (one && method === 'POST') {
      const id = decodeURIComponent(one[1]), affected = fake.sources.find(source => source.source_id === id)?.rules_total ?? 0;
      fake.sources = one[2] === 'delete' ? fake.sources.filter(source => source.source_id !== id)
        : fake.sources.map(source => (source.source_id === id ? { ...source, status: one[2] === 'deactivate' ? 'inactive' : 'active' } : source));
      return kbReply({ success: true, source_id: id, affected });
    }
    if (route === '/search') {
      return kbReply({ success: true, filter: { note: 'kb_search' }, results: [{ rule_id: 'C05-3.4', rule_type: 'matrix', chapter_no: 5, segments: ['九安'], amt_kind: 'range',
        source_id: 'fin-approval', text: '房租（年度框架合同）由财务经理审批', distance: 0.18 }] });
    }
    return kbReply({ code: 'NOT_FOUND', message: '没有这个接口' }, 404);
  };
  return fake;
}
/** 依次问各个假实现，都不认就回 404；每次请求记进 calls：[method, url, headers, body]。 */
function kbFetcher(calls, ...handlers) {
  return async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push([method, url, init.headers || {}, init.body]);
    for (const handle of handlers) {
      const answer = await handle(method, url, init);
      if (answer) return answer;
    }
    return kbReply({ message: '没有这个接口' }, 404);
  };
}
const KB_SOURCES = [
  { source_id: 'fin-approval', title: '财务审批制度', source_version: 'V4.0', file_name: '财务审批制度.docx', doc_hash: 'ab', rules_total: 118, status: 'active', ingested_at: '2026-10-20T08:00:00Z', updated_at: '2026-10-20T08:00:00Z' },
  { source_id: 'old-policy', title: '旧制度', source_version: 'V1', file_name: 'old.docx', doc_hash: 'cd', rules_total: 5, status: 'inactive', ingested_at: '2026-10-01T08:00:00Z', updated_at: '2026-10-02T08:00:00Z' },
];
const ADMIN = { id: 'poc-admin', role: 'admin' };

test('补丁 0005：PG 方式的「公司制度」也经知识库 Agent，和 S3 Vectors 方式同一块（0004 的入库预览、上传历史、检索日志都去掉）：上传带制度标识、版本、文档名，入库进行中「上传并入库」「取消」都不可用，轮询上传记录到入库完成后刷新清单；按问题检索', async t => {
  const out = await builtPage(t);
  const page = await readFile(path.join(out, 'public/kb-page.js'), 'utf8');
  for (const gone of ['/poc/kb/documents', '/poc/kb/search-log', '检索日志', '入库预览', '重新预览', 'pgCompany']) assert.ok(!page.includes(gone), `kb-page.js 里不该再有 ${gone}`);
  await run('node', ['--check', path.join(out, 'public/kb-page.js')]);
  const { mountKbPage } = await kbPageModule(t, out);
  const calls = [];
  const company = companyFake({ sources: KB_SOURCES.slice(0, 1) });
  const root = new FakeNode('div');
  mountKbPage({ root, csrfToken: () => 'tok', user: ADMIN, fetcher: kbFetcher(calls, company.handle, ownRulesFake()), pollMs: 0 });
  const { until, buttons, press, row: anyRow, block, input } = kbHelpers(root);
  const row = text => (block('sources') ? anyRow(text, block('sources')) : undefined);
  await until(() => Boolean(row('fin-approval')) && root.textContent.includes('已用 0 / 20,000 字'));
  assert.deepEqual(row('fin-approval').all(node => node.tagName === 'TD').slice(0, 5).map(node => node.textContent), ['财务审批制度', 'fin-approval', 'V4.0', '118', '有效']);
  const area = block('company');
  assert.match(area.textContent, /PostgreSQL[\s\S]*「知识库 Agent」经 A2A 读写/);
  assert.doesNotMatch(area.textContent, /文档管家|S3 Vectors|rules_search/, 'PG 方式不提文档管家');
  assert.ok(block('uploads'), '上传记录是外壳自己记的，两种方式都有');

  // 上传：清单里有同名文件的制度就用它的标识和标题（再上传是它的新版本）
  const file = input('file');
  file.files = [new File([new Uint8Array([0x50, 0x4b, 3, 4])], '财务审批制度.docx', { type: KB_DOCX })];
  await file.listeners.change[0]();
  await until(() => Boolean(input('sourceId')));
  assert.deepEqual([input('sourceId').value, input('docTitle').value], ['fin-approval', '财务审批制度']);
  input('sourceVersion').value = 'V4.1 修订';
  const lists = () => calls.filter(call => call[0] === 'GET' && call[1].endsWith('/poc/kb/sources')).length;
  const listsBefore = lists();
  const submitting = press('上传并入库');
  await until(() => company.polls > 0);
  assert.equal(buttons(area, '上传并入库')[0].disabled, true);
  assert.equal(buttons(area, '取消')[0].disabled, true, '入库进行中「取消」也不可用');
  assert.match(area.textContent, /正在入库：知识库 Agent 解析/);
  company.release();
  await submitting;
  await until(() => /入库完成/.test(root.textContent) && /V4\.1 修订/.test(row('fin-approval')?.textContent ?? ''));
  assert.match(root.textContent, /入库完成：「财务审批制度」共 121 条规则（写入 3、删除 2、不变 118）/);
  const upload = calls.find(call => call[0] === 'POST' && call[1].includes('/poc/kb/sources?'));
  const params = new URL(upload[1], 'http://bench.test').searchParams;
  assert.deepEqual([params.get('sourceId'), params.get('sourceVersion'), params.get('title')], ['fin-approval', 'V4.1 修订', '财务审批制度']);
  assert.deepEqual([upload[2]['X-File-Name'], upload[2]['X-CSRF-Token'], upload[2]['Content-Type']], [encodeURIComponent('财务审批制度.docx'), 'tok', KB_DOCX]);
  assert.equal(upload[3], file.files[0]);
  assert.equal(buttons(area, '取消').length, 0, '入库完成后表单收起');
  assert.ok(lists() > listsBefore, '入库完成后刷新清单');
  assert.match(anyRow('V4.1 修订', block('uploads'))?.textContent ?? '', /财务审批制度\.docx[\s\S]*poc-admin[\s\S]*fin-approval[\s\S]*已入库/, '上传记录刷新');

  // 按问题检索：板块、金额空着就不传
  input('question').value = '房租 年度框架合同 九安';
  await press('检索');
  await until(() => root.textContent.includes('房租（年度框架合同）由财务经理审批'));
  assert.deepEqual(anyRow('C05-3.4').all(node => node.tagName === 'TD').slice(0, 5).map(node => node.textContent), ['1', 'C05-3.4', '九安', 'fin-approval', '0.180']);
  const search = new URL(calls.findLast(call => call[1].includes('/poc/kb/search?'))[1], 'http://bench.test').searchParams;
  assert.deepEqual([...search.keys()].sort(), ['k', 'q']);
  assert.equal(search.get('q'), '房租 年度框架合同 九安');
  assert.ok(calls.every(call => !/\/poc\/kb\/(documents|search-log)/.test(call[1])), '不再请求 0004 的接口');
});

test('补丁 0005（ops_gate_buttons）：「下线」「恢复」只在 /mode 的 ops 里有时显示——PG 知识库 Agent 不支持时清单只有「删除」，说明和删除确认里也不提下线；Agent 支持时（哪种方式都一样）照样显示', async t => {
  const { mountKbPage } = await kbPageModule(t);
  async function mount(mode) {
    const calls = [];
    const root = new FakeNode('div');
    mountKbPage({ root, csrfToken: () => 'tok', user: ADMIN, fetcher: kbFetcher(calls, companyFake({ mode, sources: KB_SOURCES }).handle, ownRulesFake()), pollMs: 0 });
    const helpers = kbHelpers(root);
    const row = text => (helpers.block('sources') ? helpers.row(text, helpers.block('sources')) : undefined);
    await helpers.until(() => Boolean(row('old-policy')));
    const actions = text => row(text).all(node => node.tagName === 'BUTTON').map(node => node.textContent);
    return { ...helpers, root, calls, row, actions };
  }
  const pg = await mount({ mode: 'pg', configured: true, ready: true, ops: KB_PG_OPS });
  assert.deepEqual([pg.actions('fin-approval'), pg.actions('old-policy')], [['删除'], ['删除']], 'Agent 不支持下线 / 恢复：只有「删除」');
  assert.doesNotMatch(pg.block('sources').textContent, /「下线」/);
  await pg.press('删除', pg.row('fin-approval'));
  assert.match(pg.block('sources').textContent, /删除「财务审批制度」（fin-approval）的全部 118 条规则和登记，删了不能恢复。/);
  assert.doesNotMatch(pg.block('sources').textContent, /「下线」/, '确认里不叫人去点没有的「下线」');

  const toggles = await mount({ mode: 'pg', configured: true, ready: true, ops: KB_ALL_OPS });
  assert.deepEqual([toggles.actions('fin-approval'), toggles.actions('old-policy')], [['下线', '删除'], ['恢复', '删除']], 'Agent 支持时照样显示');
  assert.match(toggles.block('sources').textContent, /「下线」后审核 Agent 检索不到/);
  await toggles.press('下线', toggles.row('fin-approval'));
  await toggles.until(() => /已下线「财务审批制度」（118 条规则）/.test(toggles.root.textContent));
  assert.ok(toggles.calls.some(call => call[0] === 'POST' && call[1].endsWith('/poc/kb/sources/fin-approval/deactivate')));

  const s3v = await mount({ mode: 's3vectors', configured: true, ready: true, ops: ['describe', 'ingest', 'list', 'detail', 'delete', 'search'] });
  assert.deepEqual([s3v.actions('fin-approval'), s3v.actions('old-policy')], [['删除'], ['删除']], '看的是 ops，不是方式');
  const noOps = await mount({ mode: 'pg', configured: true, ready: true });
  assert.deepEqual([noOps.actions('fin-approval'), noOps.actions('old-policy')], [['删除'], ['删除']], '没有 ops 就当都不支持');
  for (const page of [pg, s3v, noOps]) assert.ok(page.calls.every(call => !/\/(deactivate|restore)$/.test(call[1])));
});

test('补丁 0005（not_configured_message）：没配知识库 Agent 的发布编号（configured=false）时「公司制度」块只说「知识库 Agent 还没配置」（S3 Vectors 方式说「知识库文档管家」）；PG 方式没在「Agent 接入」页启用（ready=false）只说「先在『Agent 接入』页启用知识库 Agent」；都不发别的请求', async t => {
  const { mountKbPage } = await kbPageModule(t);
  for (const [mode, expected] of [
    [{ mode: 'pg', configured: false, ready: false, ops: [] }, '知识库 Agent 还没配置'],
    [{ mode: 's3vectors', configured: false, ready: false, ops: [] }, '知识库文档管家还没配置'],
    [{ mode: 'pg', configured: true, ready: false, ops: [] }, '先在『Agent 接入』页启用知识库 Agent'],
  ]) {
    const calls = [];
    const root = new FakeNode('div');
    mountKbPage({ root, csrfToken: () => 'tok', user: ADMIN, fetcher: kbFetcher(calls, companyFake({ mode }).handle, ownRulesFake()), pollMs: 0 });
    const { until, block } = kbHelpers(root);
    const said = () => block('company').textContent.replace('公司制度', '');
    await until(() => said() === expected && root.textContent.includes('已用 0 / 20,000 字'));
    for (let index = 0; index < 10; index += 1) await settle();
    assert.deepEqual(calls.map(call => `${call[0]} ${call[1]}`).sort(), ['GET /api/analysis/v1/poc/custom-rules', 'GET /api/analysis/v1/poc/kb/mode'], JSON.stringify(mode));
    assert.equal(block('company').all(node => ['BUTTON', 'INPUT', 'TABLE'].includes(node.tagName)).length, 0, '整块只有那句提示');
    assert.equal(said(), expected);
    assert.ok(block('own'));
  }
});

test('补丁 0005：/mode 要等知识库 Agent 回 describe——等的时候说「正在连接知识库 Agent（约 10–20 秒）…」（这一页上次读到 S3 Vectors 方式就说「知识库文档管家」）；/mode 失败显示服务端的中文提示和「重试」，重试成功就画出整块', async t => {
  const { mountKbPage } = await kbPageModule(t);
  const UNAVAILABLE = '知识库 Agent 暂时连不上，或没在限定时间内答完：稍后再试（入库的话先看一下制度清单，可能已经写完）。';
  let release = null;
  const answers = [
    async () => { await new Promise(resolve => { release = resolve; }); return kbReply({ code: 'KB_UNAVAILABLE', message: UNAVAILABLE }, 503); },
    async () => kbReply({ mode: 'pg', configured: true, ready: true, ops: KB_PG_OPS }),
  ];
  const company = companyFake({ sources: KB_SOURCES.slice(0, 1) });
  company.mode = () => answers.shift()();
  const calls = [];
  const root = new FakeNode('div');
  mountKbPage({ root, csrfToken: () => 'tok', user: ADMIN, fetcher: kbFetcher(calls, company.handle, ownRulesFake()), pollMs: 0 });
  const { until, buttons, press, row, block } = kbHelpers(root);
  await until(() => block('company').textContent.includes('正在连接知识库 Agent（约 10–20 秒）…') && release !== null);
  assert.equal(buttons(block('company'), '重试').length, 0);
  release();
  await until(() => block('company').textContent.includes(UNAVAILABLE));
  assert.equal(buttons(block('company'), '重试').length, 1, '失败时给「重试」');
  assert.deepEqual(calls.filter(call => call[1].includes('/poc/kb/')).map(call => call[1]), ['/api/analysis/v1/poc/kb/mode'], '/mode 失败不发别的请求');
  await press('重试', block('company'));
  await until(() => Boolean(row('fin-approval', block('company'))));
  assert.equal(calls.filter(call => call[1].endsWith('/poc/kb/mode')).length, 2);
  assert.doesNotMatch(block('company').textContent, /暂时连不上/);

  // 这一页读到过 S3 Vectors 方式：下一次进来，等的时候说文档管家
  const s3v = companyFake({ mode: { mode: 's3vectors', configured: true, ready: true, ops: KB_ALL_OPS } });
  const firstRoot = new FakeNode('div');
  mountKbPage({ root: firstRoot, csrfToken: () => 'tok', user: ADMIN, fetcher: kbFetcher([], s3v.handle, ownRulesFake()), pollMs: 0 });
  const first = kbHelpers(firstRoot);
  await first.until(() => Boolean(first.block('sources')));
  let answer = null;
  s3v.mode = () => new Promise(resolve => { answer = () => resolve(kbReply({ mode: 's3vectors', configured: true, ready: true, ops: KB_ALL_OPS })); });
  const againRoot = new FakeNode('div');
  mountKbPage({ root: againRoot, csrfToken: () => 'tok', user: ADMIN, fetcher: kbFetcher([], s3v.handle, ownRulesFake()), pollMs: 0 });
  const again = kbHelpers(againRoot);
  await again.until(() => again.block('company').textContent.includes('正在连接知识库文档管家（约 10–20 秒）…') && answer !== null);
  answer();
  await again.until(() => Boolean(again.block('sources')));
});

test('补丁 0005：「我的规则」请求进行中（读列表、上传、查看全文、删除）按钮都不可用，再选文件不发请求；删掉刚上传的那份后它的全文框也收起（删别的不动它）', async t => {
  const { mountKbPage } = await kbPageModule(t);
  const own = ownRulesFake([{ id: 'r-1', title: '房租补充要求.md', format: 'md', chars: 1200, uploadedAt: '2026-10-28T08:00:00Z', text: '九安板块的房租对公付款须附出租方的房产证明。' }]);
  const calls = [];
  let hold = true, release = null;
  const fetcher = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push([method, url]);
    if (hold) { hold = false; await new Promise(resolve => { release = resolve; }); }
    return own(method, url, init) ?? kbReply({ message: '没有这个接口' }, 404);
  };
  const root = new FakeNode('div');
  mountKbPage({ root, csrfToken: () => 'tok', user: { id: 'poc-reviewer', role: 'analyst' }, fetcher, pollMs: 0 });
  const { until, press, row, block, input } = kbHelpers(root);
  const requestButtons = () => block('own').all(node => node.tagName === 'BUTTON' && ['选择文件', '查看全文', '删除'].includes(node.textContent));
  const allDisabled = () => requestButtons().every(node => node.disabled === true);
  const noneDisabled = () => requestButtons().every(node => !node.disabled);
  const held = async () => { await until(() => release !== null); };
  const letGo = () => { const go = release; release = null; go(); };

  // 读列表
  await held();
  assert.ok(requestButtons().length === 1 && allDisabled(), '读列表时「选择文件」不可用');
  letGo();
  await until(() => Boolean(row('房租补充要求.md')) && noneDisabled());

  // 上传：进行中按钮都不可用，再选一个文件不发请求
  hold = true;
  const file = input('ownFile');
  file.files = [new File(['对公付款单金额超过 10 万元须附合同。'], '合同要求.md', { type: 'text/markdown' })];
  const uploading = file.listeners.change[0]();
  await held();
  assert.ok(requestButtons().length === 3 && allDisabled(), '上传时「选择文件」「查看全文」「删除」都不可用');
  const before = calls.length;
  file.files = [new File(['x'], '另一份.md', { type: 'text/markdown' })];
  await file.listeners.change[0]();
  assert.equal(calls.length, before, '上一个请求没完成时再选文件不发请求');
  assert.match(block('own').textContent, /上一个请求还没完成/);
  letGo();
  await uploading;
  await until(() => /已上传「合同要求\.md」/.test(root.textContent) && Boolean(row('合同要求.md')) && noneDisabled());

  // 查看全文
  hold = true;
  const viewing = press('查看全文', row('房租补充要求.md'));
  await held();
  assert.ok(allDisabled(), '查看全文时按钮都不可用');
  letGo();
  await viewing;
  await until(() => root.textContent.includes('须附出租方的房产证明') && noneDisabled());

  // 删别的那份：进行中按钮都不可用；它的全文收起，刚上传的那份的全文框不动
  hold = true;
  const deleting = press('删除', row('房租补充要求.md'));
  await held();
  assert.ok(allDisabled(), '删除时按钮都不可用');
  letGo();
  await deleting;
  await until(() => !row('房租补充要求.md') && noneDisabled());
  assert.doesNotMatch(root.textContent, /须附出租方的房产证明/);
  assert.match(root.textContent, /已上传「合同要求\.md」：300 字/, '删别的规则不动刚上传的那份的全文框');

  // 删刚上传的那份：它的全文框也收起
  await press('删除', row('合同要求.md'));
  await until(() => !row('合同要求.md'));
  assert.doesNotMatch(root.textContent, /已上传「合同要求\.md」|对公付款单金额超过 10 万元须附合同。/, '删掉刚上传的那份后它的全文框收起');
});

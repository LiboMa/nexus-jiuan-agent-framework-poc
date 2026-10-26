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

test('补丁 0004：「规则库」顶上分「审核要点」「制度知识库」两个页签（制度知识库只给管理员）；kb-page.js 登记进静态文件白名单和页面', async t => {
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

test('补丁 0004：制度知识库页——上传后显示解析报告和入库预览，标签可改并重新预览（要删除的用琥珀色提醒），确认入库后轮询到结果并刷新历史；检索、检索日志', async t => {
  const out = await builtPage(t);
  globalThis.document = { createElement: tag => new FakeNode(tag), body: null };
  t.after(() => { delete globalThis.document; });
  const { mountKbPage } = await import(pathToFileURL(path.join(out, 'public/kb-page.js')).href);
  const calls = [];
  let status = 'ingesting';
  const reply = (data, code = 200) => ({ ok: code < 400, status: code, json: async () => (code < 400 ? { data } : { error: data }) });
  const fetcher = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push([method, url, init.headers || {}, init.body]);
    if (method === 'POST' && url.endsWith('/poc/kb/documents')) return reply({ id: 1, fileName: '仿真办法.docx', suggestedTag: 'sample-matrix', docTitle: '仿真办法', sourceVersion: '',
      report: { general: 3, chapter_notes: 3, matrix: 12, total: 18, chapters: [{ no: 1, title: '一、立项审批', rows: 4 }], duplicates: [], without_path: [] },
      preview: { inserted: 0, updated: 0, retagged: 0, unchanged: 12, pruned: 0, pruned_ids: [] } }, 201);
    if (url.endsWith('/documents/1/preview') && JSON.parse(init.body).sourceTag === 'other-doc') return reply({ preview: { inserted: 2, updated: 0, retagged: 0, unchanged: 0, pruned: 0, pruned_ids: [], conflicts: 10, conflict_ids: ['C01-1.1', 'C01-1.2'] } });
    if (url.endsWith('/documents/1/preview')) return reply({ preview: { inserted: 12, updated: 0, retagged: 0, unchanged: 0, pruned: 2, pruned_ids: ['C01-1.1', 'C01-1.2'], conflicts: 0, conflict_ids: [] } });
    if (url.endsWith('/documents/1/ingest')) return reply({ id: 1, status: 'ingesting' }, 202);
    if (url.endsWith('/documents/1')) { const now = status; status = 'ingested'; return reply({ id: 1, status: now, result: now === 'ingested' ? { inserted: 0, updated: 0, retagged: 0, unchanged: 12, pruned: 0 } : null, rules: [] }); }
    if (url.endsWith('/poc/kb/documents')) return reply({ items: [{ id: 1, file_name: '仿真办法.docx', status: 'ingested', uploaded_by: 'poc-reviewer', uploaded_at: '2026-10-26T08:00:00Z',
      report: { matrix: 12 }, result: { inserted: 0, updated: 0, retagged: 0, unchanged: 12, pruned: 0 } }] });
    if (url.includes('/poc/kb/search?')) return reply({ items: [{ rule_id: 'C05-5.2', business_item: '供应商货款', segment: '甲板块', amount_tier: '单笔 ＞1 万', final_approver: '财务经理', score: 0.81, keyword_hits: 2 }] });
    if (url.endsWith('/poc/kb/search-log')) return reply({ items: [{ at: '2026-10-26T08:01:00Z', caller: 'agent', question: '房租 九安', hits: [{ rule_id: 'C05-3.4', score: 0.7 }], took_ms: 300 },
      { at: '2026-10-26T08:02:00Z', caller: 'page', question: '税款', hits: [], took_ms: 200 }, { at: '2026-10-26T08:03:00Z', caller: 'verify', question: 'ping', hits: [], took_ms: 100 }] });
    return reply({ message: '没有这个接口' }, 404);
  };
  const root = new FakeNode('div');
  mountKbPage({ root, csrfToken: () => 'tok', fetcher, pollMs: 0 });
  const until = async check => { for (let index = 0; index < 50 && !check(); index += 1) await settle(); assert.ok(check(), root.textContent.slice(0, 400)); };
  const press = async label => root.all(node => node.tagName === 'BUTTON' && node.textContent === label)[0].click();
  // 等数据（日志里的问题、历史里的文件名）出来再看，不能只看卡片上固定的说明文字
  await until(() => root.textContent.includes('房租 九安') && root.textContent.includes('仿真办法.docx'));
  assert.match(root.textContent, /上传历史[\s\S]*仿真办法\.docx[\s\S]*已入库/);
  assert.match(root.textContent, /房租 九安[\s\S]*C05-3\.4（0\.70）/);
  const log = root.textContent.slice(root.textContent.indexOf('房租 九安') - 40);
  assert.match(log, /审核 Agent[\s\S]*页面检索[\s\S]*部署核对/, '检索日志把 caller 显示成中文');

  const input = root.all(node => node.tagName === 'INPUT' && node.type === 'file')[0];
  input.files = [new File([new Uint8Array([0x50, 0x4b, 3, 4])], '仿真办法.docx', { type: KB_DOCX })];
  await input.listeners.change[0]();
  await until(() => /不变 12/.test(root.textContent));
  const upload = calls.find(call => call[0] === 'POST' && call[1].endsWith('/poc/kb/documents'));
  assert.deepEqual([upload[2]['X-File-Name'], upload[2]['X-CSRF-Token'], upload[2]['Content-Type']], [encodeURIComponent('仿真办法.docx'), 'tok', KB_DOCX]);
  assert.match(root.textContent, /规则 12 条[\s\S]*一、立项审批/);
  assert.match(root.textContent, /新增 0[\s\S]*重算向量 0[\s\S]*只更新说明 0[\s\S]*不变 12[\s\S]*删除 0/);
  const tag = root.all(node => node.tagName === 'INPUT' && node.name === 'sourceTag')[0];
  assert.equal(tag.value, 'sample-matrix');
  // 规则编号已属于库里另一份文档：入库会覆盖它的规则——红字说明，确认入库按钮不可用
  const confirmButton = () => root.all(node => node.tagName === 'BUTTON' && node.textContent === '确认入库')[0];
  // 改了标签或版本还没重新预览：不能入库（入库只认看过预览的标签和版本）
  tag.value = 'other-doc';
  for (const listener of tag.listeners.input ?? []) listener();
  assert.equal(confirmButton().disabled, true, '改了标签就要先重新预览');
  const staleNote = () => root.all(node => node.tagName === 'P' && /先点「重新预览」/.test(node.textContent))[0];
  assert.equal(staleNote().hidden, false);
  await press('重新预览');
  await until(() => /10 条规则编号已属于库里另一份文档/.test(root.textContent));
  assert.equal(confirmButton().disabled, true);
  tag.value = 'other-tag';
  await press('重新预览');
  await until(() => /将删除 2 条/.test(root.textContent));
  assert.equal(confirmButton().disabled, false);
  assert.doesNotMatch(root.textContent, /已属于库里另一份文档/);
  assert.equal(staleNote().hidden, true, '重新预览后提示收起');
  const lastPreview = calls.filter(call => call[1].endsWith('/documents/1/preview')).at(-1);
  assert.deepEqual(JSON.parse(lastPreview[3]), { sourceTag: 'other-tag', sourceVersion: '' }, '预览带上页面上填的版本说明');
  assert.ok(root.all(node => /kb-warn/.test(node.className)).length > 0, '要删除的规则用琥珀色提醒');
  await press('确认入库');
  await until(() => /入库完成/.test(root.textContent));
  const ingest = calls.find(call => call[1].endsWith('/documents/1/ingest'));
  assert.deepEqual(JSON.parse(ingest[3]), { sourceTag: 'other-tag', docTitle: '仿真办法', sourceVersion: '' });
  assert.equal(ingest[2]['X-CSRF-Token'], 'tok');
  assert.ok(calls.filter(call => call[0] === 'GET' && call[1].endsWith('/poc/kb/documents')).length >= 2, '入库完成后刷新历史');

  const before = calls.length;
  await press('检索');
  assert.equal(calls.length, before, '问题是空的不发请求');
  root.all(node => node.tagName === 'INPUT' && node.name === 'question')[0].value = '供应商 货款 单笔 2 万';
  await press('检索');
  await until(() => /C05-5\.2[\s\S]*供应商货款[\s\S]*0\.81/.test(root.textContent));
  assert.ok(calls.at(-1)[1].includes(`/poc/kb/search?q=${encodeURIComponent('供应商 货款 单笔 2 万')}`));
  // 含问题里关键词的规则排在前面：说明里讲清楚，结果里显示命中了几个词
  assert.match(root.textContent, /用空格隔开/);
  const cells = root.all(node => node.tagName === 'TD').map(node => node.textContent);
  const at = cells.indexOf('C05-5.2');
  assert.deepEqual(cells.slice(at, at + 7), ['C05-5.2', '供应商货款', '甲板块', '单笔 ＞1 万', '财务经理', '2', '0.81']);
  assert.ok(root.all(node => node.tagName === 'TH').some(node => node.textContent === '命中词数'));
});

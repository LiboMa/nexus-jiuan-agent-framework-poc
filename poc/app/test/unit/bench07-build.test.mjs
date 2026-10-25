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
    'start: (publishId, documentId) => api(`/platform/agent-access/${id(publishId)}/test`']) assert.ok(analysis.includes(call), `缺 ${call}`);
  // 九安对 /platform 下的写请求有白名单（analysis-server.mjs），不在上面的 POST 回 404（页面显示「这项内容当前不可用…」）
  const server = await readFile(path.join(out, 'analysis-server.mjs'), 'utf8');
  assert.match(server, /path === PREFIX \+ '\/platform\/agent-access\/nexus' \|\| path === PREFIX \+ '\/platform\/agent-access\/nexus\/disconnect'/);
  assert.ok(server.includes(String.raw`/^\/api\/analysis\/v1\/platform\/agent-access\/pub_[A-Za-z0-9_-]{4,80}\/test$/u.test(path)`));
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
  const active = { publishId: 'pub_audit0001', status: 'active', fingerprint: 'ab12cd34', verifiedAt: '2026-10-26T01:00:00Z', card: { name: '九安审核AI（PoC）', tasks: ['review_advice@1'], declaredBy: 'card' } };
  const opts = { platformAdmin: true,
    reload: async () => ({ records: [active], audit: [] }),
    onEnable: async input => { enabled.push(input); return { fingerprint: 'ff00ff00' }; },
    calls: async () => ({ items: [{ at: '2026-10-26T01:02:00Z', number: 'DGZF-F07-001', publishId: 'pub_audit0001', trigger: 'upstream', status: 'completed', result: 'pass', latencyMs: 61000,
      note: '核对一致', basis: [{ kind: 'rule', ref: 'C05-3.4', page: null, note: '…' }, { kind: 'evidence', ref: 'c5921eaca9973a799e6d05941907dae167127694165eb1f153033b7bde5a6f41', page: 1, note: '税务事项通知书' }] }] }),
    agentTest: { documents: async () => ({ items: [] }), start: async () => ({}), view: async () => ({}) },
    nexus: { status: async () => ({ connected: true, user: 'admin' }), publications: async () => ({ items: [
      { publishId: 'pub_audit0001', name: '九安审核AI（PoC）', tasks: ['review_advice@1'], declaredBy: 'card', enableable: true, a2aReady: true, problems: [] },
      { publishId: 'pub_newagent01', name: '新发布的 Agent', tasks: ['review_advice@1'], declaredBy: 'platform', enableable: true, a2aReady: true, problems: [] },
      { publishId: 'pub_broken0001', name: '不合契约的', tasks: [], declaredBy: null, enableable: false, a2aReady: true, problems: ['不支持流式'] },
    ] }) } };
  const page = renderPlatformOps('agentAccess', { records: [active], audit: [] }, opts);
  await settle(); await settle();
  const cards = page.all(node => node.className === 'platform-access-agent');
  assert.equal(cards.length, 3, '同一个发布只出现一次');
  const shown = card => card.all(node => node.tagName === 'BUTTON').map(node => node.textContent);
  assert.deepEqual(cards.map(shown), [['测试', '停用', '复核'], ['启用'], []]);
  assert.match(cards[0].textContent, /已启用.*pub_audit0001.*密钥指纹 ab12cd34/s);
  assert.match(cards[1].textContent, /未启用.*（名片没有声明，由平台指定）/s, '名片只差契约 / 任务两行的照样能启用');
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
  const records = [{ publishId: 'pub_audit0001', status: 'active', fingerprint: 'ab12cd34', card: { name: '审核', tasks: ['review_advice@1'] } },
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
  assert.match(active.textContent, /停用后九安不再把单据交给「审核」/);
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
      { publishId: 'pub_audit0001', name: '审核', tasks: ['review_advice@1'], declaredBy: 'card', enableable: true, a2aReady: true, problems: [] },
      { publishId: 'pub_newagent01', name: '新发布的 Agent', tasks: ['review_advice@1'], declaredBy: 'platform', enableable: true, a2aReady: true, problems: [] }] }; } } });
  await settle();
  const before = page.all(node => node.className === 'platform-access-agent')[0];
  await before.all(node => node.tagName === 'BUTTON' && node.textContent === '测试')[0].click();
  await settle();
  release(); await settle(); await settle();
  const cards = page.all(node => node.className === 'platform-access-agent');
  assert.equal(cards.length, 2, '刷新后列出了 Nexus 上的发布');
  assert.equal(cards[0], before, '打开着的卡片原样保留');
  assert.equal(cards[0].all(node => node.tagName === 'SELECT').length, 1, '测试表单还在');
});

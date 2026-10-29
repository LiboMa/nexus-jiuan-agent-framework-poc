import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { createCustomRules, customRulesRoutes, docxToText } from '../../custom-rules.mjs';

// 「我的规则」：每位审核员自己上传的 .md / .docx，存在测试台本机，只操作当前登录账号自己的。
// 规则文字都是虚构的；.docx 由下面的小 zip 写法现造（只存不压），转文本走真的 python3 -I docx_text.py。
const BASE = '/api/analysis/v1/poc/custom-rules';
const REVIEWER = { id: 'poc-reviewer', role: 'admin', principalId: 'account:poc-reviewer' };
const CHECKER = { id: 'poc-checker', role: 'analyst', principalId: 'account:poc-checker' };
const POLICY = { id: 'poc-policy', role: 'policy_reviewer', principalId: 'account:poc-policy' };
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/** 最小的 zip：每个条目只存不压（method 0），本地文件头 + 中央目录 + 目录结尾。 */
function zip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content), file = Buffer.from(name), crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(33, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(file.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(33, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(file.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, file, data);
    centrals.push(central, file);
    offset += local.length + file.length + data.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const p = (...runs) => `<w:p><w:pPr/>${runs.map(run => `<w:r><w:t xml:space="preserve">${run}</w:t></w:r>`).join('')}</w:p>`;
const table = rows => `<w:tbl><w:tblPr/>${rows.map(cells => `<w:tr>${cells.map(cell => `<w:tc><w:tcPr/>${p(cell)}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`;
const docx = body => zip({
  '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}"><w:body>${body}<w:sectPr/></w:body></w:document>`,
});
const md = text => Buffer.from(text, 'utf8');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function harness({ toText = docxToText } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'custom-rules-'));
  let clock = Date.parse('2026-10-29T08:00:00.000Z'), count = 0;
  const logs = [];
  const rules = createCustomRules({ dir, docxToText: toText, now: () => (clock += 1000), newId: () => `rule-${++count}` });
  const routes = customRulesRoutes({ rules, log: line => logs.push(line) });
  const ask = async (method, route, { user = REVIEWER, body = null, headers = {} } = {}) => {
    const req = Object.assign(Readable.from([body ?? Buffer.alloc(0)]), { method, headers });
    let status = null, payload = null;
    const res = { writeHead(code) { status = code; return this; }, setHeader() {}, end(text) { payload = text ? JSON.parse(text) : null; } };
    const handled = await routes.handle({ req, url: new URL(`${BASE}${route}`, 'http://localhost'), path: `${BASE}${route}`, session: user ? { user } : null, res, body: undefined });
    return { handled, status, payload };
  };
  const upload = (name, bytes, user = REVIEWER) => ask('POST', '', { user, body: bytes, headers: { 'x-file-name': encodeURIComponent(name), 'content-length': String(bytes.length) } });
  return { dir, rules, routes, logs, ask, upload, done: () => rm(dir, { recursive: true, force: true }) };
}
const refused = async (promise, code) => assert.rejects(promise, error => { assert.equal(error.code, code); return true; });

test('md_bom_crlf：.md 带 BOM 和 CRLF（也有单独的 CR）→ 去 BOM、换行统一成 \\n、去掉首尾空白；上传回 201 带转出来的全文', async t => {
  const h = await harness();
  t.after(h.done);
  const bytes = md('\uFEFF第一条：虚构的测试付款须附虚构证明。\r\n第二条：虚构发票须盖虚构章。\r第三条：虚构。\r\n\r\n');
  const answer = await h.upload('虚构补充要求.md', bytes);
  assert.equal(answer.status, 201, JSON.stringify(answer.payload));
  const text = '第一条：虚构的测试付款须附虚构证明。\n第二条：虚构发票须盖虚构章。\n第三条：虚构。';
  assert.deepEqual(answer.payload.data, { id: 'rule-1', title: '虚构补充要求.md', format: 'md', chars: [...text].length, uploadedAt: '2026-10-29T08:00:01.000Z', text });
  const listed = await h.ask('GET', '');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.payload.data, { items: [{ id: 'rule-1', title: '虚构补充要求.md', format: 'md', chars: [...text].length, uploadedAt: '2026-10-29T08:00:01.000Z' }],
    usedChars: [...text].length, limitChars: 20000, limitFiles: 10 });
});

test('docx_table_only：只有表格的 .docx → 每行一句「a | b」；正文段落和表格按顺序，空段落去掉，一段里的几个 run 连起来', async t => {
  const h = await harness();
  t.after(h.done);
  const only = await h.rules.add('poc-reviewer', { fileName: '虚构矩阵.docx', bytes: docx(table([['a', 'b'], ['虚构甲', '虚构乙']])) });
  assert.equal(only.format, 'docx');
  assert.equal(only.text, 'a | b\n虚构甲 | 虚构乙');
  const mixed = await h.rules.add('poc-reviewer', { fileName: '虚构说明.docx',
    bytes: docx(`${p('虚构', '标题')}${p('')}${table([['事项', '', '要求'], ['', ''], ['虚构付款', '全板块', '附虚构证明']])}${p('结尾：虚构。')}`) });
  assert.equal(mixed.text, '虚构标题\n事项 |  | 要求\n虚构付款 | 全板块 | 附虚构证明\n结尾：虚构。');
  // 同一个转换器直接读文件
  const file = path.join(h.dir, 'direct.docx');
  await writeFile(file, docx(table([['a', 'b']])));
  assert.equal((await docxToText(file)).trim(), 'a | b');
});

test('empty：空 .md、只有 BOM 和空白的 .md、没有文字的 .docx → CUSTOM_RULES_EMPTY（422），什么都不存', async t => {
  const h = await harness();
  t.after(h.done);
  for (const [name, bytes] of [['空.md', Buffer.alloc(0)], ['空白.md', md('\uFEFF \r\n\t\r\n')], ['空.docx', docx(`${p('')}${table([['', '']])}`)]]) {
    const answer = await h.upload(name, bytes);
    assert.deepEqual([answer.status, answer.payload.error.code], [422, 'CUSTOM_RULES_EMPTY'], name);
    assert.match(answer.payload.error.message, /没有抽出文字/u);
  }
  assert.deepEqual((await h.ask('GET', '')).payload.data.items, []);
});

test('unreadable：扩展名 .docx 但不是 zip、zip 里没有 word/document.xml、document.xml 不是 XML → CUSTOM_RULES_UNREADABLE（422）；.md 不是 UTF-8 也拒绝', async t => {
  const h = await harness();
  t.after(h.done);
  const cases = [
    ['不是zip.docx', md('这是虚构的文字，不是 zip。')],
    ['缺正文.docx', zip({ '[Content_Types].xml': '<Types/>' })],
    ['坏XML.docx', zip({ 'word/document.xml': '<w:document><w:body>' })],
  ];
  for (const [name, bytes] of cases) {
    const answer = await h.upload(name, bytes);
    assert.deepEqual([answer.status, answer.payload.error.code], [422, 'CUSTOM_RULES_UNREADABLE'], name);
    assert.match(answer.payload.error.message, /不是有效的 Word 文件/u);
  }
  const gbk = await h.upload('虚构.md', Buffer.from([0xd0, 0xe9, 0xb9, 0xb9]));
  assert.deepEqual([gbk.status, gbk.payload.error.code], [422, 'CUSTOM_RULES_UNREADABLE']);
  assert.match(gbk.payload.error.message, /UTF-8/u);
  // 转换用的临时文件不留下
  assert.deepEqual((await readdir(path.join(h.dir, 'poc-reviewer'))).filter(name => !name.endsWith('.json')), []);
  assert.deepEqual((await h.ask('GET', '')).payload.data.items, []);
});

test('char_limit：已有 19,990 字时再加 11 字 → CUSTOM_RULES_CHAR_LIMIT（说明还剩 10 字），加 10 字通过（合计正好 20,000），再加 1 字也拒绝', async t => {
  const h = await harness();
  t.after(h.done);
  assert.equal((await h.upload('虚构长规则.md', md('甲'.repeat(19_990)))).status, 201);
  const over = await h.upload('多一字.md', md('乙'.repeat(11)));
  assert.deepEqual([over.status, over.payload.error.code], [409, 'CUSTOM_RULES_CHAR_LIMIT']);
  assert.match(over.payload.error.message, /20,000 字/u);
  assert.match(over.payload.error.message, /这份有 11 字/u);
  assert.match(over.payload.error.message, /还剩 10 字/u);
  const fits = await h.upload('正好.md', md('丙'.repeat(10)));
  assert.equal(fits.status, 201);
  const listed = (await h.ask('GET', '')).payload.data;
  assert.equal(listed.usedChars, 20_000);
  assert.deepEqual(listed.items.map(item => item.title), ['虚构长规则.md', '正好.md']);
  const full = await h.upload('再一字.md', md('丁'));
  assert.deepEqual([full.status, full.payload.error.code], [409, 'CUSTOM_RULES_CHAR_LIMIT']);
  assert.match(full.payload.error.message, /还剩 0 字/u);
});

test('file_limit：第 11 份 → CUSTOM_RULES_FILE_LIMIT（409），列表仍是 10 份；删掉一份后又能传', async t => {
  const h = await harness();
  t.after(h.done);
  for (let index = 1; index <= 10; index += 1) assert.equal((await h.upload(`虚构${index}.md`, md(`虚构规则 ${index}`))).status, 201);
  const eleventh = await h.upload('虚构11.md', md('虚构规则 11'));
  assert.deepEqual([eleventh.status, eleventh.payload.error.code], [409, 'CUSTOM_RULES_FILE_LIMIT']);
  assert.match(eleventh.payload.error.message, /最多 10 份/u);
  assert.equal((await h.ask('GET', '')).payload.data.items.length, 10);
  assert.equal((await h.ask('POST', '/rule-1/delete')).status, 200);
  assert.equal((await h.upload('虚构11.md', md('虚构规则 11'))).status, 201);
});

test('concurrent_uploads：同一账号同时传两份，各自都在限额内、合起来超了 → 只进一份（限额按顺序核对）', async t => {
  const h = await harness();
  t.after(h.done);
  assert.equal((await h.upload('底.md', md('甲'.repeat(10_000)))).status, 201);
  const answers = await Promise.all([h.upload('一.md', md('乙'.repeat(6_000))), h.upload('二.md', md('丙'.repeat(6_000)))]);
  assert.deepEqual(answers.map(answer => answer.status).sort(), [201, 409]);
  assert.equal((await h.ask('GET', '')).payload.data.usedChars, 16_000);
});

test('isolation：A 看不到、读不到、删不掉 B 的规则；forRequest 只给本人的', async t => {
  const h = await harness();
  t.after(h.done);
  const mine = (await h.upload('A的虚构规则.md', md('A 的虚构要求。'))).payload.data;
  const theirs = (await h.upload('B的虚构规则.md', md('B 的虚构要求。'), CHECKER)).payload.data;
  assert.deepEqual((await h.ask('GET', '')).payload.data.items.map(item => item.id), [mine.id]);
  assert.deepEqual((await h.ask('GET', '', { user: CHECKER })).payload.data.items.map(item => item.id), [theirs.id]);
  const peek = await h.ask('GET', `/${theirs.id}`);
  assert.deepEqual([peek.status, peek.payload.error.code], [404, 'CUSTOM_RULES_NOT_FOUND']);
  const remove = await h.ask('POST', `/${theirs.id}/delete`);
  assert.deepEqual([remove.status, remove.payload.error.code], [404, 'CUSTOM_RULES_NOT_FOUND']);
  const still = await h.ask('GET', `/${theirs.id}`, { user: CHECKER });
  assert.equal(still.status, 200);
  assert.equal(still.payload.data.text, 'B 的虚构要求。');
  assert.deepEqual(await h.rules.forRequest('poc-reviewer'), { owner: 'poc-reviewer', items: [{ title: 'A的虚构规则.md', text: 'A 的虚构要求。' }] });
  assert.deepEqual(await h.rules.forRequest('poc-checker'), { owner: 'poc-checker', items: [{ title: 'B的虚构规则.md', text: 'B 的虚构要求。' }] });
  // B 删自己的
  const own = await h.ask('POST', `/${theirs.id}/delete`, { user: CHECKER });
  assert.deepEqual([own.status, own.payload.data], [200, { id: theirs.id, deleted: true }]);
  assert.deepEqual((await h.ask('GET', '', { user: CHECKER })).payload.data.items, []);
  assert.equal(await h.rules.forRequest('poc-checker'), null);
});

test('forbidden：policy_reviewer 和没有会话的请求每个接口都是 403，不读不写', async t => {
  const h = await harness();
  t.after(h.done);
  await h.upload('虚构.md', md('虚构要求。'));
  for (const user of [POLICY, null]) {
    for (const [method, route, body] of [['GET', ''], ['POST', '', md('虚构。')], ['GET', '/rule-1'], ['POST', '/rule-1/delete']]) {
      const answer = await h.ask(method, route, { user, body, headers: { 'x-file-name': encodeURIComponent('虚构.md') } });
      assert.equal(answer.handled, true);
      assert.deepEqual([answer.status, answer.payload.error.code], [403, 'CUSTOM_RULES_FORBIDDEN'], `${user?.role} ${method} ${route}`);
      assert.match(answer.payload.error.message, /管理员和分析员/u);
    }
  }
  assert.deepEqual(await readdir(h.dir), ['poc-reviewer']);
  assert.deepEqual(await readdir(path.join(h.dir, 'poc-reviewer')), ['rule-1.json']);
});

test('for_request：没有规则时是 null（目录都没有、删光以后都一样）；有规则时 {owner, items:[{title, text}]}，按上传先后', async t => {
  const h = await harness();
  t.after(h.done);
  assert.equal(await h.rules.forRequest('poc-reviewer'), null);
  await h.rules.add('poc-reviewer', { fileName: '一.md', bytes: md('虚构一。') });
  await h.rules.add('poc-reviewer', { fileName: '二.docx', bytes: docx(table([['虚构', '二']])) });
  assert.deepEqual(await h.rules.forRequest('poc-reviewer'), { owner: 'poc-reviewer', items: [{ title: '一.md', text: '虚构一。' }, { title: '二.docx', text: '虚构 | 二' }] });
  await h.rules.remove('poc-reviewer', 'rule-1');
  await h.rules.remove('poc-reviewer', 'rule-2');
  assert.equal(await h.rules.forRequest('poc-reviewer'), null);
  // 不合格的账号编号不可能有规则
  assert.equal(await h.rules.forRequest('system:pipeline'), null);
});

test('storage：存 <dir>/<账号>/<id>.json（文件 0600、目录 0700），字段 {id,title,format,chars,sha256,uploadedAt,text}；GET /<id> 带全文', async t => {
  const h = await harness();
  t.after(h.done);
  const bytes = md('虚构的测试要求：付款须附虚构证明。');
  await h.upload('虚构.md', bytes);
  const folder = path.join(h.dir, 'poc-reviewer'), file = path.join(folder, 'rule-1.json');
  assert.equal((await stat(folder)).mode & 0o777, 0o700);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(saved, { id: 'rule-1', title: '虚构.md', format: 'md', chars: 17, sha256: sha(bytes), uploadedAt: '2026-10-29T08:00:01.000Z', text: '虚构的测试要求：付款须附虚构证明。' });
  const one = await h.ask('GET', '/rule-1');
  assert.deepEqual([one.status, one.payload.data], [200, { id: 'rule-1', title: '虚构.md', format: 'md', chars: 17, uploadedAt: '2026-10-29T08:00:01.000Z', text: saved.text }]);
  assert.equal((await h.ask('GET', '/rule-9')).status, 404);
  assert.equal((await h.ask('POST', '/rule-1/delete')).status, 200);
  assert.deepEqual(await readdir(folder), []);
  assert.equal((await h.ask('POST', '/rule-1/delete')).status, 404);
});

test('account_id：账号编号只认 ^[a-z0-9][a-z0-9-]{0,62}$，其余的 list/add/get/remove 都拒绝，不建目录', async t => {
  const h = await harness();
  t.after(h.done);
  for (const account of ['../poc-reviewer', 'Poc-Reviewer', '', '-x', 'a'.repeat(64), 'account:poc-reviewer', null]) {
    await refused(h.rules.list(account), 'CUSTOM_RULES_ACCOUNT_INVALID');
    await refused(h.rules.add(account, { fileName: '虚构.md', bytes: md('虚构。') }), 'CUSTOM_RULES_ACCOUNT_INVALID');
    await refused(h.rules.get(account, 'rule-1'), 'CUSTOM_RULES_ACCOUNT_INVALID');
    await refused(h.rules.remove(account, 'rule-1'), 'CUSTOM_RULES_ACCOUNT_INVALID');
  }
  assert.deepEqual(await readdir(h.dir), []);
  // 路由里会话账号不合格也是 403
  const answer = await h.ask('GET', '', { user: { id: 'Bad/Id', role: 'admin' } });
  assert.deepEqual([answer.status, answer.payload.error.code], [403, 'CUSTOM_RULES_ACCOUNT_INVALID']);
});

test('type_and_size：不是 .md / .docx（或没给文件名）→ CUSTOM_RULES_TYPE（400）；超过 2 MB → CUSTOM_RULES_TOO_LARGE（413）；扩展名大小写都认', async t => {
  const h = await harness();
  t.after(h.done);
  for (const name of ['虚构.txt', '虚构.doc', '虚构.md.exe', '.md', '']) {
    const answer = await h.ask('POST', '', { body: md('虚构。'), headers: name ? { 'x-file-name': encodeURIComponent(name) } : {} });
    assert.deepEqual([answer.status, answer.payload.error.code], [400, 'CUSTOM_RULES_TYPE'], name);
    assert.match(answer.payload.error.message, /\.md/u);
  }
  const big = Buffer.alloc(2 * 1024 * 1024 + 1, 0x61);
  const routed = await h.upload('大.md', big);
  assert.deepEqual([routed.status, routed.payload.error.code], [413, 'CUSTOM_RULES_TOO_LARGE']);
  assert.match(routed.payload.error.message, /2 MB/u);
  await refused(h.rules.add('poc-reviewer', { fileName: '大.md', bytes: big }), 'CUSTOM_RULES_TOO_LARGE');
  // 正好 2 MB 不算超（这份因为超过字数被拒，不是因为大小）
  await refused(h.rules.add('poc-reviewer', { fileName: '正好.md', bytes: Buffer.alloc(2 * 1024 * 1024, 0x61) }), 'CUSTOM_RULES_CHAR_LIMIT');
  const upper = await h.upload('虚构.MD', md('虚构大写扩展名。'));
  assert.deepEqual([upper.status, upper.payload.data.format, upper.payload.data.title], [201, 'md', '虚构.MD']);
  const docxUpper = await h.upload('虚构.DOCX', docx(p('虚构。')));
  assert.deepEqual([docxUpper.status, docxUpper.payload.data.format], [201, 'docx']);
  // 文件名只取最后一段
  const nested = await h.upload('../../etc/虚构.md', md('虚构。'));
  assert.equal(nested.payload.data.title, '虚构.md');
});

test('routes：前缀以外的路径不接（返回 false）；不认识的子路径交回九安；内部错误回 503 CUSTOM_RULES_UNAVAILABLE，日志只有错误码', async t => {
  const h = await harness({ toText: async () => { throw Object.assign(new Error('spawn python3 ENOENT 虚构'), { code: 'ENOENT' }); } });
  t.after(h.done);
  const outside = { req: Object.assign(Readable.from([]), { method: 'GET', headers: {} }), session: { user: REVIEWER }, res: {} };
  assert.equal(await h.routes.handle({ ...outside, url: new URL('http://localhost/api/analysis/v1/poc/custom-rules-x'), path: '/api/analysis/v1/poc/custom-rules-x' }), false);
  assert.equal(await h.routes.handle({ ...outside, url: new URL('http://localhost/api/analysis/v1/poc/kb/mode'), path: '/api/analysis/v1/poc/kb/mode' }), false);
  assert.equal((await h.ask('DELETE', '/rule-1')).handled, false);
  assert.equal((await h.ask('GET', '/rule-1/delete')).handled, false);
  assert.equal((await h.ask('GET', '/Rule..1')).handled, false);
  assert.equal((await h.ask('GET', '/')).status, 200);
  // 起不来 python3 是测试台的问题，不说文件坏了
  const answer = await h.upload('虚构.docx', docx(p('虚构的秘密要求。')));
  assert.deepEqual([answer.status, answer.payload.error.code], [503, 'CUSTOM_RULES_UNAVAILABLE']);
  assert.deepEqual(h.logs, ['POC_CUSTOM_RULES_FAILED ENOENT']);
  assert.equal(JSON.stringify(answer.payload).includes('秘密'), false);
});

test('docx_to_text：python3 起不来时原样报错（不是 CUSTOM_RULES_UNREADABLE）；不是 zip 时是 CUSTOM_RULES_UNREADABLE', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'custom-rules-docx-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'x.docx');
  await writeFile(file, md('不是 zip'));
  await refused(docxToText(file), 'CUSTOM_RULES_UNREADABLE');
  await assert.rejects(docxToText(file, { python: path.join(dir, 'no-python3') }), error => error.code === 'ENOENT');
});

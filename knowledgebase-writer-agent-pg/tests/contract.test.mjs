/**
 * 契约测试：PG 版工具的真实回复（tests/local_test.py 在 PGlite 上跑出来、写进 .build/contract-replies.json 的，内容全部虚构）
 * 经测试台的客户端 createKbStewardClient（poc/app/kb-steward-client.mjs，九安「制度知识库」页用的就是它）送一遍：
 * 每一条都要被它收下，不能有 KB_AGENT_REPLY_INVALID。A2A 调用是假的（call 直接回那条回复的 JSON），不出网、不碰真钥匙。
 *
 *   node --test knowledgebase-writer-agent-pg/tests/contract.test.mjs
 *
 * 先要有 .build/contract-replies.json：python3 -I knowledgebase-writer-agent-pg/scripts/build_tools.py --env …/deploy.env.example，
 * 再用 PGlite 跑 local_test.py（见它的文件头）。
 * 最后几条测 scripts/a2a_rules.mjs（冒烟用的命令行）：同样用假的 call，钥匙是临时目录里的假钥匙。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKbStewardClient } from '../../poc/app/kb-steward-client.mjs';
import { parseA2aUrl, run } from '../scripts/a2a_rules.mjs';

const REPLIES = fileURLToPath(new URL('../.build/contract-replies.json', import.meta.url));
const MANIFEST = fileURLToPath(new URL('../.build/MANIFEST.json', import.meta.url));
const ORIGIN = 'https://nexus.example';
const PUB = 'pub_0123456789abcdef';
const KEY = `nxa_${'f'.repeat(43)}`;
/** 接口约定第 2 节的全部操作（describe 之外都经 request 发）；preview 是 PG 版多出的，不在测试台的 SHAPES 里。 */
const CONTRACT_OPS = ['describe', 'ingest', 'list', 'detail', 'delete', 'check', 'search', 'deactivate', 'restore'];

async function loadReplies() {
  let text;
  try { text = await readFile(REPLIES, 'utf8'); }
  catch { assert.fail(`没有 ${REPLIES}：先打包，再用 PGlite 跑 knowledgebase-writer-agent-pg/tests/local_test.py（它最后写这个文件）`); }
  return JSON.parse(text);
}

const recorded = await loadReplies();

/** 假的 A2A：按发出去的 op 依次回 replies 里那一条的 JSON（与 Agent「只回工具的 JSON」一致）。 */
function harness(replies, { mode = 'pg' } = {}) {
  const calls = [], logs = [], invalid = [];
  let next = 0;
  const call = async args => {
    calls.push(args);
    const entry = replies[next++];
    assert.ok(entry, `多出来的调用：${args.data[0].op}`);
    assert.equal(args.data[0].op, entry.op, '按记录的顺序发');
    return { text: JSON.stringify(entry.reply), taskId: 't', timings: {} };
  };
  const client = createKbStewardClient({ origin: ORIGIN, publishId: PUB, mode, call, log: line => logs.push(line),
    credentialFor: async () => KEY, markInvalid: async (...args) => { invalid.push(args); } });
  return { client, calls, logs, invalid };
}

test('contract-replies.json 是当前构建跑出来的：协议、后端对，build 与 MANIFEST.json 的 source_commit 相同', async () => {
  assert.equal(recorded.protocol, 'kb.rules/v1');
  assert.equal(recorded.backend, 'pg');
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
  assert.equal(recorded.build, manifest.source_commit, '拼装换了提交：重新跑 local_test.py 生成回复');
});

test('记录里有约定的每一个操作，入库有 ingested 和 skipped，失败有 rule_conflict 和 not_found', () => {
  const ops = new Set(recorded.replies.map(entry => entry.op));
  for (const op of [...CONTRACT_OPS, 'preview']) assert.ok(ops.has(op), `缺 ${op} 的回复`);
  const statuses = recorded.replies.filter(entry => entry.op === 'ingest').map(entry => entry.reply.status ?? entry.reply.error_type);
  assert.deepEqual([...new Set(statuses)].sort(), ['ingested', 'rule_conflict', 'skipped']);
  assert.ok(recorded.replies.some(entry => entry.reply.error_type === 'not_found'));
});

test('describe() 收下 PG 版的回复：backend 是 pg、不记 POC_KB_BACKEND_MISMATCH；ops 只留测试台认识的（有下线、恢复，没有 preview）', async () => {
  const replies = recorded.replies.filter(entry => entry.op === 'describe');
  assert.equal(replies.length, 1);
  assert.ok(replies[0].reply.ops.includes('preview'), '工具的 describe 列出了 preview');
  const { client, calls, logs } = harness(replies);
  const described = await client.describe();
  assert.deepEqual(described, { protocol: 'kb.rules/v1', backend: 'pg',
    ops: ['describe', 'ingest', 'list', 'detail', 'deactivate', 'restore', 'delete', 'check', 'search'] });
  assert.deepEqual(logs, []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${ORIGIN}/a2a/${PUB}`);
  assert.equal(calls[0].key, KEY);
  assert.equal(calls[0].text, 'kb.rules/v1 · describe：只调用对应的工具一次，原样返回工具的 JSON。');
  assert.deepEqual(calls[0].data, [{ op: 'describe' }]);
});

test('每一条回复经 request(op, input) 都原样收下，没有 KB_AGENT_REPLY_INVALID', async () => {
  const replies = recorded.replies.filter(entry => entry.op !== 'describe' && entry.op !== 'preview');
  const { client, calls, invalid } = harness(replies);
  for (const [i, entry] of replies.entries()) {
    const reply = await client.request(entry.op, entry.input).catch(error => assert.fail(`${entry.op} 被拒：${error.code} ${error.reason ?? ''}`));
    assert.deepEqual(reply, entry.reply, `${entry.op} 的回复原样返回`);
    assert.deepEqual(calls[i].data, [{ op: entry.op, ...entry.input }]);
    assert.equal(calls[i].timeoutMs, entry.op === 'ingest' ? 300_000 : 120_000);
  }
  assert.equal(calls.length, replies.length);
  assert.deepEqual(invalid, [], '没有把钥匙标成失效');
});

test('失败的回复（ingest 的 rule_conflict，detail、check 的 not_found）也是合格的失败形态：原样返回 success=false，rule_conflict 带 conflicts', async () => {
  const failed = recorded.replies.filter(entry => entry.reply.success === false);
  assert.deepEqual(failed.map(entry => `${entry.op}:${entry.reply.error_type}`).sort(), ['check:not_found', 'detail:not_found', 'ingest:rule_conflict']);
  const { client } = harness(failed);
  for (const entry of failed) {
    const reply = await client.request(entry.op, entry.input);
    assert.equal(reply.success, false);
    assert.equal(typeof reply.message, 'string');
    assert.equal(reply.error_type, entry.reply.error_type);
    if (reply.error_type === 'rule_conflict') {
      assert.ok(Array.isArray(reply.conflicts) && reply.conflicts.length > 0);
    }
  }
});

test('preview 是 PG 版独有的：测试台客户端不收（TypeError，不发调用）；回复的计数字段与 ingest 相同，另带将新增 / 更新 / 删除的编号', async () => {
  const preview = recorded.replies.find(entry => entry.op === 'preview');
  const { client, calls } = harness([preview]);
  await assert.rejects(client.request('preview', preview.input), TypeError);
  assert.equal(calls.length, 0);
  const reply = preview.reply;
  assert.equal(reply.status, 'previewed');
  assert.equal(reply.source_id, preview.input.source_id);
  for (const key of ['rules_total', 'written', 'removed', 'unchanged']) assert.ok(Number.isInteger(reply[key]) && reply[key] >= 0, key);
  for (const key of ['will_insert', 'will_update', 'will_remove']) assert.ok(Array.isArray(reply[key]), key);
  assert.equal(reply.will_insert.length, reply.rules_total, '空库预览：全部是新增');
});

test('同一批回复改成 S3 Vectors 方式（mode=s3vectors）时，describe 照收但记一行 POC_KB_BACKEND_MISMATCH', async () => {
  const replies = recorded.replies.filter(entry => entry.op === 'describe');
  const { client, logs } = harness(replies, { mode: 's3vectors' });
  const described = await client.describe();
  assert.equal(described.backend, 'pg');
  assert.deepEqual(logs, ['POC_KB_BACKEND_MISMATCH s3vectors pg']);
});

// ─────────────── scripts/a2a_rules.mjs ───────────────

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const byOp = op => recorded.replies.find(entry => entry.op === op);

/** a2a_rules 的一次运行：假的 call 按 answer(args) 回文字；返回退出码、stdout / stderr 的行和发出去的请求。 */
async function cli(argv, { answer, keyText = KEY, url = `${ORIGIN}/a2a/${PUB}`, keyMode = 0o600 } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'a2a-rules-'));
  try {
    const keyFile = path.join(dir, 'a2a-call-key');
    await writeFile(keyFile, `${keyText}\n`);
    await chmod(keyFile, keyMode);
    for (const name of ['制度.docx', '正文.md', '矩阵.xlsx', 'notes.txt']) await writeFile(path.join(dir, name), `虚构内容 ${name}`);
    const calls = [], out = [], err = [];
    const call = async args => { calls.push(args); return { text: await answer(args), taskId: 't', timings: {} }; };
    const code = await run(argv.map(arg => arg.replace('{dir}', dir)), { env: { NEXUS_A2A_URL: url, NEXUS_A2A_KEY_FILE: keyFile }, call,
      out: line => out.push(line), err: line => err.push(line) });
    assert.ok(![...out, ...err].some(line => line.includes(KEY)), '调用密钥不打印');
    return { code, out, err, calls, dir };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a2a_rules：NEXUS_A2A_URL 拆成 origin 与发布编号（测试台的客户端按 origin/a2a/编号 拼回去）', () => {
  assert.deepEqual(parseA2aUrl(`${ORIGIN}/a2a/${PUB}`), { origin: ORIGIN, publishId: PUB });
  assert.deepEqual(parseA2aUrl(`${ORIGIN}/gw/a2a/${PUB}/`), { origin: `${ORIGIN}/gw`, publishId: PUB });
  for (const bad of ['', 'nexus.example/a2a/x', `${ORIGIN}/a2a/`, `${ORIGIN}/mcp/${PUB}`]) assert.throws(() => parseA2aUrl(bad), /NEXUS_A2A_URL/);
});

test('a2a_rules describe：经测试台客户端发，stdout 是工具 JSON 的原文，stderr 列出测试台认的操作；退出码 0', async () => {
  const reply = byOp('describe').reply;
  const { code, out, err, calls } = await cli(['describe'], { answer: () => JSON.stringify(reply) });
  assert.equal(code, 0);
  assert.deepEqual(out, [JSON.stringify(reply)]);
  assert.deepEqual(err, ['测试台认的操作：describe, ingest, list, detail, deactivate, restore, delete, check, search']);
  assert.equal(calls[0].url, `${ORIGIN}/a2a/${PUB}`);
  assert.equal(calls[0].key, KEY);
  assert.deepEqual(calls[0].data, [{ op: 'describe' }]);
});

test('a2a_rules ingest：带文件经测试台客户端发；附件的 MIME 按扩展名（.docx / .md / .xlsx），时限 5 分钟', async () => {
  const entry = recorded.replies.find(e => e.op === 'ingest' && e.reply.success);
  for (const [name, mime] of [['制度.docx', DOCX], ['正文.md', 'text/markdown'],
    ['矩阵.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']]) {
    const { code, out, calls } = await cli(['ingest', JSON.stringify(entry.input), `{dir}/${name}`], { answer: () => JSON.stringify(entry.reply) });
    assert.equal(code, 0, name);
    assert.deepEqual(JSON.parse(out[0]), entry.reply);
    assert.equal(calls[0].timeoutMs, 300_000);
    assert.equal(calls[0].files.length, 1);
    assert.equal(calls[0].files[0].name, name);
    assert.equal(calls[0].files[0].mimeType, mime);
    assert.equal(calls[0].files[0].bytes.toString(), `虚构内容 ${name}`);
    assert.deepEqual(calls[0].data, [{ op: 'ingest', ...entry.input }]);
  }
});

test('a2a_rules preview：不在测试台的 SHAPES 里，直接用 a2aCall 发同样格式的请求（文字、数据 Part、文件 Part）', async () => {
  const entry = byOp('preview');
  const { code, out, err, calls } = await cli(['preview', JSON.stringify(entry.input), '{dir}/制度.docx'], { answer: () => JSON.stringify(entry.reply) });
  assert.equal(code, 0);
  assert.deepEqual(err, []);
  assert.deepEqual(JSON.parse(out[0]), entry.reply);
  assert.equal(calls[0].text, 'kb.rules/v1 · preview：只调用对应的工具一次，原样返回工具的 JSON。');
  assert.deepEqual(calls[0].data, [{ op: 'preview', ...entry.input }]);
  assert.equal(calls[0].files[0].mimeType, DOCX);
  assert.equal(calls[0].timeoutMs, 300_000);
  const wrong = await cli(['preview', JSON.stringify(entry.input), '{dir}/制度.docx'], { answer: () => JSON.stringify(byOp('ingest').reply) });
  assert.equal(wrong.code, 3, 'success=true 却不是 previewed：不是 preview 的回复');
});

test('a2a_rules：工具回 success=false 照样打印、退出码 1；围栏去掉；回复不合格退出码 3、原文写到 stderr', async () => {
  const notFound = recorded.replies.find(e => e.reply.error_type === 'not_found');
  const failed = await cli(['detail', JSON.stringify(notFound.input)], { answer: () => `\`\`\`json\n${JSON.stringify(notFound.reply)}\n\`\`\`` });
  assert.equal(failed.code, 1);
  assert.deepEqual(JSON.parse(failed.out[0]), notFound.reply);
  const invalid = await cli(['list'], { answer: () => '好的，下面是制度清单：……' });
  assert.equal(invalid.code, 3);
  assert.deepEqual(invalid.out, []);
  assert.equal(invalid.err[0], 'KB_AGENT_REPLY_INVALID（not_json）');
  assert.match(invalid.err[1], /^回复原文：好的/);
  const rejected = await cli(['list'], { answer: () => { throw Object.assign(new Error('x'), { code: 'AI_AUTH_INVALID', detail: { status: 401 } }); } });
  assert.equal(rejected.code, 3);
  assert.match(rejected.err.join('\n'), /KB_AGENT_KEY_REJECTED/);
});

test('a2a_rules：约定之外的 op 照样直接发（验证 Agent 回 invalid_parameter），stderr 提醒一句', async () => {
  const reply = { success: false, error_type: 'invalid_parameter', message: '不支持的规则请求：frobnicate' };
  const { code, out, err, calls } = await cli(['frobnicate'], { answer: () => JSON.stringify(reply) });
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(out[0]), reply);
  assert.match(err[0], /frobnicate 不是约定里的操作/);
  assert.deepEqual(calls[0].data, [{ op: 'frobnicate' }]);
});

test('a2a_rules：用法与配置不对时退出码 2、不发调用；钥匙文件权限太宽只提醒', async () => {
  const never = () => assert.fail('不该发调用');
  const cases = [
    [[], /用法/], [['ingest', '{"source_id": "x"}'], /要带一个文件/], [['list', '{}', '{dir}/制度.docx'], /只有 ingest/],
    [['search', 'question=合同'], /不是合法的 JSON/], [['search', '["x"]'], /要是一个对象/], [['search', '{"op": "list"}'], /不要写 op/],
    [['ingest', '{"source_id": "x"}', '{dir}/notes.txt'], /只收/], [['ingest', '{"source_id": "x"}', '{dir}/没有这个.docx'], /读不到文件/],
    [['Bad-Op'], /op 不合规/],
  ];
  for (const [argv, message] of cases) {
    const { code, err, calls } = await cli(argv, { answer: never });
    assert.equal(code, 2, argv.join(' '));
    assert.match(err.join('\n'), message);
    assert.equal(calls.length, 0);
  }
  assert.equal((await cli(['list'], { answer: never, url: 'https://nexus.example/' })).code, 2);
  const notKey = await cli(['list'], { answer: never, keyText: 'password123' });
  assert.equal(notKey.code, 2);
  assert.match(notKey.err[0], /不像调用密钥/);
  assert.ok(!notKey.err[0].includes('password123'));
  const loose = await cli(['list'], { answer: () => JSON.stringify(byOp('list').reply), keyMode: 0o644 });
  assert.equal(loose.code, 0);
  assert.match(loose.err[0], /权限太宽/);
});

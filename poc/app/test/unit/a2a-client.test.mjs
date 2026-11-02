import test from 'node:test';
import assert from 'node:assert/strict';
import { a2aCall, a2aStream, buildPrompt, unwrapJson } from '../../lib/a2a-client.mjs';
import { answerEvents, rejectJson, startFakeA2a, writeEvents } from './helpers/fake-a2a.mjs';
import { waitUntil } from './helpers/wait.mjs';

test('流式调用返回 answer 全文，带 Bearer 调用密钥，每次用新的会话', async t => {
  const fake = await startFakeA2a(({ res }) => writeEvents(res, answerEvents('{"ok":true}')));
  t.after(() => fake.close());
  const first = await a2aStream({ url: fake.url, key: 'nxa_test_key', text: 'hello' });
  await a2aStream({ url: fake.url, key: 'nxa_test_key', text: 'again' });
  assert.equal(first.text, '{"ok":true}');
  assert.equal(first.taskId, 'task-1');
  assert.ok(first.timings.done >= first.timings.headers);
  const [one, two] = fake.requests;
  assert.equal(one.headers.authorization, 'Bearer nxa_test_key');
  assert.equal(one.body.method, 'message/stream');
  assert.equal(one.body.params.message.parts[0].text, 'hello');
  assert.notEqual(one.body.params.message.contextId, two.body.params.message.contextId);
});

test('分块追加的回答按 append 拼接', async t => {
  const events = [
    { jsonrpc: '2.0', id: 'rpc', result: { kind: 'task', id: 'task-2', status: { state: 'working' } } },
    { jsonrpc: '2.0', id: 'rpc', result: { kind: 'artifact-update', taskId: 'task-2', artifact: { name: 'answer', parts: [{ kind: 'text', text: 'ab' }] }, append: false } },
    { jsonrpc: '2.0', id: 'rpc', result: { kind: 'artifact-update', taskId: 'task-2', artifact: { name: 'answer', parts: [{ kind: 'text', text: 'cd' }] }, append: true, lastChunk: true } },
    { jsonrpc: '2.0', id: 'rpc', result: { kind: 'status-update', taskId: 'task-2', status: { state: 'completed' }, final: true } },
  ];
  const fake = await startFakeA2a(({ res }) => writeEvents(res, events));
  t.after(() => fake.close());
  assert.equal((await a2aStream({ url: fake.url, key: 'k', text: 'x' })).text, 'abcd');
});

test('网关拒绝按第四轮的映射转成九安的错误码', async t => {
  const cases = [[401, 'credential_invalid', 'AI_AUTH_INVALID'], [404, 'publication_not_found', 'AI_AUTH_INVALID'], [429, 'rate_limited', 'AI_RATE_LIMIT'],
    [429, 'budget_exceeded', 'AI_UNAVAILABLE'], [413, 'payload_too_large', 'AI_REQUEST_INVALID'], [503, 'gateway_unavailable', 'AI_UNAVAILABLE']];
  let index = 0;
  const fake = await startFakeA2a(({ res }) => { const [status, code] = cases[index++]; rejectJson(res, status, code); });
  t.after(() => fake.close());
  for (const [status, code, expected] of cases) await assert.rejects(a2aStream({ url: fake.url, key: 'k', text: 'x' }), { code: expected }, `${status} ${code}`);
});

test('流里的 JSON-RPC 错误、任务失败与任务取消', async t => {
  const scripts = [
    [{ jsonrpc: '2.0', id: 'rpc', error: { code: -32012, message: 'rate limited', data: { code: 'rate_limited' } } }],
    [{ jsonrpc: '2.0', id: 'rpc', result: { kind: 'status-update', taskId: 't', status: { state: 'failed' }, metadata: { error_code: 'timeout' }, final: true } }],
    [{ jsonrpc: '2.0', id: 'rpc', result: { kind: 'status-update', taskId: 't', status: { state: 'canceled' }, final: true } }],
  ];
  let index = 0;
  const fake = await startFakeA2a(({ res }) => writeEvents(res, scripts[index++]));
  t.after(() => fake.close());
  await assert.rejects(a2aStream({ url: fake.url, key: 'k', text: 'x' }), { code: 'AI_RATE_LIMIT' });
  await assert.rejects(a2aStream({ url: fake.url, key: 'k', text: 'x' }), { code: 'AI_UNAVAILABLE' });
  await assert.rejects(a2aStream({ url: fake.url, key: 'k', text: 'x' }), { code: 'AI_CANCELLED' });
});

test('流结束了却没有 completed：AI_OUTPUT_TRUNCATED', async t => {
  const [task, artifact] = answerEvents('half');
  const fake = await startFakeA2a(({ res }) => writeEvents(res, [task, { ...artifact, result: { ...artifact.result, lastChunk: false } }]));
  t.after(() => fake.close());
  await assert.rejects(a2aStream({ url: fake.url, key: 'k', text: 'x' }), { code: 'AI_OUTPUT_TRUNCATED' });
});

test('连不上网关：AI_NETWORK', async () => {
  await assert.rejects(a2aStream({ url: 'http://127.0.0.1:9/a2a/pub_none', key: 'k', text: 'x' }), { code: 'AI_NETWORK' });
});

test('调用方中止：AI_CANCELLED，并向网关发 tasks/cancel', async t => {
  const fake = await startFakeA2a(({ res }) => writeEvents(res, [answerEvents('x')[0]], { end: false }));
  t.after(() => fake.close());
  const controller = new AbortController();
  const pending = a2aStream({ url: fake.url, key: 'k', text: 'x', signal: controller.signal });
  await waitUntil(() => fake.requests.length === 1);
  await new Promise(resolve => setTimeout(resolve, 50)); // 让客户端读到 task 事件、记下任务编号
  controller.abort();
  await assert.rejects(pending, { code: 'AI_CANCELLED' });
  const cancel = await waitUntil(() => fake.requests.find(request => request.body?.method === 'tasks/cancel'));
  assert.equal(cancel.body.params.id, 'task-1');
});

test('a2aCall：总时限到了算 AI_UNAVAILABLE（timeout），调用方自己中止仍是 AI_CANCELLED', async t => {
  const fake = await startFakeA2a(({ res }) => writeEvents(res, [answerEvents('x')[0]], { end: false }));
  t.after(() => fake.close());
  await assert.rejects(a2aCall({ url: fake.url, key: 'k', text: 'x', timeoutMs: 200 }),
    error => error.code === 'AI_UNAVAILABLE' && error.detail?.reason === 'timeout');
  const controller = new AbortController();
  const pending = a2aCall({ url: fake.url, key: 'k', text: 'x', signal: controller.signal, timeoutMs: 10_000 });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(pending, { code: 'AI_CANCELLED' });
});

test('unwrapJson 只剥一层 ```json 代码围栏，并如实报告', () => {
  assert.deepEqual(unwrapJson('```json\n{"a":1}\n```'), { text: '{"a":1}', fenced: true });
  assert.deepEqual(unwrapJson('```\n[1]\n```'), { text: '[1]', fenced: true });
  assert.deepEqual(unwrapJson('  {"a":1} '), { text: '{"a":1}', fenced: false });
});

test('提示词把任务说明、输出 schema 和输入分段放入', () => {
  const prompt = buildPrompt('任务', { type: 'object' }, '{"x":1}');
  assert.match(prompt, /^<task>\n任务\n<\/task>/);
  assert.match(prompt, /<output_schema>\n\{"type":"object"\}\n<\/output_schema>/);
  assert.match(prompt, /<input>\n\{"x":1\}\n<\/input>$/);
});

test('提示词带上输出规则：只输出一个 JSON 对象；字符串里不用英文双引号，引用时用「」（Agent 曾在字符串里写未转义的双引号，九安拒收）', () => {
  const prompt = buildPrompt('任务', { type: 'object' }, '{"x":1}');
  const rules = prompt.match(/<output_rules>\n([\s\S]*?)\n<\/output_rules>/)?.[1];
  assert.ok(rules, '要有 <output_rules> 一段');
  assert.match(rules, /只输出一个 JSON 对象/);
  assert.match(rules, /英文双引号/);
  assert.match(rules, /「」/);
  assert.ok(prompt.indexOf('<output_rules>') > prompt.indexOf('</output_schema>') && prompt.indexOf('<output_rules>') < prompt.indexOf('<input>'), '规则放在 schema 之后、输入之前');
});

test('附件作为 A2A 0.3 文件 Part 跟在文字后面：文件名、类型与 base64 内容', async t => {
  const fake = await startFakeA2a(({ res }) => writeEvents(res, answerEvents('{"ok":true}')));
  t.after(() => fake.close());
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  await a2aCall({ url: fake.url, key: 'k', text: '请看附件里的发票', files: [{ name: '发票.png', mimeType: 'image/png', bytes: png, size: png.length, sha256: 'x' }] });
  const parts = fake.requests[0].body.params.message.parts;
  assert.deepEqual(parts, [
    { kind: 'text', text: '请看附件里的发票' },
    { kind: 'file', file: { name: '发票.png', mimeType: 'image/png', bytes: png.toString('base64') } },
  ]);
});

test('Nexus 拒绝附件（0.3 预检的 JSON 应答，或流里的 -32005 / -32602）：AI_REQUEST_INVALID，并带回 Nexus 的错误码', async t => {
  const replies = [
    res => { res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 'rpc', error: { code: -32005, message: 'not supported', data: { code: 'attachment_type_not_supported' } } })); },
    res => writeEvents(res, [{ jsonrpc: '2.0', id: 'rpc', error: { code: -32602, message: 'too large', data: { code: 'attachments_too_large' } } }]),
    res => writeEvents(res, [{ jsonrpc: '2.0', id: 'rpc', error: { code: -32005, message: 'not supported', data: { code: 'attachment_url_not_supported' } } }]),
  ];
  let index = 0;
  const fake = await startFakeA2a(({ res }) => replies[index++](res));
  t.after(() => fake.close());
  for (const expected of ['attachment_type_not_supported', 'attachments_too_large', 'attachment_url_not_supported']) {
    await assert.rejects(a2aStream({ url: fake.url, key: 'k', text: 'x' }), error => error.code === 'AI_REQUEST_INVALID' && error.detail?.code === expected, expected);
  }
});

test('可以带 DataPart：顺序是文字、数据、文件（九安的请求信封就是这样发的）', async t => {
  const fake = await startFakeA2a(({ res }) => writeEvents(res, answerEvents('{"ok":true}')));
  t.after(() => fake.close());
  const envelope = { envelope: 'jiuan.agent/v1', task: 'describe' };
  await a2aCall({ url: fake.url, key: 'k', text: '说明', data: [envelope], timeoutMs: 5000 });
  assert.deepEqual(fake.requests[0].body.params.message.parts, [{ kind: 'text', text: '说明' }, { kind: 'data', data: envelope }]);
});

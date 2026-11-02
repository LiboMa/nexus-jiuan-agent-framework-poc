/** 本机假 A2A 网关：只监听 127.0.0.1，按测试给的处理函数回放 SSE 事件，并记录收到的每个请求。tasks/cancel 一律应答成功。 */
import { createServer } from 'node:http';

export async function startFakeA2a(handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { body = null; }
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    if (body?.method === 'tasks/cancel') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { id: body.params?.id } }));
      return;
    }
    await handler({ req, res, body, requests });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, url: `${origin}/a2a/pub_test`, requests,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

export function writeEvents(res, events, { end = true } = {}) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
  if (end) res.end();
}

export function answerEvents(text, { taskId = 'task-1' } = {}) {
  return [
    { jsonrpc: '2.0', id: 'rpc', result: { kind: 'task', id: taskId, status: { state: 'working' } } },
    { jsonrpc: '2.0', id: 'rpc', result: { kind: 'artifact-update', taskId, artifact: { name: 'answer', parts: [{ kind: 'text', text }] }, append: false, lastChunk: true } },
    { jsonrpc: '2.0', id: 'rpc', result: { kind: 'status-update', taskId, status: { state: 'completed' }, final: true } },
  ];
}

export function rejectJson(res, status, code) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: code, data: { code } } }));
}

/**
 * 经 A2A 调用「知识库文档管家（S3 Vectors 版）」的最小客户端（Node 18+，无依赖）。
 * 协议与 audit-nexus 的 poc/app07/lib/a2a-client.mjs 相同（A2A 0.3 JSON-RPC message/stream + SSE，已在 Nexus 实测）：
 * 一行说明文字 + 可选的文件 Part（base64）。回答取名为 answer 的产出物的全文。
 *
 * 环境变量：NEXUS_A2A_URL = https://<env>.<domain>/a2a/<publish_id>
 *          NEXUS_A2A_KEY_FILE = 存调用密钥（nxa_…）的 600 文件（推荐），或 NEXUS_A2A_KEY = 密钥本身；都不打印
 * 命令行：
 *   node a2a_kb_client.mjs ingest <文件> [标签,…]      上传并入库（write_strategy=skip，同一内容不会重复写入）
 *   node a2a_kb_client.mjs ask "<问题>"                 检索并作答（带来源）
 *   node a2a_kb_client.mjs stats                        知识库概览
 * 作为模块：import { askKb, ingestFile } from './a2a_kb_client.mjs'
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

const MIME = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pdf': 'application/pdf',
};
// 要结构化结果时让 Agent 只回 JSON；字段名与工具返回值一致，页面可以直接用
const JSON_RULE = '只输出一个 JSON 对象，不加任何说明文字；字符串里需要引号时用中文引号「」。';

async function* sseEvents(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut;
    while ((cut = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut).replace(/^\r?\n\r?\n/, '');
      const data = block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
      if (data) yield data;
    }
  }
}

/** 一次调用：返回 { text, taskId }；失败抛 Error（message 不含密钥）。 */
const envKey = () => process.env.NEXUS_A2A_KEY_FILE
  ? readFileSync(process.env.NEXUS_A2A_KEY_FILE, 'utf8').trim() : process.env.NEXUS_A2A_KEY;

export async function a2aCall({ url = process.env.NEXUS_A2A_URL, key = envKey(), text, files = [], timeoutMs = 300_000 }) {
  if (!url || !key) throw new Error('需要 NEXUS_A2A_URL，以及 NEXUS_A2A_KEY_FILE 或 NEXUS_A2A_KEY');
  const body = {
    jsonrpc: '2.0', id: randomUUID(), method: 'message/stream',
    params: { message: { kind: 'message', messageId: randomUUID(), contextId: randomUUID(), role: 'user', parts: [
      { kind: 'text', text },
      ...files.map(f => ({ kind: 'file', file: { name: f.name, mimeType: f.mimeType, bytes: f.bytes.toString('base64') } })),
    ] } },
  };
  const res = await fetch(url, {
    method: 'POST', signal: AbortSignal.timeout(timeoutMs), body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: `Bearer ${key}` },
  });
  if (!res.ok || !(res.headers.get('content-type') || '').includes('text/event-stream')) {
    let code = '';
    try { const j = await res.json(); code = j?.error?.data?.code || j?.detail || ''; } catch { /* 非 JSON */ }
    throw new Error(`A2A 请求被拒绝：HTTP ${res.status} ${code}`);
  }
  let answer = '', taskId = null, state = null, failure = '';
  for await (const data of sseEvents(res.body)) {
    let msg;
    try { msg = JSON.parse(data); } catch { continue; }
    if (msg.error) throw new Error(`A2A 错误 ${msg.error.code} ${msg.error?.data?.code || ''}`);
    const r = msg.result || {};
    if (r.kind === 'task') { taskId = r.id; state = r.status?.state; }
    else if (r.kind === 'status-update') {
      taskId = r.taskId || taskId; state = r.status?.state;
      if (['failed', 'rejected', 'canceled'].includes(state)) {
        failure = (r.status?.message?.parts || []).map(p => p.text).join('') || r.metadata?.error_code || state;
      }
      if (r.final) break;
    } else if (r.kind === 'artifact-update') {
      const part = (r.artifact?.parts || []).filter(p => p.kind === 'text').map(p => p.text).join('');
      answer = r.append ? answer + part : part;
    }
  }
  if (failure) throw new Error(`任务未完成：${failure}`);
  if (state !== 'completed') throw new Error(`回答不完整（state=${state}）`);
  return { text: answer, taskId };
}

/** 去掉偶尔出现的 ```json 围栏后解析。 */
export function parseJson(text) {
  const m = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/u.exec(String(text).trim());
  return JSON.parse(m ? m[1] : String(text).trim());
}

export async function ingestFile(path, tags = []) {
  const name = basename(path);
  const mimeType = MIME[extname(name).toLowerCase()];
  if (!mimeType) throw new Error('只支持 .docx / .xlsx / .pdf');
  const bytes = await readFile(path);
  const text = `请把附件「${name}」入库：一步入库，write_strategy=skip${tags.length ? `，tags=${JSON.stringify(tags)}` : ''}。` +
    `完成后${JSON_RULE}字段：success, doc_id, file_name, written_chunks, status, dedup_status, error_type, message。`;
  return parseJson((await a2aCall({ text, files: [{ name, mimeType, bytes }] })).text);
}

export async function askKb(question) {
  const text = `请在知识库中检索并回答：${question}\n` +
    `${JSON_RULE}字段：answer（中文作答）, sources（数组，每项 file_name, chunk_index, similarity_score）, found（布尔）。`;
  return parseJson((await a2aCall({ text })).text);
}

export async function kbStats() {
  return parseJson((await a2aCall({ text: `请给出知识库概览（dashboard_stats）。${JSON_RULE}字段与工具返回值相同。` })).text);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, arg, tags] = process.argv.slice(2);
  const run = { ingest: () => ingestFile(arg, tags ? tags.split(',') : []), ask: () => askKb(arg), stats: () => kbStats() }[cmd];
  if (!run) { console.error('用法：node a2a_kb_client.mjs ingest <文件> [标签,…] | ask "<问题>" | stats'); process.exit(2); }
  run().then(r => console.log(JSON.stringify(r, null, 2))).catch(e => { console.error(e.message); process.exit(1); });
}

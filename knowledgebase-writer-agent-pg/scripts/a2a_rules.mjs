#!/usr/bin/env node
/**
 * 经 A2A 给「知识库文档管家（PG 版）」发一次规则请求（kb.rules/v1），打印工具回的 JSON。冒烟与端到端测试用。
 *
 *   node knowledgebase-writer-agent-pg/scripts/a2a_rules.mjs <op> [JSON 参数] [文件]
 *     … describe
 *     … list
 *     … search  '{"question": "合同用印 审批", "top_k": 3}'
 *     … preview '{"source_id": "fin-approval-demo", "title": "某虚构集团财务审批授权办法"}' 制度.docx
 *     … ingest  '{"source_id": "fin-approval-demo", "source_version": "V1", "title": "某虚构集团财务审批授权办法"}' 制度.docx
 *
 * 环境变量：NEXUS_A2A_URL      = https://<env>.<domain>/a2a/<publish_id>
 *          NEXUS_A2A_KEY_FILE = 调用密钥（nxa_…）的 600 文件；不设就用本包的 .state/a2a-call-key（admin_run.sh issue-call-key 写的）。
 *          调用密钥只从文件读进内存，不打印、不进命令行。
 * - 约定里的操作经测试台的客户端 createKbStewardClient（poc/app07/kb-steward-client.mjs）发，与九安「制度知识库」页同一条路：
 *   同样的文字与数据 Part、同样的时限（ingest 5 分钟，其余 2 分钟），回复按它的 SHAPES / failedShape 校验；describe 走它的 describe()。
 * - preview 是 PG 版独有的、不在测试台的 SHAPES 里；约定之外的 op（用来验证 Agent 回 invalid_parameter）也一样：
 *   都直接用 poc/app/nexus/a2a-client.mjs 的 a2aCall 发同样格式的请求，只查回复是一个带 success 的 JSON 对象。
 * - 附件的 MIME 按扩展名定（.docx / .xlsx / .pdf / .md）：测试台只发 .docx，这里四种都能发。
 * 输出：stdout 一行工具的 JSON（去掉模型偶尔加的 ```json 围栏，其余原样）；测试台认的操作、校验没过的原因写到 stderr。
 * 退出码：0 工具回 success=true；1 工具回 success=false（JSON 照样打印）；2 用法或配置不对；3 调用失败或回复没过校验。
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { a2aCall, keyRejected, unwrapJson } from '../../poc/app/nexus/a2a-client.mjs';
import { createKbStewardClient } from '../../poc/app07/kb-steward-client.mjs';

const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_KEY_FILE = path.join(PKG, '.state', 'a2a-call-key');
const PROTOCOL = 'kb.rules/v1';
/** 测试台客户端收的操作（它的 SHAPES 加 describe）；其余的直接用 a2aCall 发。 */
const CLIENT_OPS = new Set(['describe', 'ingest', 'list', 'detail', 'deactivate', 'restore', 'delete', 'check', 'search']);
const WITH_FILE = new Set(['ingest', 'preview']);
const MIME = Object.freeze({
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pdf': 'application/pdf',
  '.md': 'text/markdown',
});
const RAW_TIMEOUT_MS = Object.freeze({ preview: 300_000 });
const DEFAULT_TIMEOUT_MS = 120_000;
const USAGE = '用法：a2a_rules.mjs <op> [JSON 参数] [文件]（ingest / preview 要带文件）；环境变量 NEXUS_A2A_URL、NEXUS_A2A_KEY_FILE';

class UsageError extends Error {}

/** https://<host>[/前缀]/a2a/<publish_id> → { origin, publishId }（测试台的客户端按 `${origin}/a2a/${publishId}` 拼回去）。 */
export function parseA2aUrl(url) {
  const match = /^(https?:\/\/[^/?#]+(?:\/[^?#]*?)?)\/a2a\/([A-Za-z0-9_-]+)\/?$/u.exec(String(url ?? '').trim());
  if (!match) throw new UsageError('NEXUS_A2A_URL 应是 https://<env>.<domain>/a2a/<publish_id>');
  return { origin: match[1], publishId: match[2] };
}

const mimeOf = name => MIME[path.extname(name).toLowerCase()];

async function readKey(file, warn) {
  let text, info;
  try { [text, info] = await Promise.all([readFile(file, 'utf8'), stat(file)]); }
  catch { throw new UsageError(`读不到调用密钥文件 ${file}（设 NEXUS_A2A_KEY_FILE，或先 admin_run.sh issue-call-key）`); }
  if (info.mode & 0o077) warn(`调用密钥文件 ${file} 的权限太宽（应为 600）`);
  const key = text.trim();
  if (!/^nxa_[A-Za-z0-9_-]+$/u.test(key)) throw new UsageError(`${file} 里不像调用密钥（应以 nxa_ 开头）`);
  return key;
}

function parseArgs(argv) {
  const [op, second, third, ...rest] = argv;
  if (!op || rest.length) throw new UsageError(USAGE);
  if (!/^[a-z][a-z_]{0,31}$/u.test(op)) throw new UsageError(`op 不合规：${op}`);
  let input = {};
  if (second !== undefined) {
    try { input = JSON.parse(second); } catch { throw new UsageError(`JSON 参数不是合法的 JSON：${second}`); }
    if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new UsageError('JSON 参数要是一个对象，如 {"source_id": "…"}');
    if ('op' in input) throw new UsageError('JSON 参数里不要写 op：它由第一个参数给');
  }
  if (WITH_FILE.has(op) && third === undefined) throw new UsageError(`${op} 要带一个文件（.docx / .xlsx / .pdf / .md）`);
  if (!WITH_FILE.has(op) && third !== undefined) throw new UsageError('只有 ingest / preview 带文件');
  if (third !== undefined && !mimeOf(third)) throw new UsageError(`只收 ${Object.keys(MIME).join(' / ')}：${third}`);
  return { op, input, filePath: third };
}

/** 回复的文字 → 工具的 JSON 文本与对象（不是带 success 的 JSON 对象时 reply 为 null）。 */
function toolJson(text) {
  const body = unwrapJson(text).text;
  try {
    const reply = JSON.parse(body);
    return { body, reply: reply && typeof reply === 'object' && !Array.isArray(reply) && typeof reply.success === 'boolean' ? reply : null };
  } catch {
    return { body, reply: null };
  }
}

/**
 * 发一次，返回退出码。call / env / out / err 可替换（测试用假的 call，不出网）。
 */
export async function run(argv, { env = process.env, call = a2aCall, out = line => process.stdout.write(`${line}\n`),
  err = line => process.stderr.write(`${line}\n`) } = {}) {
  let op, input, filePath, origin, publishId, key, file = null;
  try {
    ({ op, input, filePath } = parseArgs(argv));
    ({ origin, publishId } = parseA2aUrl(env.NEXUS_A2A_URL));
    key = await readKey(env.NEXUS_A2A_KEY_FILE || DEFAULT_KEY_FILE, err);
    if (filePath) {
      try { file = { name: path.basename(filePath), bytes: await readFile(filePath) }; }
      catch { throw new UsageError(`读不到文件 ${filePath}`); }
    }
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    err(error.message);
    return 2;
  }

  let raw = null;
  // 附件按扩展名给 MIME（测试台的客户端一律写 .docx 的）；记下这一轮回的原文，打印的是它
  const send = async args => {
    const answer = await call({ ...args, files: (args.files ?? []).map(f => ({ ...f, mimeType: mimeOf(f.name) ?? f.mimeType })) });
    raw = answer?.text;
    return answer;
  };
  const finish = () => {
    const { body, reply } = toolJson(raw);
    out(body);
    return reply?.success === true ? 0 : 1;
  };

  if (!CLIENT_OPS.has(op)) {
    if (op !== 'preview') err(`${op} 不是约定里的操作：照样发，Agent 应回 invalid_parameter（不调工具）`);
    try {
      await send({ url: `${origin}/a2a/${publishId}`, key, text: `${PROTOCOL} · ${op}：只调用对应的工具一次，原样返回工具的 JSON。`,
        data: [{ op, ...input }], files: file ? [{ name: file.name, bytes: file.bytes }] : [], timeoutMs: RAW_TIMEOUT_MS[op] ?? DEFAULT_TIMEOUT_MS });
    } catch (error) {
      err(keyRejected(error) ? '调用密钥被拒（AI_AUTH_INVALID）：在 Nexus 上检查这把钥匙' : `调用失败：${error?.code ?? 'A2A_FAILED'}`);
      return 3;
    }
    const { body, reply } = toolJson(raw);
    if (!reply || (op === 'preview' && reply.success && (reply.status !== 'previewed' || reply.source_id !== input.source_id))) {
      err(`回复不是 ${op} 的工具 JSON：${body.slice(0, 2000)}`);
      return 3;
    }
    return finish();
  }

  // 只发一次：钥匙被拒时客户端调 markInvalid，这里不用记，报 KB_AGENT_KEY_REJECTED 即可
  const client = createKbStewardClient({ origin, publishId, mode: 'pg', call: send, log: err,
    credentialFor: async () => key, markInvalid: async () => {} });
  try {
    if (op === 'describe') {
      const described = await client.describe();
      err(`测试台认的操作：${described.ops.join(', ')}`);
    } else {
      await client.request(op, input, file);
    }
  } catch (error) {
    const reason = error?.reason ? `（${error.reason}）` : '';
    err(error?.code === 'KB_AGENT_KEY_REJECTED' ? '调用密钥被拒（KB_AGENT_KEY_REJECTED）：在 Nexus 上检查这把钥匙'
      : `${error?.code ?? 'KB_UNAVAILABLE'}${reason}`);
    if (error?.code === 'KB_AGENT_REPLY_INVALID' && raw != null) err(`回复原文：${String(raw).slice(0, 2000)}`);
    return 3;
  }
  return finish();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await run(process.argv.slice(2));
}

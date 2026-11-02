/**
 * 「公司制度」经 A2A 调知识库 Agent 的发布（两种知识库方式共用一套）：pg 方式是 PG 知识库 Agent（约定见
 * docs/specs/2026-10-30-pg-knowledgebase-agent-contract.md），s3vectors 方式是知识库文档管家（它提示词的「规则请求」一节）。约定 kb.rules/v1：
 *   文字 `kb.rules/v1 · <op>：只调用对应的工具一次，原样返回工具的 JSON。` + 数据 Part `{ op, …input }`（+ ingest 的 .docx 文件 Part）。
 *   op：describe（这个 Agent 支持哪些操作）、ingest、list、detail、deactivate、restore、delete、check、search；ingest 限时 5 分钟，其余 2 分钟。
 *   Agent 只回工具的 JSON：这里去掉偶尔的 ```json 围栏后 JSON.parse，按 op 校验形态；不合格抛 KB_AGENT_REPLY_INVALID，不重试。
 *   JSON 前面偶尔多一句引导语（模型在调工具前先说一句，A2A 把各段文字拼在一起）：短的、不含 { } 的引导语照样收下，记一行警告（readReply）。
 * describe 的结果缓存 5 分钟（同时来的几次共用一轮）；protocol 不是 kb.rules/v1、工具失败都算不合格。钥匙被拒或哪一次回复不合格就清缓存，没问成的不缓存。
 *   例外：Agent 回的是「不认识这个 op」（success=false、error_type=invalid_parameter，还没有 describe 的 Agent 都这样回）时，用这种方式的
 *   缺省操作（FALLBACK_OPS），和 describe 的结果一样缓存。describe 回的 backend 和方式对不上时记一行 POC_KB_BACKEND_MISMATCH <方式> <backend>，别的照常。
 * 部署配置里没有发布编号（publishId 为 null）：configured 为 false，ready() 回 false，describe / request 抛 KB_AGENT_NOT_CONFIGURED——不取钥匙、不发调用。
 * 调用密钥只经「Agent 接入」页启用（credentialFor）；没有就抛 KB_AGENT_NOT_READY、不发调用。Nexus 不认这把钥匙（401 / credential_invalid）
 * 时 markInvalid 一次后抛 KB_AGENT_KEY_REJECTED；之后 credentialFor 回 null，不会反复重试。别的调用失败（超时、404、5xx）抛 KB_UNAVAILABLE。
 * 抛出的错误只带错误码（reason 是 A2A 的错误码或校验没过的那一项），不带回复的内容和钥匙。
 */
import { a2aCall, keyRejected, unwrapJson } from './lib/a2a-client.mjs';
import { DOCX } from './kb-docx.mjs';

const PROTOCOL = 'kb.rules/v1';
const KNOWN_OPS = Object.freeze(['describe', 'ingest', 'list', 'detail', 'deactivate', 'restore', 'delete', 'check', 'search']);
/** Agent 不认识 describe 时按方式取的操作：s3vectors = 文档管家的规则工具全部支持；pg = 约定里必须有的那几个（没有下线 / 恢复）。 */
const FALLBACK_OPS = Object.freeze({
  s3vectors: KNOWN_OPS,
  pg: Object.freeze(['describe', 'ingest', 'list', 'detail', 'delete', 'check', 'search']),
});
const DESCRIBE_TTL_MS = 5 * 60_000;
const TIMEOUT_MS = Object.freeze({ ingest: 300_000 });
const DEFAULT_TIMEOUT_MS = 120_000;
const failure = (code, reason) => Object.assign(new Error(code), { code, ...(reason ? { reason } : {}) });
/** 这两种失败说明 Agent 那边变了（换了钥匙、换了版本）：describe 的缓存作废。 */
const STALE = new Set(['KB_AGENT_KEY_REJECTED', 'KB_AGENT_REPLY_INVALID']);

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = value => Number.isInteger(value) && value >= 0;
const isText = value => typeof value === 'string';
const sameSource = (reply, input) => reply.source_id === input.source_id;
/** 成功时各 op 的回复形态（工具的返回值；两种方式字段相同，见 s3vectors_rules_tools.py 和 PG 知识库 Agent 的约定）。 */
const SHAPES = Object.freeze({
  describe: reply => reply.protocol === PROTOCOL && isText(reply.backend) && Array.isArray(reply.ops) && reply.ops.every(isText),
  ingest: (reply, input) => ['ingested', 'skipped'].includes(reply.status) && sameSource(reply, input) && isText(reply.source_version)
    && ['rules_total', 'written', 'removed', 'unchanged'].every(key => isCount(reply[key])) && Array.isArray(reply.conflicts)
    && (reply.report === undefined || isObject(reply.report)),
  list: reply => Array.isArray(reply.sources) && reply.sources.every(source => isObject(source) && isText(source.source_id)),
  detail: (reply, input) => isObject(reply.source) && sameSource(reply.source, input) && Array.isArray(reply.rule_ids),
  deactivate: (reply, input) => sameSource(reply, input) && isCount(reply.affected),
  restore: (reply, input) => sameSource(reply, input) && isCount(reply.affected),
  delete: (reply, input) => sameSource(reply, input) && isCount(reply.affected),
  check: reply => typeof reply.ok === 'boolean' && Array.isArray(reply.problems),
  search: reply => isObject(reply.filter) && Array.isArray(reply.results) && reply.results.every(hit => isObject(hit) && isText(hit.rule_id)),
});
/** 工具自己的失败（success=false）也是合格的回复：要有 error_type 和 message；rule_conflict 另带 conflicts。 */
const failedShape = reply => isText(reply.error_type) && isText(reply.message) && (reply.conflicts === undefined || Array.isArray(reply.conflicts));

/** 引导语最长多少字：Agent 偶尔在调工具前先写一句话（如「首先确认附件路径。」），A2A 把各段文字拼在一起回来。 */
const LEADIN_MAX = 200;

/** 「一句引导语 + 一个完整的 JSON 对象」：引导语不超过 LEADIN_MAX 字、不含 { }；JSON 后面不能再有文字（可以是 ``` 围栏的收尾）。→ { reply, lead } 或 null */
function afterLeadIn(body) {
  const start = body.indexOf('{');
  const lead = start > 0 ? body.slice(0, start) : '';
  if (start <= 0 || [...lead].length > LEADIN_MAX || /[{}]/u.test(lead)) return null;
  try { return { reply: JSON.parse(body.slice(start).replace(/\n?```\s*$/u, '')), lead: lead.replace(/```(?:json)?\s*$/u, '') }; } catch { return null; }
}

/** 回复的文字 → 工具的 JSON；不合格抛 KB_AGENT_REPLY_INVALID（reason 只说是哪一类不合格）。
 *  前面多一句引导语的也收下，记一行 POC_KB_AGENT_REPLY_LEADIN <op> <引导语字数>（不记内容）。 */
function readReply(op, input, text, log = () => {}) {
  const body = unwrapJson(text).text;
  let reply;
  try { reply = JSON.parse(body); } catch {
    const found = afterLeadIn(body);
    if (!found) throw failure('KB_AGENT_REPLY_INVALID', 'not_json');
    reply = found.reply;
    log(`POC_KB_AGENT_REPLY_LEADIN ${op} ${[...found.lead.trim()].length}`);
  }
  if (!isObject(reply)) throw failure('KB_AGENT_REPLY_INVALID', 'not_object');
  if (reply.success === false) {
    if (!failedShape(reply)) throw failure('KB_AGENT_REPLY_INVALID', 'failure_shape');
    return reply;
  }
  if (reply.success !== true || !SHAPES[op](reply, input)) throw failure('KB_AGENT_REPLY_INVALID', 'shape');
  return reply;
}

export function createKbStewardClient({ origin, publishId, mode, credentialFor, markInvalid, call = a2aCall, now = Date.now, log = () => {} }) {
  if (!Object.hasOwn(FALLBACK_OPS, mode)) throw new TypeError(`kb mode must be pg or s3vectors: ${mode}`);
  const configured = typeof publishId === 'string' && publishId !== '';
  const fallback = Object.freeze({ protocol: PROTOCOL, backend: mode, ops: FALLBACK_OPS[mode] });
  let described = null;   // describe 的缓存 { at, pending }（进行中的那一轮也算）

  async function exchange(op, input, file) {
    if (!configured) throw failure('KB_AGENT_NOT_CONFIGURED');
    const key = await credentialFor(publishId);
    if (!key) throw failure('KB_AGENT_NOT_READY');
    let answer;
    try {
      answer = await call({ url: `${origin}/a2a/${publishId}`, key, text: `${PROTOCOL} · ${op}：只调用对应的工具一次，原样返回工具的 JSON。`, data: [{ op, ...input }],
        files: file ? [{ name: file.name, mimeType: DOCX, bytes: file.bytes }] : [], timeoutMs: TIMEOUT_MS[op] ?? DEFAULT_TIMEOUT_MS });
    } catch (error) {
      if (keyRejected(error)) {
        await Promise.resolve().then(() => markInvalid(publishId, 'AI_AUTH_INVALID')).catch(() => {});
        throw failure('KB_AGENT_KEY_REJECTED');
      }
      throw failure('KB_UNAVAILABLE', String(error?.code || 'A2A_FAILED').slice(0, 40));
    }
    return readReply(op, input, answer?.text, log);
  }

  return {
    /** 部署配置里有没有这个发布编号（GET /mode 的 configured）。 */
    configured,
    /** 「Agent 接入」页里这个发布有没有可用的钥匙（GET /mode 的 ready）；没配置时不取钥匙。 */
    async ready() { return configured && Boolean(await credentialFor(publishId)); },
    /** 这个 Agent 支持哪些操作：{ protocol, backend, ops }（ops 只留认识的、去重，按 Agent 给的顺序）。缓存 5 分钟。 */
    async describe() {
      if (!configured) throw failure('KB_AGENT_NOT_CONFIGURED');
      if (described && now() - described.at < DESCRIBE_TTL_MS) return described.pending;
      const pending = exchange('describe', {}).then(reply => {
        if (reply.success === false && reply.error_type === 'invalid_parameter') return fallback;
        if (reply.success !== true) throw failure('KB_AGENT_REPLY_INVALID', 'describe_failed');
        if (reply.backend !== mode) log(`POC_KB_BACKEND_MISMATCH ${mode} ${reply.backend.replace(/[^A-Za-z0-9._-]/gu, '?').slice(0, 40)}`);
        return Object.freeze({ protocol: reply.protocol, backend: reply.backend, ops: Object.freeze([...new Set(reply.ops.filter(op => KNOWN_OPS.includes(op)))]) });
      });
      const entry = { at: now(), pending };
      described = entry;
      pending.catch(() => { if (described === entry) described = null; });
      return pending;
    },
    /** 一次规则请求；file = { name, bytes }（只有 ingest 带）。返回工具的 JSON（success 为 true 或 false）。 */
    async request(op, input = {}, file = null) {
      if (op === 'describe' || !Object.hasOwn(SHAPES, op)) throw new TypeError(`unknown kb.rules op: ${op}`);
      try { return await exchange(op, input, file); }
      catch (error) { if (STALE.has(error?.code)) described = null; throw error; }
    },
  };
}

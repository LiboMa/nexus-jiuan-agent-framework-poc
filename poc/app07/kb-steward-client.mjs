/**
 * S3 Vectors 方式的「公司制度」：经 A2A 调「知识库文档管家（S3 Vectors 版）」的发布，约定 kb.rules/v1（文档管家提示词的「规则请求」一节）：
 *   文字 `kb.rules/v1 · <op>：只调用对应的工具一次，原样返回工具的 JSON。` + 数据 Part `{ op, …input }`（+ ingest 的 .docx 文件 Part）。
 *   op → 工具：ingest → rules_writer；list / detail / deactivate / restore / delete / check → rules_manager；search → rules_search。
 *   文档管家只回工具的 JSON：这里去掉偶尔的 ```json 围栏后 JSON.parse，按 op 校验形态；不合格抛 KB_AGENT_REPLY_INVALID，不重试。
 * 调用密钥只经「Agent 接入」页启用（credentialFor）；没有就抛 KB_AGENT_NOT_READY、不发调用。Nexus 不认这把钥匙（401 / credential_invalid）
 * 时 markInvalid 一次后抛 KB_AGENT_KEY_REJECTED；之后 credentialFor 回 null，不会反复重试。别的调用失败（超时、404、5xx）抛 KB_UNAVAILABLE。
 * 抛出的错误只带错误码（reason 是 A2A 的错误码或校验没过的那一项），不带回复的内容和钥匙。
 */
import { a2aCall, keyRejected, unwrapJson } from '../app/nexus/a2a-client.mjs';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const TIMEOUT_MS = Object.freeze({ ingest: 300_000 });
const DEFAULT_TIMEOUT_MS = 120_000;
const failure = (code, reason) => Object.assign(new Error(code), { code, ...(reason ? { reason } : {}) });

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = value => Number.isInteger(value) && value >= 0;
const isText = value => typeof value === 'string';
const sameSource = (reply, input) => reply.source_id === input.source_id;
/** 成功时各 op 的回复形态（工具的返回值，见 s3vectors_rules_tools.py）。 */
const SHAPES = Object.freeze({
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

/** 回复的文字 → 工具的 JSON；不合格抛 KB_AGENT_REPLY_INVALID（reason 只说是哪一类不合格）。 */
function readReply(op, input, text) {
  let reply;
  try { reply = JSON.parse(unwrapJson(text).text); } catch { throw failure('KB_AGENT_REPLY_INVALID', 'not_json'); }
  if (!isObject(reply)) throw failure('KB_AGENT_REPLY_INVALID', 'not_object');
  if (reply.success === false) {
    if (!failedShape(reply)) throw failure('KB_AGENT_REPLY_INVALID', 'failure_shape');
    return reply;
  }
  if (reply.success !== true || !SHAPES[op](reply, input)) throw failure('KB_AGENT_REPLY_INVALID', 'shape');
  return reply;
}

export function createKbStewardClient({ origin, publishId, credentialFor, markInvalid, call = a2aCall }) {
  const url = `${origin}/a2a/${publishId}`;
  return {
    /** 「Agent 接入」页里这个发布有没有可用的钥匙（GET /mode 的 ready）。 */
    async ready() { return Boolean(await credentialFor(publishId)); },
    /** 一次规则请求；file = { name, bytes }（只有 ingest 带）。返回工具的 JSON（success 为 true 或 false）。 */
    async request(op, input = {}, file = null) {
      if (!Object.hasOwn(SHAPES, op)) throw new TypeError(`unknown kb.rules op: ${op}`);
      const key = await credentialFor(publishId);
      if (!key) throw failure('KB_AGENT_NOT_READY');
      let answer;
      try {
        answer = await call({ url, key, text: `kb.rules/v1 · ${op}：只调用对应的工具一次，原样返回工具的 JSON。`, data: [{ op, ...input }],
          files: file ? [{ name: file.name, mimeType: DOCX, bytes: file.bytes }] : [], timeoutMs: TIMEOUT_MS[op] ?? DEFAULT_TIMEOUT_MS });
      } catch (error) {
        if (keyRejected(error)) {
          await Promise.resolve().then(() => markInvalid(publishId, 'AI_AUTH_INVALID')).catch(() => {});
          throw failure('KB_AGENT_KEY_REJECTED');
        }
        throw failure('KB_UNAVAILABLE', String(error?.code || 'A2A_FAILED').slice(0, 40));
      }
      return readReply(op, input, answer?.text);
    },
  };
}

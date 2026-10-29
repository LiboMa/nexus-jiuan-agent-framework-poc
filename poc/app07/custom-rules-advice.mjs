/**
 * 人从单据页发起 AI 独立建议（review_advice@1）时，把这个人的「我的规则」（custom-rules.mjs）附进发给审核 Agent 的请求；
 * 自动初审（流水线）和「Agent 接入」页的单据测试都不附。九安不改，外壳包两处：
 *   - withAdviceActor(reviewAdviceState)：单据页的发起入口 start 在 AsyncLocalStorage 里调九安原来的 start，记下发起人和单据；
 *     九安的 start → begin → assemble 中间只有 await（authorize、读这一轮的状态），没有定时器、事件或排队，上下文一路跟到组装器
 *     （test/unit/custom-rules-advice.test.mjs 用九安真实的任务服务证明）。
 *   - withCustomRules(assembler, …)：九安的组装器照常组装；当前上下文是人（不是 system:pipeline）发起的这张单、且是这一轮的第一次组装、
 *     这个账号有规则时，加 input.customRules = { owner, items: [{ title, text }] }。整份请求超 maxRequestChars 就照九安 fit() 的办法
 *     从原件末尾逐页去掉（不裁规则），去完仍超 AGENT_REQUEST_TOO_LARGE；重新跑契约的两项校验，按九安的算法重算 inputFingerprint
 *     （它决定 Nexus 的 contextId：不重算，两个人对同一张单会落在同一个会话里）。
 * 日志一行 POC_CUSTOM_RULES <单据> <账号> <规则字数>，不写规则正文；读不出规则时这一轮不发，日志只写错误码。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

const SYSTEM_PIPELINE = 'system:pipeline';   // 九安 src/platform/service-identity.mjs 的流水线身份
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const MESSAGES = Object.freeze({
  AGENT_CONFIGURATION: '自定义规则的组装外壳配置不全。',
  AGENT_REQUEST_TOO_LARGE: '自定义规则加上单据字段与付款明细超出一次调用的上限（原件页文字已经全部去掉），这次没有发出。',
  AGENT_ASSEMBLY_FAILED: '平台尚未完成：AI 独立建议的请求没能组装成合规的格式。',
  CUSTOM_RULES_UNAVAILABLE: '这次没能读出你的「我的规则」，没有发出；稍后再试。',
});
const fail = code => { throw Object.assign(new Error(MESSAGES[code]), { code }); };

// 单据页发起的这一轮：{ actor, documentId, used }。一个进程一份，两个外壳共用
const roundContext = new AsyncLocalStorage();

/** 单据页的发起入口：start 在发起人的上下文里调九安原来的 start；list、view 原样。 */
export function withAdviceActor(reviewAdviceState) {
  if (!reviewAdviceState) return reviewAdviceState;
  return Object.freeze({ ...reviewAdviceState,
    start: args => roundContext.run({ actor: args?.actor, documentId: args?.document?.id, used: false }, () => reviewAdviceState.start(args)) });
}

// 九安 review-advice.mjs 的写法：量请求按 Unicode 字符数，指纹是 sha256(JSON.stringify(排序键后的 request.input))
const size = request => [...JSON.stringify(request)].length;
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]));
  return value;
}
const fingerprintOf = input => createHash('sha256').update(JSON.stringify(sortKeys(input))).digest('hex');

export function withCustomRules(assembler, { rules, contract, task, log = () => {} } = {}) {
  const maxChars = task?.manifest?.limits?.maxRequestChars;
  if (typeof assembler?.assemble !== 'function' || typeof assembler?.basis !== 'function' || typeof rules?.forRequest !== 'function'
    || typeof contract?.envelope?.validateRequest !== 'function' || typeof task?.validateInput !== 'function' || !Number.isSafeInteger(maxChars)
    || typeof log !== 'function') fail('AGENT_CONFIGURATION');

  /** 这次组装是不是人从单据页发起的那一轮（同一上下文里后来的组装、别的单都不算）；是就给发起人。 */
  function personOf(subject) {
    const round = roundContext.getStore();
    if (!round || round.used || round.documentId !== subject?.documentId) return null;
    round.used = true;
    const actor = round.actor;
    if (!actor || typeof actor !== 'object' || actor.principal === SYSTEM_PIPELINE || typeof actor.id !== 'string') return null;
    return actor;
  }

  /** 九安 fit()：一轮从最后一份原件往前各去一页，直到放得下；原件去完仍放不下 AGENT_REQUEST_TOO_LARGE。 */
  function fit(request) {
    const files = Array.isArray(request.input?.evidence?.files) ? request.input.evidence.files : [];
    while (size(request) > maxChars) {
      if (!files.some(file => file.pages?.length)) fail('AGENT_REQUEST_TOO_LARGE');
      for (let index = files.length - 1; index >= 0 && size(request) > maxChars; index -= 1) {
        if (files[index].pages?.length) { files[index].pages.pop(); request.input.evidence.truncated = true; }
      }
    }
  }

  async function assemble(subject) {
    const actor = personOf(subject);
    const assembled = await assembler.assemble(subject);
    if (!actor) return assembled;
    let custom;
    try { custom = await rules.forRequest(actor.id); } catch (error) {
      log(`POC_CUSTOM_RULES_FAILED ${CODE.test(String(error?.code ?? '')) ? error.code : 'UNKNOWN'}`);
      fail('CUSTOM_RULES_UNAVAILABLE');
    }
    if (!custom) return assembled;
    const request = structuredClone(assembled.request);
    request.input.customRules = custom;
    fit(request);
    if (!contract.envelope.validateRequest(request).ok || !task.validateInput(request.input).ok) fail('AGENT_ASSEMBLY_FAILED');
    const ruleChars = custom.items.reduce((sum, item) => sum + [...item.text].length, 0);
    log(`POC_CUSTOM_RULES ${subject.documentId} ${custom.owner} ${ruleChars}`);
    return { ...assembled, request, inputFingerprint: fingerprintOf(request.input) };
  }

  return Object.freeze({ assemble, basis: subject => assembler.basis(subject) });
}

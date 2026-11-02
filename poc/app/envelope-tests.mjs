/**
 * 「Agent 接入」页请求信封测试用的契约部分（九安 v0.7.10 副本里的 src/agent-contract，组合根注入）：
 *   templates()            契约里的每个任务一份示例请求（examples/request*.json；没有示例、输入可以为空的给最小请求），这个实例的审批流任务排最前；
 *                          context 换成测试台自己的租户和公司
 *   checkRequest(request)  按契约查请求信封和任务输入，返回查不过的地方 [{ path, message }]（空 = 合契约）
 *   judge(request, text)   判 Agent 的回答：恰好一个结果信封 JSON（最多包一层 ```json）、和请求对得上、output 合任务契约，
 *                          和九安适配层第一轮的判法相同（这里不要求修正，原样判）
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ENVELOPE = 'jiuan.agent/v1';
const PREFERRED = ['request.json', 'request-pass.json'];

export function createEnvelopeChecks({ contract, contractDir, extractResultObject, checkResultEnvelope, scope, firstTasks = [] }) {
  function example(task, version) {
    const dir = path.join(contractDir, 'tasks', task, `v${version}`, 'examples');
    let files = [];
    try { files = readdirSync(dir).filter(name => /^request[a-z0-9-]*\.json$/u.test(name)); } catch { files = []; }
    const pick = PREFERRED.find(name => files.includes(name)) ?? files.sort()[0];
    return pick ? JSON.parse(readFileSync(path.join(dir, pick), 'utf8')) : null;
  }
  const built = [];
  for (const [key, entry] of contract.tasks) {
    const { task, version, title, limits } = entry.manifest;
    let request = example(task, version);
    if (!request && entry.validateInput({}).ok) {
      request = { envelope: ENVELOPE, task, taskVersion: version, requestId: randomUUID(), context: { tenantId: '', scope: 'company', companyId: '', subject: null, locale: 'zh-CN' }, input: {} };
    }
    if (!request) continue;
    request.context = { ...request.context, tenantId: scope.tenantId, companyId: scope.companyId };
    built.push(Object.freeze({ task: key, title, timeoutMs: limits.timeoutMs, request: Object.freeze(request) }));
  }
  built.sort((left, right) => Number(!firstTasks.includes(left.task)) - Number(!firstTasks.includes(right.task)));
  const templates = () => built.map(item => ({ ...item, request: structuredClone(item.request) }));

  function checkRequest(request) {
    const problems = contract.envelope.validateRequest(request).errors.map(({ path: at, message }) => ({ path: at || '/', message }));
    const entry = contract.tasks.get(`${request?.task}@${request?.taskVersion}`);
    if (!entry) problems.push({ path: '/task', message: `契约里没有任务 ${request?.task}@${request?.taskVersion}` });
    else {
      problems.push(...entry.validateInput(request.input).errors.map(({ path: at, message }) => ({ path: `/input${at}`, message })));
      const max = entry.manifest.limits.maxRequestChars;
      if ([...JSON.stringify(request)].length > max) problems.push({ path: '/', message: `请求超过 ${max} 个字符的上限` });
    }
    return problems;
  }

  function judge(request, text) {
    const entry = contract.tasks.get(`${request?.task}@${request?.taskVersion}`);
    const maxAnswerChars = entry?.manifest.limits.maxAnswerChars ?? 20_000;
    const extracted = extractResultObject(text, { maxAnswerChars });
    if (!extracted.ok) {
      const message = extracted.code === 'ANSWER_TOO_LONG' ? `回答超过 ${maxAnswerChars} 个字符的上限。` : '回答里必须恰好是一个 JSON 对象（最多包一层 ```json 代码块）。';
      return { ok: false, value: null, problems: [{ code: extracted.code, path: '', message }] };
    }
    const checked = checkResultEnvelope({ request, result: extracted.value, contract });
    return { ok: checked.ok, value: checked.ok ? extracted.value : null, problems: checked.problems };
  }

  return { templates, checkRequest, judge };
}

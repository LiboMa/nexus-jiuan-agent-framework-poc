/**
 * 九安存的 AI 任务轮次（只读）：每张单每个任务一份状态 agent-task:v1:<哈希>（当前一轮 + 最近 5 轮历史），键由租户、公司、任务、单据编号算出
 * （agentTaskKey，组合根注入九安自己的那个），所以从单据反查。
 *   everyDocument        单据池全部单据（按页读）
 *   walkRounds           单据 × 任务 → { document, task, record, current }，轮次原样：「Agent 接入」的调用记录（agent-calls.mjs）和工作台（dashboard.mjs，
 *                        「待复核」要单据现在的版本 document.version）用
 *   readAdviceRounds     AI 独立建议的每一轮，整理成工作台要的样子
 *   currentAdviceReader  一张单的当前一轮（复核用，reviews.mjs）：只读这一张单的状态，不扫单据池
 *   adviceOf             单据 + 一轮 → 复核状态要的样子（currentAdviceReader 和工作台 dashboard.mjs 共用）
 * 轮次字段照九安 agent-task-service.mjs：round、subjectVersion（这一轮审的是单据的哪个版本）、status（running | completed | declined | failed |
 * superseded；从没跑过就没有轮次）、output.result（pass | fail）、output.basis（Agent 返回的逐条依据；record.basis 是组装请求时的输入，不是这个）。
 */
export const ADVICE_TASK = 'review_advice';

/** 单据池全部单据：九安的 listDocuments 每页最多 50 张（再多回 ANALYSIS_VALIDATION），按页读到不满一页为止，最多 max 张。 */
export async function everyDocument(listPage, { pageSize = 50, max = 1000 } = {}) {
  const items = [];
  for (let offset = 0; offset < max; offset += pageSize) {
    const page = (await listPage({ limit: pageSize, offset })).items ?? [];
    items.push(...page);
    if (page.length < pageSize) break;
  }
  return items;
}

/** Agent 返回的逐条依据，缺的项补空。 */
export const basisOf = output => (Array.isArray(output?.basis) ? output.basis : [])
  .map(item => ({ kind: item?.kind ?? null, ref: item?.ref ?? '', page: Number.isSafeInteger(item?.page) ? item.page : null, note: item?.note ?? '' }));
const outputOf = record => (record?.output && typeof record.output === 'object' ? record.output : {});
const stateKey = ({ tenantId, agentTaskKey, document, task }) => agentTaskKey({ tenantId, companyId: document.companyId, task, subject: { kind: 'document', id: document.id } });

/** 每张单、每个任务：当前一轮在前，再是历史（九安存的顺序）。 */
export async function walkRounds({ tenantId, tasks, agentTaskKey, listDocuments, readState }) {
  const rounds = [];
  for (const document of await listDocuments()) {
    for (const task of tasks) {
      const state = await readState(stateKey({ tenantId, agentTaskKey, document, task }));
      if (state?.current) rounds.push({ document, task, record: state.current, current: true });
      for (const record of Array.isArray(state?.history) ? state.history : []) if (record) rounds.push({ document, task, record, current: false });
    }
  }
  return rounds;
}

/** AI 独立建议的每一轮：documentVersion 是这一轮审的版本（不一定是单据现在的版本）。 */
export async function readAdviceRounds({ tenantId, agentTaskKey, readState, listDocuments, task = ADVICE_TASK }) {
  return (await walkRounds({ tenantId, tasks: [task], agentTaskKey, listDocuments, readState })).map(({ document, record, current }) => {
    const output = outputOf(record);
    return { documentId: document.id, companyId: document.companyId, documentVersion: record.subjectVersion ?? null, round: record.round ?? null,
      trigger: record.trigger ?? null, requestedBy: record.requestedBy ?? null, status: record.status ?? null, result: output.result ?? null, basis: basisOf(output),
      errorCode: record.errorCode ?? null, startedAt: record.startedAt ?? null, finishedAt: record.finishedAt ?? null, current };
  });
}

/** 单据和它的当前一轮 → { documentVersion（单据现在的版本）, round, status, result, adviceVersion（这一轮审的版本） }；record 为 null 时轮次各项为 null。 */
export const adviceOf = (document, record) => ({ documentVersion: document.version, round: record?.round ?? null, status: record?.status ?? null,
  result: outputOf(record).result ?? null, adviceVersion: record?.subjectVersion ?? null });

/**
 * readDocument(id) → 范围内的单据（要 id、companyId、version），不在范围里或不存在时 null。
 * 返回的函数：documentId → null（单据不在范围里）或 adviceOf 的样子；没跑过 AI 建议时 round、status、result、adviceVersion 都是 null。
 */
export function currentAdviceReader({ tenantId, agentTaskKey, readState, readDocument, task = ADVICE_TASK }) {
  return async documentId => {
    const document = await readDocument(documentId);
    if (!document || document.id !== documentId) return null;
    return adviceOf(document, (await readState(stateKey({ tenantId, agentTaskKey, document, task })))?.current ?? null);
  };
}

/**
 * 用九安自己的 AI 建议服务组装「这张单据会发给模型的输入」：给它注入一个只截获、不调用的模型客户端，结果一概不保存。
 * 这样调用测试和审批流送给 Agent 的是同一份 facts / ruleResults，九安的校验函数也对得上，不必复制九安组装输入的代码。
 */
import { createAnalysisAiAdviceService } from '../jiuan.mjs';
import { fail } from '../http.mjs';

export async function captureAdvisoryInput({ runtime, tenantId, actor, document }) {
  let captured = null;
  const capture = { model: 'poc-input-capture', async advisory(input) {
    captured = input;
    throw Object.assign(new Error('captured'), { code: 'AI_CANCELLED' });
  } };
  const service = createAnalysisAiAdviceService({ tenantId, modelClient: capture, authorize: runtime.authorize, readCurrent: runtime.readCurrent,
    readCache: async () => null, persist: async () => {}, offline: false });
  await service.enqueue({ actor, companyId: document.companyId, documentId: document.id, sourceVersion: document.version });
  await service.idle();
  if (!captured) fail('POC_ADVISORY_INPUT_UNAVAILABLE', 409);
  const { signal, ...input } = captured;
  return input;
}

/**
 * 审批流（以及九安自己的 AI 建议）用的调用密钥从系统里读，不要求 secrets.env 里另放一把：
 * 先用这张单据审批的发起人自己在 Agent 页启用的那把，没有再用别的账号启用的，最后才是 secrets.env（access/me.mjs 的 systemCredential）。
 * 只有 401 才把用到的那一把标记失效；secrets.env 里的那一把不属于任何账号，不标。
 */
export function createSystemKeyResolver({ me, workflow, publishId }) {
  return {
    getKey: ({ documentId = null } = {}) => me.systemCredential(publishId, { preferAccountId: documentId ? workflow.initiatorOf(documentId) : null }),
    async onAuthRejected(credential) {
      if (credential?.source === 'user' && credential.accountId) await me.markInvalid({ id: credential.accountId }, publishId);
    },
  };
}

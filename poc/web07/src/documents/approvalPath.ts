/**
 * 审批路径与最终审批人（Spec 第 9 节）：审核 Agent 的提示词规定规则依据的 note 写「适用审批路径：…；最终审批人：…；核对：…」
 * （audit-agent/prompt.yaml）。两段都读得出才给，读不出回 null——不猜。全角、半角的冒号和分号都认。
 */
const PATTERN = /适用审批路径\s*[：:]\s*([^；;]+?)\s*[；;]\s*最终审批人\s*[：:]\s*([^；;。\n]+)/u;

export function parseApprovalPath(note: string): { path: string; finalApprover: string } | null {
  if (typeof note !== 'string') return null;
  const match = PATTERN.exec(note);
  if (!match) return null;
  const path = match[1].trim(), finalApprover = match[2].trim();
  return path && finalApprover ? { path, finalApprover } : null;
}

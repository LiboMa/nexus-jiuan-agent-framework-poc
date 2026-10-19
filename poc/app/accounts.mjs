/**
 * 两个虚构账号。role 是九安的角色（决定九安页面上的权限，运行时服务只接受 admin / analyst），
 * pocRole 是 PoC 审批流里的岗位。口令不在代码里：写在密钥配置文件的 passwordKey 那一项（deploy.sh 首次运行时生成）。
 */
export const ACCOUNTS = Object.freeze([
  Object.freeze({ id: 'poc-reviewer', name: '审核员（虚构）', role: 'admin', pocRole: 'reviewer', passwordKey: 'REVIEWER_PASSWORD' }),
  Object.freeze({ id: 'poc-checker', name: '复核人（虚构）', role: 'analyst', pocRole: 'checker', passwordKey: 'CHECKER_PASSWORD' }),
]);

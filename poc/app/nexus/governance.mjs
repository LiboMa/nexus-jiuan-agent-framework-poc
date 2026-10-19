/**
 * 九安的数据治理：模型调用都带 dataContext.environment = 'prod'，所以要声明允许送入模型的租户与公司。
 * 这里声明的是 PoC 的虚构租户与两家虚构公司；留存声明如实写 Nexus 隐藏会话的默认保留期（九安只把它当未经核实的声明）。
 */
import { COMPANIES, TENANT_ID } from '../seed.mjs';

export function governanceEnv() {
  return { AI_DATA_ENVIRONMENT: 'prod', AI_PROD_DATA_TENANT_ID: TENANT_ID, AI_PROD_DATA_COMPANY_IDS: COMPANIES.map(company => company.id).join(','),
    AI_MODEL_DATA_RETENTION: 'nexus-hidden-session-30d' };
}

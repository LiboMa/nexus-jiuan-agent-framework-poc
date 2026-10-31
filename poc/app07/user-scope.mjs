/**
 * 外壳新接口（复核、AI 建议的各轮、原件的文字、工作台）的公司范围（Ruling FR1）：登录的人在九安里能看的汇联易公司 ∩ 测试台的公司。
 * 「能看哪些公司」用九安自己的 analysisHuilianyiCompanyIds（server.mjs 从 J.auth 注入；九安的单据接口也按它，analysis-server.mjs 的 sourceCompanyIds），
 * 外壳不自己解释账号的公司写法。九安不许规则发布复核人有公司（analysis-auth.mjs），所以他的范围是空的：单据池、工作台都是空的。
 * 读不出范围（九安的函数因为写法不对抛错、没有会话）也当空的。
 */

/** sourceCompanyIds(user) → 这个人在九安里的汇联易公司。返回的函数：user → 范围（测试台的公司里这个人能看的，按他给的顺序，不重复）。 */
export function createUserScope({ benchCompanyIds, sourceCompanyIds }) {
  const bench = new Set(benchCompanyIds);
  return user => {
    let own;
    try { own = sourceCompanyIds(user ?? {}); } catch { return []; }
    return Array.isArray(own) ? [...new Set(own)].filter(id => typeof id === 'string' && bench.has(id)) : [];
  };
}

/**
 * read({ id, companyIds }) 是九安 store 的 getDocument / getDocumentHead。返回的函数：(id, user) → 这个人范围里的单据，或 null。
 * 范围是空的就不去读（九安的 store 遇到空的公司列表也回 null，这里不靠它）。
 */
export const scopedDocument = (scopeOf, read) => async (id, user) => {
  const companyIds = scopeOf(user);
  return companyIds.length ? read({ id, companyIds }) : null;
};

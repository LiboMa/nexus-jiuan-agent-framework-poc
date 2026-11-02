/**
 * 测试用：九安自己的「这个人能看哪些汇联易公司」（analysisHuilianyiCompanyIds，九安 v0.7.10 副本的 src/analysis-auth.mjs），
 * 和外壳按它算的范围（user-scope.mjs）。九安构件默认在 ../../.build/jiuan（相对 poc/app），可用 JIUAN_DIR 指到别处。
 * 不是测试文件（不叫 *.test.mjs），由各个测试引用。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createUserScope } from '../../user-scope.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const JIUAN = path.resolve(process.env.JIUAN_DIR || path.join(here, '../../../../.build/jiuan'));
export const { analysisHuilianyiCompanyIds } = await import(pathToFileURL(path.join(JIUAN, 'src/analysis-auth.mjs')).href);

/** 测试台的公司是 benchCompanyIds 时，外壳给登录的人算的范围（server.mjs 也这么接）。 */
export const benchScope = benchCompanyIds => createUserScope({ benchCompanyIds, sourceCompanyIds: analysisHuilianyiCompanyIds });

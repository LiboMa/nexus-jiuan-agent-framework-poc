/**
 * 九安开发包的唯一入口：PoC 的其他模块都从这里取九安的函数，不各自拼九安的路径。
 * 这些模块导入时不连网、不起定时器、不写文件（导入链里没有 mysql2）。
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { JIUAN_CODE_DIR } from './jiuan-path.mjs';

const load = relative => import(pathToFileURL(path.join(JIUAN_CODE_DIR, relative)).href);
const [server, auth, runtime, registry, workspace, normalize, advice, aiModel, governance] = await Promise.all([
  load('analysis-server.mjs'),
  load('src/analysis-auth.mjs'),
  load('src/analysis-runtime-services.mjs'),
  load('src/analysis-runtime-registry.mjs'),
  load('src/analysis-rule-workspace.mjs'),
  load('src/analysis-normalize.mjs'),
  load('src/analysis-ai-advice.mjs'),
  load('providers/ai-model.mjs'),
  load('src/ai-data-governance.mjs'),
]);

export const { createAnalysisApp } = server;
export const { createAnalysisAuth, analysisPrincipal, analysisProviderScopes } = auth;
export const { createAnalysisRuntimeServices } = runtime;
export const { createAnalysisRuntimeRegistry } = registry;
export const { createAnalysisRuleWorkspace } = workspace;
export const { normalizeAnalysisReport } = normalize;
export const { createAnalysisAiAdviceService } = advice;
export const {
  ADVISORY_TASK, ADVISORY_SCHEMA, validateAdvisoryInput, parseAdvisoryResult,
  DRAFT_EVIDENCE_TASK, DRAFT_EVIDENCE_SCHEMA, validateDraftEvidenceInput, validateDraftEvidenceResult,
} = aiModel;
export const { modelDataPolicy, assertModelDataAllowed } = governance;

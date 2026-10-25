/**
 * 九安 v0.7.10 副本的唯一入口：外壳的其他模块都从这里取九安的函数，不各自拼路径。
 * 副本由 bench/build-jiuan07.sh 生成（本机在 .build/jiuan07，EC2 上由 JIUAN07_DIR 指到发布包里的副本）。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const JIUAN07_DIR = path.resolve(process.env.JIUAN07_DIR || path.join(here, '../../.build/jiuan07'));
const load = relative => import(pathToFileURL(path.join(JIUAN07_DIR, relative)).href);

export const [
  server, auth, sync, scheduler, agentRunner, listSync, reportDetail, detailProjection, elementCheck, catalog, pausedCatalog,
  config, huilianyiSource, runtimeServices, runtimeRegistry, database, platformStore, connectors, nexusA2a, contractChecks,
  enablement, taskService, reviewAdviceTask, elementCheckState, reviewAdviceState, serviceIdentity, callMiddleware, secretSource,
  companyScope, pipelineProgress, platformRoutes, companyDirectory, departmentDirectory, approvalIdentity, milestone,
] = await Promise.all([
  'analysis-server.mjs', 'src/analysis-auth.mjs', 'src/analysis-sync.mjs', 'src/platform/scheduler.mjs', 'src/platform/agent-runner.mjs',
  'src/platform/adapters/list-sync.mjs', 'src/platform/adapters/report-detail.mjs', 'src/platform/adapters/detail-projection.mjs',
  'src/platform/adapters/element-check.mjs', 'src/platform/agent-catalog.mjs', 'src/platform/adapters/catalog.mjs',
  'src/analysis-config.mjs', 'src/huilianyi-source.mjs', 'src/analysis-runtime-services.mjs', 'src/analysis-runtime-registry.mjs',
  'src/analysis-database.mjs', 'src/platform/platform-store.mjs', 'src/platform/connectors.mjs', 'providers/nexus-a2a.mjs',
  'src/agent-contract/checks.mjs', 'src/agent-enablement.mjs', 'src/agent-task-service.mjs', 'src/agent-tasks/review-advice.mjs',
  'src/agent-tasks/element-check-state.mjs', 'src/agent-tasks/review-advice-state.mjs', 'src/platform/service-identity.mjs',
  'src/platform/call-middleware.mjs', 'src/platform/secret-source.mjs', 'src/platform/company-scope.mjs',
  'src/platform/pipeline-progress.mjs', 'src/platform/platform-routes.mjs', 'src/company-directory.mjs',
  'src/department-directory.mjs', 'src/approval-identity.mjs', 'src/milestone-runtime.mjs',
].map(load));

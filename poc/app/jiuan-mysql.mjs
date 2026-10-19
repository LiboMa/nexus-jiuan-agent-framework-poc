/**
 * 九安里要用到 mysql2 的模块（MySQL 存储与平台部分）。只在测试台（POC_STORE=mysql）下动态导入：
 * 这些模块的导入链里有 mysql2，要用构建出来的九安副本（JIUAN_CODE_DIR=.build/jiuan，带 node_modules）。
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { JIUAN_CODE_DIR } from './jiuan-path.mjs';

const load = relative => import(pathToFileURL(path.join(JIUAN_CODE_DIR, relative)).href);
const [database, platformStore, connectors, secretSource, middleware, runner, catalog, projection, scheduler, progress, routes] = await Promise.all([
  load('src/analysis-database.mjs'),
  load('src/platform/platform-store.mjs'),
  load('src/platform/connectors.mjs'),
  load('src/platform/secret-source.mjs'),
  load('src/platform/call-middleware.mjs'),
  load('src/platform/agent-runner.mjs'),
  load('src/platform/adapters/catalog.mjs'),
  load('src/platform/adapters/detail-projection.mjs'),
  load('src/platform/scheduler.mjs'),
  load('src/platform/pipeline-progress.mjs'),
  load('src/platform/platform-routes.mjs'),
]);

export const { createAnalysisDatabase } = database;
export const { createPlatformStore } = platformStore;
export const { createConnectorRegistry } = connectors;
export const { createSecretSource } = secretSource;
export const { createCallGateway } = middleware;
export const { createAgentRunner } = runner;
export const { createPausedAdapter } = catalog;
export const { createDetailProjectionAdapter } = projection;
export const { createScheduler } = scheduler;
export const { createPipelineProgress } = progress;
export const { createPlatformRoutes } = routes;

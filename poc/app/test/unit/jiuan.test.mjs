import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';

test('九安开发包目录存在，且有服务端与前端', async () => {
  const { JIUAN_CODE_DIR, JIUAN_PUBLIC_DIR } = await import('../../jiuan-path.mjs');
  assert.ok(existsSync(path.join(JIUAN_CODE_DIR, 'analysis-server.mjs')), JIUAN_CODE_DIR);
  assert.ok(existsSync(path.join(JIUAN_PUBLIC_DIR, 'analysis.js')), JIUAN_PUBLIC_DIR);
});

test('jiuan.mjs 导出 PoC 用到的全部九安函数与常量', async () => {
  const jiuan = await import('../../jiuan.mjs');
  for (const name of ['createAnalysisApp', 'createAnalysisAuth', 'analysisPrincipal', 'analysisProviderScopes',
    'createAnalysisRuntimeServices', 'createAnalysisRuntimeRegistry', 'createAnalysisRuleWorkspace', 'normalizeAnalysisReport',
    'createAnalysisAiAdviceService', 'validateAdvisoryInput', 'parseAdvisoryResult', 'validateDraftEvidenceInput',
    'validateDraftEvidenceResult', 'modelDataPolicy', 'assertModelDataAllowed']) {
    assert.equal(typeof jiuan[name], 'function', name);
  }
  assert.equal(typeof jiuan.ADVISORY_TASK, 'string');
  assert.equal(typeof jiuan.DRAFT_EVIDENCE_TASK, 'string');
  assert.equal(typeof jiuan.ADVISORY_SCHEMA, 'object');
  assert.equal(typeof jiuan.DRAFT_EVIDENCE_SCHEMA, 'object');
});

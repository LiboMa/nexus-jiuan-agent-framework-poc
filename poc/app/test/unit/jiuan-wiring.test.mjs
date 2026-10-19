import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAnalysisRuntimeServices, createAnalysisRuleWorkspace, normalizeAnalysisReport, analysisPrincipal, analysisProviderScopes } from '../../jiuan.mjs';
import { createMemoryStore } from '../../memory-store.mjs';

const T = 'spike-tenant', C = 'spike-company';
const account = { id: 'spike-owner', name: '验证账号（虚构）', enabled: true, role: 'admin', mode: 'local_owner', companyIds: [C] };
const actor = { id: account.id, name: account.name, role: account.role, mode: account.mode, companyIds: [C],
  principalId: analysisPrincipal(account), providerScopes: analysisProviderScopes(undefined, [C]) };
const fileUrl = 'https://spike-files.invalid/contract.pdf';
const bytes = Buffer.from('%PDF-1.7 SPIKE CONTRACT (fictitious)');
const pages = ['房屋租赁合同（虚构）：每月租金人民币 100.00 元。'];
const raw = { tenantId: T, docCompanyOID: C, docCompanyName: '验证主体（虚构）', companyOID: C, expenseReportOID: 'spike-report-1', businessCode: 'DGZF-SPIKE-1',
  formName: '常规对公付款', paymentAmount: '100.00', paymentCurrencyCode: 'CNY', lastModifyDate: '2026-10-10 08:00:00', status: 1003, approvalHistoryDTOs: [],
  expenseReportInvoices: [{ invoiceView: { attachments: [{ attachmentOID: 'spike-att-1', tenantId: T, fileName: '合同.pdf', fileType: 'PDF', size: bytes.length, fileURL: fileUrl }] } }] };
const advisoryResult = { recommendation: 'MANUAL_REVIEW', riskLevel: 'low', confidence: 'medium', summary: '验证用建议（虚构）', keyFindings: [],
  requiredActions: ['核对合同'], unresolvedQuestions: [], conflictFlags: [], rejectionDraft: null };

test('九安运行时在内存存储上读原件、再出 AI 建议（不需要 MySQL）', async () => {
  const config = { environment: 'prod', instance: 'test', scope: { tenantId: T, companyId: C }, accounts: [account] };
  const document = { ...normalizeAnalysisReport(structuredClone(raw), { scope: { tenantId: T, companyId: C }, connectionId: 'spike' }), collectedAt: '2026-10-10T09:00:00.000Z' };
  const store = createMemoryStore({ documents: [document], companies: [{ id: C, tenantId: T, name: '验证主体（虚构）' }] });
  const calls = [];
  const sha = createHash('sha256').update(bytes).digest('hex');
  const runtime = createAnalysisRuntimeServices({
    config, getConfig: () => config, store,
    ruleProvider: createAnalysisRuleWorkspace({ store, tenantId: T, getAccounts: () => config.accounts }),
    modelClient: { model: 'spike-model', async advisory(input) { calls.push(input); return structuredClone(advisoryResult); } },
    sourceClient: { async getReportDetail() { return { response: structuredClone(raw) }; } },
    evidenceFetch: async url => (String(url) === fileUrl
      ? new Response(bytes, { headers: { 'content-type': 'application/pdf', 'content-length': String(bytes.length) } })
      : new Response(null, { status: 404 })),
    attachmentHosts: ['spike-files.invalid'],
    extractor: async file => (file.sha256 === sha
      ? { status: 'ready', method: 'poc-text', totalPages: pages.length, errors: [], pages: pages.map((text, index) => ({ page: index + 1, text })) }
      : { status: 'failed', method: 'none', totalPages: null, errors: ['NO_TEXT'], pages: [] }),
  });
  try {
    const input = { actor, companyId: C, documentId: document.id, sourceVersion: document.version };
    await runtime.evidenceService.enqueue(input);
    await runtime.evidenceService.idle();
    assert.equal((await runtime.evidenceService.view(input)).status, 'completed');
    assert.equal((await runtime.adviceService.enqueue(input)).status, 'queued');
    await runtime.adviceService.idle();
    const advice = await runtime.adviceService.view({ actor, companyId: C, documentId: document.id });
    assert.equal(advice.status, 'completed');
    assert.equal(advice.advice.modelRecommendation, 'MANUAL_REVIEW');
    assert.equal(advice.advice.rejectionDraft, null);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].dataContext.environment, 'prod');
    assert.equal(calls[0].facts.evidenceCoverage.originalPageTextAvailable, true);
  } finally {
    await runtime.close();
  }
});

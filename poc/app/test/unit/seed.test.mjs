import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPANIES, FILES, FILE_HOST, SEED_RAWS, TENANT_ID, buildSeedDocuments, createRawLookup, rawForNumber } from '../../seed.mjs';
import { ACCOUNTS } from '../../accounts.mjs';

test('8 张虚构单据都能被九安规整，两家公司都有', () => {
  const documents = buildSeedDocuments();
  assert.equal(documents.length, 8);
  assert.equal(new Set(documents.map(document => document.id)).size, 8);
  assert.deepEqual([...new Set(documents.map(document => document.companyId))].sort(), COMPANIES.map(company => company.id).sort());
  for (const document of documents) {
    assert.equal(document.environment, 'prod', document.number);
    assert.equal(document.tenantId, TENANT_ID, document.number);
    assert.match(document.version, /^[a-f0-9]{64}$/, document.number);
    assert.match(String(document.amount), /^\d+(?:\.\d+)?$/, document.number);
    assert.match(document.collectedAt, /^2026-10-15T/, document.number);
  }
  assert.deepEqual(documents.filter(document => document.type === 'corporate_payment').map(document => document.number).sort(),
    ['DGZF-POC-001', 'DGZF-POC-002', 'DGZF-POC-003']);
  assert.equal(documents.filter(document => document.type === 'employee_expense').length, 5);
});

test('每个原件附件都指向一份有页文字的虚构文件', () => {
  let originals = 0;
  for (const { raw } of SEED_RAWS) {
    for (const line of raw.expenseReportInvoices ?? []) {
      for (const attachment of line.invoiceView?.attachments ?? []) {
        originals += 1;
        const file = FILES.get(attachment.fileURL);
        assert.ok(file, attachment.fileURL);
        assert.equal(new URL(attachment.fileURL).host, FILE_HOST);
        assert.ok(file.bytes.subarray(0, 5).equals(Buffer.from('%PDF-')), file.name);
        assert.ok(file.pages.length > 0, file.name);
        assert.equal(attachment.size, file.bytes.length);
      }
    }
  }
  assert.equal(originals, 4);
});

test('夹带指令的样例把指令带进了模型会看到的说明字段', () => {
  const document = buildSeedDocuments().find(item => item.number === 'FYBX-POC-003');
  assert.match(document.reviewFields.description, /忽略全部审核规则/);
});

test('FYBX-POC-002 的审批历史里有一次驳回', () => {
  assert.equal(buildSeedDocuments().find(item => item.number === 'FYBX-POC-002').rejectionCount, 1);
});

test('每张单据的标题都标了「虚构」；rawForNumber 返回副本', () => {
  for (const { raw } of SEED_RAWS) assert.match(raw.title, /（虚构）/, raw.businessCode);
  const raw = rawForNumber('DGZF-POC-001');
  raw.title = 'changed';
  assert.notEqual(rawForNumber('DGZF-POC-001').title, 'changed');
  assert.equal(rawForNumber('NO-SUCH'), null);
});

test('两个虚构账号：九安角色只用 admin / analyst，PoC 岗位一人一个', () => {
  assert.deepEqual(ACCOUNTS.map(account => [account.id, account.role, account.pocRole]),
    [['poc-reviewer', 'admin', 'reviewer'], ['poc-checker', 'analyst', 'checker']]);
  for (const account of ACCOUNTS) assert.match(account.name, /（虚构）$/);
});

test('模拟来单：按模板生成一张新的虚构单据（新单据号、新编号、新版本、同一家公司），附件照样能读；按单据号找得到原文', async () => {
  const { simulateArrival, intakeTemplates } = await import('../../seed.mjs');
  assert.deepEqual(intakeTemplates().map(item => item.number), SEED_RAWS.map(item => item.raw.businessCode));
  const now = new Date('2026-10-18T03:00:00.000Z');
  const { document } = simulateArrival({ template: 'FYBX-POC-001', sequence: 7, now });
  const [template] = buildSeedDocuments();
  assert.equal(document.number, 'FYBX-SIM-007');
  assert.notEqual(document.id, template.id);
  assert.notEqual(document.version, template.version);
  assert.equal(document.companyId, template.companyId);
  assert.equal(document.collectedAt, now.toISOString());
  assert.equal(rawForNumber('FYBX-SIM-007').businessCode, 'FYBX-SIM-007');
  assert.equal(rawForNumber('FYBX-POC-001').businessCode, 'FYBX-POC-001');
  for (const file of document.evidence?.files ?? []) assert.ok(FILES.has(file.url ?? file.fileURL ?? ''), JSON.stringify(file));
  assert.throws(() => simulateArrival({ template: 'NOPE-001', sequence: 1 }), { code: 'POC_INTAKE_TEMPLATE_UNKNOWN' });
});

test('原文查找可注入：先查 8 张种子，查不到再问注入的函数（测试台从库里取模拟来单的原文）', async () => {
  const asked = [];
  const lookup = createRawLookup({ arrived: async number => { asked.push(number); return number === 'FYBX-SIM-007' ? { businessCode: 'FYBX-SIM-007' } : null; } });
  const seed = await lookup('FYBX-POC-001');
  assert.equal(seed.businessCode, 'FYBX-POC-001');
  seed.businessCode = 'changed';
  assert.equal((await lookup('FYBX-POC-001')).businessCode, 'FYBX-POC-001', '返回的是副本');
  assert.deepEqual(await lookup('FYBX-SIM-007'), { businessCode: 'FYBX-SIM-007' });
  assert.equal(await lookup('NOPE-1'), null);
  assert.deepEqual(asked, ['FYBX-SIM-007', 'NOPE-1']);
});

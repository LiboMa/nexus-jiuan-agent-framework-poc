/**
 * 附件与 A2A 发现的端到端测试（对线上地址）。接口部分走浏览器同一条路（CloudFront → PoC 服务端 → A2A → Nexus），真实调用 3 次，约 0.15 美元：
 *   - 知识 Agent（审核员先启用，跑完停用；审核员没连接 Nexus 时这两项跳过）：带住宿发票图片做 select；带差旅制度 Markdown 做 answer；
 *   - 审核 Agent：按单据 FYBX-POC-001 带住宿发票 PDF 出审批建议，输出照样过九安的校验。
 * 界面部分（Playwright + 本机 Chrome）只检查附件区：加入示例附件、上传本机文件、挡掉不支持的类型，不发送。
 * 请用 run.sh 运行：它先重启服务，再从 infra/secrets.env 读口令与知识 Agent 的调用密钥（E2E_KNOWLEDGE_A2A_KEY）。
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createPocClient, parseAnswer } from '../../scripts/poc-client.mjs';

const BASE = process.env.E2E_BASE_URL || 'https://andon-finance.tinyboat.blog';
const PASSWORD = process.env.E2E_REVIEWER_PASSWORD;
const KNOWLEDGE = process.env.E2E_KNOWLEDGE_PUBLICATION || 'pub_2cc24c29d2e5b2c9';
const ADVISORY = process.env.E2E_ADVISORY_PUBLICATION || 'pub_5c53e70d8dc7ddea';
const SHOTS = new URL('../../../../evidence/round6/e2e/', import.meta.url);
const SAMPLES = fileURLToPath(new URL('../../samples/', import.meta.url));
const KNOWN = ['KA-C01', 'KA-C02', 'KA-C03', 'KA-C04', 'KB-C01', 'KB-C02', 'KA-D01', 'KA-D02', 'KA-D03', 'KA-D04', 'KB-D01', 'KB-D02'];
const KA_C01 = '员工出差住宿按城市分级报销：北京、上海、广州、深圳每晚不超过 600 元，其他城市每晚不超过 450 元；超标部分自理。确因会议指定酒店超标的，须附会议通知。';
const AI_TIMEOUT = 5 * 60_000;
let client, browser;

// 审核员本人已经启用了知识 Agent（不论状态）时，测试只用不动：不换密钥，跑完也不停用。
let knowledgeEnabled = false, enabledByTest = false;
before(async () => {
  assert.ok(PASSWORD, '请用 run.sh 运行：它从 infra/secrets.env 读口令');
  await mkdir(SHOTS, { recursive: true });
  client = createPocClient({ base: BASE });
  await client.login('poc-reviewer', PASSWORD);
  const me = await client.me();
  const existing = me.publications.find(item => item.publishId === KNOWLEDGE)?.enablement ?? null;
  if (existing) knowledgeEnabled = existing.status === 'active';
  else if (me.connection.status === 'connected' && process.env.E2E_KNOWLEDGE_A2A_KEY) {
    await client.enable(KNOWLEDGE, { token: process.env.E2E_KNOWLEDGE_A2A_KEY, loadCapabilities: false, client: 'cli' });
    knowledgeEnabled = enabledByTest = true;
  }
});
after(async () => {
  await browser?.close();
  if (enabledByTest) await client.disable(KNOWLEDGE).catch(() => {});
});

const sampleFile = async id => { const sample = await client.sample(id); return { name: sample.name, type: sample.mimeType, data: sample.data }; };
async function callAgent(body) {
  const run = await client.waitRun(await client.invoke(body), { timeoutMs: AI_TIMEOUT });
  assert.equal(run.status, 'ok', `${run.errorCode ?? ''} ${JSON.stringify(run.detail ?? null)}`);
  return run;
}

test('发现：审批 Agent 是系统提供的，经 A2A 读到名片；附件规则单独下发', async () => {
  const me = await client.me();
  const advisory = me.system.find(item => item.publishId === ADVISORY);
  assert.ok(advisory, '审批 Agent 应该是系统提供的');
  assert.equal(advisory.card?.error, null);
  assert.equal(advisory.card.protocolVersion, '0.3');
  for (const mode of ['application/pdf', 'image/png', 'text/markdown']) assert.ok(advisory.card.inputModes.includes(mode), mode);
  assert.equal((await client.attachmentPolicy()).attachmentPolicy.maxFiles, 5);
  assert.equal((await client.samples()).length, 6);
});

test('知识 Agent select：带住宿发票图片，从申请部门认出销售一部，挑出住宿标准，并说明从图片里读到了 580 元', { timeout: AI_TIMEOUT + 30_000 }, async t => {
  if (!knowledgeEnabled) { t.skip('知识 Agent 没有可用的启用：审核员没连接 Nexus，或者已有的那一项不可用'); return; }
  const input = { document: { companyId: 'poc-company-a', number: 'FYBX-POC-001', documentType: 'employee_reimbursement', formName: '差旅费报销单', expenseType: '差旅费',
    amount: '1280', currency: 'CNY', departmentName: '销售一部（虚构）', fields: [{ label: '出差事由', value: '拜访客户，确认续约条款' }],
    description: '北京客户拜访差旅：高铁往返与一晚住宿（虚构）' } };
  const run = await callAgent({ publishId: KNOWLEDGE, mode: 'text', text: JSON.stringify({ task: 'select', input }), attachments: [await sampleFile('hotel-invoice-png')] });
  assert.equal(run.task, 'task:select');
  assert.deepEqual(run.attachments.map(item => item.mimeType), ['image/png']);
  const out = parseAnswer(run.rawText);
  assert.equal(out?.task, 'select', run.rawText);
  assert.ok(out.departments.some(item => item.name === '销售一部' && item.source === 'applicant_department'), JSON.stringify(out.departments));
  const ids = out.items.map(item => item.id);
  assert.ok(ids.includes('KA-C01'), ids.join(','));
  assert.ok(ids.every(id => KNOWN.includes(id)), ids.join(','));
  assert.ok(out.focus.length <= 17 && out.focus.every(line => line.length <= 600));
  assert.equal(out.attachmentsRead?.length, 1, JSON.stringify(out.attachmentsRead));
  assert.match(JSON.stringify(out.attachmentsRead), /580/);
});

test('知识 Agent answer：带差旅制度 Markdown，回答引用 KA-C01（摘录逐字取自原文），并说明读到了附件', { timeout: AI_TIMEOUT + 30_000 }, async t => {
  if (!knowledgeEnabled) { t.skip('知识 Agent 没有可用的启用：审核员没连接 Nexus，或者已有的那一项不可用'); return; }
  const policy = await sampleFile('travel-policy-md');
  const input = { question: '附件里的制度与知识库，对北京出差住宿每晚上限的说法一致吗？', companyId: 'poc-company-a' };
  const run = await callAgent({ publishId: KNOWLEDGE, mode: 'text', text: JSON.stringify({ task: 'answer', input }), attachments: [policy] });
  const out = parseAnswer(run.rawText);
  assert.equal(out?.task, 'answer', run.rawText);
  const cited = out.citations.find(item => item.id === 'KA-C01');
  assert.ok(cited, JSON.stringify(out.citations));
  assert.ok(KA_C01.includes(cited.quote), cited.quote);
  assert.match(out.answer, /600/);
  assert.ok(out.attachmentsRead?.some(item => item.name === policy.name), JSON.stringify(out.attachmentsRead));
});

test('审核 Agent：单据 FYBX-POC-001 带住宿发票 PDF，审批建议照样过九安的校验', { timeout: AI_TIMEOUT + 30_000 }, async () => {
  const document = (await client.documents()).find(item => item.number === 'FYBX-POC-001');
  const run = await callAgent({ publishId: ADVISORY, mode: 'advisory', documentId: document.id, attachments: [await sampleFile('hotel-invoice-pdf')] });
  assert.equal(run.task, 'advisory');
  assert.equal(run.validation, 'passed');
  assert.deepEqual(run.attachments.map(item => item.mimeType), ['application/pdf']);
});

test('界面：调用测试面板显示名片、加入示例附件、上传本机文件（图片带缩略图），挡掉不支持的类型；不发送', async () => {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await (await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } })).newPage();
  await page.goto(BASE);
  await page.locator('#poc-login-account').selectOption('poc-reviewer');
  await page.locator('#poc-login-password').fill(PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.locator('article.document-card').first().waitFor();
  await page.evaluate(() => { window.location.hash = '#nexusAgents'; });
  const panel = page.locator('#poc-invoke');
  await panel.waitFor();
  await panel.locator('#poc-invoke-target').selectOption(knowledgeEnabled ? KNOWLEDGE : ADVISORY);
  await assert.doesNotReject(panel.getByText(/名片（A2A 0\.3，流式）：接受 .*PDF/).waitFor());
  await panel.getByRole('button', { name: '住宿发票-FYBX-POC-001.png' }).click();
  const items = panel.locator('ul.poc-attachments li');
  await items.first().waitFor();
  await assert.doesNotReject(items.first().locator('img.poc-thumb').waitFor());
  await panel.locator('#poc-invoke-files').setInputFiles(path.join(SAMPLES, '报销明细-FYBX-POC-001.xlsx'));
  await page.waitForFunction(() => document.querySelectorAll('ul.poc-attachments li').length === 2);
  assert.match(await items.nth(1).innerText(), /报销明细-FYBX-POC-001\.xlsx/);
  const unsupported = path.join(await mkdtemp(path.join(tmpdir(), 'poc-e2e-')), 'setup.exe');
  await writeFile(unsupported, 'MZ');
  await panel.locator('#poc-invoke-files').setInputFiles(unsupported);
  await assert.doesNotReject(panel.getByText('setup.exe：不支持这种类型').waitFor());
  assert.equal(await items.count(), 2);
  await panel.screenshot({ path: fileURLToPath(new URL('invoke-attachments.png', SHOTS)) });
});

/**
 * 给交付文档截线上页面的图（docs/assets/screens/*.png）。只看不改：登录审核员，打开单据池、单据详情的审批流卡片、
 * Agent 页（我的 Nexus 连接、我的 Agent）和调用测试面板（加一个示例附件，不发送），不调用任何 Agent，不花钱。
 *   cd audit-nexus/poc/app/test/e2e && node capture-screens.mjs
 * 口令从 infra/secrets.env 读（REVIEWER_PASSWORD），不打印；E2E_BASE_URL 可改站点。
 */
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { readSecret } from '../../scripts/poc-client.mjs';

const BASE = process.env.E2E_BASE_URL || 'https://andon-finance.tinyboat.blog';
const SECRETS = fileURLToPath(new URL('../../../infra/secrets.env', import.meta.url));
const OUT = new URL('../../../../docs/assets/screens/', import.meta.url);
const password = readSecret(SECRETS, 'REVIEWER_PASSWORD');
if (!password) throw new Error(`在 ${SECRETS} 里找不到 REVIEWER_PASSWORD`);
const file = name => fileURLToPath(new URL(`${name}.png`, OUT));

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await (await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } })).newPage();
  await page.goto(BASE);
  await page.locator('#poc-login-account').selectOption('poc-reviewer');
  await page.locator('#poc-login-password').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.locator('article.document-card').first().waitFor();
  await page.waitForTimeout(800);
  await page.screenshot({ path: file('documents') });
  console.log('documents.png');

  const card = page.locator('article.document-card', { has: page.locator('h2.document-title', { hasText: 'FYBX-POC-001' }) });
  await card.getByRole('button', { name: '查看依据' }).click();
  const approval = page.locator('dialog.detail-dialog .poc-approval');
  await approval.waitFor();
  await approval.scrollIntoViewIfNeeded();
  await approval.screenshot({ path: file('document-approval') });
  console.log('document-approval.png');
  await page.keyboard.press('Escape');

  await page.evaluate(() => { window.location.hash = '#nexusAgents'; });
  await page.getByText('我的 Nexus 连接').first().waitFor();
  await page.locator('.poc-my-agents').waitFor();
  await page.waitForTimeout(800);
  await page.screenshot({ path: file('agents-page') });
  console.log('agents-page.png');

  const invoke = page.locator('#poc-invoke');
  await invoke.scrollIntoViewIfNeeded();
  await invoke.getByRole('button', { name: '住宿发票-FYBX-POC-001.png' }).click();
  await invoke.locator('ul.poc-attachments li img.poc-thumb').first().waitFor();
  await invoke.screenshot({ path: file('invoke-panel') });
  console.log('invoke-panel.png');
} finally {
  await browser.close();
}

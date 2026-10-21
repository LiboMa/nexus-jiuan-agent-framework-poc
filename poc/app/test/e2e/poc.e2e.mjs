/**
 * 对线上地址的端到端测试（Playwright + 本机 Chrome，不下载浏览器），覆盖规格第 9 节的场景。
 * 真实调用 Nexus：两次审批建议加一次调用测试，约 0.15 美元。请用 run.sh 运行：它先重启服务，再从 infra/secrets.env 读口令。
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const BASE = process.env.E2E_BASE_URL || 'https://andon-finance.tinyboat.blog';
const PASSWORD = { 'poc-reviewer': process.env.E2E_REVIEWER_PASSWORD, 'poc-checker': process.env.E2E_CHECKER_PASSWORD };
const SHOTS = new URL('../../../../evidence/round5/e2e/', import.meta.url);
const AI_TIMEOUT = 5 * 60_000;
let browser;

before(async () => {
  assert.ok(PASSWORD['poc-reviewer'] && PASSWORD['poc-checker'], '请用 run.sh 运行：它从 infra/secrets.env 读口令');
  await mkdir(SHOTS, { recursive: true });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});
after(async () => { await browser?.close(); });

async function signIn(account) {
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await page.goto(BASE);
  await page.locator('#poc-login-account').selectOption(account);
  await page.locator('#poc-login-password').fill(PASSWORD[account]);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.locator('article.document-card').first().waitFor();
  return page;
}
const go = (page, route) => page.evaluate(hash => { window.location.hash = hash; }, route);
async function openDocument(page, number) {
  await go(page, '#documents');
  const card = page.locator('article.document-card', { has: page.locator('h2.document-title', { hasText: number }) });
  await card.getByRole('button', { name: '查看依据' }).click();
  const panel = page.locator('dialog.detail-dialog .poc-approval');
  await panel.waitFor();
  return panel;
}
const reach = (panel, status, timeout = 30_000) => panel.locator(`.poc-status[data-status="${status}"]`).waitFor({ timeout });
const shot = (page, name) => page.screenshot({ path: fileURLToPath(new URL(`${name}.png`, SHOTS)), fullPage: true });

async function decide(panel, decision, reason) {
  await panel.locator(`#poc-decision-${decision}`).check();
  await panel.locator('#poc-decision-reason').fill(reason);
  if (decision === 'return') {
    const note = panel.locator('#poc-return-note');
    if (!(await note.inputValue()).trim()) await note.fill('请补充酒店发票与培训通知后重新提交。');
  }
  await panel.getByRole('button', { name: '提交复核结果' }).click();
  await reach(panel, decision === 'approve' ? 'approved' : 'returned');
}
const cardOf = (page, number) => page.locator('article.document-card', { has: page.locator('h2.document-title', { hasText: number }) });

test('0. 平台中心能打开（九安真实运行时）', async () => {
  const page = await signIn('poc-checker');
  await go(page, '#platformAgents');
  const card = page.locator('article.platform-agent-card', { has: page.locator('h3', { hasText: '汇联易单据同步' }) });
  await card.waitFor({ timeout: 30_000 });
  assert.doesNotMatch(await card.locator('.platform-status').innerText(), /运行中/);
  await shot(page, '00-platform-agents');
  await page.context().close();
});

test('1. 用口令登录后看到单据池（8 张虚构单据）和「模拟来单」', async () => {
  const page = await signIn('poc-reviewer');
  await go(page, '#documents');
  await page.locator('.list-count', { hasText: '共 8 张单据' }).waitFor();
  await page.locator('.poc-intake').getByRole('button', { name: '模拟来单' }).waitFor();
  await shot(page, '01-documents');
  await page.context().close();
});

test('2–3. 模拟来单：系统自动发起，卡片上不用点就出现 AI 初审建议；复核人人工复核退回，结果为「已退回」', { timeout: AI_TIMEOUT + 3 * 60_000 }, async () => {
  const reviewer = await signIn('poc-reviewer');
  await go(reviewer, '#documents');
  const bar = reviewer.locator('.poc-intake');
  await bar.locator('#poc-intake-template option[value="FYBX-POC-002"]').waitFor({ state: 'attached' });
  await bar.locator('#poc-intake-template').selectOption('FYBX-POC-002');
  await bar.getByRole('button', { name: '模拟来单' }).click();
  await reviewer.locator('.list-count', { hasText: '共 9 张单据' }).waitFor();
  const card = reviewer.locator('article.document-card').first();
  const number = (await card.locator('h2.document-title').innerText()).trim();
  assert.match(number, /^FYBX-SIM-\d{3}$/);
  await card.locator('.poc-approval-slot', { hasText: '来单自动发起' }).waitFor();
  await card.locator('.poc-approval-slot', { hasText: 'AI 初审：' }).waitFor({ timeout: AI_TIMEOUT });
  await card.locator('.poc-approval-slot', { hasText: '待人工复核' }).waitFor();
  await shot(reviewer, '02-auto-advice-on-card');
  await reviewer.context().close();
  const checker = await signIn('poc-checker');
  const panel = await openDocument(checker, number);
  await reach(panel, 'pending_review');
  await panel.locator('.poc-advice', { hasText: 'AI 初审建议' }).waitFor();
  await decide(panel, 'return', 'E2E：缺少酒店发票与培训通知，退回补充。');
  await shot(checker, '03-returned');
  await checker.context().close();
});

test('4. 原有单据手动发起 AI 初审；审核员人工复核通过，结果为「已通过」', { timeout: AI_TIMEOUT + 3 * 60_000 }, async () => {
  const reviewer = await signIn('poc-reviewer');
  const panel = await openDocument(reviewer, 'FYBX-POC-001');
  await panel.getByRole('button', { name: '发起 AI 初审' }).click();
  await reach(panel, 'pending_review', AI_TIMEOUT);
  await decide(panel, 'approve', 'E2E：附件与金额已核对。');
  await shot(reviewer, '04-approved');
  await reviewer.context().close();
});

test('5. Nexus Agent 页：审核员本人启用的审批 Agent 在调用测试里，调用成功并通过九安校验', { timeout: 6 * 60_000 }, async () => {
  const page = await signIn('poc-reviewer');
  await go(page, '#nexusAgents');
  const target = page.locator('#poc-invoke-target');
  await target.locator('option[value="pub_5c53e70d8dc7ddea"]').waitFor({ state: 'attached' });
  await target.selectOption('pub_5c53e70d8dc7ddea');
  await page.locator('#poc-invoke-mode-advisory').check();
  const option = page.locator('#poc-invoke-document option', { hasText: 'FYBX-POC-004' });
  await option.waitFor({ state: 'attached' });
  await page.locator('#poc-invoke-document').selectOption(await option.getAttribute('value'));
  await page.getByRole('button', { name: '发送' }).click();
  // 一出结果就判断：失败时带上面板里的错误码直接报出来，不等到超时。
  const result = page.locator('#poc-invoke .poc-result');
  const outcome = result.locator('.tag', { hasText: /^(成功|失败)$/ }).first();
  await outcome.waitFor({ timeout: 5 * 60_000 });
  assert.equal((await outcome.textContent()).trim(), '成功', (await result.innerText()).slice(0, 500));
  await page.locator('#poc-invoke .poc-result .tag', { hasText: '九安校验通过' }).waitFor();
  await page.locator('table.poc-runs td', { hasText: '调用测试' }).first().waitFor();
  await shot(page, '05-nexus-agents');
  await page.context().close();
});

test('6. 单据池的卡片上显示审批结果', async () => {
  const page = await signIn('poc-reviewer');
  await go(page, '#documents');
  const status = number => page.locator('article.document-card', { has: page.locator('h2.document-title', { hasText: number }) }).locator('.poc-approval-slot .tag');
  await page.locator('article.document-card').first().locator('.poc-approval-slot .tag', { hasText: '已退回' }).waitFor();
  await status('FYBX-POC-001').filter({ hasText: '已通过' }).waitFor();
  await shot(page, '06-pool-statuses');
  await page.context().close();
});

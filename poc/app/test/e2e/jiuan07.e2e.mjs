/**
 * 测试台上九安 v0.7.10（https://jiuan-v0710.tinyboat.blog）的端到端测试（Playwright + 本机 Chrome）。请用 run07.sh 运行：它先重置库
 * （保留「Agent 接入」的启用记录），再从 infra/secrets.env 读两个账号的口令。调用密钥不经过测试：管理员在
 * 「后台配置 › Agent 接入」页上粘贴一次，九安加密存库，之后的调用都用这条启用记录。
 * 流程：口令登录 → 页面上的启用记录在、可用 → 四张虚构对公付款单先读取原件、再手动发起 AI 独立建议（重置后启用记录写回之前的那一轮九安不自动重排）
 * → 结论和依据核对，Agent 引用的规则编号到测试台的知识库（nexus-pgvector 的 approval_rules）里逐个核对 → 计入两档结论 → 没有回写
 * → 模拟来单一张，等九安同步、读详情后自动发起并完成 → 期间九安没有连 Nexus 以外的地址、没有调汇联易的审批写入。
 * 真实调用 Nexus：五次 AI 独立建议，每次约 0.1–0.3 美元。
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';

const run = promisify(execFile);
const BASE = process.env.E2E07_BASE_URL || 'https://jiuan-v0710.tinyboat.blog';
const INSTANCE = process.env.E2E07_INSTANCE;
const PUBLISH_ID = 'pub_5c53e70d8dc7ddea';
const SHOTS = new URL('../../../../evidence/round7/e2e/', import.meta.url);
// fixtures.mjs 的四个场景：九安房租（合同、发票齐）、柯顿运维费（超合同、收款方不符）、O+O 税款（有缴款通知）、新零售推广费（无原件、事由带注入文字）
const EXPECT = Object.freeze({ 'DGZF-F07-001': 'pass', 'DGZF-F07-002': 'fail', 'DGZF-F07-003': 'pass', 'DGZF-F07-004': 'fail' });
const RULE_ID = /\b(C\d{2}-(?:\d+\.\d+|NOTE)|G-\d{2})\b/g;
const ADVICE_TIMEOUT = 5 * 60_000;
const startedAt = new Date();
let browser, page;
const advices = new Map();

before(async () => {
  assert.ok(process.env.E2E_REVIEWER_PASSWORD && INSTANCE, '请用 run07.sh 运行：它重置测试台并从 infra/secrets.env 读两个账号的口令');
  await mkdir(SHOTS, { recursive: true });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await (await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } })).newPage();
});
after(async () => { await browser?.close(); });

const shot = name => page.screenshot({ path: fileURLToPath(new URL(`${name}.png`, SHOTS)), fullPage: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
/** 用页面的会话调九安的接口；POST 带上九安要的 X-CSRF-Token。 */
const api = (path, { method = 'GET', body } = {}) => page.evaluate(async ({ path, method, body }) => {
  const headers = { Accept: 'application/json' };
  if (method !== 'GET') {
    const session = await (await fetch('/api/analysis/v1/session', { credentials: 'same-origin' })).json();
    Object.assign(headers, { 'Content-Type': 'application/json', 'X-CSRF-Token': session.data.csrfToken });
  }
  const response = await fetch(`/api/analysis/v1${path}`, { method, credentials: 'same-origin', headers, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, json: await response.json().catch(() => null) };
}, { path, method, body });
const documents = async () => (await api('/documents?limit=50')).json.data.items;
const byNumber = async number => (await documents()).find(item => item.number === number);
async function until(read, done, { timeout, every = 5000, what }) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) assert.fail(`${what}：${Math.round(timeout / 1000)} 秒内没有完成，最后状态 ${JSON.stringify(value)?.slice(0, 300)}`);
    await sleep(every);
  }
}
const finished = advice => ['completed', 'failed', 'declined'].includes(advice?.status);
const ruleIdsOf = advice => [...new Set((advice?.basis ?? []).filter(item => item.kind === 'rule').flatMap(item => [...String(item.ref).matchAll(RULE_ID)].map(match => match[1])))];

/** 经 SSM 到测试台的知识库里查这些规则编号，返回查到的那些。 */
async function knownRuleIds(ids) {
  if (!ids.every(id => /^[A-Z0-9.-]+$/.test(id))) throw new Error(`规则编号格式不对：${ids}`);
  const sql = `SELECT string_agg(rule_id, ',' ORDER BY rule_id) FROM approval_rules WHERE rule_id IN (${ids.map(id => `'${id}'`).join(',')});`;
  const params = JSON.stringify({ commands: [`docker exec nexus-pgvector psql -U postgres -d nexus -X -tAc "${sql}"`] });
  const aws = async args => (await run('aws', ['--region', 'us-east-1', ...args, '--output', 'text'])).stdout.trim();
  const id = await aws(['ssm', 'send-command', '--instance-ids', INSTANCE, '--document-name', 'AWS-RunShellScript', '--comment', 'e2e kb rule-id check (read-only)', '--parameters', params, '--query', 'Command.CommandId']);
  await run('aws', ['--region', 'us-east-1', 'ssm', 'wait', 'command-executed', '--command-id', id, '--instance-id', INSTANCE]).catch(() => {});
  return (await aws(['ssm', 'get-command-invocation', '--command-id', id, '--instance-id', INSTANCE, '--query', 'StandardOutputContent'])).split(',').filter(Boolean);
}

test('登录：口令登录后进入九安 v0.7.10，单据池里是模拟汇联易同步来的 5 张虚构单据（4 张对公付款、1 张差旅报销）', async () => {
  await page.goto(BASE);
  await page.waitForURL(/\/poc\/login$/);
  await page.locator('#account').selectOption('poc-reviewer');
  await page.locator('#password').fill(process.env.E2E_REVIEWER_PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await page.getByText('版本 v0.7.10').first().waitFor({ timeout: 30_000 });
  const items = await until(documents, list => list.length >= 5, { timeout: 4 * 60_000, what: '单据同步' });
  assert.deepEqual(items.filter(item => item.type === 'corporate_payment').map(item => item.number).sort(), Object.keys(EXPECT));
  assert.equal(items.filter(item => item.type !== 'corporate_payment').length, 1);
  await page.getByRole('link', { name: '单据池' }).first().click();
  for (const number of Object.keys(EXPECT)) await page.getByText(number).first().waitFor();
  await shot('01-documents');
});

test('Agent 接入：管理员在页面上启用的发布还在，状态「已启用」，名片声明的任务是 review_advice@1（密钥只在页面上粘贴，测试不碰）', async () => {
  await page.getByRole('link', { name: '后台配置' }).click();
  await page.getByRole('tab', { name: 'Agent 接入' }).click();
  const row = page.getByRole('row', { name: new RegExp(PUBLISH_ID) });
  await row.waitFor({ timeout: 20_000 }).catch(() => assert.fail(`还没有启用 ${PUBLISH_ID}：请到 ${BASE}/#adminConfig?tab=agentAccess 用「启用一个发布」粘贴调用密钥，再跑测试`));
  await row.getByText('已启用').waitFor({ timeout: 10_000 }).catch(() => assert.fail(`${PUBLISH_ID} 的启用记录不是「已启用」（可能已失效）：请到 Agent 接入页换一把密钥`));
  await row.getByText('review_advice@1').waitFor({ timeout: 10_000 });
  await shot('02-agent-access');
});

test('AI 独立建议：四张对公付款单各发起一轮，结论符合预期，依据里引用了知识库规则，编号都在库里', { timeout: ADVICE_TIMEOUT + 3 * 60_000 }, async () => {
  for (const number of Object.keys(EXPECT)) {
    const document = await byNumber(number);
    // 九安页面上的顺序：先「读取原件」，再「运行一轮 AI 独立建议」（AI 独立建议只用已经读过的原件）。DGZF-F07-004 没有原件。
    const evidence = async () => (await api(`/documents/${document.id}/evidence`)).json.data;
    if ((await evidence()).status !== 'completed') {
      const read = await api(`/documents/${document.id}/evidence/read`, { method: 'POST', body: { sourceVersion: document.version } });
      assert.ok([200, 202].includes(read.status), `${number} 读取原件没有受理：${JSON.stringify(read.json)?.slice(0, 300)}`);
      await until(evidence, value => ['completed', 'failed'].includes(value?.status), { timeout: 60_000, every: 2000, what: `${number} 读取原件` });
    }
    const started = await api(`/documents/${document.id}/advice`, { method: 'POST', body: { sourceVersion: document.version } });
    assert.equal(started.status, 202, `${number} 发起失败：${JSON.stringify(started.json)?.slice(0, 300)}`);
  }
  const cited = new Set();
  for (const [number, expected] of Object.entries(EXPECT)) {
    const document = await byNumber(number);
    const advice = await until(async () => (await api(`/documents/${document.id}/advice`)).json.data, finished, { timeout: ADVICE_TIMEOUT, what: `${number} 的 AI 独立建议` });
    advices.set(number, advice);
    assert.equal(advice.status, 'completed', `${number}：${advice.errorCode ?? advice.declinedReason}`);
    assert.equal(advice.result, expected, `${number} 的结论是 ${advice.result}，应为 ${expected}：${advice.note}`);
    const ids = ruleIdsOf(advice);
    assert.ok(ids.length, `${number} 没有引用知识库规则：${JSON.stringify(advice.basis)}`);
    ids.forEach(id => cited.add(id));
  }
  const known = await knownRuleIds([...cited]);
  assert.deepEqual([...cited].filter(id => !known.includes(id)), [], 'Agent 引用了知识库里没有的规则编号');
  // 页面上：单据详情里的「AI 独立建议」显示结论和规则依据
  for (const [number, expected] of Object.entries(EXPECT)) {
    await page.getByRole('link', { name: '单据池' }).first().click();
    const card = page.locator(`article.document-card[data-document-id="${(await byNumber(number)).id}"]`);
    await card.getByRole('button', { name: '查看依据' }).click();
    const dialog = page.getByRole('dialog', { name: number });
    await dialog.getByRole('heading', { name: 'AI 独立建议', level: 2 }).waitFor({ timeout: 30_000 });
    // 建议的标题是「建议通过（时间）」「不建议通过（时间）」，和两档结论里的「建议通过——…」用全角括号区分
    await dialog.getByText(expected === 'pass' ? /^建议通过（/ : /^不建议通过（/).first().waitFor({ timeout: 30_000 });
    await dialog.getByText(ruleIdsOf(advices.get(number))[0]).first().waitFor();
    await shot(`03-advice-${number}`);
    await dialog.getByRole('button', { name: '关闭' }).click();
  }
});

test('两档结论：AI 独立建议计入结论，不再显示「平台尚未完成 AI 独立建议」', async () => {
  for (const [number, expected] of Object.entries(EXPECT)) {
    const verdict = JSON.stringify((await byNumber(number)).verdict);
    assert.doesNotMatch(verdict, /平台尚未完成 AI 独立建议/, number);
    assert.match(verdict, expected === 'pass' ? /AI 独立建议：建议通过/ : /AI 独立建议：不建议通过/, number);
  }
});

test('没有回写：AI 独立建议不带通过 / 驳回，审批汇总接口不存在', async () => {
  for (const advice of advices.values()) assert.deepEqual([advice.canApprove, advice.canReject], [false, false]);
  assert.equal((await api('/approvals/summary?window=7d')).status, 404);
});

test('模拟来单：管理员来一张新单，九安下一轮同步进单据池，读完详情后自动发起 AI 独立建议并完成', { timeout: 12 * 60_000 }, async () => {
  await page.goto(`${BASE}/poc/intake`);
  await page.locator('#template').selectOption('DGZF-F07-001');
  await page.getByRole('button', { name: '模拟来单' }).click();
  const message = await page.locator('#message').filter({ hasText: /已来单 DGZF-SIM-\d{3}/ }).textContent({ timeout: 30_000 });
  const number = /DGZF-SIM-\d{3}/.exec(message)[0];
  await shot('04-intake');
  await page.goto(BASE);
  const document = await until(() => byNumber(number), Boolean, { timeout: 4 * 60_000, what: `${number} 进单据池` });
  const advice = await until(async () => (await api(`/documents/${document.id}/advice`)).json.data, finished, { timeout: ADVICE_TIMEOUT, what: `${number} 自动发起的 AI 独立建议` });
  assert.equal(advice.status, 'completed', `${number}：${advice.errorCode ?? advice.declinedReason}`);
  assert.equal(advice.result, 'pass', `${number}（模板 DGZF-F07-001）的结论应为 pass：${advice.note}`);
  assert.ok(ruleIdsOf(advice).length, '自动发起的这一轮也要引用知识库规则');
});

test('出网与写回：测试期间九安没有调汇联易的审批写入；被拦下的出网只有写死的外部地址，没有 Nexus', async () => {
  const since = startedAt.toISOString().replace('T', ' ').slice(0, 19);
  const params = JSON.stringify({ commands: [`journalctl -u andon-jiuan07 --since '${since} UTC' --no-pager -o cat | grep -E 'POC_EGRESS_BLOCKED|POC_HLY_WRITE_BLOCKED' | sort | uniq -c || true`] });
  const aws = async args => (await run('aws', ['--region', 'us-east-1', ...args, '--output', 'text'])).stdout.trim();
  const id = await aws(['ssm', 'send-command', '--instance-ids', INSTANCE, '--document-name', 'AWS-RunShellScript', '--comment', 'e2e egress check (read-only)', '--parameters', params, '--query', 'Command.CommandId']);
  await run('aws', ['--region', 'us-east-1', 'ssm', 'wait', 'command-executed', '--command-id', id, '--instance-id', INSTANCE]).catch(() => {});
  const lines = await aws(['ssm', 'get-command-invocation', '--command-id', id, '--instance-id', INSTANCE, '--query', 'StandardOutputContent']);
  console.log(`出网与写回拦截记录：${lines || '（无）'}`);
  assert.doesNotMatch(lines, /POC_HLY_WRITE_BLOCKED/);
  assert.doesNotMatch(lines, /POC_EGRESS_BLOCKED nxs-beine1013/);
});

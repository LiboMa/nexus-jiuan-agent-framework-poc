/**
 * 测试台上九安 v0.7.10（https://jiuan-v0710.tinyboat.blog）的端到端测试（Playwright + 本机 Chrome）。请用 run07.sh 运行：它先重置库
 * （保留「Agent 接入」的启用记录），再从 infra/secrets.env 读两个账号的口令。调用密钥不经过测试：管理员在
 * 「后台配置 › Agent 接入」页上粘贴一次，九安加密存库，之后的调用都用这条启用记录。
 * 流程：口令登录 → 页面上的启用记录在、可用 → 四张虚构对公付款单先读取原件、再手动发起 AI 独立建议（重置后启用记录写回之前的那一轮九安不自动重排）
 * → 结论和依据核对，Agent 引用的规则编号到测试台的知识库（nexus-pgvector 的 approval_rules）里逐个核对 → 计入两档结论 → 没有回写
 * → 模拟来单一张，等九安同步、读详情后自动发起并完成 → 给了 KB_E2E_DOCX（本机的制度原文）时，在「规则库 › 制度知识库」上传、预览、入库、检索、看检索日志
 * → 期间九安没有连 Nexus 以外的地址、没有调汇联易的审批写入。
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
const SHOTS = new URL('../../../../evidence/round7/e2e/', import.meta.url);
// fixtures.mjs 的四个场景：九安房租（合同、发票齐）、柯顿运维费（超合同、收款方不符）、O+O 税款（有缴款通知）、新零售推广费（无原件、事由带注入文字）
const EXPECT = Object.freeze({ 'DGZF-F07-001': 'pass', 'DGZF-F07-002': 'fail', 'DGZF-F07-003': 'pass', 'DGZF-F07-004': 'fail' });
const RULE_ID = /\b(C\d{2}-(?:\d+\.\d+|NOTE)|G-\d{2})\b/g;
const ADVICE_TIMEOUT = 5 * 60_000;
const startedAt = new Date();
let browser, page, publication = null;
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

test('Agent 接入：页面上已经连了 Nexus，Nexus 上的发布和已启用的 Agent 在一张表里；审批流只调一个审批 Agent（就绪、接 review_advice@1），其他就绪的只供前端工作流调用（不写死发布；密钥只在页面上粘贴，测试不碰）', async () => {
  const { records = [] } = (await api('/platform/agent-access')).json?.data ?? {};
  // 审批流只调审批 Agent（补丁 0003）：就绪、被指定为审批 Agent 的那一个，它的 card.tasks 才带 review_advice@1
  publication = records.find(record => record.status === 'active' && record.approval === true && record.card?.tasks?.includes('review_advice@1')) ?? null;
  assert.ok(publication, `还没有可用的审批 Agent：请到 ${BASE}/#adminConfig?tab=agentAccess 启用审核 Agent（贴调用密钥），再点「设为审批 Agent」，然后跑测试`);
  assert.equal(records.filter(record => record.approval === true).length, 1, '审批 Agent 只有一个');
  await page.getByRole('link', { name: '后台配置' }).click();
  await page.getByRole('tab', { name: 'Agent 接入' }).click();
  await page.locator('.platform-access-bar').getByText('已连接 Nexus').waitFor({ timeout: 60_000 });
  const card = page.locator('.platform-access-agent').filter({ hasText: publication.publishId });
  await card.getByText('就绪', { exact: true }).waitFor({ timeout: 60_000 });
  await card.getByText('审批 Agent', { exact: true }).waitFor();
  await card.getByText(/审批流调用它：.*review_advice@1/).waitFor();
  await page.locator('.platform-access-approval').getByText(/审批流调用「/).waitFor();
  assert.equal(await page.locator('.platform-access-agent').filter({ hasText: publication.publishId }).count(), 1, '同一个发布只列一次');
  assert.deepEqual(await card.getByRole('button').allTextContents(), ['测试', '取消审批 Agent', '停用', '复核']);
  // 其他已启用的 Agent 只是就绪，不进审批流
  for (const other of records.filter(record => record.status === 'active' && record.publishId !== publication.publishId)) {
    await page.locator('.platform-access-agent').filter({ hasText: other.publishId }).getByText('供前端工作流调用（不进审批流）').waitFor();
  }
  // 新发布的名片说明里没有契约 / 任务两行时，照样能启用（任务由平台指定），不再报「名片 description 不满足」
  assert.doesNotMatch(await page.locator('.platform-access-page').innerText(), /description 不满足|hasLine/);
  await assert.rejects(page.getByRole('button', { name: '启用一个发布' }).waitFor({ timeout: 2000 }), '不再有手填发布编号的启用表单');
  await shot('02-agent-access');
});

test('AI 独立建议：四张对公付款单都有结论（重置后九安自动发起；没发起的再手动发起），结论符合预期，依据里引用了知识库规则，编号都在库里', { timeout: ADVICE_TIMEOUT + 3 * 60_000 }, async () => {
  assert.ok(publication, '上一条用例没找到可用的审核 Agent');
  for (const number of Object.keys(EXPECT)) {
    const document = await byNumber(number);
    // 九安页面上的顺序：先「读取原件」，再「运行一轮 AI 独立建议」（AI 独立建议只用已经读过的原件）。DGZF-F07-004 没有原件。
    const evidence = async () => (await api(`/documents/${document.id}/evidence`)).json.data;
    if ((await evidence()).status !== 'completed') {
      const read = await api(`/documents/${document.id}/evidence/read`, { method: 'POST', body: { sourceVersion: document.version } });
      assert.ok([200, 202].includes(read.status), `${number} 读取原件没有受理：${JSON.stringify(read.json)?.slice(0, 300)}`);
      await until(evidence, value => ['completed', 'failed'].includes(value?.status), { timeout: 60_000, every: 2000, what: `${number} 读取原件` });
    }
    const now = (await api(`/documents/${document.id}/advice`)).json.data;
    if (now?.status === 'running' || now?.status === 'completed' && now.stale !== true) continue;   // 九安已经自动发起或跑完
    const started = await api(`/documents/${document.id}/advice`, { method: 'POST', body: { sourceVersion: document.version } });
    assert.ok([202, 409].includes(started.status), `${number} 发起失败：${JSON.stringify(started.json)?.slice(0, 300)}`);   // 409 是自动那一轮正在跑
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
    // 九安把 Agent 的备注和依据收在折叠的「模型说明（模型自评，未核实）」里：像审核人一样展开，再找规则编号
    const note = dialog.locator('details.analysis-advice-model-note').first();
    await note.locator('summary').click();
    await note.getByText(ruleIdsOf(advices.get(number))[0]).first().waitFor();
    await shot(`03-advice-${number}`);
    await dialog.getByRole('button', { name: '关闭' }).click();
  }
});

test('调用记录与测试：每张对公付款单的这一轮都在调用记录里；在「Agent 接入」页测审批 Agent：单据（得到结论，不改单据的结论）、文本（有回复）、请求信封 describe@1（回答合契约），都记进调用记录', { timeout: 8 * 60_000 }, async () => {
  assert.ok(publication, '前面的用例没找到可用的审核 Agent');
  const calls = (await api('/platform/agent-access/calls')).json?.data?.items ?? [];
  for (const [number, expected] of Object.entries(EXPECT)) {
    assert.ok(calls.some(call => call.number === number && call.status === 'completed' && call.result === expected && call.publishId === publication.publishId), `调用记录里缺 ${number} 的这一轮`);
  }
  const before = JSON.stringify((await byNumber('DGZF-F07-003')).verdict);
  await page.getByRole('link', { name: '后台配置' }).click();
  await page.getByRole('tab', { name: 'Agent 接入' }).click();
  const card = page.locator('.platform-access-agent').filter({ hasText: publication.publishId });
  await card.getByRole('button', { name: '测试' }).click();
  // 审批 Agent 的测试默认是「单据」
  const select = card.locator('select[name=documentId]');
  await select.locator('option', { hasText: 'DGZF-F07-003' }).waitFor({ state: 'attached' });
  await select.selectOption({ label: await select.locator('option', { hasText: 'DGZF-F07-003' }).textContent() });
  await card.getByRole('button', { name: '开始测试' }).click();
  await card.getByText(/测试完成|这次没有完成/).waitFor({ timeout: 6 * 60_000 });
  await card.getByText('测试完成，已记进下面的调用记录。').waitFor({ timeout: 1000 });
  await card.locator('.platform-access-feedback').getByText(EXPECT['DGZF-F07-003'] === 'pass' ? '建议通过' : '不建议通过', { exact: true }).waitFor();
  await page.locator('.platform-access-calls').getByRole('row').filter({ hasText: 'DGZF-F07-003' }).filter({ hasText: '测试 · 单据' }).first().waitFor({ timeout: 30_000 });
  // 文本：一段话原样发过去，有回复
  await card.getByRole('tab', { name: '文本' }).click();
  await card.locator('textarea[name=text]').fill('你好，请用一句话说明你能做什么。');
  await card.getByRole('button', { name: '发送' }).click();
  await card.getByText(/测试完成|这次没有完成/).waitFor({ timeout: 3 * 60_000 });
  await card.getByText('测试完成，已记进下面的调用记录。').waitFor({ timeout: 1000 });
  assert.ok((await card.locator('.platform-access-feedback').innerText()).includes('Agent 的回复'));
  // 请求信封：describe@1 的示例（按契约预填），回答要合契约
  await card.getByRole('tab', { name: '请求信封' }).click();
  await card.locator('select[name=task]').selectOption('describe@1');
  await card.getByRole('button', { name: '发送' }).click();
  await card.getByText(/测试完成|这次没有完成/).waitFor({ timeout: 3 * 60_000 });
  const verdict = await card.locator('.platform-access-feedback').innerText();
  assert.match(verdict, /^合格/, `describe@1 的回答应合契约：${verdict.slice(0, 400)}`);
  await shot('03b-agent-test');
  assert.equal(JSON.stringify((await byNumber('DGZF-F07-003')).verdict), before, '测试不改单据的结论');
});

test('两档结论：AI 独立建议计入结论——不建议通过的列为风险，建议通过的结论是「建议通过」；没有一张显示「平台尚未完成 AI 独立建议」', async () => {
  // 九安 analysis-verdict.mjs：fail 记成一条风险「AI 独立建议：不建议通过」；pass 记进结论的依据（列表接口不带依据），
  // 没完成的记成技术风险「平台尚未完成 AI 独立建议」，结论就不会是 pass_suggested
  for (const [number, expected] of Object.entries(EXPECT)) {
    const { verdict } = await byNumber(number);
    assert.doesNotMatch(JSON.stringify(verdict), /平台尚未完成 AI 独立建议/, number);
    if (expected === 'fail') assert.ok(verdict.risks.some(item => item.title === 'AI 独立建议：不建议通过'), `${number}：${JSON.stringify(verdict).slice(0, 300)}`);
    else assert.equal(verdict.verdict, 'pass_suggested', `${number}：${JSON.stringify(verdict).slice(0, 300)}`);
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

// 制度原文只在本机（不进仓库、页面不截图）；没给就跳过。标签沿用知识库工具的默认值（kb/lib/common.sh 的 RULES_SOURCE_TAG），
// 这样页面和 kb.sh ingest 认的是同一套规则
const KB_DOCX = process.env.KB_E2E_DOCX;
const KB_TAG = process.env.KB_E2E_TAG || 'finance-approval-v4';
const KB_QUESTION = process.env.KB_E2E_QUESTION || '房租 年度框架合同 九安';
const KB_EXPECT = process.env.KB_E2E_EXPECT || 'C05-3.4';

test('制度知识库：管理员上传本机的制度原文——预览不删、不和别的文档冲突，确认入库后历史里是「已入库」；按问题检索前 3 名有预期规则；检索日志里有这次测试期间审核 Agent 的调用', { skip: KB_DOCX ? false : '没给 KB_E2E_DOCX（本机的制度原文）', timeout: 20 * 60_000 }, async () => {
  const card = title => page.locator('section.platform-ops-card').filter({ has: page.getByRole('heading', { name: title }) });
  await page.goto(`${BASE}/#rules?view=kb`);
  await page.locator('input[type=file][name=file]').setInputFiles(KB_DOCX);
  const preview = page.locator('.kb-preview').first();
  await preview.waitFor({ timeout: 3 * 60_000 });
  await page.locator('input[name=sourceTag]').fill(KB_TAG);
  await Promise.all([page.waitForResponse(response => /\/poc\/kb\/documents\/\d+\/preview$/.test(new URL(response.url()).pathname), { timeout: 3 * 60_000 }),
    page.getByRole('button', { name: '重新预览' }).click()]);
  await sleep(500);
  assert.match(await preview.innerText(), /删除 0$/, '同一份制度重新入库不该删规则');
  assert.equal(await page.locator('.kb-block').count(), 0, '规则编号不该和库里另一份文档冲突');
  await page.getByRole('button', { name: '确认入库' }).click();
  const outcome = await card('上传制度文档').getByText(/入库完成|入库没有完成/).first().innerText({ timeout: 15 * 60_000 });
  assert.match(outcome, /^入库完成/, outcome);
  const [latest] = (await api('/poc/kb/documents')).json.data.items;
  assert.deepEqual([latest.status, latest.source_tag, latest.result?.pruned], ['ingested', KB_TAG, 0]);

  await card('按问题检索').locator('input[name=question]').fill(KB_QUESTION);
  await card('按问题检索').getByRole('button', { name: '检索' }).click();
  await card('按问题检索').locator('tbody tr td').first().waitFor();
  await sleep(1000);
  const top3 = (await card('按问题检索').locator('tbody tr').evaluateAll(rows => rows.map(row => row.cells[1]?.innerText))).slice(0, 3);
  assert.ok(top3.includes(KB_EXPECT), `「${KB_QUESTION}」前 3 名应有 ${KB_EXPECT}：${top3}`);

  const log = (await api('/poc/kb/search-log')).json.data.items;
  assert.ok(log.some(entry => entry.caller === 'page' && entry.question === KB_QUESTION), '页面检索记进检索日志');
  assert.ok(log.some(entry => entry.caller === 'agent' && new Date(entry.at) >= startedAt), '这次测试里审核 Agent 审单时经连接器调了 kb_search');
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

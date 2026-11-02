/**
 * 测试台上九安 v0.7.10 的新前端（poc/web，React；https://jiuan-v0710.tinyboat.blog/ 是它，九安原来的页面在 /analysis.html）的端到端测试
 * （Playwright + 本机 Chrome）。请用 run.sh 运行：它先重置库（保留「Agent 接入」的启用记录），再从 infra/secrets.env 读两个账号的口令，
 * 从 DEPLOY_ENV 取知识库方式（KB_MODE，不写是 pg）和这种方式的知识库 Agent 的发布编号；跑完这个文件再跑 api.e2e.mjs（只测接口的那些和
 * 新抽屉里的模型说明、自定义规则）。调用密钥不经过测试：管理员在「Agent 接入」页上粘贴一次，九安加密存库。
 * 流程：旧入口 /poc/login → /#access=<票据> 由新前端换成会话（另开一个浏览器上下文）→ 新登录页口令登录（poc-reviewer，管理员）
 * → 准备：等单据同步，清掉 poc-reviewer 的「我的规则」，DGZF-F07-001 / -003 / -004 经接口先读原件、再发起 AI 独立建议（-002 在页面上发起）
 * → 单据池打开 DGZF-F07-002：原件页签「读取原件」、按页看到虚构原件的文字；AI 建议页签「发起审核 / 重新审核」、等出结论（通过或不通过都行：
 *   2026-10-31 起知识库是审批风险判断卡，四张虚构单的结论不再写死，基线由 api.e2e.mjs 记下）；单据信息、历史也有内容
 * → 工作台：四张单都有结论后，上排四个数都有，「待我复核」和单据池「待复核」的张数一样
 * → 复核「采纳」DGZF-F07-002：待复核少一张，工作台的「待我复核」几秒内跟着少一张；「改判」DGZF-F07-003（按 AI 的结论选反方向的原因、写备注）：
 *   人工改判率有值
 * → 我的规则：上传一份虚构的 .md、核对转出来的文字、「已用 N 字」跟着变（不限字数，没有合计上限），再删掉（不留规则）
 * → Agent 接入：Nexus 上的发布都列出来，审批 Agent 有标识、按钮是「测试 · 取消审批 Agent · 重新验证 · 停用」（没有旧的「复核」）；
 *   知识库 Agent 就绪、「供前端工作流调用（不进审批流）」（不点「设为审批 Agent」）；对审批 Agent 测一次单据、一次文本、一次请求信封 describe@1
 * → 知识库（只给管理员；知识库 Agent 的钥匙启用后）：页面说 Agent 就绪；「上传制度」传 KB_E2E_DOCX（制度标识 risk-cards、版本说明 2026-10-29、
 *   文档名用预填的、必须正好是文件名）→ 没有变化、449 条；按问题检索，前 3 名里有一条的原文写着预期的卡片编号
 * → 分析员（poc-checker，另开一个浏览器上下文）：导航里没有知识库、Agent 接入、设置；直接打开 #/agents 是「没有权限」。
 * 真实调用 Nexus：四次 AI 独立建议（四张对公付款单，每次约 0.1–0.3 美元；api.e2e.mjs 接着看到它们已完成就不再发起）、「Agent 接入」页的
 * 三次测试（单据一次是一轮审单，约 0.1–0.3 美元；文本、请求信封很便宜）；另有几次知识库 Agent 的调用（就绪检查、制度清单、上传——没有变化、检索）。
 * 截图三张（evidence/round7/e2e/web-*.png）：工作台、单据池 + 抽屉（原件页签，虚构原件）、「上传制度」弹框（选文件之前）。制度原文只在本机
 * （不进仓库）；知识库页的制度详情、检索结果不截图、不打印（上面是真实制度的原文）。自定义规则的文字是虚构的。
 * 人工核对（测试看不到）：Chrome 在「Agent 接入」的密钥框上会不会弹「保存密码」——由项目负责人在自己的浏览器里看。
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const BASE = process.env.E2E_BASE_URL || 'https://jiuan-v0710.tinyboat.blog';
// 知识库方式和知识库 Agent 的发布（run.sh 从 DEPLOY_ENV 取：KB_MODE、KB_PG_PUBLICATION_ID 或 KB_S3V_PUBLICATION_ID）
const KB_MODE = process.env.E2E_KB_MODE || 'pg';
const KB_PUBLICATION_ID = process.env.E2E_KB_PUBLICATION_ID || '';
const KB_PUBLICATION_KEY = KB_MODE === 's3vectors' ? 'KB_S3V_PUBLICATION_ID' : 'KB_PG_PUBLICATION_ID';
// 知识库里有效的制度（项目负责人 2026-10-31 定的）：审批风险判断卡 risk-cards，449 条（risk-cards-H1 一条说明 + risk-cards-T1.1…T1.448 每行一张卡）；
// 原来的 finance-approval-v4（V4.0 审批矩阵，102 条）已下线、不恢复、不删。制度原文只在本机（不进仓库、不截图、不打印文字）
const KB_DOCX = process.env.KB_E2E_DOCX;
const KB_TAG = process.env.KB_E2E_TAG || 'risk-cards';
const KB_VERSION = process.env.KB_E2E_VERSION || '2026-10-29';
const KB_RULES = Number(process.env.KB_E2E_RULES || 449);
// 检索的问题和前 3 名里要有的卡片（按卡片原文里的「卡片编号：…」认，不认 T1.n 的位置编号）。问题同 api.e2e.mjs：检索日志那条按它的 md5 认出页面上的这次检索
const KB_QUESTION = process.env.KB_E2E_QUESTION || '报废损失 董事长';
const KB_EXPECT_CARD = process.env.KB_E2E_EXPECT_CARD || 'EXP783344-财务';
const SHOTS = new URL('../../../../evidence/round7/e2e/', import.meta.url);
// fixtures.mjs 的四个场景：九安房租（合同、发票齐）、柯顿运维费（超合同、收款方不符）、O+O 税款（有缴款通知）、新零售推广费（无原件、事由带注入文字）。
// 结论原来按 V4 审批矩阵设计；知识库换成审批风险判断卡后不再写死，只要通过或不通过（基线由 api.e2e.mjs 记下）
const NUMBERS = Object.freeze(['DGZF-F07-001', 'DGZF-F07-002', 'DGZF-F07-003', 'DGZF-F07-004']);
const RESULT_TEXT = Object.freeze({ pass: '建议通过', fail: '不建议通过' });
// 在页面上打开、发起、采纳的那张；改判的那张（按 AI 的结论改成反方向）
const OPENED = 'DGZF-F07-002';
const OVERRIDDEN = 'DGZF-F07-003';
// fixtures.mjs 里 DGZF-F07-002 的两份虚构原件和它们页上的几个字
const ORIGINALS = Object.freeze([
  { name: '运维服务合同（虚构）.pdf', page: 2, text: '第五条 付款：按季度支付' },
  { name: '三季度运维服务发票（虚构）.pdf', page: 1, text: '价税合计：人民币 60,000.00 元' },
]);
// 一轮最长 180 秒（补丁 0006）；连接器同时只跑两轮，四张单一起发起时排在后面的要先等一轮跑完：等够两轮再加点余量
const ADVICE_TIMEOUT = 7 * 60_000;
const OWNER = 'poc-reviewer';
const CHECKER = 'poc-checker';
// 「我的规则」用的虚构规则（不是真实制度），传上去马上删掉
const OWN_RULE = Object.freeze({ name: '端到端测试-虚构补充要求.md', text: '（虚构，端到端测试用）本条只用来核对上传、字数和删除，不对任何单据提出审核要求。' });
let browser, context, page;

before(async () => {
  assert.ok(process.env.E2E_REVIEWER_PASSWORD && process.env.E2E_CHECKER_PASSWORD, '请用 run.sh 运行：它重置测试台并从 infra/secrets.env 读两个账号的口令');
  assert.ok(['pg', 's3vectors'].includes(KB_MODE), `E2E_KB_MODE 只能是 pg 或 s3vectors：${KB_MODE}`);
  await mkdir(SHOTS, { recursive: true });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
});
after(async () => { await browser?.close(); });

const shotPath = name => fileURLToPath(new URL(`${name}.png`, SHOTS));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const thousands = value => value.toLocaleString('en-US');
const charsOf = text => [...text.trim()].length;
/** 用页面的会话调九安和外壳的接口；POST 带上九安要的 X-CSRF-Token。target 默认是管理员那一页。 */
const api = (apiPath, { method = 'GET', body } = {}, target = page) => target.evaluate(async ({ apiPath, method, body }) => {
  const headers = { Accept: 'application/json' };
  if (method !== 'GET') {
    const session = await (await fetch('/api/analysis/v1/session', { credentials: 'same-origin' })).json();
    Object.assign(headers, { 'Content-Type': 'application/json', 'X-CSRF-Token': session.data.csrfToken });
  }
  const response = await fetch(`/api/analysis/v1${apiPath}`, { method, credentials: 'same-origin', headers, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, json: await response.json().catch(() => null) };
}, { apiPath, method, body });
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
const adviceOf = async document => (await api(`/documents/${document.id}/advice`)).json.data;
/** 这几张单在外壳里的复核状态 { [id]: { state, current, review } }。 */
const reviewStates = async ids => (await api(`/poc/reviews/latest?ids=${ids.map(encodeURIComponent).join(',')}`)).json.data.items;
const latestReview = async document => (await api(`/poc/reviews?documentId=${encodeURIComponent(document.id)}`)).json.data.items[0];

/**
 * 这几张单 AI 独立建议的各轮和调用记录：只打印编号、触发、状态、错误码、用时和尝试次数（不打印 Agent 的备注和依据），
 * 一轮没出来时好看出是超过 180 秒、在连接器那里排队，还是 Nexus 拒绝；也记下每一轮的用时。
 */
async function adviceDiagnosis(numbers) {
  // 知识库的规则编号（同 api.e2e.mjs 的 RULE_ID）：审批矩阵 C05-3.2 / G-01，风险判断卡 risk-cards-T1.4
  const ruleId = /(?<![A-Za-z0-9_.-])(C\d{2}-(?:\d+\.\d+|NOTE)|G-\d{2}|[a-z0-9][a-z0-9-]*-(?:H\d+|T\d+(?:\.\d+)*))(?![A-Za-z0-9_-]|\.\d)/g;
  const cited = basis => [...new Set((basis ?? []).filter(item => item.kind === 'rule').flatMap(item => (String(item.ref ?? '').startsWith('自定义：') ? ['自定义'] : [...String(item.ref ?? '').matchAll(ruleId)].map(match => match[1]))))];
  const span = (from, to) => (from && to ? `${((Date.parse(to) - Date.parse(from)) / 1000).toFixed(1)} 秒` : '—');
  const calls = (await api('/platform/agent-access/calls')).json?.data?.items ?? [];
  const lines = [];
  for (const number of numbers) {
    const document = await byNumber(number);
    const rounds = (await api(`/poc/advice-rounds?documentId=${encodeURIComponent(document.id)}`)).json?.data?.items ?? [];
    for (const round of rounds) {
      const ids = cited(round.basis);
      lines.push(`${number} 第 ${round.round} 轮 ${round.trigger ?? '—'} ${round.status}${round.result ? ` ${round.result}` : ''}${round.errorCode ? ` ${round.errorCode}` : ''}，${round.startedAt ?? '—'} 起 ${span(round.startedAt, round.finishedAt)}`
        + `${round.basis?.length ? `；依据 ${round.basis.length} 条，引用 ${ids.join('、') || '（没有规则）'}` : ''}`);
    }
    for (const call of calls.filter(entry => entry.number === number)) {
      lines.push(`  调用记录 ${call.trigger ?? '—'}${call.mode ? `·${call.mode}` : ''} ${call.status}${call.result ? ` ${call.result}` : ''}${call.errorCode ? ` ${call.errorCode}` : ''}，用时 ${call.latencyMs ?? '—'} 毫秒，尝试 ${call.attempts ?? '—'} 次${call.repaired ? '，修正过一次格式' : '，没修正格式'}${call.agentVersion ? `，Agent 版本 ${call.agentVersion}` : ''}`);
    }
  }
  console.log(`AI 独立建议的各轮（只有编号、状态和用时）：\n${lines.join('\n')}`);
}

async function ownRules() {
  const { status, json } = await api('/poc/custom-rules');
  assert.equal(status, 200, `读不出「我的规则」：${JSON.stringify(json)?.slice(0, 300)}`);
  return json.data;
}
/** 删掉 poc-reviewer 的「我的规则」（only 给了就只删这个标题的），回删掉的那些。 */
async function clearOwnRules(only) {
  const items = (await ownRules()).items.filter(item => !only || item.title === only);
  for (const item of items) {
    const { status, json } = await api(`/poc/custom-rules/${encodeURIComponent(item.id)}/delete`, { method: 'POST' });
    assert.equal(status, 200, `删不掉「我的规则」里的「${item.title}」：${JSON.stringify(json)?.slice(0, 300)}`);
  }
  return items;
}

/** 在新前端的登录页口令登录，等工作台出来。 */
async function signIn(target, account, password) {
  await target.goto(`${BASE}/#/login`);
  await target.getByLabel('账号').selectOption(account);
  await target.getByLabel('口令').fill(password);
  await target.getByRole('button', { name: '登录' }).click();
  await target.getByRole('heading', { name: '工作台', level: 1 }).waitFor({ timeout: 30_000 });
}
/** 管理员那一页还没登录（例如只跑一部分用例）就先登录；前一条用例中途失败留下的弹框、抽屉先按 Esc 关掉（弹框开着时页面别处读屏读不到）。 */
async function ensureSession() {
  if (!page.url().startsWith(BASE)) await page.goto(BASE);
  for (let left = 3; left > 0 && await page.getByRole('dialog').count(); left -= 1) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }
  if ((await api('/session')).status !== 200) await signIn(page, OWNER, process.env.E2E_REVIEWER_PASSWORD);
}
/** 点侧栏的导航，等那一页的标题。 */
async function go(label, target = page) {
  await target.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: label, exact: true }).click();
  await target.getByRole('heading', { name: label, level: 1 }).waitFor({ timeout: 30_000 });
}
/** 单据池「待复核 N」的 N（复核状态读完才有数）。 */
async function poolPending() {
  const radio = page.getByRole('radiogroup', { name: '复核状态' }).getByRole('radio', { name: /^待复核 \d+$/ });
  await radio.waitFor({ timeout: 60_000 });
  return Number(/(\d+)$/.exec((await radio.innerText()).trim())[1]);
}
/** 工作台上排一个数（「待我复核」是个链接，其余是有标题的区块）：「4张」「50%」「38秒 / 张」→ 4、50、38；「—」→ null。 */
async function tileValue(label) {
  const tile = label === '待我复核' ? page.getByRole('link', { name: /^待我复核/ }) : page.getByRole('region', { name: label, exact: true });
  const text = (await tile.locator('[data-value]').innerText({ timeout: 30_000 })).trim();
  assert.doesNotMatch(text, /NaN|undefined/, `工作台「${label}」写成了 ${text}`);
  const match = /^([\d,]+)/.exec(text);
  return match ? Number(match[1].replace(/,/g, '')) : (assert.equal(text, '—', `工作台「${label}」认不出：${text}`), null);
}
/** 单据池里点开一张单（在「全部」里找），回抽屉。 */
async function openInPool(number) {
  await page.getByRole('radiogroup', { name: '复核状态' }).getByRole('radio', { name: /^全部/ }).click();
  await page.getByRole('button', { name: number, exact: true }).click();
  const drawer = page.getByRole('dialog', { name: number });
  await drawer.waitFor({ timeout: 30_000 });
  return drawer;
}

test('旧登录入口：/poc/login 口令登录后跳到 /#access=<票据>，新前端把票据换成会话、从地址栏抹掉，进工作台（另开一个浏览器上下文）', { timeout: 2 * 60_000 }, async () => {
  const other = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } });
  try {
    const old = await other.newPage();
    const visited = [];
    old.on('framenavigated', frame => { if (frame === old.mainFrame()) visited.push(frame.url()); });
    await old.goto(`${BASE}/poc/login`);
    await old.getByLabel('账号').selectOption(OWNER);
    await old.getByLabel('口令').fill(process.env.E2E_REVIEWER_PASSWORD);
    const [exchange] = await Promise.all([
      old.waitForResponse(reply => reply.request().method() === 'POST' && new URL(reply.url()).pathname === '/api/analysis/v1/auth/exchange', { timeout: 30_000 }),
      old.getByRole('button', { name: '登录' }).click()]);
    assert.equal(exchange.status(), 200, '新前端没能把旧入口的票据换成会话');
    await old.getByRole('heading', { name: '工作台', level: 1 }).waitFor({ timeout: 30_000 });
    // 票据不打印：只看经过了 /#access=、最后的地址里没有它
    assert.ok(visited.some(url => /^[^#]*\/#access=./.test(url)), '旧登录页没有跳到 /#access=<票据>');
    assert.equal(new URL(old.url()).hash, '#/', '票据换完应从地址栏抹掉，停在 #/');
    const session = (await api('/session', {}, old)).json?.data;
    assert.deepEqual([session?.user?.id, session?.user?.role], [OWNER, 'admin']);
  } finally {
    await other.close();
  }
});

test('登录：新前端的登录页（账号 + 口令）登录 poc-reviewer，进工作台，侧栏写着管理员', { timeout: 2 * 60_000 }, async () => {
  await page.goto(BASE);
  await page.waitForURL(/#\/login$/, { timeout: 30_000 });   // 没登录时 SessionGate 送到登录页
  await signIn(page, OWNER, process.env.E2E_REVIEWER_PASSWORD);
  const sidebar = page.getByRole('complementary', { name: '侧栏' });
  await sidebar.getByText('审核员（虚构）', { exact: true }).waitFor();
  await sidebar.getByText('管理员', { exact: true }).waitFor();
  assert.equal((await api('/session')).json?.data?.user?.role, 'admin');
});

test('准备：单据从模拟汇联易同步进来（4 张对公付款、1 张差旅报销）；poc-reviewer 的「我的规则」清空；DGZF-F07-001 / -003 / -004 经接口先读原件、再发起 AI 独立建议（-002 在页面上发起）', { timeout: 6 * 60_000 }, async () => {
  await ensureSession();
  const items = await until(documents, list => list.length >= 5, { timeout: 4 * 60_000, what: '单据同步' });
  assert.deepEqual(items.filter(item => item.type === 'corporate_payment').map(item => item.number).sort(), NUMBERS);
  assert.equal(items.filter(item => item.type !== 'corporate_payment').length, 1);
  // 手动发起时附 poc-reviewer 的规则：清空了这几轮才只是公司制度的结论（api.e2e.mjs 核对外壳日志里没有 POC_CUSTOM_RULES）
  const removed = await clearOwnRules();
  if (removed.length) console.log(`准备：删掉了 ${OWNER} 留下的 ${removed.length} 份「我的规则」`);
  for (const number of NUMBERS.filter(number => number !== OPENED)) {
    const document = await byNumber(number);
    // 九安的顺序：先「读取原件」，再发起 AI 独立建议（它只用已经读过的原件）。DGZF-F07-004 没有原件。
    const evidence = async () => (await api(`/documents/${document.id}/evidence`)).json.data;
    if ((await evidence()).status !== 'completed') {
      const read = await api(`/documents/${document.id}/evidence/read`, { method: 'POST', body: { sourceVersion: document.version } });
      assert.ok([200, 202].includes(read.status), `${number} 读取原件没有受理：${JSON.stringify(read.json)?.slice(0, 300)}`);
      await until(evidence, value => ['completed', 'failed'].includes(value?.status), { timeout: 60_000, every: 2000, what: `${number} 读取原件` });
    }
    const now = await adviceOf(document);
    if (now?.status === 'running' || now?.status === 'completed' && now.stale !== true) continue;   // 九安已经自动发起或跑完
    const started = await api(`/documents/${document.id}/advice`, { method: 'POST', body: { sourceVersion: document.version } });
    assert.ok([202, 409].includes(started.status), `${number} 发起失败：${JSON.stringify(started.json)?.slice(0, 300)}`);   // 409 是自动那一轮正在跑
  }
});

test(`单据池：打开 ${OPENED}，抽屉的四个页签都有内容——原件（读取原件、按页看虚构原件的文字）、AI 建议（发起 / 重新审核，等出结论和依据）、单据信息、历史`, { timeout: ADVICE_TIMEOUT + 4 * 60_000 }, async () => {
  await ensureSession();
  await go('单据池');
  const drawer = await openInPool(OPENED);
  const tabs = drawer.getByRole('tablist', { name: '单据内容' });
  await tabs.getByRole('tab', { name: 'AI 建议' }).waitFor();
  assert.equal(await tabs.getByRole('tab', { name: 'AI 建议' }).getAttribute('aria-selected'), 'true', '抽屉打开时应在「AI 建议」页签');

  // 1. 原件：没读就点「读取原件」，等读完；两份虚构原件都有按页的文字
  await tabs.getByRole('tab', { name: /^原件/ }).click();
  const evidence = drawer.getByRole('tabpanel');
  const heads = /^(还没读取原件|正在读取原件|原件已读取|原件没有读完|原件需要重新读取|原件状态暂时读不到)$/;
  await evidence.getByText(heads).waitFor({ timeout: 30_000 });
  if (!await evidence.getByText('原件已读取', { exact: true }).isVisible()) {
    if (!await evidence.getByText('正在读取原件', { exact: true }).isVisible()) await evidence.getByRole('button', { name: '读取原件' }).click();
    await evidence.getByText(/^(原件已读取|原件没有读完|原件需要重新读取)$/).waitFor({ timeout: 2 * 60_000 });
    assert.ok(await evidence.getByText('原件已读取', { exact: true }).isVisible(), `${OPENED} 的原件没有读完：${(await evidence.innerText()).slice(0, 300)}`);
  }
  const files = evidence.getByRole('list', { name: '原件清单' }).getByRole('listitem');
  assert.equal(await files.count(), ORIGINALS.length, `${OPENED} 应有 ${ORIGINALS.length} 份原件`);
  await evidence.getByRole('heading', { name: '按页看文字' }).waitFor({ timeout: 30_000 });
  for (const original of ORIGINALS) {
    await files.filter({ hasText: original.name }).getByText('文字已读取', { exact: true }).waitFor();
    const pageText = evidence.getByRole('region', { name: `${original.name} 的文字` }).getByRole('article', { name: `${original.name} 第 ${original.page} 页` });
    await pageText.getByText(original.text).waitFor({ timeout: 30_000 });
  }
  // 截图：单据池 + 抽屉。停在原件页签（虚构原件）：AI 建议页签的依据说明里可能转述真实制度的审批路径，不截
  await page.screenshot({ path: shotPath('web-02-pool-drawer'), fullPage: true });

  // 2. AI 建议：重置后这一轮要跑——没在跑、也没有当前版本的结论，就点「发起审核」（没跑过）或「重新审核」（失败、旧版本……）
  await tabs.getByRole('tab', { name: 'AI 建议' }).click();
  const advicePanel = drawer.getByRole('tabpanel');
  const verdict = advicePanel.getByRole('region', { name: 'AI 结论' });
  const stuck = advicePanel.getByText(/^(AI 建议没有完成|AI 没有给出建议|AI 建议的状态暂时读不到)$/);
  const document = await byNumber(OPENED);
  const now = await adviceOf(document);
  const ready = now?.status === 'running' || now?.status === 'completed' && now.stale !== true && ['pass', 'fail'].includes(now.result);
  if (!ready) {
    const clock = Date.now();
    // 等发起的请求回来、页面换成「AI 正在审核」，再等结论：上一轮失败时那句「没有完成」在点之前就在
    const [reply] = await Promise.all([
      page.waitForResponse(answer => answer.request().method() === 'POST' && new URL(answer.url()).pathname === `/api/analysis/v1/documents/${document.id}/advice`, { timeout: 30_000 }),
      advicePanel.getByRole('button', { name: /^(发起审核|重新审核)$/ }).click()]);
    assert.equal(reply.status(), 202, `${OPENED} 发起没有受理：${(await reply.text()).slice(0, 300)}`);
    await advicePanel.getByText('AI 正在审核', { exact: true }).waitFor({ timeout: 30_000 });
    await verdict.or(stuck).first().waitFor({ timeout: ADVICE_TIMEOUT });
    console.log(`${OPENED}：页面上发起到看到结论 ${Math.round((Date.now() - clock) / 1000)} 秒`);
  } else {
    await verdict.or(stuck).first().waitFor({ timeout: ADVICE_TIMEOUT });
  }
  // 失败时只说状态，不打印抽屉里的依据和说明（可能转述规则原文）
  if (!await verdict.isVisible()) await adviceDiagnosis([OPENED]);
  assert.ok(await verdict.isVisible(), `${OPENED} 的 AI 建议没有出结论：${await stuck.allInnerTexts()}`);
  const advice = await adviceOf(document);
  assert.equal(advice.status, 'completed', `${OPENED}：${advice.errorCode ?? String(advice.declinedReason ?? '').slice(0, 120)}`);
  assert.ok(advice.result in RESULT_TEXT, `${OPENED} 的结论应是 pass 或 fail：${advice.result}`);
  await verdict.getByText(RESULT_TEXT[advice.result], { exact: true }).waitFor();
  if (advice.startedAt && advice.finishedAt) console.log(`${OPENED} 的 AI 独立建议用时 ${((Date.parse(advice.finishedAt) - Date.parse(advice.startedAt)) / 1000).toFixed(1)} 秒（九安记录的开始到结束）`);
  // 依据逐条列出，引用了知识库规则的带「公司制度」标签（风险判断卡没有审批路径，「审批路径」那一行可以没有）
  const basis = advicePanel.getByRole('list', { name: '依据' }).getByRole('listitem');
  assert.ok(await basis.count() > 0, `${OPENED} 的依据是空的`);
  if (advice.basis.some(item => item.kind === 'rule' && !String(item.ref ?? '').trim().startsWith('自定义：'))) await basis.filter({ hasText: '公司制度' }).first().waitFor();

  // 3. 单据信息：九安 1:1 单据页的几块（虚构的单据）
  await tabs.getByRole('tab', { name: '单据信息' }).click();
  const detail = drawer.getByRole('tabpanel');
  for (const heading of ['基本信息', '单据字段', '付款明细', '审批流程']) await detail.getByRole('heading', { name: heading }).waitFor({ timeout: 30_000 });
  await detail.getByText('示例云服务有限公司（虚构）').first().waitFor();
  assert.ok(await detail.getByRole('list', { name: '付款明细' }).getByRole('listitem').count() > 0, '付款明细是空的');

  // 4. 历史：AI 建议的各轮（当前一轮是刚才那一轮）和复核记录（还没复核）
  await tabs.getByRole('tab', { name: '历史' }).click();
  const history = drawer.getByRole('tabpanel');
  const rounds = history.getByRole('list', { name: 'AI 建议的各轮' }).getByRole('listitem');
  await rounds.first().waitFor({ timeout: 30_000 });
  await rounds.filter({ hasText: '当前' }).filter({ hasText: RESULT_TEXT[advice.result] }).first().waitFor();
  await history.getByText(/^还没有复核记录/).waitFor();
});

test('工作台：四张对公付款单都有结论后，上排四个数都有（没有 NaN），「待我复核」和单据池「待复核」的张数一样、和外壳的复核状态一致', { timeout: ADVICE_TIMEOUT + 3 * 60_000 }, async () => {
  await ensureSession();
  const docs = await Promise.all(NUMBERS.map(byNumber));
  const settled = [];
  for (const document of docs) settled.push(await until(() => adviceOf(document), finished, { timeout: ADVICE_TIMEOUT, what: `${document.number} 的 AI 独立建议` }));
  await adviceDiagnosis(NUMBERS);
  settled.forEach((advice, index) => assert.equal(advice.status, 'completed', `${docs[index].number}：${advice.errorCode ?? String(advice.declinedReason ?? '').slice(0, 120)}`));
  const states = await reviewStates(docs.map(document => document.id));
  const pending = docs.filter(document => ['pending', 'outdated'].includes(states[document.id]?.state)).length;
  // 外壳的看板缓存在一轮结束时清掉；万一还没清，最多再等一个缓存周期（60 秒）
  const seen = await until(async () => {
    await go('工作台');
    const dashboard = await tileValue('待我复核');
    await go('单据池');
    return { dashboard, pool: await poolPending() };
  }, value => value.dashboard === pending && value.pool === pending, { timeout: 90_000, every: 10_000, what: `工作台「待我复核」、单据池「待复核」都应是 ${pending}` });
  console.log(`工作台：待我复核 ${seen.dashboard}，单据池待复核 ${seen.pool}，外壳 ${pending}`);
  await go('工作台');
  const completed = await tileValue('AI 已出建议');
  assert.ok(completed >= NUMBERS.length, `「AI 已出建议」应至少 ${NUMBERS.length} 张：${completed}`);
  assert.notEqual(await tileValue('建议通过'), null, '「建议通过」应有百分数');
  assert.notEqual(await tileValue('出建议用时'), null, '「出建议用时」应有秒数');
  assert.doesNotMatch(await page.getByTestId('dashboard-content').innerText(), /NaN/);
  await page.screenshot({ path: shotPath('web-01-dashboard'), fullPage: true });
});

test(`复核「采纳」：在抽屉里采纳 ${OPENED} 的 AI 建议，单据池「待复核」少一张，工作台的「待我复核」几秒内跟着少一张（复核后看板的缓存作废）`, { timeout: 3 * 60_000 }, async () => {
  await ensureSession();
  await go('单据池');
  const before = await poolPending();
  const document = await byNumber(OPENED);
  assert.equal((await reviewStates([document.id]))[document.id]?.state, 'pending', `${OPENED} 应在待复核里`);
  const drawer = await openInPool(OPENED);
  const form = drawer.getByRole('radiogroup', { name: '复核结论' });
  await form.waitFor({ timeout: 30_000 });
  await form.getByRole('radio', { name: /^采纳 AI 建议/ }).click();
  await drawer.getByRole('button', { name: '提交复核' }).click();
  await until(poolPending, value => value === before - 1, { timeout: 15_000, every: 500, what: `单据池「待复核」应从 ${before} 变成 ${before - 1}` });
  const review = await latestReview(document);
  const { result } = await adviceOf(document);
  assert.deepEqual([review?.decision, review?.finalResult, review?.actor], ['adopt', result, OWNER], `${OPENED} 的复核记录：${JSON.stringify(review)}`);
  const clock = Date.now();
  await go('工作台');
  await until(() => tileValue('待我复核'), value => value === before - 1, { timeout: 5000, every: 250, what: `工作台「待我复核」应跟着变成 ${before - 1}` });
  console.log(`采纳：待复核 ${before} → ${before - 1}，工作台 ${Date.now() - clock} 毫秒内跟上`);
});

test(`复核「改判」：${OVERRIDDEN} 改判成和 AI 相反的结论（AI 建议通过 → 原因「原件缺失或不符」；不建议通过 → 「原件齐全 AI 没识别」）、写备注；单据池「待复核」再少一张，工作台的人工改判率有值`, { timeout: 3 * 60_000 }, async () => {
  await ensureSession();
  await go('单据池');
  const before = await poolPending();
  const document = await byNumber(OVERRIDDEN);
  const { result } = await adviceOf(document);
  assert.ok(result in RESULT_TEXT, `${OVERRIDDEN} 还没有结论：${result}`);
  const overturn = result === 'pass' ? { label: '原件缺失或不符', reason: 'evidence_missing', final: 'fail' } : { label: '原件齐全 AI 没识别', reason: 'evidence_complete', final: 'pass' };
  const drawer = await openInPool(OVERRIDDEN);
  const form = drawer.getByRole('radiogroup', { name: '复核结论' });
  await form.waitFor({ timeout: 30_000 });
  await form.getByRole('radio', { name: /^改判/ }).click();
  await drawer.getByLabel('改判原因').selectOption({ label: overturn.label });
  await drawer.getByLabel('备注', { exact: true }).fill('端到端测试的改判（虚构），只用来核对改判率。');
  await drawer.getByRole('button', { name: '提交复核' }).click();
  await until(poolPending, value => value === before - 1, { timeout: 15_000, every: 500, what: `单据池「待复核」应从 ${before} 变成 ${before - 1}` });
  const review = await latestReview(document);
  assert.deepEqual([review?.decision, review?.reason, review?.finalResult], ['override', overturn.reason, overturn.final], `${OVERRIDDEN} 的复核记录：${JSON.stringify(review)}`);
  await go('工作台');
  // 人工改判率的折线：每天一个点（读屏名「10/31：改判率 50.0%（复核 2 张，改判 1 张）」）；今天复核了两张、改判一张
  const point = page.getByRole('region', { name: '人工改判率', exact: true }).getByRole('img', { name: /：改判率 \d+(?:\.\d)?%（复核 [1-9][\d,]* 张，改判 [1-9][\d,]* 张）$/ });
  await point.first().waitFor({ timeout: 10_000 });
  console.log(`人工改判率：${await point.first().getAttribute('aria-label')}`);
  await page.getByRole('region', { name: 'AI 已出建议', exact: true }).getByText(/^人工改判 [1-9][\d,]* 张$/).waitFor({ timeout: 10_000 });
  const { advice } = (await api('/poc/dashboard?window=14d')).json.data;
  assert.ok(advice.overrides >= 1, `看板的改判数应至少 1：${JSON.stringify(advice)}`);
});

test('我的规则：上传一份虚构的 .md，弹框核对转出来的文字，「已用 N 字」（不限字数）和清单跟着变；再删掉它（先确认），回到上传之前（用例结束时不留规则）', { timeout: 3 * 60_000 }, async () => {
  await ensureSession();
  const chars = charsOf(OWN_RULE.text);
  try {
    const start = await ownRules();
    assert.equal(start.limitChars, null, `「我的规则」不该再有合计字数上限：limitChars 是 ${start.limitChars}（部署的外壳是不是旧的？）`);
    await go('我的规则');
    const usage = used => page.getByText(`已用 ${thousands(used)} 字`, { exact: true });
    await usage(start.usedChars).waitFor({ timeout: 30_000 });
    await page.locator('input[type=file][aria-label="选择规则文件"]').setInputFiles({ name: OWN_RULE.name, mimeType: 'text/markdown', buffer: Buffer.from(OWN_RULE.text, 'utf8') });
    const check = page.getByRole('dialog', { name: '核对转出来的文字' });
    await check.or(page.getByRole('alert')).first().waitFor({ timeout: 60_000 });
    assert.ok(await check.isVisible(), `上传没有成功：${await page.getByRole('alert').allInnerTexts()}`);
    await check.getByText(`已上传「${OWN_RULE.name}」：${thousands(chars)} 字`).waitFor();
    assert.equal((await check.getByTestId('rule-text').innerText()).trim(), OWN_RULE.text.trim(), '转出来的文字和原文不一致');
    await check.getByRole('button', { name: '核对无误' }).click();
    await usage(start.usedChars + chars).waitFor({ timeout: 30_000 });
    const row = page.getByRole('table', { name: '我的规则' }).getByRole('row').filter({ hasText: OWN_RULE.name });
    await row.getByText(thousands(chars), { exact: true }).waitFor();
    // 删掉：先在弹框里确认
    await row.getByRole('button', { name: '删除' }).click();
    await page.getByRole('dialog', { name: '删除规则' }).getByRole('button', { name: '确认删除' }).click();
    await page.getByText(`已删除「${OWN_RULE.name}」。`, { exact: true }).waitFor({ timeout: 30_000 });
    await usage(start.usedChars).waitFor({ timeout: 30_000 });
    assert.equal(await row.count(), 0, '删掉后清单里不该还有它');
    assert.deepEqual((await ownRules()).items.filter(item => item.title === OWN_RULE.name), [], '接口里不该还有它');
  } finally {
    // 中途失败也不留规则
    const left = await clearOwnRules(OWN_RULE.name).catch(error => { console.log(`清理「我的规则」没有完成：${error.message}`); return []; });
    if (left.length) console.log(`我的规则用例中途失败：删掉了留下的 ${left.length} 份`);
  }
});

test('Agent 接入：已连接 Nexus，Nexus 上的发布都在 Agent 列表里；只有一个审批 Agent（就绪、接 review_advice@1），标「审批 Agent」，按钮是「测试 · 取消审批 Agent · 重新验证 · 停用」；页面上没有旧的「复核」按钮（不写死发布；密钥只在页面上粘贴，测试不碰）', { timeout: 3 * 60_000 }, async () => {
  await ensureSession();
  const { records = [] } = (await api('/platform/agent-access')).json?.data ?? {};
  const approval = records.find(record => record.status === 'active' && record.approval === true && record.card?.tasks?.includes('review_advice@1'));
  assert.ok(approval, `还没有可用的审批 Agent：请到 ${BASE}/#/agents 启用审核 Agent（贴调用密钥），再点「设为审批 Agent」，然后跑测试`);
  assert.equal(records.filter(record => record.approval === true).length, 1, '审批 Agent 只有一个');
  assert.equal((await api('/platform/agent-access/nexus')).json?.data?.connected, true, `还没连 Nexus：请到 ${BASE}/#/agents 点「连接 Nexus」贴一次 Nexus API 密钥`);
  await go('Agent 接入');
  const bar = page.getByRole('region', { name: 'Nexus 连接' });
  await bar.getByText('已连接 Nexus', { exact: true }).waitFor({ timeout: 60_000 });
  await bar.getByText(/^正在读取 Nexus 上的发布/).waitFor({ state: 'hidden', timeout: 60_000 });
  const table = page.getByRole('table', { name: 'Agent 列表' });
  const rowOf = publishId => table.getByRole('row').filter({ hasText: publishId });
  // Nexus 上开了 A2A 的发布和已启用的，一个发布一行
  const { status, json } = await api('/platform/agent-access/publications');
  assert.equal(status, 200, `读不出 Nexus 上的发布：${JSON.stringify(json?.error)?.slice(0, 300)}`);
  const published = json.data.items ?? [];
  assert.ok(published.length > 0, 'Nexus 上一个发布也没有列出来');
  for (const publishId of new Set([...published.map(item => item.publishId), ...records.map(record => record.publishId)])) {
    assert.equal(await rowOf(publishId).count(), 1, `${publishId} 应在 Agent 列表里列一次`);
  }
  // 审批 Agent：就绪、有标识、审批流只调它；按钮合它的状态
  const row = rowOf(approval.publishId);
  await row.getByText('就绪', { exact: true }).waitFor();
  await row.getByText('审批 Agent', { exact: true }).waitFor();
  await row.getByText('审批流只调它', { exact: true }).waitFor();
  assert.deepEqual(await row.getByRole('button').allTextContents(), ['测试', '取消审批 Agent', '重新验证', '停用']);
  assert.equal(await table.getByText('审批 Agent', { exact: true }).count(), 1, '只有一行标「审批 Agent」');
  await page.getByText(/^审批流调用「.+」：单据池里对公付款单的 AI 独立建议都发给它/).waitFor();
  // 其他已启用的只是就绪，不进审批流
  for (const other of records.filter(record => record.status === 'active' && record.publishId !== approval.publishId)) {
    await rowOf(other.publishId).getByText('供前端工作流调用（不进审批流）', { exact: true }).waitFor();
  }
  // 新发布的名片说明里没有契约 / 任务两行时照样能启用（任务由平台指定），不再报「名片 description 不满足」
  assert.doesNotMatch(await page.getByRole('main').innerText(), /description 不满足|hasLine/);
  // 「重新验证」取代了旧页面上的「复核」（那是全站审核员复核 AI 建议的意思）
  assert.equal(await page.getByRole('button', { name: '复核', exact: true }).count(), 0, '页面上不该再有「复核」按钮');
  assert.ok(await page.getByRole('button', { name: '重新验证', exact: true }).count() >= 1, '就绪的 Agent 应有「重新验证」');
});

test(`Agent 接入 · 知识库 Agent（${KB_MODE}）：发布已启用（人在这一页贴过它的调用密钥）、就绪，标「供前端工作流调用（不进审批流）」，不是审批 Agent（测试不点「设为审批 Agent」）`, { timeout: 2 * 60_000 }, async () => {
  await ensureSession();
  assert.ok(KB_PUBLICATION_ID, `run.sh 没给知识库 Agent 的发布编号：DEPLOY_ENV 里写 ${KB_PUBLICATION_KEY}（${KB_MODE} 方式）`);
  const { records = [] } = (await api('/platform/agent-access')).json?.data ?? {};
  const kb = records.find(record => record.publishId === KB_PUBLICATION_ID);
  assert.equal(kb?.status, 'active', `知识库 Agent 的发布 ${KB_PUBLICATION_ID} 还没启用：请到 ${BASE}/#/agents 启用它（贴调用密钥），然后跑测试`);
  assert.notEqual(kb.approval, true, `知识库 Agent（${KB_PUBLICATION_ID}）不能是审批 Agent：在 Agent 接入页把审批 Agent 设回审核 Agent`);
  await go('Agent 接入');
  const row = page.getByRole('table', { name: 'Agent 列表' }).getByRole('row').filter({ hasText: KB_PUBLICATION_ID });
  await row.getByText('就绪', { exact: true }).waitFor({ timeout: 60_000 });
  await row.getByText('供前端工作流调用（不进审批流）', { exact: true }).waitFor();
  assert.deepEqual(await row.getByRole('button').allTextContents(), ['测试', '设为审批 Agent', '重新验证', '停用']);
});

test('Agent 接入 · 测试：对审批 Agent 测一次单据（DGZF-F07-003，得到建议通过或不建议通过，不改单据的结论）、一次文本（有回复）、一次请求信封 describe@1（合格），都记进调用记录', { timeout: 12 * 60_000 }, async () => {
  await ensureSession();
  const { records = [] } = (await api('/platform/agent-access')).json?.data ?? {};
  const approval = records.find(record => record.status === 'active' && record.approval === true);
  assert.ok(approval, '没有可用的审批 Agent（见上一条用例）');
  const number = 'DGZF-F07-003';
  const verdictBefore = JSON.stringify((await byNumber(number)).verdict);
  await go('Agent 接入');
  await page.getByRole('table', { name: 'Agent 列表' }).getByRole('row').filter({ hasText: approval.publishId }).getByRole('button', { name: '测试', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /^测试「/ });
  await dialog.waitFor();
  const done = /^(测试完成，已记进下面的调用记录。|这次没有完成，原因见下。|等了五分钟还没有结果)/;
  /** 点发送，等「已发给…」，再等结果；回「测试结果」那一块。 */
  async function send(button, what) {
    await button.click();
    await dialog.getByText(/^已发给「/).or(dialog.getByRole('alert')).first().waitFor({ timeout: 30_000 });
    const status = dialog.getByText(done).or(dialog.getByRole('alert'));
    await status.first().waitFor({ timeout: 6 * 60_000 });
    const text = (await status.first().innerText()).trim();
    if (text !== '测试完成，已记进下面的调用记录。') {
      // 没完成时只打印原因那一行和错误码（不打印 Agent 的备注和依据）
      const reason = await dialog.getByRole('region', { name: '测试结果' }).getByText(/^(没有完成：|错误码 )/).allInnerTexts().catch(() => []);
      await adviceDiagnosis([number]).catch(() => {});
      assert.fail(`${what}：${text} ${reason.join(' ')}`);
    }
    return dialog.getByRole('region', { name: '测试结果' });
  }
  // 单据：审批 Agent 默认就是这一种
  assert.equal(await dialog.getByRole('tab', { name: '单据', exact: true }).getAttribute('aria-selected'), 'true', '审批 Agent 的测试默认是「单据」');
  const select = dialog.getByLabel('对公付款单');
  const option = select.locator('option', { hasText: number });
  await option.waitFor({ state: 'attached', timeout: 30_000 });
  await select.selectOption({ label: (await option.textContent()).trim() });
  const documentResult = await send(dialog.getByRole('button', { name: '开始测试' }), '单据测试');
  await documentResult.getByText(/^(建议通过|不建议通过)$/).first().waitFor();
  console.log(`单据测试 ${number}：${(await documentResult.getByText(/^(建议通过|不建议通过)$/).first().innerText()).trim()}`);
  // 文本：一段话原样发过去，有回复
  await dialog.getByRole('tab', { name: '文本' }).click();
  await dialog.getByLabel('发给 Agent 的文字').fill('你好，请用一句话说明你能做什么。');
  const textResult = await send(dialog.getByRole('button', { name: '发送' }), '文本测试');
  await textResult.getByText('Agent 的回复', { exact: true }).waitFor();
  // 请求信封：describe@1 的示例（按契约预填），回答要合契约
  await dialog.getByRole('tab', { name: '请求信封' }).click();
  const task = dialog.getByLabel('任务');
  await task.locator('option[value="describe@1"]').waitFor({ state: 'attached', timeout: 30_000 });
  await task.selectOption('describe@1');
  const envelopeResult = await send(dialog.getByRole('button', { name: '发送' }), '请求信封 describe@1');
  await envelopeResult.getByText(/^(合格|不合格)$/).first().waitFor();
  assert.ok(await envelopeResult.getByText('合格', { exact: true }).first().isVisible(), `describe@1 的回答应合契约：${(await envelopeResult.innerText()).slice(0, 400)}`);
  await dialog.getByRole('button', { name: '关闭' }).click();
  await page.getByRole('table', { name: '调用记录' }).getByRole('row').filter({ hasText: number }).filter({ hasText: '测试 · 单据' }).first().waitFor({ timeout: 30_000 });
  assert.equal(JSON.stringify((await byNumber(number)).verdict), verdictBefore, '测试不改单据的结论');
  await adviceDiagnosis([number]);
});

test(`知识库（${KB_MODE}，只给管理员）：页面说知识库 Agent 就绪，制度清单里有 ${KB_TAG}（有效，${KB_RULES} 条）；清单存在测试台的库里，再读不问 Agent；「上传制度」弹框打开（截图在选文件之前，不截真实制度）`, { timeout: 5 * 60_000 }, async () => {
  await ensureSession();
  const mode = (await api('/poc/kb/mode')).json?.data;
  assert.equal(mode?.mode, KB_MODE, `测试台的知识库方式是 ${mode?.mode}，run.sh 按 DEPLOY_ENV 给的是 ${KB_MODE}`);
  assert.equal(mode.configured, true, `测试台没配知识库 Agent 的发布：DEPLOY_ENV 里写 ${KB_PUBLICATION_KEY}，重新配置测试台`);
  assert.equal(mode.ready, true, `知识库 Agent 还没就绪：请到 ${BASE}/#/agents 启用 ${KB_PUBLICATION_ID || KB_PUBLICATION_KEY}（贴调用密钥）`);
  await go('知识库');
  // 页面先问 /mode（外壳没存过 describe 时要等 Agent 回，约 10–20 秒）：就绪时右上有「上传制度」，否则整页是那句提示
  const notice = page.getByText(/^(先在『Agent 接入』页启用|.*还没配置$|知识库的状态没有读出来|不认识的知识库方式)/);
  await page.getByRole('button', { name: '上传制度' }).first().or(notice).first().waitFor({ timeout: 3 * 60_000 });
  assert.equal(await notice.count(), 0, `知识库页没有就绪：${await notice.allInnerTexts()}`);
  const header = page.locator('[data-agent]');
  assert.match(await header.innerText(), KB_MODE === 'pg' ? /知识库 Agent\s*就绪/ : /知识库文档管家\s*就绪/);
  // 制度清单：只看这一行有、状态有效（标题是真实制度的名字，不打印）
  const source = page.getByRole('table', { name: '制度清单' }).getByRole('row').filter({ hasText: KB_TAG });
  await source.first().waitFor({ timeout: 3 * 60_000 });
  await source.getByText('有效', { exact: true }).waitFor();
  await source.getByText(thousands(KB_RULES), { exact: true }).waitFor();
  // 制度清单存在测试台的库里（poc_kb_cache）：再读一次不问 Agent——读到的时间不变、几秒内回来（问 Agent 一次要 4–10 秒）
  const first = (await api('/poc/kb/sources')).json?.data;
  const started = Date.now();
  const again = (await api('/poc/kb/sources')).json?.data;
  const tookMs = Date.now() - started;
  console.log(`制度清单再读一次：${tookMs} 毫秒（从 Agent 读到的时间 ${again?.fetched_at ?? '—'}）`);
  assert.ok(first?.fetched_at && again?.fetched_at === first.fetched_at, '再读制度清单应来自测试台的库（fetched_at 不变）');
  assert.ok(tookMs < 3000, `再读制度清单应在 3 秒内（现在 ${tookMs} 毫秒）：不该再问 Agent`);
  // 「上传制度」弹框：选文件之前截图（只有拖放区和说明）
  await page.getByRole('button', { name: '上传制度' }).first().click();
  const dialog = page.getByRole('dialog', { name: '上传制度' });
  await dialog.getByText(/^知识库 Agent ?就绪$|^知识库文档管家就绪$/).waitFor({ timeout: 60_000 });
  await dialog.getByText('选择文件', { exact: true }).waitFor();
  await dialog.screenshot({ path: shotPath('web-03-upload-policy-modal') });
  await dialog.getByRole('button', { name: '取消' }).click();
  await dialog.waitFor({ state: 'hidden' });
});

test(`知识库 · 上传制度：「上传制度」传本机的制度原文（KB_E2E_DOCX），制度标识 ${KB_TAG}、版本说明 ${KB_VERSION}、文档名用预填的（必须正好是文件名）——结果是「没有变化」，${KB_RULES} 条、没有冲突（不截图、不打印制度的文字）`, { skip: KB_DOCX ? false : '没给 KB_E2E_DOCX（本机的制度 .docx）', timeout: 20 * 60_000 }, async () => {
  await ensureSession();
  assert.equal((await api('/poc/kb/mode')).json?.data?.ready, true, `知识库 Agent 还没就绪：请到 ${BASE}/#/agents 启用 ${KB_PUBLICATION_ID || KB_PUBLICATION_KEY}`);
  const fileName = path.basename(KB_DOCX);
  const listed = await api('/poc/kb/sources');
  assert.ok(listed.status === 200 && listed.json?.data?.success !== false, `读不出制度清单：${listed.status} ${JSON.stringify(listed.json?.error ?? listed.json?.data?.message)?.slice(0, 300)}`);
  const existing = (listed.json.data.sources ?? []).find(item => item.source_id === KB_TAG);
  assert.ok(existing && existing.status === 'active', `知识库里还没有有效的 ${KB_TAG}：这条用例预期「没有变化」，要库里已经有这份制度`);
  assert.equal(existing.rules_total, KB_RULES, `库里的 ${KB_TAG} 应有 ${KB_RULES} 条`);
  await go('知识库');
  await page.getByRole('button', { name: '上传制度' }).first().click({ timeout: 3 * 60_000 });
  const dialog = page.getByRole('dialog', { name: '上传制度' });
  await dialog.locator('input[type=file][aria-label="选择制度文件"]').setInputFiles(KB_DOCX);
  const sourceId = dialog.getByLabel('制度标识');
  await sourceId.waitFor();
  // 制度清单读到后才按它预填（约 10–20 秒）
  await dialog.getByText(/^正在读取制度清单/).waitFor({ state: 'hidden', timeout: 3 * 60_000 });
  const prefilledId = await sourceId.inputValue();
  if (prefilledId !== KB_TAG) console.log(`预填的制度标识是「${prefilledId}」，改成 ${KB_TAG}`);
  await sourceId.fill(KB_TAG);
  await dialog.getByText(/^规则库里已有「/).waitFor({ timeout: 10_000 });   // 同一个标识：这次是它的新版本
  // 护栏（不对就不上传，免得改了库）：标识是 risk-cards，预填的文档名正好是文件名（知识库 Agent 把它记成 source_doc，不一样就不是「没有变化」）
  assert.equal(await sourceId.inputValue(), KB_TAG, `制度标识应是 ${KB_TAG}`);
  assert.equal(await dialog.getByLabel('文档名').inputValue(), fileName, '预填的文档名应正好是文件名（带 .docx）');
  await dialog.getByLabel('版本说明').fill(KB_VERSION);
  const lastUpload = Math.max(0, ...((await api('/poc/kb/uploads')).json?.data?.items ?? []).map(entry => entry.id));
  const [response] = await Promise.all([
    page.waitForResponse(reply => reply.request().method() === 'POST' && new URL(reply.url()).pathname === '/api/analysis/v1/poc/kb/sources', { timeout: 3 * 60_000 }),
    dialog.getByRole('button', { name: '上传并入库' }).click()]);
  const sent = new URL(response.url()).searchParams;
  assert.deepEqual([sent.get('sourceId'), sent.get('sourceVersion'), sent.get('title')], [KB_TAG, KB_VERSION, fileName], '页面发出的标识、版本说明、文档名不对');
  // 浏览器有时给不出这次回复的正文（上一轮就是）：读不到就从上传记录里找这之后新的那一条
  const accepted = await response.json().catch(error => { console.log(`读不到上传接口回复的正文（${String(error.message).split('\n')[0]}），改从上传记录里找这一次`); return null; });
  assert.equal(response.status(), 202, `上传没有受理：${JSON.stringify(accepted?.error)?.slice(0, 300)}`);
  const uploadId = accepted?.data?.id ?? (await until(async () => ((await api('/poc/kb/uploads')).json?.data?.items ?? [])
    .filter(entry => entry.id > lastUpload && entry.sourceId === KB_TAG).map(entry => entry.id).sort((a, b) => b - a)[0], Number.isSafeInteger, { timeout: 30_000, every: 2000, what: '上传记录里这一次' }));
  const item = await until(async () => (await api(`/poc/kb/uploads/${uploadId}`)).json?.data, value => value && value.status !== 'ingesting',
    { timeout: 15 * 60_000, what: '知识库 Agent 入库' });
  console.log(`制度入库（${KB_MODE}）：${item.status}，共 ${item.rulesTotal} 条（写入 ${item.written}、删除 ${item.removed}、不变 ${item.unchanged}），用时 ${Math.round((item.elapsedMs ?? 0) / 1000)} 秒；库里原来 ${existing.rules_total} 条`);
  assert.equal(item.status, 'skipped', `应是「没有变化」（同一份文件、同一个标识和文档名）：${item.status} ${item.error?.code ?? ''}`);
  assert.equal(item.rulesTotal, KB_RULES, `条数应是 ${KB_RULES}`);
  assert.deepEqual(item.conflicts ?? [], [], '规则编号不该和库里另一份制度冲突');
  // 弹框里：「没有变化」和条数
  await dialog.getByText('没有变化', { exact: true }).waitFor({ timeout: 60_000 });
  await dialog.getByRole('list', { name: '入库结果' }).getByRole('listitem').filter({ hasText: /^规则/ }).getByText(thousands(KB_RULES), { exact: true }).waitFor();
  await dialog.getByRole('button', { name: '完成' }).click();
  // 上传记录里这一次：没有变化
  await page.getByRole('table', { name: '上传记录' }).locator(`tr[data-upload="${uploadId}"]`).getByText('没有变化', { exact: true }).waitFor({ timeout: 30_000 });
});

test(`知识库 · 检索：「检索」弹框按问题「${KB_QUESTION}」检索，前 3 名里有一条的原文写着「卡片编号：${KB_EXPECT_CARD}」（只打印规则编号；结果是制度原文，不截图、不打印）`, { timeout: 5 * 60_000 }, async () => {
  await ensureSession();
  assert.equal((await api('/poc/kb/mode')).json?.data?.ready, true, `知识库 Agent 还没就绪：请到 ${BASE}/#/agents 启用 ${KB_PUBLICATION_ID || KB_PUBLICATION_KEY}`);
  await go('知识库');
  await page.getByRole('button', { name: '检索', exact: true }).click({ timeout: 3 * 60_000 });
  const dialog = page.getByRole('dialog', { name: '检索规则' });
  await dialog.getByLabel('问题').fill(KB_QUESTION);
  await dialog.getByRole('button', { name: '检索', exact: true }).click();
  const results = dialog.getByRole('list', { name: '检索结果' });
  await results.or(dialog.getByRole('alert')).or(dialog.getByText('没有找到规则', { exact: true })).first().waitFor({ timeout: 3 * 60_000 });
  assert.ok(await results.isVisible(), `检索没有结果：${(await dialog.getByRole('alert').allInnerTexts()).join(' ').slice(0, 300)}`);
  // 每条的第一个粗体字是规则编号，下面是原文；按原文里的卡片编号认（T1.n 是行的位置，换版本会变）
  const card = `卡片编号：${KB_EXPECT_CARD}`;
  const top3 = (await results.getByRole('listitem').evaluateAll((rows, card) => rows.map(row => ({ id: row.querySelector('b')?.textContent?.trim(), hit: row.textContent.includes(card) })), card)).slice(0, 3);
  console.log(`检索「${KB_QUESTION}」前 3 名：${top3.map(row => `${row.id}${row.hit ? `（${KB_EXPECT_CARD}）` : ''}`).join('、')}`);
  assert.ok(top3.some(row => row.hit), `「${KB_QUESTION}」前 3 名（${top3.map(row => row.id)}）里没有一条的原文写着「${card}」`);
  await dialog.getByRole('button', { name: '关闭' }).click();
});

test('分析员：poc-checker（分析员）登录后，导航里只有工作台、单据池、我的规则——没有知识库、Agent 接入、设置；直接打开 #/agents、#/knowledge、#/settings 是「没有权限」，接口那头也拒绝（另开一个浏览器上下文）', { timeout: 2 * 60_000 }, async () => {
  const other = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } });
  try {
    const checker = await other.newPage();
    await signIn(checker, CHECKER, process.env.E2E_CHECKER_PASSWORD);
    assert.equal((await api('/session', {}, checker)).json?.data?.user?.role, 'analyst');
    const links = (await checker.getByRole('navigation', { name: '主导航' }).getByRole('link').allInnerTexts()).map(text => text.trim());
    assert.deepEqual(links, ['工作台', '单据池', '我的规则'], `分析员的导航：${links}`);
    for (const hash of ['#/agents', '#/knowledge', '#/settings']) {
      await checker.goto(`${BASE}/${hash}`);
      await checker.getByRole('heading', { name: '没有权限', level: 1 }).waitFor({ timeout: 30_000 });
    }
    // 接口那头九安和外壳照样只认管理员
    assert.equal((await api('/platform/agent-access', {}, checker)).status, 403, '分析员读「Agent 接入」应被拒');
    assert.equal((await api('/poc/kb/mode', {}, checker)).status, 403, '分析员读知识库应被拒');
  } finally {
    await other.close();
  }
});

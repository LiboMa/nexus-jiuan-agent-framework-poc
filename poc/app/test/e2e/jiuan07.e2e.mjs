/**
 * 测试台上九安 v0.7.10（https://jiuan-v0710.tinyboat.blog）的端到端测试（Playwright + 本机 Chrome）。请用 run07.sh 运行：它先重置库
 * （保留「Agent 接入」的启用记录），再从 infra/secrets.env 读两个账号的口令，从 DEPLOY_ENV 取知识库方式（KB_MODE，不写是 pg）和这种方式的
 * 知识库 Agent 的发布编号。调用密钥不经过测试：管理员在「后台配置 › Agent 接入」页上粘贴一次，九安加密存库，之后的调用都用这条启用记录。
 * 流程：口令登录 → 页面上的启用记录在、可用，知识库 Agent 的发布已启用、不是审批 Agent
 * → 「规则库 › 制度知识库 › 公司制度」经知识库 Agent（A2A，两种方式同一块；在 AI 独立建议之前，知识库要先有规则）：给了 KB_E2E_DOCX（本机的
 *   制度原文）就在页面上传入库、核对上传记录和制度清单，没给就先核对库里已有预期规则；按问题检索前 3 名有预期规则
 * → 清场：poc-reviewer 的「我的规则」清空（下面以它手动发起，带上自定义规则就不只是公司制度的结论）
 * → 四张虚构对公付款单先读取原件、再手动发起 AI 独立建议（重置后启用记录写回之前的那一轮九安不自动重排）→ 结论和依据核对，Agent 引用的
 *   规则编号按方式到知识库里逐个核对（pg：经 SSM 查 nexus-pgvector 的 approval_rules；s3vectors：本机凭证对规则索引 GetVectors，只认有效的）；
 *   这几轮都没附自定义规则（外壳日志里没有 POC_CUSTOM_RULES）→ pg 方式：检索日志 kb_search_log 里有审核 Agent 审单时的检索
 * → 调用记录与「Agent 接入」页的测试 → 计入两档结论 → 没有回写 → 模拟来单一张，等九安同步、读详情后自动发起并完成
 * → 自定义规则：poc-reviewer 上传一份虚构的补充要求，手动发起 DGZF-F07-001 不通过、删掉后回到通过；再带接近每人上限 5,000 字的虚构规则发起
 *   一次，Nexus 不拒收、在九安合同的 120 秒内跑完（记下这一轮的用时）；用例结束时不留规则 → 期间九安没有连 Nexus 以外的地址、没有调汇联易的审批写入。
 * 真实调用 Nexus：八次 AI 独立建议（四张单、模拟来单、自定义规则三轮），每次约 0.1–0.3 美元；另有「Agent 接入」页的三次测试和几次知识库 Agent 的调用。
 * 制度原文只在本机（不进仓库）；「规则库 › 制度知识库」页不截图（上面有真实制度的标题和检索出的原文）。自定义规则的文字都是虚构的。
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';

const run = promisify(execFile);
const BASE = process.env.E2E07_BASE_URL || 'https://jiuan-v0710.tinyboat.blog';
const INSTANCE = process.env.E2E07_INSTANCE;
const REGION = process.env.E2E07_REGION || 'us-east-1';
// 出站拦截记录里不该出现的 Nexus 主机名（run07.sh 从栈参数 NexusOrigin 取）
const NEXUS_HOST = process.env.E2E07_NEXUS_HOST || '';
// 知识库方式和「公司制度」经的知识库 Agent 的发布（run07.sh 从 DEPLOY_ENV 取：KB_MODE、KB_PG_PUBLICATION_ID 或 KB_S3V_PUBLICATION_ID）
const KB_MODE = process.env.E2E07_KB_MODE || 'pg';
const KB_PUBLICATION_ID = process.env.E2E07_KB_PUBLICATION_ID || '';
const KB_PUBLICATION_KEY = KB_MODE === 's3vectors' ? 'KB_S3V_PUBLICATION_ID' : 'KB_PG_PUBLICATION_ID';
// s3vectors 方式：引用的规则编号用本机的 AWS 凭证到这个向量桶的规则索引里查
const KB_S3V_BUCKET = process.env.E2E07_KB_S3V_BUCKET || '';
const KB_S3V_RULES_INDEX = process.env.E2E07_KB_S3V_RULES_INDEX || '';
// 制度原文只在本机（不进仓库、页面不截图）。制度标识沿用知识库工具的默认值（kb/lib/common.sh 的 RULES_SOURCE_TAG），这样页面和 kb.sh ingest 认的是同一套规则
const KB_DOCX = process.env.KB_E2E_DOCX;
const KB_TAG = process.env.KB_E2E_TAG || 'finance-approval-v4';
const KB_QUESTION = process.env.KB_E2E_QUESTION || '房租 年度框架合同 九安';
const KB_EXPECT = process.env.KB_E2E_EXPECT || 'C05-3.4';
const SHOTS = new URL('../../../../evidence/round7/e2e/', import.meta.url);
// fixtures.mjs 的四个场景：九安房租（合同、发票齐）、柯顿运维费（超合同、收款方不符）、O+O 税款（有缴款通知）、新零售推广费（无原件、事由带注入文字）
const EXPECT = Object.freeze({ 'DGZF-F07-001': 'pass', 'DGZF-F07-002': 'fail', 'DGZF-F07-003': 'pass', 'DGZF-F07-004': 'fail' });
const RULE_ID = /\b(C\d{2}-(?:\d+\.\d+|NOTE)|G-\d{2})\b/g;
const ADVICE_TIMEOUT = 5 * 60_000;
// 登录的账号：管理员，「我的规则」按它存，手动发起时附它的规则（外壳日志 POC_CUSTOM_RULES <单据> poc-reviewer <字数>）
const OWNER = 'poc-reviewer';
const CUSTOM_NOTE = `（含 ${OWNER} 的自定义规则）`;
// 「我的规则」用的虚构规则（不是真实制度）：一份让 DGZF-F07-001（九安房租，合同、发票齐）不通过；一份接近每人合计 5,000 字的上限，只用来量请求大小和用时
const RENT_RULE = Object.freeze({ name: '九安房租补充要求.md', text: '九安板块的房租类对公付款，须附出租方的房产证明；没有的不予通过。' });
const NEAR_LIMIT_CHARS = 4_900;
const OWN_RULES_LIMIT = 5_000;
const NEAR_LIMIT_RULE = Object.freeze({ name: '虚构长规则-量请求大小.md', text: (() => {
  const lines = [];
  for (let n = 1, size = 0; size < NEAR_LIMIT_CHARS; n += 1) {
    const line = `第 ${n} 条（虚构的填充文字）：本条只用来在端到端测试里量一次调用的大小，不对任何单据提出审核要求。`;
    lines.push(line);
    size += line.length + 1;
  }
  return `${lines.join('\n').slice(0, NEAR_LIMIT_CHARS - 1).trimEnd()}。`;
})() });
const startedAt = new Date();
let browser, page, publication = null;
const advices = new Map();

before(async () => {
  assert.ok(process.env.E2E_REVIEWER_PASSWORD && INSTANCE, '请用 run07.sh 运行：它重置测试台并从 infra/secrets.env 读两个账号的口令');
  assert.ok(['pg', 's3vectors'].includes(KB_MODE), `E2E07_KB_MODE 只能是 pg 或 s3vectors：${KB_MODE}`);
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
const adviceOf = async document => (await api(`/documents/${document.id}/advice`)).json.data;
/** 以登录的人（poc-reviewer）在单据页手动发起一轮 AI 独立建议（同页面上「运行一轮 AI 独立建议」的接口），等这一轮跑完。 */
async function runAdvice(number) {
  const document = await byNumber(number);
  const started = await api(`/documents/${document.id}/advice`, { method: 'POST', body: { sourceVersion: document.version } });
  assert.equal(started.status, 202, `${number} 发起失败：${JSON.stringify(started.json)?.slice(0, 300)}`);
  const advice = await until(() => adviceOf(document), finished, { timeout: ADVICE_TIMEOUT, what: `${number} 的 AI 独立建议` });
  return { document, advice };
}

const aws = async args => (await run('aws', ['--region', REGION, ...args])).stdout.trim();
/** 经 SSM 在测试台实例上跑一条只读命令，回标准输出；命令没成功就抛（带标准错误的开头）。 */
async function ssm(command, comment) {
  const id = await aws(['ssm', 'send-command', '--instance-ids', INSTANCE, '--document-name', 'AWS-RunShellScript', '--comment', comment,
    '--parameters', JSON.stringify({ commands: [command] }), '--query', 'Command.CommandId', '--output', 'text']);
  await aws(['ssm', 'wait', 'command-executed', '--command-id', id, '--instance-id', INSTANCE]).catch(() => {});
  const [status, stdout, stderr] = JSON.parse(await aws(['ssm', 'get-command-invocation', '--command-id', id, '--instance-id', INSTANCE,
    '--query', '[Status,StandardOutputContent,StandardErrorContent]', '--output', 'json']));
  if (status !== 'Success') throw new Error(`经 SSM 的只读命令没有成功（${comment}）：${status} ${String(stderr ?? '').trim().slice(0, 300)}`);
  return String(stdout ?? '').trim();
}
/** 以应用用户在测试台的知识库（nexus-pgvector）里跑一条只读 SQL（会话设成只读；规则表归应用用户，不在超级用户会话里读）。 */
function psql(sql, comment) {
  if (/["$`\\]/.test(sql)) throw new Error('SQL 里不能有双引号、$、反引号或反斜杠（整条命令放在 shell 的双引号里）');
  return ssm(`docker exec -e 'PGOPTIONS=-c default_transaction_read_only=on' nexus-pgvector psql -U nexus -d nexus -X -v ON_ERROR_STOP=1 -tAc "${sql}"`, comment);
}
const journalSince = date => `${date.toISOString().replace('T', ' ').slice(0, 19)} UTC`;
/**
 * 测试台外壳（andon-jiuan07）从 since 起的日志里含 text（原样匹配）的行。只有 grep 的「没找到」（退出码 1）算没有；
 * journalctl 读不出、grep 出错（退出码 2）都让命令失败（ssm 抛），免得「没有这一行」的断言没凭据也过。
 */
async function journalLines(text, since = startedAt) {
  if (!/^[A-Za-z0-9_ .:-]+$/.test(text)) throw new Error(`日志匹配串格式不对：${text}`);
  const out = await ssm([`out=$(journalctl -u andon-jiuan07 --since '${journalSince(since)}' --no-pager -o cat) || { echo "journalctl failed: $?" >&2; exit 3; }`,
    `printf '%s\\n' "$out" | grep -F '${text}'; rc=$?; if [ "$rc" -eq 1 ]; then exit 0; fi; exit "$rc"`].join('; '), 'e2e journal check (read-only)');
  return out.split('\n').map(line => line.trim()).filter(Boolean);
}

/**
 * 这些规则编号里知识库查得到的那些（按方式）：pg 经 SSM 查 nexus-pgvector 的 approval_rules（以应用用户、只读会话）；
 * s3vectors 用本机的 AWS 凭证对规则索引 GetVectors（只读），只认元数据 active 为 true 的。
 */
async function knownRuleIds(ids) {
  if (!ids.every(id => /^[A-Z0-9.-]+$/.test(id))) throw new Error(`规则编号格式不对：${ids}`);
  if (!ids.length) return [];
  if (KB_MODE === 's3vectors') {
    assert.ok(KB_S3V_BUCKET && KB_S3V_RULES_INDEX, 's3vectors 方式要知道向量桶和规则索引：DEPLOY_ENV 里写 KB_S3V_BUCKET、KB_S3V_RULES_INDEX，用 run07.sh 运行');
    const found = [];
    for (let at = 0; at < ids.length; at += 100) {   // GetVectors 一次最多 100 个
      const reply = JSON.parse(await aws(['s3vectors', 'get-vectors', '--vector-bucket-name', KB_S3V_BUCKET, '--index-name', KB_S3V_RULES_INDEX,
        '--keys', ...ids.slice(at, at + 100), '--return-metadata', '--output', 'json']));
      found.push(...(reply.vectors ?? []).filter(vector => vector.metadata?.active === true).map(vector => vector.key));
    }
    return found;
  }
  const sql = `SELECT string_agg(rule_id, ',' ORDER BY rule_id) FROM approval_rules WHERE rule_id IN (${ids.map(id => `'${id}'`).join(',')});`;
  return (await psql(sql, 'e2e kb rule-id check (read-only)')).split(',').filter(Boolean);
}

/** 「公司制度」的制度清单（经知识库 Agent 的 list；工具失败时接口也回 200、data.success === false）。 */
async function kbSources() {
  const { status, json } = await api('/poc/kb/sources');
  assert.ok(status === 200 && json?.data?.success !== false, `读不出制度清单：${status} ${JSON.stringify(json?.error ?? json?.data)?.slice(0, 300)}`);
  return json.data.sources ?? [];
}

async function ownRules() {
  const { status, json } = await api('/poc/custom-rules');
  assert.equal(status, 200, `读不出「我的规则」：${JSON.stringify(json)?.slice(0, 300)}`);
  return json.data;
}
/** 删掉 poc-reviewer 的全部「我的规则」，回删掉的那些。 */
async function clearOwnRules() {
  const { items } = await ownRules();
  for (const item of items) {
    const { status, json } = await api(`/poc/custom-rules/${encodeURIComponent(item.id)}/delete`, { method: 'POST' });
    assert.equal(status, 200, `删不掉「我的规则」里的「${item.title}」：${JSON.stringify(json)?.slice(0, 300)}`);
  }
  return items;
}
/** 像审核员一样在「规则库 › 制度知识库 › 我的规则」选一个 .md 上传，等页面显示转出来的文字；回列表里这一份 { id, title, chars, … }。 */
async function uploadOwnRule({ name, text }) {
  await page.goto(`${BASE}/#rules?view=kb`);
  const own = page.locator('section[data-kb-block=own]');
  await own.locator('button:not([disabled])', { hasText: '选择文件' }).waitFor({ timeout: 60_000 });   // 列表读完、不忙
  await own.locator('input[type=file][name=ownFile]').setInputFiles({ name, mimeType: 'text/markdown', buffer: Buffer.from(text, 'utf8') });
  const failure = own.locator('.platform-ops-dialog-result.error');
  await own.getByText(`已上传「${name}」`).or(failure).first().waitFor({ timeout: 60_000 });
  assert.equal(await failure.count(), 0, `上传「${name}」没有成功：${await failure.allInnerTexts()}`);
  const rule = (await ownRules()).items.find(item => item.title === name);
  assert.ok(rule, `「我的规则」列表里没有「${name}」`);
  assert.equal(rule.chars, [...text.trim()].length, `「${name}」转出来的字数和原文不一致`);
  return rule;
}

test('登录：口令登录后进入九安 v0.7.10，单据池里是模拟汇联易同步来的 5 张虚构单据（4 张对公付款、1 张差旅报销）', async () => {
  await page.goto(BASE);
  await page.waitForURL(/\/poc\/login$/);
  await page.locator('#account').selectOption(OWNER);
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

test('Agent 接入：页面上已经连了 Nexus，Nexus 上的发布和已启用的 Agent 在一张表里；审批流只调一个审批 Agent（就绪、接 review_advice@1），其他就绪的只供前端工作流调用；「公司制度」经的知识库 Agent 已启用、不是审批 Agent（不写死发布；密钥只在页面上粘贴，测试不碰）', async () => {
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
  // 「公司制度」经的知识库 Agent（pg：PG 知识库 Agent；s3vectors：知识库文档管家）：人在这一页启用过（就绪），只供前端调用、不是审批 Agent
  assert.ok(KB_PUBLICATION_ID, `run07.sh 没给知识库 Agent 的发布编号：DEPLOY_ENV 里写 ${KB_PUBLICATION_KEY}（${KB_MODE} 方式）`);
  const kb = records.find(record => record.publishId === KB_PUBLICATION_ID);
  assert.equal(kb?.status, 'active', `知识库 Agent 的发布 ${KB_PUBLICATION_ID} 还没启用：请到 ${BASE}/#adminConfig?tab=agentAccess 启用它（贴调用密钥），然后跑测试`);
  assert.notEqual(kb.approval, true, `知识库 Agent（${KB_PUBLICATION_ID}）不能是审批 Agent：在 Agent 接入页把审批 Agent 设回审核 Agent`);
  await page.locator('.platform-access-agent').filter({ hasText: KB_PUBLICATION_ID }).getByText('就绪', { exact: true }).waitFor({ timeout: 60_000 });
});

test(`制度知识库（${KB_MODE}）：管理员的「公司制度」经知识库 Agent——给了 KB_E2E_DOCX 就在页面上传本机的制度原文，入库完成（或没有变化）、没有冲突，清单里这份是有效的；没给就先核对库里已有预期规则；按问题检索前 3 名有预期规则（在 AI 独立建议之前；页面不截图）`, { timeout: 20 * 60_000 }, async () => {
  const mode = (await api('/poc/kb/mode')).json?.data;
  assert.equal(mode?.mode, KB_MODE, `测试台的知识库方式是 ${mode?.mode}，run07.sh 按 DEPLOY_ENV 给的是 ${KB_MODE}`);
  assert.equal(mode.configured, true, `测试台没配知识库 Agent 的发布：DEPLOY_ENV 里写 ${KB_PUBLICATION_KEY}，重新配置测试台`);
  assert.equal(mode.ready, true, `知识库 Agent 还没就绪：请到 ${BASE}/#adminConfig?tab=agentAccess 启用 ${KB_PUBLICATION_ID || KB_PUBLICATION_KEY}`);
  const company = page.locator('section[data-kb-block=company]');
  const card = title => company.locator('section.platform-ops-card').filter({ has: page.getByRole('heading', { name: title }) });
  await page.goto(`${BASE}/#rules?view=kb`);
  await card('上传制度文档').waitFor({ timeout: 3 * 60_000 });   // 页面先等 Agent 回 describe（约 10–20 秒）

  if (KB_DOCX) {
    // 库里已有这份制度时，文档名和版本说明照旧（再上传是它的新版本），只换原文
    const existing = (await kbSources()).find(source => source.source_id === KB_TAG);
    await company.locator('input[type=file][name=file]').setInputFiles(KB_DOCX);
    await company.locator('input[name=sourceId]').fill(KB_TAG);
    if (existing?.title) await company.locator('input[name=docTitle]').fill(existing.title);
    await company.locator('input[name=sourceVersion]').fill(existing?.source_version ?? '');
    const [response] = await Promise.all([
      page.waitForResponse(reply => reply.request().method() === 'POST' && new URL(reply.url()).pathname === '/api/analysis/v1/poc/kb/sources', { timeout: 3 * 60_000 }),
      company.getByRole('button', { name: '上传并入库' }).click()]);
    const accepted = await response.json().catch(() => null);
    assert.equal(response.status(), 202, `上传没有受理：${JSON.stringify(accepted?.error ?? accepted)?.slice(0, 300)}`);
    const item = await until(async () => (await api(`/poc/kb/uploads/${accepted.data.id}`)).json?.data, value => value && value.status !== 'ingesting',
      { timeout: 15 * 60_000, what: '知识库 Agent 入库' });
    assert.ok(['ingested', 'skipped'].includes(item.status), `入库没有完成：${item.error?.code ?? item.status} ${item.error?.message ?? ''} 冲突 ${JSON.stringify(item.conflicts)}`);
    assert.deepEqual(item.conflicts, [], '规则编号不该和库里另一份制度冲突');
    console.log(`制度入库（${KB_MODE}）：${item.status}，共 ${item.rulesTotal} 条（写入 ${item.written}、删除 ${item.removed}、不变 ${item.unchanged}），用时 ${Math.round(item.elapsedMs / 1000)} 秒`);
    await card('上传制度文档').getByText(/入库完成：|已经是这一版/).first().waitFor({ timeout: 60_000 });
    const source = (await kbSources()).find(entry => entry.source_id === KB_TAG);
    assert.ok(source, `制度清单里没有 ${KB_TAG}`);
    assert.deepEqual([source.status, source.rules_total], ['active', item.rulesTotal], `清单里 ${KB_TAG} 应是有效的、条数和这次入库一致`);
  } else {
    const known = await knownRuleIds([KB_EXPECT]);
    assert.ok(known.includes(KB_EXPECT), `知识库（${KB_MODE}）里还没有有效的 ${KB_EXPECT}：先入库——给 KB_E2E_DOCX=<本机的制度原文> 让这条用例在页面上传，或由管理员在「规则库 › 制度知识库」页上传`);
  }

  const search = card('按问题检索');
  await search.locator('input[name=question]').fill(KB_QUESTION);
  await search.getByRole('button', { name: '检索' }).click();
  const searchFailure = search.locator('.platform-ops-dialog-result.error');
  await search.locator('tbody tr td').or(searchFailure).first().waitFor({ timeout: 3 * 60_000 });
  assert.equal(await searchFailure.count(), 0, `检索没有完成：${await searchFailure.allInnerTexts()}`);
  const top3 = (await search.locator('tbody tr').evaluateAll(rows => rows.map(row => row.cells[1]?.innerText))).slice(0, 3);
  assert.ok(top3.includes(KB_EXPECT), `「${KB_QUESTION}」前 3 名应有 ${KB_EXPECT}：${top3}`);
});

test('清场：poc-reviewer 的「我的规则」是空的（有就删掉并记一笔）——下面以它手动发起 AI 独立建议，带上自定义规则就不只是公司制度的结论', async () => {
  const removed = await clearOwnRules();
  if (removed.length) console.log(`清场：删掉了 ${OWNER} 留下的 ${removed.length} 份「我的规则」`);
  assert.deepEqual((await ownRules()).items, [], `${OWNER} 还有「我的规则」`);
});

test('AI 独立建议：四张对公付款单都有结论（重置后九安自动发起；没发起的再手动发起），结论符合预期，依据里引用了知识库规则，编号都在库里；这几轮都没附自定义规则', { timeout: ADVICE_TIMEOUT + 3 * 60_000 }, async () => {
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
    const now = await adviceOf(document);
    if (now?.status === 'running' || now?.status === 'completed' && now.stale !== true) continue;   // 九安已经自动发起或跑完
    const started = await api(`/documents/${document.id}/advice`, { method: 'POST', body: { sourceVersion: document.version } });
    assert.ok([202, 409].includes(started.status), `${number} 发起失败：${JSON.stringify(started.json)?.slice(0, 300)}`);   // 409 是自动那一轮正在跑
  }
  const cited = new Set();
  for (const [number, expected] of Object.entries(EXPECT)) {
    const document = await byNumber(number);
    const advice = await until(() => adviceOf(document), finished, { timeout: ADVICE_TIMEOUT, what: `${number} 的 AI 独立建议` });
    advices.set(number, advice);
    assert.equal(advice.status, 'completed', `${number}：${advice.errorCode ?? advice.declinedReason}`);
    assert.equal(advice.result, expected, `${number} 的结论是 ${advice.result}，应为 ${expected}：${advice.note}`);
    const ids = ruleIdsOf(advice);
    assert.ok(ids.length, `${number} 没有引用知识库规则：${JSON.stringify(advice.basis)}`);
    ids.forEach(id => cited.add(id));
  }
  const known = await knownRuleIds([...cited]);
  assert.deepEqual([...cited].filter(id => !known.includes(id)), [], `Agent 引用了知识库（${KB_MODE}）里没有的规则编号`);
  // 自动初审不附自定义规则，手动发起的那几轮清场后 poc-reviewer 也没有规则：外壳一行 POC_CUSTOM_RULES 都不该记（带空格，不算 POC_CUSTOM_RULES_FAILED）
  assert.deepEqual(await journalLines('POC_CUSTOM_RULES '), [], '四张单的这几轮不该附自定义规则');
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

test('检索日志（pg 方式）：这次测试期间审核 Agent 审单时经连接器调了 kb_search（经 SSM 只读查 kb_search_log；不算页面上那次检索）', { skip: KB_MODE === 'pg' ? false : 's3vectors 方式没有检索日志（审核 Agent 用 rules_search）' }, async () => {
  // 页面那次检索经知识库 Agent 也记进来（约定里 caller 也是 agent）：按问题的 md5 认出它（问题本身不进 SQL；页面和接口都先去掉首尾空白）。
  // 一条查询数两样：页面那次（不限 caller，证明 md5 认得出它）和其余 caller = agent 的（审核 Agent 审单时的检索），两样都至少一次
  const pageQuestion = createHash('md5').update(KB_QUESTION.trim(), 'utf8').digest('hex');
  const sql = `SELECT count(*) FILTER (WHERE md5(question) = '${pageQuestion}'), count(*) FILTER (WHERE caller = 'agent' AND md5(question) IS DISTINCT FROM '${pageQuestion}')`
    + ` FROM kb_search_log WHERE at >= to_timestamp(${Math.floor(startedAt.getTime() / 1000)});`;
  const reply = await psql(sql, 'e2e kb_search_log check (read-only)');
  const [pageCount, agentCount] = reply.split('|').map(Number);
  console.log(`检索日志：测试开始以来页面那次检索 ${pageCount} 次，审核 Agent 的 kb_search ${agentCount} 次`);
  assert.ok(pageCount >= 1, `kb_search_log 里认不出页面那次检索（「${KB_QUESTION.trim()}」）：知识库 Agent 可能改了问题文字，其余的检索就分不清是谁的（${reply}）`);
  assert.ok(agentCount >= 1, `测试开始以来 kb_search_log 里没有审核 Agent 的检索（caller = agent，页面那次不算）：${reply}`);
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
  const advice = await until(() => adviceOf(document), finished, { timeout: ADVICE_TIMEOUT, what: `${number} 自动发起的 AI 独立建议` });
  assert.equal(advice.status, 'completed', `${number}：${advice.errorCode ?? advice.declinedReason}`);
  assert.equal(advice.result, 'pass', `${number}（模板 DGZF-F07-001）的结论应为 pass：${advice.note}`);
  assert.ok(ruleIdsOf(advice).length, '自动发起的这一轮也要引用知识库规则');
});

// 放在两档结论、模拟来单之后：这几轮改了 DGZF-F07-001 的当前建议，最后一轮（接近上限）的结论不核对
test('自定义规则：poc-reviewer 上传「九安房租补充要求.md」后在单据页手动发起 DGZF-F07-001——不通过，备注写明含它的自定义规则，依据里有「自定义：」那一条，外壳记了 POC_CUSTOM_RULES；删掉后再发起回到通过、不提自定义规则；再带接近 5,000 字（每人上限）的虚构规则发起一次，Nexus 不拒收、120 秒内跑完，记下用时；用例结束时不留规则', { timeout: 3 * ADVICE_TIMEOUT + 10 * 60_000 }, async () => {
  assert.ok(publication, '前面的用例没找到可用的审核 Agent');
  const number = 'DGZF-F07-001';
  const logged = async id => journalLines(`POC_CUSTOM_RULES ${id} ${OWNER} `);   // 外壳的一行：POC_CUSTOM_RULES <单据> <账号> <规则字数>
  try {
    // 1. 带上补充要求：公司制度下通过的这张单，因为没附出租方的房产证明而不通过
    const rent = await uploadOwnRule(RENT_RULE);
    const strict = await runAdvice(number);
    const { id } = strict.document;
    assert.equal(strict.advice.status, 'completed', `${number}：${strict.advice.errorCode ?? strict.advice.declinedReason}`);
    assert.equal(strict.advice.result, 'fail', `带上「${RENT_RULE.name}」后 ${number} 应不通过：${strict.advice.note}`);
    assert.ok(strict.advice.note.startsWith(CUSTOM_NOTE), `备注应以「${CUSTOM_NOTE}」开头：${strict.advice.note.slice(0, 200)}`);
    assert.ok(strict.advice.basis.some(item => item.kind === 'rule' && String(item.ref).startsWith('自定义：')), `依据里应有 ref 以「自定义：」开头的规则：${JSON.stringify(strict.advice.basis).slice(0, 600)}`);
    assert.ok((await logged(id)).includes(`POC_CUSTOM_RULES ${id} ${OWNER} ${rent.chars}`), `外壳日志里应有 POC_CUSTOM_RULES ${id} ${OWNER} ${rent.chars}`);
    // 页面上：单据详情的「模型说明」里写明含 poc-reviewer 的自定义规则
    await page.getByRole('link', { name: '单据池' }).first().click();
    await page.locator(`article.document-card[data-document-id="${id}"]`).getByRole('button', { name: '查看依据' }).click();
    const dialog = page.getByRole('dialog', { name: number });
    await dialog.getByRole('heading', { name: 'AI 独立建议', level: 2 }).waitFor({ timeout: 30_000 });
    await dialog.getByText(/^不建议通过（/).first().waitFor({ timeout: 30_000 });
    const note = dialog.locator('details.analysis-advice-model-note').first();
    await note.locator('summary').click();
    await note.getByText(CUSTOM_NOTE).first().waitFor();
    await shot('05-custom-rule-advice');
    await dialog.getByRole('button', { name: '关闭' }).click();

    // 2. 删掉规则再发起：回到公司制度的结论，备注不提自定义规则，外壳也没再附
    await clearOwnRules();
    assert.deepEqual((await ownRules()).items, [], `${OWNER} 的规则没删干净`);
    const linesBefore = (await logged(id)).length;
    const plain = await runAdvice(number);
    assert.equal(plain.advice.status, 'completed', `${number}：${plain.advice.errorCode ?? plain.advice.declinedReason}`);
    assert.equal(plain.advice.result, 'pass', `删掉规则后 ${number} 应回到通过：${plain.advice.note}`);
    assert.doesNotMatch(plain.advice.note, /自定义规则/, '没有规则时备注不该提自定义规则');
    assert.equal((await logged(id)).length, linesBefore, '删掉规则后这一轮不该再附自定义规则');

    // 3. 接近每人 5,000 字的上限（虚构的填充文字）：请求整份送到 Nexus，不被拒收，并在九安合同的 120 秒内跑完（设计第 5 节风险 4、第 9 节）。
    // 上限为什么是 5,000 字见设计第 9 节（更长的规则一轮会超过 120 秒）；这里记下这一轮的用时
    const long = await uploadOwnRule(NEAR_LIMIT_RULE);
    const { usedChars, limitChars } = await ownRules();
    assert.equal(limitChars, OWN_RULES_LIMIT, `测试台的「我的规则」合计上限应是 ${OWN_RULES_LIMIT} 字（部署的外壳是不是旧的？）`);
    assert.ok(usedChars === long.chars && limitChars - usedChars <= 200, `合计应接近上限：${usedChars} / ${limitChars}`);
    // 只看 Nexus 收没收下、按时答完：Agent 答了（completed）或婉拒（declined）都算；failed 带着错误码失败（如 AI_REQUEST_INVALID、请求过长、
    // 外壳的 AGENT_REQUEST_TOO_LARGE；超过 120 秒被九安取消是 AI_UNAVAILABLE）
    const clock = Date.now();
    const near = await runAdvice(number);
    const waited = Math.round((Date.now() - clock) / 1000);
    const { startedAt: began, finishedAt: ended } = near.advice;
    const took = began && ended ? `${((Date.parse(ended) - Date.parse(began)) / 1000).toFixed(1)} 秒（九安记录的开始到结束）` : '九安没记开始、结束时间';
    console.log(`接近上限的一轮：自定义规则 ${long.chars} 字，用时 ${took}，测试从发起到看到结果 ${waited} 秒（含每 5 秒一次的轮询）；${
      near.advice.status === 'declined' ? `Agent 婉拒：${near.advice.declinedReason}` : near.advice.status === 'completed' ? `结论 ${near.advice.result}` : `${near.advice.status} ${near.advice.errorCode ?? ''}`}`);
    assert.ok(['completed', 'declined'].includes(near.advice.status),
      `带 ${long.chars} 字自定义规则的这一轮没有按时答完（Nexus 拒收了请求，或超过九安合同的 120 秒被取消）：${near.advice.status} ${near.advice.errorCode ?? ''}，用时 ${took}`);
    assert.ok((await logged(id)).includes(`POC_CUSTOM_RULES ${id} ${OWNER} ${long.chars}`), `外壳日志里应有 POC_CUSTOM_RULES ${id} ${OWNER} ${long.chars}（整份规则附上了）`);
    await clearOwnRules();
  } finally {
    // 中途失败也不留规则
    const left = await clearOwnRules().catch(error => { console.log(`清理「我的规则」没有完成：${error.message}`); return []; });
    if (left.length) console.log(`自定义规则用例中途失败：删掉了 ${OWNER} 留下的 ${left.length} 份「我的规则」`);
  }
  assert.deepEqual((await ownRules()).items, [], `用例结束时 ${OWNER} 不留规则`);
});

test('出网与写回：测试期间九安没有调汇联易的审批写入；被拦下的出网只有写死的外部地址，没有 Nexus', async () => {
  const lines = await ssm(`journalctl -u andon-jiuan07 --since '${journalSince(startedAt)}' --no-pager -o cat | grep -E 'POC_EGRESS_BLOCKED|POC_HLY_WRITE_BLOCKED' | sort | uniq -c || true`,
    'e2e egress check (read-only)');
  console.log(`出网与写回拦截记录：${lines || '（无）'}`);
  assert.doesNotMatch(lines, /POC_HLY_WRITE_BLOCKED/);
  assert.ok(NEXUS_HOST, '请用 run07.sh 运行：它从栈参数取 Nexus 的主机名');
  assert.ok(!lines.includes(`POC_EGRESS_BLOCKED ${NEXUS_HOST}`), `出站拦截记录里不该有 Nexus（${NEXUS_HOST}）`);
});

/**
 * 测试台上九安 v0.7.10（https://jiuan-v0710.tinyboat.blog）的端到端测试（Playwright + 本机 Chrome）：只测接口的那些，加上新前端单据抽屉里的
 * 模型说明和「我的规则」上传。页面上的其余流程（登录页、工作台、单据池和抽屉、复核、Agent 接入、知识库、分析员）在 web.e2e.mjs，run.sh 先跑它、
 * 再跑这个文件，两个文件共用一次重置和同一个开始时间（E2E_STARTED_AT：外壳日志、检索日志从这一刻数起）。请用 run.sh 运行：它先重置库
 * （保留「Agent 接入」的启用记录），再从 infra/secrets.env 读两个账号的口令，从 DEPLOY_ENV 取知识库方式（KB_MODE，不写是 pg）。
 * 调用密钥不经过测试：管理员在新前端的「Agent 接入」页（#/agents）上粘贴一次，九安加密存库，之后的调用都用这条启用记录。
 * 流程：旧入口 /poc/login 口令登录（跳到 /#access=<票据>，新前端换成会话），九安原来的页面 /analysis.html 照旧能开 → 启用记录里有且只有一个
 *   可用的审批 Agent（接口）
 * → 清场：poc-reviewer 的「我的规则」清空（下面以它手动发起，带上自定义规则就不只是公司制度的结论）
 * → 四张虚构对公付款单都有 AI 独立建议（web.e2e.mjs 已经发起过的不再发起；没有的先读取原件、再手动发起）→ 都是通过或不通过、有依据，Agent 引用的
 *   规则编号按方式到知识库里逐个核对（pg：经 SSM 或 SSH 查 nexus-pgvector 的 approval_rules；s3vectors：本机凭证对规则索引 GetVectors，只认有效的）。
 *   结论原来按 V4 审批矩阵设计；2026-10-31 起知识库是审批风险判断卡（risk-cards），结论不再写死：每张记下结论、引用的编号和用时，作新的基线；
 *   这几轮都没附自定义规则（外壳日志里没有 POC_CUSTOM_RULES）；新前端的单据抽屉里结论、依据里的规则编号和 AI 的说明都在
 *   → pg 方式：检索日志 kb_search_log 里有审核 Agent 审单时的检索（页面上的那次检索在 web.e2e.mjs 的「知识库 · 检索」）
 * → 调用记录 → 计入两档结论 → 没有回写 → 模拟来单一张（旧的 /poc/intake 页），等九安同步、读详情后自动发起并完成（结论同样记下）
 * → 自定义规则：poc-reviewer 在新前端「我的规则」页上传一份虚构的补充要求，手动发起 DGZF-F07-001 不通过（抽屉里标着含它的自定义规则）、删掉后
 *   回到它没有自定义规则时的基线结论；再带约 20,000 字的虚构长规则（「我的规则」不限字数）发起一次，Nexus 不拒收、在九安合同的 180 秒内跑完
 *   （测试台补丁 0006；记下这一轮的用时）；用例结束时不留规则
 * → 期间九安没有连 Nexus 以外的地址、没有调汇联易的审批写入。
 * 真实调用 Nexus：一次模拟来单、三轮自定义规则的 AI 独立建议（每次约 0.1–0.3 美元）；四张单的那四轮通常已由 web.e2e.mjs 跑完，单独跑这个文件
 * 时在这里发起（再加四次）。截图只有模拟来单页（evidence/round7/e2e/04-intake.png）：抽屉里 AI 的说明可能转述真实制度的审批路径，不截。
 * 自定义规则的文字都是虚构的。断言失败时只打印编号、状态和错误码，不打印 Agent 的备注和依据说明（可能转述规则原文）。
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
const BASE = process.env.E2E_BASE_URL || 'https://jiuan-v0710.tinyboat.blog';
const INSTANCE = process.env.E2E_INSTANCE;
const REGION = process.env.E2E_REGION || 'us-east-1';
// 出站拦截记录里不该出现的 Nexus 主机名（run.sh 从栈参数 NexusOrigin 取）
const NEXUS_HOST = process.env.E2E_NEXUS_HOST || '';
// 知识库方式（run.sh 从 DEPLOY_ENV 的 KB_MODE 取）：引用的规则编号到哪里核对、有没有检索日志
const KB_MODE = process.env.E2E_KB_MODE || 'pg';
// s3vectors 方式：引用的规则编号用本机的 AWS 凭证到这个向量桶的规则索引里查
const KB_S3V_BUCKET = process.env.E2E_KB_S3V_BUCKET || '';
const KB_S3V_RULES_INDEX = process.env.E2E_KB_S3V_RULES_INDEX || '';
// web.e2e.mjs「知识库 · 检索」在页面上检索的问题：检索日志那条按它的 md5 认出页面那次（和那边同一个默认值、同一个环境变量）
const KB_QUESTION = process.env.KB_E2E_QUESTION || '报废损失 董事长';
const SHOTS = new URL('../../../../evidence/round7/e2e/', import.meta.url);
// fixtures.mjs 的四个场景：九安房租（合同、发票齐）、柯顿运维费（超合同、收款方不符）、O+O 税款（有缴款通知）、新零售推广费（无原件、事由带注入文字）。
// 结论不写死（见文件头）：AI 独立建议那条把每张的结论记进 advices，后面的用例以它为基线
const NUMBERS = Object.freeze(['DGZF-F07-001', 'DGZF-F07-002', 'DGZF-F07-003', 'DGZF-F07-004']);
const RESULTS = Object.freeze(['pass', 'fail']);
// 知识库的规则编号：审批矩阵（kb/lib/parse_rules.py：C05-3.2、C07-NOTE、G-01）和审批风险判断卡（<制度标识>-H1、<制度标识>-T1.4，例如 risk-cards-T1.448）
const RULE_ID = /(?<![A-Za-z0-9_.-])(C\d{2}-(?:\d+\.\d+|NOTE)|G-\d{2}|[a-z0-9][a-z0-9-]*-(?:H\d+|T\d+(?:\.\d+)*))(?![A-Za-z0-9_-]|\.\d)/g;
// 一轮最长 180 秒（补丁 0006）；连接器同时只跑两轮，排在后面的那一轮要先等一轮跑完：等够两轮再加点余量
const ADVICE_TIMEOUT = 7 * 60_000;
// 登录的账号：管理员，「我的规则」按它存，手动发起时附它的规则（外壳日志 POC_CUSTOM_RULES <单据> poc-reviewer <字数>）
const OWNER = 'poc-reviewer';
const CUSTOM_NOTE = `（含 ${OWNER} 的自定义规则）`;
// 「我的规则」用的虚构规则（不是真实制度）：一份让 DGZF-F07-001（九安房租，合同、发票齐）不通过；一份约 20,000 字的长规则，只用来量请求大小和用时
// （「我的规则」2026-11-01 起不限字数；10-30 那一轮在旧提示词下，这么长的规则一轮超过了 120 秒）
const RENT_RULE = Object.freeze({ name: '九安房租补充要求.md', text: '九安板块的房租类对公付款，须附出租方的房产证明；没有的不予通过。' });
const LONG_RULE_CHARS = 20_000;
const LONG_RULE = Object.freeze({ name: '虚构长规则-量请求大小.md', text: (() => {
  const lines = [];
  for (let n = 1, size = 0; size < LONG_RULE_CHARS; n += 1) {
    const line = `第 ${n} 条（虚构的填充文字）：本条只用来在端到端测试里量一次调用的大小，不对任何单据提出审核要求。`;
    lines.push(line);
    size += line.length + 1;
  }
  return `${lines.join('\n').slice(0, LONG_RULE_CHARS - 1).trimEnd()}。`;
})() });
// 这次测试从哪一刻算起：run.sh 重置完给的 E2E_STARTED_AT（两个文件共用），单独跑时是这个文件开始的时候
const startedAt = new Date(process.env.E2E_STARTED_AT || Date.now());
let browser, page, publication = null;
const advices = new Map();

before(async () => {
  assert.ok(process.env.E2E_REVIEWER_PASSWORD && INSTANCE, '请用 run.sh 运行：它重置测试台并从 infra/secrets.env 读两个账号的口令');
  assert.ok(['pg', 's3vectors'].includes(KB_MODE), `E2E_KB_MODE 只能是 pg 或 s3vectors：${KB_MODE}`);
  assert.ok(Number.isFinite(startedAt.getTime()), `E2E_STARTED_AT 不是时间：${process.env.E2E_STARTED_AT}`);
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
/** 引用知识库规则的那几条依据（kind rule、不是「自定义：」开头的我的规则）。 */
const ruleBasis = advice => (advice?.basis ?? []).filter(item => item.kind === 'rule' && !String(item.ref ?? '').trim().startsWith('自定义：'));
const idsIn = item => [...String(item.ref ?? '').matchAll(RULE_ID)].map(match => match[1]);
const ruleIdsOf = advice => [...new Set(ruleBasis(advice).flatMap(idsIn))];
/** 依据的样子，只给编号和种类（不带说明）：失败时打印用。 */
const basisShape = advice => (advice?.basis ?? []).map(item => `${item.kind}:${item.kind === 'rule' ? (String(item.ref ?? '').startsWith('自定义：') ? '自定义' : idsIn(item).join('+') || '认不出编号') : '…'}`).join(' ');
const secondsOf = advice => (advice?.startedAt && advice?.finishedAt ? `${((Date.parse(advice.finishedAt) - Date.parse(advice.startedAt)) / 1000).toFixed(1)} 秒` : '没记时间');
/** 一轮完成、结论是通过或不通过、有依据、每条知识库规则的依据都认得出编号（编号在不在库里另查）。 */
function assertRound(advice, what) {
  assert.equal(advice?.status, 'completed', `${what}：${advice?.status} ${advice?.errorCode ?? String(advice?.declinedReason ?? '').slice(0, 120)}`);
  assert.ok(RESULTS.includes(advice.result), `${what} 的结论应是 pass 或 fail：${advice.result}`);
  assert.ok(advice.basis?.length, `${what} 没有依据`);
  assert.equal(ruleBasis(advice).filter(item => !idsIn(item).length).length, 0, `${what} 有引用知识库规则的依据认不出编号：${basisShape(advice)}`);
}
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
// 实例经 SSH 管理时（run.sh 给了 E2E_SSH_TARGET 和 E2E_SSH_OPTS_JSON），同样的只读命令经 SSH 以 sudo 跑；命令从 stdin 进去，不拼进参数
const SSH_TARGET = process.env.E2E_SSH_TARGET || '';
const SSH_OPTS = SSH_TARGET ? JSON.parse(process.env.E2E_SSH_OPTS_JSON || '[]') : [];
function overSsh(command, comment) {
  return new Promise((resolve, reject) => {
    const child = execFile('ssh', [...SSH_OPTS, SSH_TARGET, 'sudo -n bash -c "$(cat)"'], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`经 SSH 的只读命令没有成功（${comment}）：退出码 ${error.code} ${String(stderr ?? '').trim().slice(0, 300)}`));
      else resolve(String(stdout ?? '').trim());
    });
    child.stdin.end(command);
  });
}
/** 在测试台实例上跑一条只读命令（经 SSM，或经 SSH），回标准输出；命令没成功就抛（带标准错误的开头）。 */
async function ssm(command, comment) {
  if (SSH_TARGET) return overSsh(command, comment);
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
 * 测试台外壳（andon-jiuan）从 since 起的日志里含 text（原样匹配）的行。只有 grep 的「没找到」（退出码 1）算没有；
 * journalctl 读不出、grep 出错（退出码 2）都让命令失败（ssm 抛），免得「没有这一行」的断言没凭据也过。
 */
async function journalLines(text, since = startedAt) {
  if (!/^[A-Za-z0-9_ .:-]+$/.test(text)) throw new Error(`日志匹配串格式不对：${text}`);
  const out = await ssm([`out=$(journalctl -u andon-jiuan --since '${journalSince(since)}' --no-pager -o cat) || { echo "journalctl failed: $?" >&2; exit 3; }`,
    `printf '%s\\n' "$out" | grep -F '${text}'; rc=$?; if [ "$rc" -eq 1 ]; then exit 0; fi; exit "$rc"`].join('; '), 'e2e journal check (read-only)');
  return out.split('\n').map(line => line.trim()).filter(Boolean);
}

/**
 * 这些规则编号里知识库查得到的那些（按方式）：pg 经 SSM 查 nexus-pgvector 的 approval_rules（以应用用户、只读会话）；
 * s3vectors 用本机的 AWS 凭证对规则索引 GetVectors（只读），只认元数据 active 为 true 的。
 */
async function knownRuleIds(ids) {
  if (!ids.every(id => /^[A-Za-z0-9.-]+$/.test(id))) throw new Error(`规则编号格式不对：${ids}`);
  if (!ids.length) return [];
  if (KB_MODE === 's3vectors') {
    assert.ok(KB_S3V_BUCKET && KB_S3V_RULES_INDEX, 's3vectors 方式要知道向量桶和规则索引：DEPLOY_ENV 里写 KB_S3V_BUCKET、KB_S3V_RULES_INDEX，用 run.sh 运行');
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
/** 像审核员一样在新前端的「我的规则」页（#/my-rules）选一个 .md 上传，核对弹框里转出来的文字；回列表里这一份 { id, title, chars, … }。 */
async function uploadOwnRule({ name, text }) {
  await page.goto(`${BASE}/#/my-rules`);
  await page.reload();   // 重新读清单（React Query 里可能还是删之前的）
  await page.getByRole('heading', { name: '我的规则', level: 1 }).waitFor({ timeout: 30_000 });
  await page.getByText(/^已用 [\d,]+ 字$/).waitFor({ timeout: 60_000 });   // 清单读完（不限字数：只写已用多少字）
  await page.locator('input[type=file][aria-label="选择规则文件"]').setInputFiles({ name, mimeType: 'text/markdown', buffer: Buffer.from(text, 'utf8') });
  const check = page.getByRole('dialog', { name: '核对转出来的文字' });
  await check.or(page.getByRole('alert')).first().waitFor({ timeout: 60_000 });
  assert.ok(await check.isVisible(), `上传「${name}」没有成功：${await page.getByRole('alert').allInnerTexts()}`);
  await check.getByText(`已上传「${name}」`).waitFor();
  await check.getByRole('button', { name: '核对无误' }).click();
  await check.waitFor({ state: 'hidden' });
  const rule = (await ownRules()).items.find(item => item.title === name);
  assert.ok(rule, `「我的规则」列表里没有「${name}」`);
  assert.equal(rule.chars, [...text.trim()].length, `「${name}」转出来的字数和原文不一致`);
  return rule;
}
/** 在新前端打开这张单的抽屉（#/documents?doc=<id>，重新载入页面免得用到缓存的上一轮），回抽屉；默认在「AI 建议」页签。 */
async function openDrawer(number) {
  const { id } = await byNumber(number);
  await page.goto(`${BASE}/#/documents?doc=${encodeURIComponent(id)}`);
  await page.reload();
  const drawer = page.getByRole('dialog', { name: number });
  await drawer.waitFor({ timeout: 30_000 });
  return drawer;
}

test('登录（旧入口）：/poc/login 口令登录，跳到 /#access=<票据>，新前端换成会话进工作台；九安原来的页面 /analysis.html 照旧能开（版本 v0.7.10）；单据池里是模拟汇联易同步来的 5 张虚构单据（4 张对公付款、1 张差旅报销）', { timeout: 6 * 60_000 }, async () => {
  // 新前端的登录页和这条旧入口的细节在 web.e2e.mjs；这里只用它登录（旧登录页是外壳自己的页面，按它的 id 找输入框）
  await page.goto(`${BASE}/poc/login`);
  await page.locator('#account').selectOption(OWNER);
  await page.locator('#password').fill(process.env.E2E_REVIEWER_PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await page.getByRole('heading', { name: '工作台', level: 1 }).waitFor({ timeout: 30_000 });
  assert.doesNotMatch(page.url(), /access=/, '票据换完应从地址栏抹掉');
  const items = await until(documents, list => list.length >= 5, { timeout: 4 * 60_000, what: '单据同步' });
  assert.deepEqual(items.filter(item => item.type === 'corporate_payment').map(item => item.number).sort(), NUMBERS);
  assert.equal(items.filter(item => item.type !== 'corporate_payment').length, 1);
  // 九安原来的页面还在 /analysis.html，同一个会话打开
  await page.goto(`${BASE}/analysis.html`);
  await page.getByText('版本 v0.7.10').first().waitFor({ timeout: 30_000 });
  await page.goto(BASE);
  await page.getByRole('heading', { name: '工作台', level: 1 }).waitFor({ timeout: 30_000 });
});

test('审批 Agent（接口）：启用记录里审批流只调一个审批 Agent（就绪、接 review_advice@1）；页面上的「Agent 接入」和知识库 Agent 的核对在 web.e2e.mjs（不写死发布；密钥只在页面上粘贴，测试不碰）', async () => {
  const { records = [] } = (await api('/platform/agent-access')).json?.data ?? {};
  // 审批流只调审批 Agent（补丁 0003）：就绪、被指定为审批 Agent 的那一个，它的 card.tasks 才带 review_advice@1
  publication = records.find(record => record.status === 'active' && record.approval === true && record.card?.tasks?.includes('review_advice@1')) ?? null;
  assert.ok(publication, `还没有可用的审批 Agent：请到 ${BASE}/#/agents 启用审核 Agent（贴调用密钥），再点「设为审批 Agent」，然后跑测试`);
  assert.equal(records.filter(record => record.approval === true).length, 1, '审批 Agent 只有一个');
});

test('清场：poc-reviewer 的「我的规则」是空的（有就删掉并记一笔）——下面以它手动发起 AI 独立建议，带上自定义规则就不只是公司制度的结论', async () => {
  const removed = await clearOwnRules();
  if (removed.length) console.log(`清场：删掉了 ${OWNER} 留下的 ${removed.length} 份「我的规则」`);
  assert.deepEqual((await ownRules()).items, [], `${OWNER} 还有「我的规则」`);
});

test('AI 独立建议：四张对公付款单都有结论（web.e2e.mjs 已经发起过；没有的再手动发起），都是通过或不通过、有依据，引用的知识库规则编号都在库里（每张的结论、编号、用时记作基线）；这几轮都没附自定义规则；新前端的单据抽屉里结论、依据里的规则编号和 AI 的说明都在', { timeout: ADVICE_TIMEOUT + 4 * 60_000 }, async () => {
  assert.ok(publication, '上一条用例没找到可用的审核 Agent');
  for (const number of NUMBERS) {
    const document = await byNumber(number);
    // 九安页面上的顺序：先「读取原件」，再「运行一轮 AI 独立建议」（AI 独立建议只用已经读过的原件）。DGZF-F07-004 没有原件。
    const evidence = async () => (await api(`/documents/${document.id}/evidence`)).json.data;
    if ((await evidence()).status !== 'completed') {
      const read = await api(`/documents/${document.id}/evidence/read`, { method: 'POST', body: { sourceVersion: document.version } });
      assert.ok([200, 202].includes(read.status), `${number} 读取原件没有受理：${JSON.stringify(read.json)?.slice(0, 300)}`);
      await until(evidence, value => ['completed', 'failed'].includes(value?.status), { timeout: 60_000, every: 2000, what: `${number} 读取原件` });
    }
    const now = await adviceOf(document);
    if (now?.status === 'running' || now?.status === 'completed' && now.stale !== true) continue;   // web.e2e.mjs 或九安已经发起、跑完
    const started = await api(`/documents/${document.id}/advice`, { method: 'POST', body: { sourceVersion: document.version } });
    assert.ok([202, 409].includes(started.status), `${number} 发起失败：${JSON.stringify(started.json)?.slice(0, 300)}`);   // 409 是自动那一轮正在跑
  }
  const cited = new Set();
  for (const number of NUMBERS) {
    const document = await byNumber(number);
    const advice = await until(() => adviceOf(document), finished, { timeout: ADVICE_TIMEOUT, what: `${number} 的 AI 独立建议` });
    advices.set(number, advice);
    assertRound(advice, number);
    const ids = ruleIdsOf(advice);
    ids.forEach(id => cited.add(id));
    console.log(`基线 ${number}：${advice.result}，引用 ${ids.join('、') || '（没有引用知识库规则）'}；依据 ${basisShape(advice)}；用时 ${secondsOf(advice)}`);
  }
  const known = await knownRuleIds([...cited]);
  assert.deepEqual([...cited].filter(id => !known.includes(id)), [], `Agent 引用了知识库（${KB_MODE}）里没有的规则编号`);
  // 自动初审不附自定义规则，手动发起的那几轮清场后 poc-reviewer 也没有规则：外壳一行 POC_CUSTOM_RULES 都不该记（带空格，不算 POC_CUSTOM_RULES_FAILED）
  assert.deepEqual(await journalLines('POC_CUSTOM_RULES '), [], '四张单的这几轮不该附自定义规则');
  // 页面上：新前端单据抽屉的「AI 建议」页签显示结论；依据逐条摊开（旧页面收在折叠的「模型说明」里），Agent 引用的规则编号带「公司制度」标签；
  // Agent 的备注在「AI 的说明（模型自评…）」下面。不截图：依据的说明可能转述真实制度的审批路径
  // 风险判断卡没有审批矩阵：依据的说明里可以没有「适用审批路径」，抽屉里「审批路径 / 最终审批人」那一行可以没有，这里不查它
  for (const number of NUMBERS) {
    const drawer = await openDrawer(number);
    const advice = advices.get(number);
    await drawer.getByRole('region', { name: 'AI 结论' }).getByText(advice.result === 'pass' ? '建议通过' : '不建议通过', { exact: true }).waitFor({ timeout: 30_000 });
    const listed = drawer.getByRole('list', { name: '依据' }).getByRole('listitem');
    await listed.first().waitFor();
    assert.equal(await listed.count(), advice.basis.length, `${number}：抽屉里的依据条数和接口不一致`);
    const [first] = ruleIdsOf(advice);
    if (first) await listed.filter({ hasText: first }).filter({ hasText: '公司制度' }).first().waitFor();
    if (String(advice.note ?? '').trim()) await drawer.getByText('AI 的说明（模型自评，请对照单据和原件核对）', { exact: true }).waitFor();
    await drawer.getByRole('button', { name: '关闭' }).click();
    await drawer.waitFor({ state: 'hidden' });
  }
});

test('检索日志（pg 方式）：这次测试期间审核 Agent 审单时经连接器调了 kb_search（经 SSM 或 SSH 只读查 kb_search_log；不算 web.e2e.mjs 在知识库页上的那次检索）', { skip: KB_MODE === 'pg' ? false : 's3vectors 方式没有检索日志（审核 Agent 用 rules_search）' }, async () => {
  // 页面那次检索（web.e2e.mjs「知识库 · 检索」，同一次重置、同一个开始时间）经知识库 Agent 也记进来（约定里 caller 也是 agent）：
  // 按问题的 md5 认出它（问题本身不进 SQL；页面和接口都先去掉首尾空白）。
  // 一条查询数两样：页面那次（不限 caller，证明 md5 认得出它）和其余 caller = agent 的（审核 Agent 审单时的检索），两样都至少一次
  const pageQuestion = createHash('md5').update(KB_QUESTION.trim(), 'utf8').digest('hex');
  const sql = `SELECT count(*) FILTER (WHERE md5(question) = '${pageQuestion}'), count(*) FILTER (WHERE caller = 'agent' AND md5(question) IS DISTINCT FROM '${pageQuestion}')`
    + ` FROM kb_search_log WHERE at >= to_timestamp(${Math.floor(startedAt.getTime() / 1000)});`;
  const reply = await psql(sql, 'e2e kb_search_log check (read-only)');
  const [pageCount, agentCount] = reply.split('|').map(Number);
  console.log(`检索日志：测试开始以来页面那次检索 ${pageCount} 次，审核 Agent 的 kb_search ${agentCount} 次`);
  assert.ok(pageCount >= 1, `kb_search_log 里认不出页面那次检索（「${KB_QUESTION.trim()}」）：web.e2e.mjs 的「知识库 · 检索」没跑到（知识库 Agent 没就绪？），`
    + `或者知识库 Agent 改了问题文字，其余的检索就分不清是谁的（${reply}）`);
  assert.ok(agentCount >= 1, `测试开始以来 kb_search_log 里没有审核 Agent 的检索（caller = agent，页面那次不算）：${reply}`);
});

test('调用记录：每张对公付款单的这一轮都在调用记录里，发给审批 Agent、结论和这一轮的建议一致（「Agent 接入」页上的测试在 web.e2e.mjs）', async () => {
  assert.ok(publication, '前面的用例没找到可用的审核 Agent');
  const calls = (await api('/platform/agent-access/calls')).json?.data?.items ?? [];
  for (const number of NUMBERS) {
    const { result } = advices.get(number) ?? await adviceOf(await byNumber(number));
    assert.ok(calls.some(call => call.number === number && call.status === 'completed' && call.result === result && call.publishId === publication.publishId), `调用记录里缺 ${number} 的这一轮（${result}）`);
  }
});

test('两档结论：AI 独立建议计入结论——不建议通过的列为风险「AI 独立建议：不建议通过」，建议通过的不列这条风险；没有一张显示「平台尚未完成 AI 独立建议」（每张的两档结论记作基线）', async () => {
  // 九安 analysis-verdict.mjs：fail 记成一条风险「AI 独立建议：不建议通过」；pass 记进结论的依据（列表接口不带依据），
  // 没完成的记成技术风险「平台尚未完成 AI 独立建议」。建议通过的单，两档结论还看九安自己的规则（缺件等），不写死是 pass_suggested
  for (const number of NUMBERS) {
    const { result } = advices.get(number) ?? await adviceOf(await byNumber(number));
    const { verdict } = await byNumber(number);
    const titles = (verdict?.risks ?? []).map(item => item.title);
    console.log(`两档结论 ${number}：AI ${result} → ${verdict?.verdict}；风险 ${titles.join('、') || '（无）'}`);
    assert.doesNotMatch(JSON.stringify(verdict), /平台尚未完成 AI 独立建议/, number);
    assert.equal(titles.includes('AI 独立建议：不建议通过'), result === 'fail', `${number}：AI ${result}，风险 ${titles}`);
    if (result === 'fail') assert.notEqual(verdict.verdict, 'pass_suggested', `${number}：AI 不建议通过，两档结论不该是建议通过`);
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
  const intakeAt = Date.now();
  const number = /DGZF-SIM-\d{3}/.exec(message)[0];
  await shot('04-intake');
  await page.goto(BASE);
  // 九安按自己的同步周期从模拟汇联易拉单、读详情（每 5 秒看一次单据池）
  const document = await until(() => byNumber(number), Boolean, { timeout: 6 * 60_000, what: `${number} 进单据池` });
  const listedAt = Date.now();
  const advice = await until(() => adviceOf(document), finished, { timeout: ADVICE_TIMEOUT, what: `${number} 自动发起的 AI 独立建议` });
  const rounds = (await api(`/poc/advice-rounds?documentId=${encodeURIComponent(document.id)}`)).json?.data?.items ?? [];
  const current = rounds.find(round => round.current) ?? rounds[0];
  const call = ((await api('/platform/agent-access/calls')).json?.data?.items ?? []).find(entry => entry.number === number);
  const since = at => (at ? `来单后 ${Math.round((Date.parse(at) - intakeAt) / 1000)} 秒` : '—');
  console.log(`模拟来单 ${number}：来单到进 /documents ${Math.round((listedAt - intakeAt) / 1000)} 秒（每 5 秒查一次）；自动的一轮（${current?.trigger ?? '—'}）${since(advice.startedAt)}开始、`
    + `${since(advice.finishedAt)}结束，用时 ${secondsOf(advice)}，${advice.status} ${advice.result ?? advice.errorCode ?? ''}；调用记录 ${call?.latencyMs ?? '—'} 毫秒${call?.repaired ? '，修正过一次格式' : ''}`);
  assertRound(advice, `${number}（模板 DGZF-F07-001）`);
  const ids = ruleIdsOf(advice);
  const known = await knownRuleIds(ids);
  assert.deepEqual(ids.filter(item => !known.includes(item)), [], `${number} 引用了知识库（${KB_MODE}）里没有的规则编号`);
  console.log(`基线 ${number}（模板 DGZF-F07-001，自动发起）：${advice.result}（DGZF-F07-001 是 ${advices.get('DGZF-F07-001')?.result ?? '—'}），引用 ${ids.join('、') || '（没有引用知识库规则）'}；用时 ${secondsOf(advice)}`);
});

// 放在两档结论、模拟来单之后：这几轮改了 DGZF-F07-001 的当前建议，最后一轮（长规则）的结论不核对
test('自定义规则：poc-reviewer 在「我的规则」页上传「九安房租补充要求.md」后手动发起 DGZF-F07-001——不通过，备注写明含它的自定义规则（抽屉里标着），依据里有「自定义：」那一条（标「我的规则」），外壳记了 POC_CUSTOM_RULES；删掉后再发起回到它没有自定义规则时的基线结论、不提自定义规则；再带约 20,000 字的虚构长规则（不限字数）发起一次，Nexus 不拒收、在九安合同的 180 秒内跑完，记下用时；用例结束时不留规则', { timeout: 3 * ADVICE_TIMEOUT + 10 * 60_000 }, async () => {
  assert.ok(publication, '前面的用例没找到可用的审核 Agent');
  const number = 'DGZF-F07-001';
  const logged = async id => journalLines(`POC_CUSTOM_RULES ${id} ${OWNER} `);   // 外壳的一行：POC_CUSTOM_RULES <单据> <账号> <规则字数>
  // 没有自定义规则时这张单的结论（AI 独立建议那条记下的基线；只跑这一条时取它现在的建议）
  const baseline = advices.get(number) ?? await adviceOf(await byNumber(number));
  assert.ok(RESULTS.includes(baseline?.result), `${number} 还没有基线结论：${baseline?.status}`);
  try {
    // 1. 带上补充要求：这张房租单没附出租方的房产证明，所以不通过（不管公司制度下的基线是什么）
    const rent = await uploadOwnRule(RENT_RULE);
    const strict = await runAdvice(number);
    const { id } = strict.document;
    assertRound(strict.advice, `${number}（带自定义规则）`);
    console.log(`自定义规则 ${number}：带上「${RENT_RULE.name}」${strict.advice.result}，依据 ${basisShape(strict.advice)}；用时 ${secondsOf(strict.advice)}`);
    assert.equal(strict.advice.result, 'fail', `带上「${RENT_RULE.name}」后 ${number} 应不通过`);
    assert.ok(String(strict.advice.note ?? '').startsWith(CUSTOM_NOTE), `备注应以「${CUSTOM_NOTE}」开头`);
    assert.ok(strict.advice.basis.some(item => item.kind === 'rule' && String(item.ref).startsWith('自定义：')), `依据里应有 ref 以「自定义：」开头的规则：${basisShape(strict.advice)}`);
    assert.ok((await logged(id)).includes(`POC_CUSTOM_RULES ${id} ${OWNER} ${rent.chars}`), `外壳日志里应有 POC_CUSTOM_RULES ${id} ${OWNER} ${rent.chars}`);
    // 页面上：新前端的单据抽屉标着「含 poc-reviewer 的自定义规则」（取自备注开头那句），依据里那一条标「我的规则」（不截图，同上）
    const drawer = await openDrawer(number);
    await drawer.getByRole('region', { name: 'AI 结论' }).getByText('不建议通过', { exact: true }).waitFor({ timeout: 30_000 });
    await drawer.getByText(`含 ${OWNER} 的自定义规则`, { exact: true }).waitFor();
    await drawer.getByRole('list', { name: '依据' }).getByRole('listitem').filter({ hasText: '我的规则' }).first().waitFor();
    await drawer.getByRole('button', { name: '关闭' }).click();

    // 2. 删掉规则再发起：回到没有自定义规则时的基线结论，依据里没有「自定义：」，备注不提自定义规则，外壳也没再附
    await clearOwnRules();
    assert.deepEqual((await ownRules()).items, [], `${OWNER} 的规则没删干净`);
    const linesBefore = (await logged(id)).length;
    const plain = await runAdvice(number);
    assertRound(plain.advice, `${number}（删掉自定义规则后）`);
    console.log(`自定义规则 ${number}：删掉后 ${plain.advice.result}（基线 ${baseline.result}），依据 ${basisShape(plain.advice)}；用时 ${secondsOf(plain.advice)}`);
    assert.equal(plain.advice.result, baseline.result, `删掉规则后 ${number} 应回到基线结论 ${baseline.result}`);
    assert.ok(!plain.advice.basis.some(item => String(item.ref ?? '').trim().startsWith('自定义：')), '没有规则时依据里不该有「自定义：」');
    assert.doesNotMatch(String(plain.advice.note ?? ''), /自定义规则/, '没有规则时备注不该提自定义规则');
    assert.equal((await logged(id)).length, linesBefore, '删掉规则后这一轮不该再附自定义规则');

    // 3. 约 20,000 字的虚构长规则（填充文字）：「我的规则」不限字数，请求整份送到 Nexus（规则不裁），不被拒收，并在九安合同的 180 秒内跑完
    // （测试台补丁 0006；设计第 5 节风险 4、第 9 节；10-30 那一轮在旧提示词下这么长的规则超过了 120 秒）；这里记下这一轮的用时
    const long = await uploadOwnRule(LONG_RULE);
    const { usedChars, limitChars } = await ownRules();
    assert.equal(limitChars, null, `测试台的「我的规则」不该再有合计字数上限：limitChars 是 ${limitChars}（部署的外壳是不是旧的？）`);
    assert.ok(usedChars === long.chars && long.chars > LONG_RULE_CHARS - 200, `应只有这一份约 ${LONG_RULE_CHARS} 字的长规则：${usedChars} / ${long.chars}`);
    // 只看 Nexus 收没收下、按时答完：Agent 答了（completed）或婉拒（declined）都算；failed 带着错误码失败（如 AI_REQUEST_INVALID、请求过长、
    // 外壳的 CUSTOM_RULES_TOO_LONG——规则加上单据放不进一次请求；超过 180 秒被九安取消是 AI_UNAVAILABLE；连接器的 200 秒是兜底，到点是 CONNECTOR_TIMEOUT）
    const clock = Date.now();
    const lengthy = await runAdvice(number);
    const waited = Math.round((Date.now() - clock) / 1000);
    const { startedAt: began, finishedAt: ended } = lengthy.advice;
    const took = began && ended ? `${((Date.parse(ended) - Date.parse(began)) / 1000).toFixed(1)} 秒（九安记录的开始到结束）` : '九安没记开始、结束时间';
    console.log(`长规则的一轮：自定义规则 ${long.chars} 字，用时 ${took}，测试从发起到看到结果 ${waited} 秒（含每 5 秒一次的轮询）；${
      lengthy.advice.status === 'declined' ? `Agent 婉拒：${String(lengthy.advice.declinedReason ?? '').slice(0, 120)}` : lengthy.advice.status === 'completed' ? `结论 ${lengthy.advice.result}` : `${lengthy.advice.status} ${lengthy.advice.errorCode ?? ''}`}`);
    assert.ok(['completed', 'declined'].includes(lengthy.advice.status),
      `带 ${long.chars} 字自定义规则的这一轮没有按时答完（Nexus 拒收了请求，或超过九安合同的 180 秒被取消）：${lengthy.advice.status} ${lengthy.advice.errorCode ?? ''}，用时 ${took}`);
    assert.ok(began && ended && Date.parse(ended) - Date.parse(began) < 180_000, `带 ${long.chars} 字自定义规则的这一轮应在九安合同的 180 秒内跑完：${took}`);
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
  const lines = await ssm(`journalctl -u andon-jiuan --since '${journalSince(startedAt)}' --no-pager -o cat | grep -E 'POC_EGRESS_BLOCKED|POC_HLY_WRITE_BLOCKED' | sort | uniq -c || true`,
    'e2e egress check (read-only)');
  console.log(`出网与写回拦截记录：${lines || '（无）'}`);
  assert.doesNotMatch(lines, /POC_HLY_WRITE_BLOCKED/);
  assert.ok(NEXUS_HOST, '请用 run.sh 运行：它从栈参数取 Nexus 的主机名');
  assert.ok(!lines.includes(`POC_EGRESS_BLOCKED ${NEXUS_HOST}`), `出站拦截记录里不该有 Nexus（${NEXUS_HOST}）`);
});

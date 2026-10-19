/**
 * 「我的 Nexus」端到端测试（对线上地址，用命令行 agent_access.py 当调用方）。
 * 不花钱的：无效 API 密钥被拒、错误调用密钥被拒、用户隔离。花钱的（约 0.06 美元）：启用知识 Agent 并读能力清单、调用一次 answer。
 * 审核员第一次连接需要一把新的 API 密钥（E2E_NEXUS_API_KEY；用过一次就作废）。连接保存在实例上，之后的运行直接复用。
 * 请用 run.sh 运行：它先重启服务（顺带验证重启后连接与启用都还在），再从 infra/secrets.env 读口令与密钥。
 * 审核员本人已经启用了知识 Agent 时，测试不替换它的密钥、也不停用它，直接用它调用（线上账号是真人在用的）。
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const BASE = process.env.E2E_BASE_URL || 'https://andon-finance.tinyboat.blog';
const SCRIPT = fileURLToPath(new URL('../../../../skills/agent-access/scripts/agent_access.py', import.meta.url));
const KNOWLEDGE = 'pub_2cc24c29d2e5b2c9';
const SHOTS = new URL('../../../../evidence/round6/e2e/', import.meta.url);
const secrets = [process.env.E2E_REVIEWER_PASSWORD, process.env.E2E_CHECKER_PASSWORD, process.env.E2E_KNOWLEDGE_A2A_KEY, process.env.E2E_NEXUS_API_KEY].filter(Boolean);
let home, browser;
let knowledgeOwner = null;   // 'user'：审核员本人启用的，测试只用不动；'test'：测试自己启用的，最后停用

function cli(profile, args, input = '') {
  const result = spawnSync('python3', ['-I', SCRIPT, '--profile', profile, ...args], { input, encoding: 'utf8', env: { PATH: process.env.PATH, AGENT_ACCESS_HOME: home }, timeout: 330_000 });
  for (const secret of secrets) assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false, `输出里出现了密钥：${args[0]}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json: () => JSON.parse(result.stdout) };
}

before(async () => {
  assert.ok(process.env.E2E_REVIEWER_PASSWORD && process.env.E2E_CHECKER_PASSWORD && process.env.E2E_KNOWLEDGE_A2A_KEY, '请用 run.sh 运行');
  home = await mkdtemp(path.join(tmpdir(), 'agent-access-e2e-'));
  await mkdir(SHOTS, { recursive: true });
  for (const [profile, account, password] of [['reviewer', 'poc-reviewer', process.env.E2E_REVIEWER_PASSWORD], ['checker', 'poc-checker', process.env.E2E_CHECKER_PASSWORD]]) {
    assert.equal(cli(profile, ['login', '--origin', BASE, '--account', account, '--password-stdin', '--client', 'cli', '--yes'], `${password}\n`).status, 0);
  }
});
after(async () => { await browser?.close(); });

test('复核人：用无效的 API 密钥连接被拒（退出码 4），不影响别人', () => {
  assert.equal(cli('checker', ['nexus', 'connect', '--yes'], `nxc_${'0'.repeat(43)}\n`).status, 4);
});

test('审核员：已连接（重启后连接仍在），或者用 E2E_NEXUS_API_KEY 连上', t => {
  let view = cli('reviewer', ['status', '--json']).json();
  if (view.connection.status !== 'connected') {
    if (!process.env.E2E_NEXUS_API_KEY) { t.skip('审核员还没连接 Nexus，且没有 E2E_NEXUS_API_KEY：在页面上连接一次，或把一把新的 API 密钥填进 secrets.env 再跑'); return; }
    assert.equal(cli('reviewer', ['nexus', 'connect', '--yes'], `${process.env.E2E_NEXUS_API_KEY}\n`).status, 0);
    view = cli('reviewer', ['status', '--json']).json();
  }
  assert.equal(view.connection.status, 'connected');
  assert.equal(view.interfaceVersion, 'agent-access-v1');
  assert.ok(view.publications.some(item => item.publishId === KNOWLEDGE), '知识 Agent 应该在审核员的发布列表里');
  assert.deepEqual(view.system.map(item => item.publishId), ['pub_5c53e70d8dc7ddea']);
});

test('审核员：错误的调用密钥被拒（退出码 4，不花钱）；正确的启用成功并读到能力清单 v2；调用 answer 成功；复核人看不到', t => {
  const view = cli('reviewer', ['status', '--json']).json();
  if (view.connection.status !== 'connected') { t.skip('审核员没有连接 Nexus'); return; }
  const before = view.publications.find(item => item.publishId === KNOWLEDGE)?.enablement ?? null;
  // 带错误密钥的启用在验证这一步就被拒，不会改动已有的启用。
  assert.equal(cli('reviewer', ['enable', KNOWLEDGE, '--key-stdin', '--yes'], `nxa_${'0'.repeat(43)}\n`).status, 4);
  if (before) {
    knowledgeOwner = 'user';
    t.diagnostic('知识 Agent 已由审核员本人启用：不替换它的密钥，直接用它调用');
    assert.equal(before.status, 'active', '审核员本人启用的知识 Agent 不可用，请在页面上换密钥');
  } else {
    const enabled = cli('reviewer', ['enable', KNOWLEDGE, '--key-stdin', '--yes', '--json'], `${process.env.E2E_KNOWLEDGE_A2A_KEY}\n`);
    assert.equal(enabled.status, 0, enabled.stdout || enabled.stderr);
    knowledgeOwner = 'test';
    assert.equal(enabled.json().enablement.capabilitiesVersion, 'knowledge-agent-2026-10-17.2');
  }
  const invoked = cli('reviewer', ['invoke', KNOWLEDGE, '--task', 'answer', '--input', '{"question":"甲公司员工去北京出差，住宿每晚最多能报多少？","companyId":"poc-company-a"}', '--wait', '--yes', '--json']);
  assert.equal(invoked.status, 0, invoked.stderr);
  assert.match(invoked.json().rawText, /600/);
  const checker = cli('checker', ['status', '--json']).json();
  assert.equal(checker.publications.some(item => item.enablement), false);
});

test('界面：审核员的 Agent 页显示「我的 Nexus 连接」与「已启用」的知识 Agent；截图', async t => {
  if (cli('reviewer', ['status', '--json']).json().connection.status !== 'connected') { t.skip('审核员没有连接 Nexus'); return; }
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await (await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } })).newPage();
  await page.goto(BASE);
  await page.locator('#poc-login-account').selectOption('poc-reviewer');
  await page.locator('#poc-login-password').fill(process.env.E2E_REVIEWER_PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.locator('article.document-card').first().waitFor();
  await page.evaluate(() => { window.location.hash = '#nexusAgents'; });
  await page.getByText('我的 Nexus 连接').waitFor();
  await page.getByText(/已启用（\d+）/).waitFor();
  await page.locator(`article.poc-agent-card[data-publish-id="${KNOWLEDGE}"]`).getByText('已启用').first().waitFor();
  await page.screenshot({ path: fileURLToPath(new URL('my-agents.png', SHOTS)), fullPage: true });
});

test('审核员：停用后回到待启用；停用可以重复', t => {
  if (knowledgeOwner !== 'test') { t.skip(knowledgeOwner === 'user' ? '知识 Agent 是审核员本人启用的，测试不停用它' : '这次没有由测试启用知识 Agent'); return; }
  assert.equal(cli('reviewer', ['disable', KNOWLEDGE, '--yes']).status, 0);
  assert.equal(cli('reviewer', ['disable', KNOWLEDGE, '--yes']).status, 0);
  assert.equal(cli('reviewer', ['agents', '--state', 'pending']).stdout.includes(KNOWLEDGE), true);
});

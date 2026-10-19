# Agent 接入第一期实现计划：用户自己连接 Nexus、自己启用 Agent

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal**：每个应用用户用自己的 Nexus API 密钥连接，列出自己的发布，自己粘贴调用密钥启用 Agent，然后在调用测试里使用。接口约定为 `agent-access-v1`，页面、命令行 `agent_access.py` 和以后的编码工具共用这一套。

**Architecture**：PoC 服务端新增 `access/` 模块，每个账号有自己的目录，里面放 CLI 凭证目录、加密保存的启用清单、连接记录和留痕。它包括：
- 服务（`me.mjs`）：连接、列表、名片、启用验证、停用、取调用凭证；
- 接口（`routes.mjs`）：挂在九安的 platformRoutes 钩子上。

调用测试改成按「我的启用 → 系统提供」的顺序找调用密钥；运行记录按账号过滤。Agent 页改版。命令行是一个只用 Python 标准库的单文件脚本，以后打包成 Skill。

**Tech Stack**：Node 24（`node:test`、`node:crypto` 的 AES-256-GCM），九安 v0.5.3 原服务端，nexus-ai-operator CLI（Python 3.9+），A2A 0.3，Playwright（端到端测试）。

**Spec**：
- `audit-nexus/docs/specs/2026-10-17-agent-registry-design.md`（v3，下文简称「设计」）
- `audit-nexus/docs/specs/2026-10-17-agent-access-skills-design.md`（下文简称「Skills 设计」）

## Global Constraints

**接口**
- 接口版本号是 `agent-access-v1`。以后只加字段，不改已有字段的含义，也不删字段。
- 返回格式：成功是 `{"data": …}`，失败是 `{"error": {"code", "message"}}`。返回里一律不含任何密钥。
- 前缀是 `/api/analysis/v1/poc/nexus/me`。只作用于当前会话的账号，沿用九安的会话、来源和 CSRF 校验。
- 错误码和 HTTP 状态完全按设计第 12 节：
  - `POC_NEXUS_API_KEY_INVALID`（400）
  - `POC_NEXUS_UNREACHABLE`（502）
  - `POC_NEXUS_NOT_CONNECTED`（409）
  - `POC_PUBLICATION_NOT_MINE`（404）
  - `POC_CARD_UNAVAILABLE`（409）
  - `POC_CALL_KEY_INVALID`（400）
  - `POC_AGENT_NOT_ENABLED`（409）
  - `POC_ISSUE_NOT_ALLOWED`（403）
  - `POC_ME_RATE_LIMIT`（429）
- 连接和启用合在一起限流：每个账号每分钟 5 次。
- 列表超过 60 秒就先刷新；名片缓存 60 秒，所有账号共用。

**启用与验证**
- 先读 A2A 名片，再用这把密钥发 JSON-RPC `tasks/get`，任务编号随机生成。2026-10-17 在线上实测过：
  - HTTP 200（返回 JSON-RPC 错误「Task not found」）算有效；
  - HTTP 401 或 404 算无效；
  - 其他状态，或者网络不通，算 `POC_NEXUS_UNREACHABLE`。
- 默认读一次能力清单（发 `{"task":"describe"}`）。读不到不算启用失败。
- 指纹是 sha256 的前 8 位，密钥本身不回显，也不进日志。

**存储**
- 每个账号一个目录 `<usersDir>/<账号>/`，`usersDir` 缺省是 `/var/lib/andon-finance/users`，可以用环境变量 `POC_USERS_DIR` 改。目录权限 0700，文件 0600；写入先写临时文件再改名；同一账号的写操作排队执行。
- 目录里有：`nexus/`（CLI 凭证目录）、`enabled.json`、`connection.json`、`audit.jsonl`。
- 调用密钥用 AES-256-GCM 加密，密文格式是 `v1.<iv>.<tag>.<密文>`（base64url）。加密密钥 `REGISTRY_KEY` 放在 `secrets.env`，是 32 字节的 base64；没有这一项时，`deploy.sh` 生成一条追加进去。

**系统提供**
- 「系统提供的 Agent」就是 `secrets.env` 里每一行 `NEXUS_A2A_KEY_<发布编号>` 对应的发布，所有用户可见，不用启用。
- 迁移之后只保留审批流那一把（`pub_5c53e70d8dc7ddea`）。知识 Agent 的那一行改名为 `E2E_KNOWLEDGE_A2A_KEY`，只给端到端测试用，应用不加载。
- 审批流不变。

**命令行 `agent_access.py`**
- 只用 Python 3.9+ 标准库。
- 写操作要加 `--yes`，没加时退出码 9。
- 口令、API 密钥、调用密钥只经标准输入传入。
- 输出一律脱敏：`nxc_`、`nxa_`、`nxp_`、`afp_` 开头的串换成 `[已隐藏]`。
- 退出码 0、2–9 的含义按 Skills 设计第 5 节。
- 会话保存在 `$AGENT_ACCESS_HOME`（缺省 `~/.agent-access`）下的 `credentials.json`，文件 0600，目录 0700，按 `--profile` 分开，不保存口令。

**通用约束**
- 九安开发包（`audit-nexus/source/`）只读，不改。不使用 SSM。
- 界面文案用中文，句子简短，直接说用户能做什么。
- 不是 git 仓库，没有提交步骤。按全局规则，端到端测试跑完并经主人确认之前，不推送任何东西。
- 每个任务的测试命令：`cd audit-nexus/poc/app && node --test "test/unit/**/*.test.mjs"`。`deploy.sh` 每次部署前也会跑这一套。

## Review Focus

1. **同一账号同时发两次启用**（双击、两个标签页）：两次写入排队执行，`enabled.json` 始终是合法的 JSON，同一个发布只有一项。由任务 2 的测试保证。
2. **服务重启**：连接和启用都还在。CLI 凭证在磁盘上，启用清单也在磁盘上，重启后打开页面直接显示「已连接」和「已启用」，不用重新粘贴。由任务 4 的测试保证。
3. **已经连上之后，用用过的或无效的 API 密钥重新连接**：返回 400 `POC_NEXUS_API_KEY_INVALID`，原来的连接保持不变。由任务 4 的测试保证。
4. **启用之后发布被暂停**：调用时 Nexus 返回 404，只记成这次调用失败，**不能**把启用标成「密钥失效」；只有 401 才标。由任务 5 的测试保证。
5. **`REGISTRY_KEY` 被换掉了**：已保存的密钥解不开。页面把这一项显示成「密钥失效」，调用时返回 409 `POC_AGENT_NOT_ENABLED`，服务不能崩。由任务 4 的测试保证。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `poc/app/access/crypto.mjs`（新） | 加密、解密、指纹 |
| `poc/app/access/store.mjs`（新） | 每个账号的目录、启用清单、连接记录、留痕；原子写入、排队执行 |
| `poc/app/access/verify.mjs`（新） | 不花钱地验证调用密钥（`tasks/get`）；读能力清单 |
| `poc/app/access/me.mjs`（新） | 「我的 Nexus」服务：视图、连接、断开、刷新、启用、停用、取调用凭证、标记失效、系统提供的 Agent |
| `poc/app/access/routes.mjs`（新） | `/poc/nexus/me*` 接口 |
| `poc/app/secrets.mjs` | 新增 `registryKeyFrom`，删掉 `nexusApiKeyFrom` |
| `poc/app/config.mjs` | 新增 `usersDir`；不再需要 `NEXUS_HOME` 和 `NEXUS_PROFILE` |
| `poc/app/nexus/cli.mjs` | 新增 `logout` |
| `poc/app/nexus/catalog.mjs` | 只留 `publicationView`、`cardView`、`fetchAgentCard`；删掉 `createNexusCatalog` |
| `poc/app/nexus/invoke.mjs` | 按 `resolve(user, publishId)` 取调用凭证；401 时标记失效；运行记录多记 `actorId` |
| `poc/app/nexus/routes.mjs` | 删掉 `/agents`、`/refresh`；新增 `/attachment-policy`；运行记录按账号过滤 |
| `poc/app/server.mjs` | 组装存储、服务和接口；启动时要求有 `REGISTRY_KEY` |
| `poc/app/public-src/nexus-poc.js` | Agent 页改版：我的 Nexus 连接、我的 Agent（三组卡片和启用表单）、我还没发布的 Agent |
| `poc/app/public-src/nexus-invoke.js` | 调用测试可以预填能力清单（`hooks.manifests`） |
| `poc/app/public-src/nexus-poc.css` | 分组、启用表单、未发布列表的样式 |
| `audit-nexus/skills/agent-access/scripts/agent_access.py`（新） | 命令行，也就是以后 Skill 的脚本 |
| `audit-nexus/skills/agent-access/tests/test_agent_access.py`（新） | 纯函数的单元测试（`python3 -m unittest`） |
| `poc/app/test/unit/agent-access-cli.test.mjs`（新） | 在本机起 PoC，对它跑一遍 `agent_access.py` |
| `poc/app/test/e2e/access.e2e.mjs`（新）、`test/e2e/run.sh` | 线上端到端测试 |
| `poc/infra/deploy.sh` | 补上 `REGISTRY_KEY`；新文件的模板里去掉 `NEXUS_API_KEY` |

---

### Task 1：REGISTRY_KEY 与加密

**Files:**
- Create: `poc/app/access/crypto.mjs`
- Modify: `poc/app/secrets.mjs`：新增 `registryKeyFrom`；删除 `nexusApiKeyFrom`；更新文件头的注释
- Modify: `poc/infra/deploy.sh:55-69`
- Test: `poc/app/test/unit/access-crypto.test.mjs`（新）
- Test: `poc/app/test/unit/secrets.test.mjs:6,28-33`
- Test: `poc/app/test/unit/infra.test.mjs`

**Interfaces:**
- Produces:
  - `seal(key: Buffer, plaintext: string) → string`
  - `open(key: Buffer, sealed: string) → string`：失败时抛出错误，`code` 为 `POC_SEALED_INVALID`
  - `fingerprint(value: string) → string`：8 位十六进制
  - `registryKeyFrom(secrets: Map) → Buffer`：32 字节
- 被以下任务使用：
  - 任务 4（`me.mjs`）
  - 任务 5（`server.mjs`）

- [ ] **Step 1：写失败的测试** `test/unit/access-crypto.test.mjs`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fingerprint, open, seal } from '../../access/crypto.mjs';
import { parseSecrets, registryKeyFrom } from '../../secrets.mjs';

const KEY = randomBytes(32);

test('seal / open 往返；每次密文不同；密文里看不出原文；指纹是 sha256 前 8 位', () => {
  const a = seal(KEY, 'nxa_example_token_value'), b = seal(KEY, 'nxa_example_token_value');
  assert.notEqual(a, b);
  assert.match(a, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(a.includes('nxa_example'), false);
  assert.equal(open(KEY, a), 'nxa_example_token_value');
  assert.equal(fingerprint('abc'), 'ba7816bf');
});

test('换了加密密钥、密文被改过或格式不对：一律 POC_SEALED_INVALID', () => {
  const sealed = seal(KEY, 'secret-value');
  assert.throws(() => open(randomBytes(32), sealed), { code: 'POC_SEALED_INVALID' });
  const parts = sealed.split('.');
  parts[3] = `${parts[3].slice(0, -2)}${parts[3].endsWith('AA') ? 'BB' : 'AA'}`;
  assert.throws(() => open(KEY, parts.join('.')), { code: 'POC_SEALED_INVALID' });
  for (const bad of ['', 'v0.a.b.c', 'v1.only', null]) assert.throws(() => open(KEY, bad), { code: 'POC_SEALED_INVALID' });
});

test('registryKeyFrom：32 字节 base64；缺失或格式不对时说明怎么补，且不带值', () => {
  const value = randomBytes(32).toString('base64');
  assert.equal(registryKeyFrom(parseSecrets(`REGISTRY_KEY=${value}\n`)).length, 32);
  for (const text of ['', 'REGISTRY_KEY=\n', 'REGISTRY_KEY=abc\n', `REGISTRY_KEY=${randomBytes(16).toString('base64')}\n`]) {
    assert.throws(() => registryKeyFrom(parseSecrets(text)), error => /REGISTRY_KEY/.test(error.message) && /deploy\.sh/.test(error.message) && !error.message.includes('abc'));
  }
});
```

在 `secrets.test.mjs` 里，把第 28–33 行那个测试改成只测 `a2aKeysFrom`，同时从第 6 行的 import 里删掉 `nexusApiKeyFrom`：

```js
test('a2aKeysFrom 只认 NEXUS_A2A_KEY_<发布编号>，并且值不能为空；E2E_KNOWLEDGE_A2A_KEY 不算系统提供', () => {
  const secrets = parseSecrets('NEXUS_A2A_KEY_pub_5c53e70d8dc7ddea=nxa_1\nNEXUS_A2A_KEY_bad=x\nNEXUS_A2A_KEY_pub_empty=\nE2E_KNOWLEDGE_A2A_KEY=nxa_2\n');
  assert.deepEqual([...a2aKeysFrom(secrets)], [['pub_5c53e70d8dc7ddea', 'nxa_1']]);
});
```

在 `infra.test.mjs` 末尾追加：

```js
test('deploy.sh：secrets.env 没有 REGISTRY_KEY 时追加一条（openssl 32 字节）；新文件模板不再写 NEXUS_API_KEY', async () => {
  const deploy = await readFile(new URL('../../../infra/deploy.sh', import.meta.url), 'utf8');
  assert.match(deploy, /grep -q '\^REGISTRY_KEY=' "\$SECRETS"/);
  assert.match(deploy, /REGISTRY_KEY=\$\(openssl rand -base64 32\)/);
  assert.equal(/^NEXUS_API_KEY=/m.test(deploy), false);
});
```

`infra.test.mjs` 文件开头已经 import 了 `readFile`；如果没有，就加上 `import { readFile } from 'node:fs/promises';`。

- [ ] **Step 2：运行，确认失败**

运行：`node --test test/unit/access-crypto.test.mjs test/unit/secrets.test.mjs test/unit/infra.test.mjs`
预期：access-crypto 报 `ERR_MODULE_NOT_FOUND`；infra 新增的那个测试失败。

- [ ] **Step 3：实现** `access/crypto.mjs`

```js
/**
 * 用户调用密钥的加密：AES-256-GCM，每次随机 12 字节 IV；密文格式 v1.<iv>.<tag>.<密文>（base64url）。
 * 加密密钥是启动配置 REGISTRY_KEY（secrets.env）：只拿到 enabled.json 解不出调用密钥。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const invalid = () => Object.assign(new Error('POC_SEALED_INVALID'), { code: 'POC_SEALED_INVALID' });

export function seal(key, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${body.toString('base64url')}`;
}

export function open(key, sealed) {
  const [version, iv, tag, body, extra] = String(sealed ?? '').split('.');
  if (version !== 'v1' || !iv || !tag || !body || extra !== undefined) throw invalid();
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw invalid();
  }
}

export const fingerprint = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 8);
```

修改 `secrets.mjs`：
- 文件头的注释里，删掉 `NEXUS_API_KEY` 那一行，加上一行：`REGISTRY_KEY  加密各用户调用密钥的密钥（32 字节 base64，deploy.sh 发现没有时生成）`；
- 再加一行说明：`E2E_KNOWLEDGE_A2A_KEY  只给端到端测试用，应用不加载`；
- 删掉 `nexusApiKeyFrom`，追加下面这个函数：

```js
/** REGISTRY_KEY：加密各用户调用密钥用（32 字节，base64）。报错只说缺哪一项、怎么补，不带任何值。 */
export function registryKeyFrom(secrets) {
  const value = secrets.get('REGISTRY_KEY');
  const key = typeof value === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(value) ? Buffer.from(value, 'base64') : null;
  if (!key || key.length !== 32) {
    throw new Error('密钥配置文件里的 REGISTRY_KEY 缺失或格式不对（应是 32 字节的 base64）：运行 infra/deploy.sh 会自动补上');
  }
  return key;
}
```

修改 `deploy.sh`：
- 在 `SECRETSFILE` 模板里，删掉 `# 这台 EC2 读 Nexus Agent 列表用的 API 密钥…` 那一行注释，以及 `NEXUS_API_KEY=` 这一行；
- 在模板最后一行 `NEXUS_A2A_KEY_$(param AdvisoryPublicationId)=` 之后、`SECRETSFILE` 之前，插入下面两行：

```
# 加密各用户调用密钥的密钥（32 字节 base64）。换掉它，所有用户都要重新启用 Agent。
REGISTRY_KEY=$(openssl rand -base64 32)
```

再把模板上方注释里的「各发布的 A2A 调用密钥」改成「系统提供的 A2A 调用密钥（审批流在用的发布）」。然后在 `chmod 600 "$SECRETS"` 之前插入：

```bash
if ! grep -q '^REGISTRY_KEY=' "$SECRETS"; then
  printf '%s\n' '# 加密各用户调用密钥的密钥（32 字节 base64）。换掉它，所有用户都要重新启用 Agent。' "REGISTRY_KEY=$(openssl rand -base64 32)" >> "$SECRETS"
  echo "已在 ${SECRETS} 里补上 REGISTRY_KEY"
fi
```

- [ ] **Step 4：运行，确认通过**

运行：`node --test test/unit/access-crypto.test.mjs test/unit/secrets.test.mjs test/unit/infra.test.mjs`
预期：全部通过。此时 `server.mjs` 还在 import `nexusApiKeyFrom`，所以 server.test 会失败，这是预期的，任务 5 会修复。全套测试留到任务 5 再跑。

---

### Task 2：每个账号的存储

**Files:**
- Create: `poc/app/access/store.mjs`
- Test: `poc/app/test/unit/access-store.test.mjs`（新）

**Interfaces:**
- Produces：`createUserStore({ root: string, now?: () => string })`，返回下面这些方法，都是 async：
  - `nexusHomeFor(accountId) → string`：建好 `<root>/<账号>/nexus`（0700），返回它的路径
  - `list(accountId) → item[]`
  - `get(accountId, publishId) → item | null`
  - `put(accountId, item) → item`：按 `publishId` 替换已有的那一项
  - `update(accountId, publishId, patch) → item | null`
  - `remove(accountId, publishId) → boolean`
  - `readConnection(accountId) → object | null`
  - `saveConnection(accountId, value)`
  - `clearConnection(accountId)`
  - `audit(accountId, entry)`：自动加上 `at`
  - `readAudit(accountId) → entry[]`
- 账号名必须符合 `/^[a-z0-9][a-z0-9-]{0,63}$/`，否则抛出错误，`code` 为 `POC_ACCOUNT_INVALID`。
- `enabled.json` 损坏时抛出错误，`code` 为 `POC_STORE_CORRUPT`。

- [ ] **Step 1：写失败的测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createUserStore } from '../../access/store.mjs';

const root = () => mkdtemp(path.join(tmpdir(), 'poc-users-'));
const item = (publishId, extra = {}) => ({ publishId, displayName: publishId, credential: { cipher: 'v1.a.b.c', fingerprint: '00000000', verifiedAt: 't' },
  status: 'active', enabledAt: 't', updatedAt: 't', ...extra });
const mode = async file => (await stat(file)).mode & 0o777;

test('目录 0700、文件 0600；put 按发布编号替换；get / list / remove', async () => {
  const dir = await root();
  const store = createUserStore({ root: dir });
  assert.deepEqual(await store.list('poc-reviewer'), []);
  await store.put('poc-reviewer', item('pub_aaaa'));
  await store.put('poc-reviewer', item('pub_bbbb'));
  await store.put('poc-reviewer', item('pub_aaaa', { displayName: '新名字' }));
  assert.deepEqual((await store.list('poc-reviewer')).map(entry => [entry.publishId, entry.displayName]), [['pub_bbbb', 'pub_bbbb'], ['pub_aaaa', '新名字']]);
  assert.equal((await store.get('poc-reviewer', 'pub_aaaa')).displayName, '新名字');
  assert.equal(await store.get('poc-reviewer', 'pub_none'), null);
  assert.equal(await mode(path.join(dir, 'poc-reviewer')), 0o700);
  assert.equal(await mode(path.join(dir, 'poc-reviewer', 'enabled.json')), 0o600);
  assert.equal(await store.remove('poc-reviewer', 'pub_aaaa'), true);
  assert.equal(await store.remove('poc-reviewer', 'pub_aaaa'), false);
  assert.deepEqual((await store.list('poc-reviewer')).map(entry => entry.publishId), ['pub_bbbb']);
});

test('同一账号同时写很多次：排队执行，文件始终是合法 JSON，同一个发布只有一项（Review Focus 1）', async () => {
  const dir = await root();
  const store = createUserStore({ root: dir });
  await Promise.all([
    ...Array.from({ length: 10 }, (_, index) => store.put('poc-reviewer', item(`pub_${String(index).padStart(4, '0')}`))),
    ...Array.from({ length: 5 }, (_, index) => store.put('poc-reviewer', item('pub_same', { updatedAt: String(index) }))),
  ]);
  const data = JSON.parse(await readFile(path.join(dir, 'poc-reviewer', 'enabled.json'), 'utf8'));
  assert.equal(data.items.length, 11);
  assert.equal(data.items.filter(entry => entry.publishId === 'pub_same').length, 1);
});

test('update 只改给的字段；不存在时返回 null', async () => {
  const store = createUserStore({ root: await root() });
  await store.put('poc-reviewer', item('pub_aaaa'));
  assert.equal((await store.update('poc-reviewer', 'pub_aaaa', { status: 'key_invalid' })).status, 'key_invalid');
  assert.equal((await store.get('poc-reviewer', 'pub_aaaa')).credential.fingerprint, '00000000');
  assert.equal(await store.update('poc-reviewer', 'pub_none', { status: 'x' }), null);
});

test('nexusHomeFor 建好 0700 的 nexus 目录；连接记录可存、可读、可清；留痕只追加', async () => {
  const dir = await root();
  const store = createUserStore({ root: dir, now: () => '2026-10-17T00:00:00.000Z' });
  const home = await store.nexusHomeFor('poc-checker');
  assert.equal(home, path.join(dir, 'poc-checker', 'nexus'));
  assert.equal(await mode(home), 0o700);
  assert.equal(await store.readConnection('poc-checker'), null);
  await store.saveConnection('poc-checker', { connectedAt: 'x', nexusUser: { name: 'admin' } });
  assert.equal((await store.readConnection('poc-checker')).nexusUser.name, 'admin');
  await store.clearConnection('poc-checker');
  assert.equal(await store.readConnection('poc-checker'), null);
  await store.audit('poc-checker', { action: 'connect' });
  await store.audit('poc-checker', { action: 'disconnect' });
  assert.deepEqual(await store.readAudit('poc-checker'), [{ at: '2026-10-17T00:00:00.000Z', action: 'connect' }, { at: '2026-10-17T00:00:00.000Z', action: 'disconnect' }]);
  assert.equal(await mode(path.join(dir, 'poc-checker', 'audit.jsonl')), 0o600);
});

test('账号名不合规（含路径）一律拒绝；enabled.json 损坏时报 POC_STORE_CORRUPT', async () => {
  const dir = await root();
  const store = createUserStore({ root: dir });
  for (const bad of ['../etc', 'A', '', 'a/b', null]) await assert.rejects(store.list(bad), { code: 'POC_ACCOUNT_INVALID' });
  await store.nexusHomeFor('poc-reviewer');
  await writeFile(path.join(dir, 'poc-reviewer', 'enabled.json'), '{bad');
  await assert.rejects(store.list('poc-reviewer'), { code: 'POC_STORE_CORRUPT' });
});
```

- [ ] **Step 2：运行，确认失败**

运行：`node --test test/unit/access-store.test.mjs`
预期：报 `ERR_MODULE_NOT_FOUND`。

- [ ] **Step 3：实现** `access/store.mjs`

```js
/**
 * 每个应用账号一个目录 <root>/<账号>/（0700）：
 *   nexus/           这个账号的 operator CLI 凭证目录（NEXUS_HOME），由 CLI 自己管理
 *   enabled.json     启用的 Agent（调用密钥已加密）
 *   connection.json  连接 Nexus 的时间与 Nexus 账号（不含任何密钥）
 *   audit.jsonl      留痕：连接、断开、启用、换密钥、重新验证、停用、标记失效（只追加）
 * 写入先写临时文件再改名；同一账号的写操作排队执行。
 */
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ACCOUNT = /^[a-z0-9][a-z0-9-]{0,63}$/;
const error = code => Object.assign(new Error(code), { code });

export function createUserStore({ root, now = () => new Date().toISOString() }) {
  const chains = new Map();
  let sequence = 0;
  const dirFor = accountId => {
    if (typeof accountId !== 'string' || !ACCOUNT.test(accountId)) throw error('POC_ACCOUNT_INVALID');
    return path.join(root, accountId);
  };
  const file = (accountId, name) => path.join(dirFor(accountId), name);
  async function ensure(accountId) {
    const dir = dirFor(accountId);
    await mkdir(path.join(dir, 'nexus'), { recursive: true, mode: 0o700 });
    return dir;
  }
  function serial(accountId, task) {
    const run = async () => { dirFor(accountId); return task(); };
    const next = (chains.get(accountId) ?? Promise.resolve()).then(run, run);
    chains.set(accountId, next.catch(() => {}));
    return next;
  }
  async function readJson(target, fallback) {
    try { return JSON.parse(await readFile(target, 'utf8')); } catch (cause) {
      if (cause?.code === 'ENOENT') return fallback;
      throw error('POC_STORE_CORRUPT');
    }
  }
  async function writeJson(target, value) {
    sequence += 1;
    const tmp = `${target}.${process.pid}.${sequence}.tmp`;
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, target);
  }
  async function items(accountId) {
    const data = await readJson(file(accountId, 'enabled.json'), { version: 1, items: [] });
    if (!data || !Array.isArray(data.items)) throw error('POC_STORE_CORRUPT');
    return data.items;
  }
  const save = (accountId, list) => writeJson(file(accountId, 'enabled.json'), { version: 1, items: list });
  return {
    async nexusHomeFor(accountId) { return path.join(await ensure(accountId), 'nexus'); },
    async list(accountId) { dirFor(accountId); return items(accountId); },
    async get(accountId, publishId) { dirFor(accountId); return (await items(accountId)).find(entry => entry.publishId === publishId) ?? null; },
    put: (accountId, item) => serial(accountId, async () => {
      await ensure(accountId);
      await save(accountId, [...(await items(accountId)).filter(entry => entry.publishId !== item.publishId), item]);
      return item;
    }),
    update: (accountId, publishId, patch) => serial(accountId, async () => {
      const list = await items(accountId);
      const index = list.findIndex(entry => entry.publishId === publishId);
      if (index < 0) return null;
      list[index] = { ...list[index], ...patch };
      await save(accountId, list);
      return list[index];
    }),
    remove: (accountId, publishId) => serial(accountId, async () => {
      const list = await items(accountId);
      const kept = list.filter(entry => entry.publishId !== publishId);
      if (kept.length === list.length) return false;
      await save(accountId, kept);
      return true;
    }),
    async readConnection(accountId) { dirFor(accountId); return readJson(file(accountId, 'connection.json'), null); },
    saveConnection: (accountId, value) => serial(accountId, async () => { await ensure(accountId); await writeJson(file(accountId, 'connection.json'), value); }),
    clearConnection: accountId => serial(accountId, () => rm(file(accountId, 'connection.json'), { force: true })),
    audit: (accountId, entry) => serial(accountId, async () => {
      await ensure(accountId);
      await appendFile(file(accountId, 'audit.jsonl'), `${JSON.stringify({ at: now(), ...entry })}\n`, { mode: 0o600 });
    }),
    async readAudit(accountId) {
      try { return (await readFile(file(accountId, 'audit.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch (cause) {
        if (cause?.code === 'ENOENT') return [];
        throw error('POC_STORE_CORRUPT');
      }
    },
  };
}
```

- [ ] **Step 4：运行，确认通过**

运行：`node --test test/unit/access-store.test.mjs`
预期：5 个测试全部通过。

---

### Task 3：CLI 断开、密钥验证与能力清单

**Files:**
- Modify: `poc/app/nexus/cli.mjs:22-28`（新增 `logout`）
- Create: `poc/app/access/verify.mjs`
- Test: `poc/app/test/unit/cli.test.mjs`（追加）
- Test: `poc/app/test/unit/access-verify.test.mjs`（新）

**Interfaces:**
- Produces：
  - `cli.logout() → Promise<{exitCode, json}>`
  - `verifyCallKey({ url, key, fetchImpl?, timeoutMs? }) → 'valid' | 'invalid'`：其他情况抛出错误，`code` 为 `POC_NEXUS_UNREACHABLE`，`status` 为 502
  - `loadManifest({ url, key, call?, timeoutMs? }) → { manifest: object | null, version: string | null, error: string | null }`

- [ ] **Step 1：写失败的测试**

在 `cli.test.mjs` 末尾追加：

```js
test('logout 只删本机凭证（不带 --revoke）', async () => {
  const calls = [];
  const cli = createOperatorCli({ script: '/opt/op/nexus.py', nexusHome: '/var/lib/x/users/poc-reviewer/nexus', profile: 'default', origin: 'https://nexus.example',
    exec: async (file, args, options) => { calls.push({ args, env: options.env }); return { exitCode: 0, json: { ok: true, removed: true } }; } });
  assert.equal((await cli.logout()).exitCode, 0);
  assert.deepEqual(calls[0].args, ['-I', '/opt/op/nexus.py', '--profile', 'default', '--json', 'logout']);
  assert.equal(calls[0].env.NEXUS_HOME, '/var/lib/x/users/poc-reviewer/nexus');
});
```

新建 `access-verify.test.mjs`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadManifest, verifyCallKey } from '../../access/verify.mjs';
import { answerEvents, startFakeA2a, writeEvents } from './helpers/fake-a2a.mjs';

const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

test('verifyCallKey：发的是 tasks/get（不是 message/stream），带 Bearer；200 有效，401 / 404 无效（2026-10-17 实测的三种返回）', async t => {
  const replies = [
    res => json(res, 200, { jsonrpc: '2.0', id: 'x', error: { code: -32603, message: 'Task not found', data: null } }),
    res => json(res, 401, { jsonrpc: '2.0', id: 'x', error: { code: -32010, message: 'credential_invalid' } }),
    res => json(res, 404, { jsonrpc: '2.0', id: 'x', error: { code: -32011, message: 'publication_not_found' } }),
  ];
  let index = 0;
  const fake = await startFakeA2a(({ res }) => replies[index++](res));
  t.after(() => fake.close());
  assert.equal(await verifyCallKey({ url: fake.url, key: 'nxa_good' }), 'valid');
  assert.equal(await verifyCallKey({ url: fake.url, key: 'nxa_bad' }), 'invalid');
  assert.equal(await verifyCallKey({ url: fake.url, key: 'nxa_other' }), 'invalid');
  assert.equal(fake.requests[0].body.method, 'tasks/get');
  assert.match(fake.requests[0].body.params.id, /^[0-9a-f-]{36}$/);
  assert.equal(fake.requests[0].headers.authorization, 'Bearer nxa_good');
});

test('verifyCallKey：Nexus 出错（5xx）或连不上，算 POC_NEXUS_UNREACHABLE（502）', async t => {
  const fake = await startFakeA2a(({ res }) => json(res, 503, { error: 'gateway_unavailable' }));
  t.after(() => fake.close());
  await assert.rejects(verifyCallKey({ url: fake.url, key: 'nxa_x' }), { code: 'POC_NEXUS_UNREACHABLE', status: 502 });
  await assert.rejects(verifyCallKey({ url: 'http://127.0.0.1:9/a2a/pub_x', key: 'nxa_x', timeoutMs: 500 }), { code: 'POC_NEXUS_UNREACHABLE' });
});

test('loadManifest：describe 返回能力清单时取出版本；不是能力清单或调用失败时只给错误码，不抛', async t => {
  const manifest = { task: 'describe', version: 'knowledge-agent-2026-10-17.2', tasks: [{ name: 'answer', purpose: '问知识库' }] };
  const replies = [JSON.stringify(manifest), '```json\n' + JSON.stringify(manifest) + '\n```', '{"recommendation":"MANUAL_REVIEW"}'];
  let index = 0;
  const fake = await startFakeA2a(({ res, body }) => {
    if (index >= replies.length) { json(res, 401, { error: { data: { code: 'credential_invalid' } } }); return; }
    assert.equal(body.params.message.parts[0].text, '{"task":"describe"}');
    writeEvents(res, answerEvents(replies[index++]));
  });
  t.after(() => fake.close());
  assert.deepEqual(await loadManifest({ url: fake.url, key: 'k' }), { manifest, version: 'knowledge-agent-2026-10-17.2', error: null });
  assert.equal((await loadManifest({ url: fake.url, key: 'k' })).version, 'knowledge-agent-2026-10-17.2');
  assert.deepEqual(await loadManifest({ url: fake.url, key: 'k' }), { manifest: null, version: null, error: 'POC_NOT_A_MANIFEST' });
  assert.deepEqual(await loadManifest({ url: fake.url, key: 'k' }), { manifest: null, version: null, error: 'AI_AUTH_INVALID' });
});
```

- [ ] **Step 2：运行，确认失败**

运行：`node --test test/unit/cli.test.mjs test/unit/access-verify.test.mjs`
预期：logout 那个测试报 `cli.logout is not a function`；verify 那个文件报 `ERR_MODULE_NOT_FOUND`。

- [ ] **Step 3：实现**

在 `cli.mjs` 的返回对象里，`login` 后面加一项：

```js
    logout: () => exec(python, [...base, 'logout'], { env: env(), timeoutMs }),
```

同时把文件头注释的第一句改成：「以子进程调用 nexus-ai-operator（Python 标准库实现）。每个账号一个凭证目录（NEXUS_HOME），由 CLI 自己保存、续期、轮换；这里不读。」

新建 `access/verify.mjs`：

```js
/**
 * 启用时的两件事：
 * 1. 不花钱地验证调用密钥：发 JSON-RPC tasks/get（随机任务编号）。Nexus 先认证、再分发（a2a_endpoint.py:528），tasks/get 不占用 Agent。
 *    2026-10-17 实测：有效 → HTTP 200 + JSON-RPC 错误 "Task not found"；无效 → 401 credential_invalid；别的发布的密钥 → 404 publication_not_found。
 * 2. 读能力清单：经 A2A 发 {"task":"describe"}（约 0.03 美元）；读不到不算启用失败，只给错误码。
 */
import { randomUUID } from 'node:crypto';
import { a2aCall, unwrapJson } from '../nexus/a2a-client.mjs';

const unreachable = () => Object.assign(new Error('POC_NEXUS_UNREACHABLE'), { code: 'POC_NEXUS_UNREACHABLE', status: 502 });

export async function verifyCallKey({ url, key, fetchImpl = globalThis.fetch, timeoutMs = 10_000 }) {
  let res;
  try {
    res = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tasks/get', params: { id: randomUUID() } }) });
    await res.arrayBuffer();
  } catch {
    throw unreachable();
  }
  if (res.status === 200) return 'valid';
  if ([401, 403, 404].includes(res.status)) return 'invalid';
  throw unreachable();
}

export async function loadManifest({ url, key, call = a2aCall, timeoutMs = 120_000 }) {
  try {
    const { text } = await call({ url, key, text: JSON.stringify({ task: 'describe' }), timeoutMs });
    const value = JSON.parse(unwrapJson(text).text);
    if (value && value.task === 'describe' && Array.isArray(value.tasks)) {
      return { manifest: value, version: typeof value.version === 'string' ? value.version.slice(0, 80) : null, error: null };
    }
    return { manifest: null, version: null, error: 'POC_NOT_A_MANIFEST' };
  } catch (error) {
    return { manifest: null, version: null, error: error instanceof SyntaxError ? 'POC_NOT_A_MANIFEST' : typeof error?.code === 'string' ? error.code : 'AI_UNAVAILABLE' };
  }
}
```

- [ ] **Step 4：运行，确认通过**

运行：`node --test test/unit/cli.test.mjs test/unit/access-verify.test.mjs`
预期：全部通过。

---

### Task 4：「我的 Nexus」服务

**Files:**
- Create: `poc/app/access/me.mjs`
- Modify: `poc/app/nexus/catalog.mjs`：删掉 `createNexusCatalog` 和只给它用的辅助函数，只留 `publicationView`、`cardView`、`fetchAgentCard`
- Test: `poc/app/test/unit/access-me.test.mjs`（新）
- Test: `poc/app/test/unit/catalog.test.mjs`：改写，见 Step 1

**Interfaces:**
- Consumes：
  - 任务 1：`seal`、`open`、`fingerprint`
  - 任务 2：`createUserStore`
  - 任务 3：`verifyCallKey`、`loadManifest`（以参数形式注入）
  - `catalog.mjs`：`publicationView(item, origin)`、`cardView(json)`、`fetchAgentCard(url)`
- Produces：
  - `INTERFACE_VERSION = 'agent-access-v1'`
  - `createMeService({ store, cliFor, registryKey, keyStore, fetchCard, verifyKey, loadManifest, nexusOrigin, advisoryPublishId, staleMs?, cardTtlMs?, perMinute?, clock?, now? })`，返回以下方法：
    - `view(user, mode?) → MyView`：`mode` 取 `'auto' | 'force' | 'never'`
    - `connect(user, apiKey, { client }) → MyView`
    - `disconnect(user, { client }) → MyView`
    - `refresh(user) → MyView`
    - `enable(user, publishId, { token, loadCapabilities, issue, client }) → PublicationView`
    - `disable(user, publishId, { client }) → MyView`
    - `credentialFor(user, publishId) → { key, rpcUrl, source: 'user' | 'system' } | null`
    - `markInvalid(user, publishId) → void`
- 数据结构：
  - `MyView` = `{ interfaceVersion, connection: { status, nexusUser, preset, connectedAt, refreshedAt, error }, publications: PublicationView[], unpublished: [...], system: [...] }`
  - `PublicationView` = `publicationView` 的全部字段，再加上 `listed`、`card`、`enablement`、`capabilities`。`capabilities` 是缓存的能力清单，前端「按任务」用。这一项是在设计第 12 节「我的视图」之上额外增加的字段，符合「只加不改」。

- [ ] **Step 1：写失败的测试** `test/unit/access-me.test.mjs`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { INTERFACE_VERSION, createMeService } from '../../access/me.mjs';
import { createUserStore } from '../../access/store.mjs';
import { seal } from '../../access/crypto.mjs';

const NEXUS = 'https://nexus.example';
const REVIEWER = { id: 'poc-reviewer', name: '审核员（虚构）' };
const CHECKER = { id: 'poc-checker', name: '复核人（虚构）' };
const GOOD = 'nxa_' + 'g'.repeat(43), OTHER = 'nxa_' + 'o'.repeat(43), API_KEY = 'nxc_' + 'k'.repeat(43);
const ok = json => ({ exitCode: 0, json });
const publication = (id, extra = {}) => ({ publish_id: id, display_name: `发布 ${id}`, description: '虚构', agent_id: `agent_${id}`, effective_agent_id: `agent_${id}`,
  agent_name: `agent ${id}`, status: 'active', owner_name: 'admin', follow_updates: true, current_version: 1, pinned_version: null,
  agent_default_model: 'global.anthropic.claude-sonnet-5', channels: [{ channel: 'a2a', enabled: true, status: 'ready', ready: true, rpc_url: `${NEXUS}/a2a/${id}` }], ...extra });
const CARD = { name: '九安知识Agent（PoC）', description: '审批知识服务', protocolVersion: '0.3', capabilities: { streaming: true }, defaultInputModes: ['text/plain', 'application/pdf'] };
const MANIFEST = { task: 'describe', version: 'knowledge-agent-2026-10-17.2', tasks: [{ name: 'answer', purpose: '问知识库' }] };

function nexusAccount({ connected = false, loginExit = 0, publications = [publication('pub_mine'), publication('pub_paused', { status: 'paused' })],
  agents = [{ agent_id: 'agent_draft', agent_name: 'draft', agent_name_cn: '草稿 Agent', status: 'draft', version: '1', creator_user_id: 'u-1' }] } = {}) {
  const state = { connected, loginExit, publications, agents, calls: [] };
  state.cli = {
    async whoami() { state.calls.push('whoami'); return state.connected ? ok({ ok: true, user: { user_id: 'u-1', name: 'admin', role: 'editor' }, connection: { name: 'andon', preset: 'read_only' } })
      : { exitCode: 3, json: { ok: false, error: { code: 'not_connected' } } }; },
    async login(key) { state.calls.push(['login', key]); if (state.loginExit === 0) state.connected = true; return { exitCode: state.loginExit, json: null }; },
    async logout() { state.calls.push('logout'); state.connected = false; return { exitCode: 0, json: { ok: true } }; },
    async get(pathname) { state.calls.push(['get', pathname]); return pathname === '/api/v2/publications' ? ok({ ok: true, data: { items: state.publications } }) : ok({ ok: true, data: state.agents }); },
  };
  return state;
}

async function setup({ accounts = { 'poc-reviewer': nexusAccount(), 'poc-checker': nexusAccount() }, verify = async ({ key }) => (key === GOOD ? 'valid' : 'invalid'),
  manifest = async () => ({ manifest: MANIFEST, version: MANIFEST.version, error: null }), registryKey = randomBytes(32), root, systemKeys = { pub_5c53e70d8dc7ddea: 'nxa_system' } } = {}) {
  const dir = root ?? await mkdtemp(path.join(tmpdir(), 'poc-me-'));
  let time = 1_000_000;
  const calls = { verify: [], manifest: [], cards: [] };
  const store = createUserStore({ root: dir });
  const me = createMeService({ store, registryKey, nexusOrigin: NEXUS, advisoryPublishId: 'pub_5c53e70d8dc7ddea', clock: () => time, now: () => new Date(time).toISOString(),
    cliFor: async accountId => accounts[accountId].cli,
    keyStore: { ids: () => Object.keys(systemKeys), has: id => Object.hasOwn(systemKeys, id), get: id => systemKeys[id] ?? null },
    fetchCard: async url => { calls.cards.push(url); if (url.includes('pub_paused')) throw Object.assign(new Error('x'), { code: 'POC_CARD_UNAVAILABLE' }); return CARD; },
    verifyKey: async args => { calls.verify.push(args); return verify(args); },
    loadManifest: async args => { calls.manifest.push(args); return manifest(args); } });
  return { me, store, dir, calls, accounts, registryKey, tick: ms => { time += ms; } };
}

test('没连接：视图带接口版本、未连接状态、系统提供的审批 Agent（带名片）', async () => {
  const { me } = await setup();
  const view = await me.view(REVIEWER);
  assert.equal(view.interfaceVersion, INTERFACE_VERSION);
  assert.equal(view.connection.status, 'not_connected');
  assert.deepEqual(view.publications, []);
  assert.deepEqual(view.system.map(item => [item.publishId, item.purpose, item.card.protocolVersion]), [['pub_5c53e70d8dc7ddea', 'advisory', '0.3']]);
  assert.equal(JSON.stringify(view).includes('nxa_system'), false);
});

test('连接：经 CLI 登录、whoami；列出我的发布（带名片）和我未发布的 Agent；记下连接时间与留痕；返回里没有密钥', async () => {
  const { me, store, accounts } = await setup();
  const view = await me.connect(REVIEWER, API_KEY, { client: 'web' });
  assert.deepEqual(accounts['poc-reviewer'].calls.find(call => Array.isArray(call) && call[0] === 'login'), ['login', API_KEY]);
  assert.equal(view.connection.status, 'connected');
  assert.deepEqual(view.connection.nexusUser, { id: 'u-1', name: 'admin', role: 'editor' });
  assert.equal(view.connection.preset, 'read_only');
  assert.ok(view.connection.connectedAt);
  assert.deepEqual(view.publications.map(item => [item.publishId, item.listed, item.card.error, item.enablement]), [['pub_mine', true, null, null], ['pub_paused', true, 'POC_CARD_UNAVAILABLE', null]]);
  assert.deepEqual(view.unpublished.map(item => item.name), ['草稿 Agent']);
  assert.equal(JSON.stringify(view).includes(API_KEY), false);
  assert.deepEqual((await store.readAudit('poc-reviewer')).map(entry => [entry.action, entry.client]), [['connect', 'web']]);
});

test('连接失败：格式不对不调 CLI；CLI 拒绝 → POC_NEXUS_API_KEY_INVALID；平台不可用 → POC_NEXUS_UNREACHABLE', async () => {
  const bad = nexusAccount({ loginExit: 3 }), down = nexusAccount({ loginExit: 8 });
  const { me } = await setup({ accounts: { 'poc-reviewer': bad, 'poc-checker': down } });
  await assert.rejects(me.connect(REVIEWER, 'not-a-key', {}), { code: 'POC_NEXUS_API_KEY_INVALID', status: 400 });
  assert.equal(bad.calls.length, 0);
  await assert.rejects(me.connect(REVIEWER, API_KEY, {}), { code: 'POC_NEXUS_API_KEY_INVALID', status: 400 });
  await assert.rejects(me.connect(CHECKER, API_KEY, {}), { code: 'POC_NEXUS_UNREACHABLE', status: 502 });
});

test('已经连上之后用无效的 API 密钥重连：400，原来的连接保持（Review Focus 3）', async () => {
  const account = nexusAccount();
  const { me } = await setup({ accounts: { 'poc-reviewer': account, 'poc-checker': nexusAccount() } });
  await me.connect(REVIEWER, API_KEY, {});
  account.loginExit = 3;
  await assert.rejects(me.connect(REVIEWER, 'nxc_' + 'u'.repeat(43), {}), { code: 'POC_NEXUS_API_KEY_INVALID' });
  assert.equal((await me.view(REVIEWER)).connection.status, 'connected');
});

test('列表 60 秒内直接用快照；超过 60 秒或 refresh 时重读；没连接时 refresh 是 409', async () => {
  const { me, accounts, tick } = await setup();
  await assert.rejects(me.refresh(REVIEWER), { code: 'POC_NEXUS_NOT_CONNECTED', status: 409 });
  await me.connect(REVIEWER, API_KEY, {});
  const count = () => accounts['poc-reviewer'].calls.filter(call => call === 'whoami').length;
  const before = count();
  await me.view(REVIEWER);
  assert.equal(count(), before);
  tick(61_000);
  await me.view(REVIEWER);
  assert.equal(count(), before + 1);
  await me.refresh(REVIEWER);
  assert.equal(count(), before + 2);
});

test('启用：发布在我的列表里 → 读名片 → tasks/get 验证 → 加密保存（文件里没有明文）→ 读能力清单；视图里是已启用，带指纹和能力清单', async () => {
  const { me, dir, calls, store } = await setup();
  await me.connect(REVIEWER, API_KEY, {});
  const view = await me.enable(REVIEWER, 'pub_mine', { token: ` ${GOOD} `, client: 'claude_code' });
  assert.equal(calls.verify[0].url, `${NEXUS}/a2a/pub_mine`);
  assert.equal(calls.verify[0].key, GOOD);
  assert.equal(calls.manifest.length, 1);
  assert.equal(view.enablement.status, 'active');
  assert.match(view.enablement.fingerprint, /^[0-9a-f]{8}$/);
  assert.equal(view.enablement.capabilitiesVersion, MANIFEST.version);
  assert.deepEqual(view.capabilities, MANIFEST);
  const file = await readFile(path.join(dir, 'poc-reviewer', 'enabled.json'), 'utf8');
  assert.equal(file.includes(GOOD), false);
  assert.equal(JSON.stringify(view).includes(GOOD), false);
  assert.deepEqual((await store.readAudit('poc-reviewer')).map(entry => entry.action), ['connect', 'enable']);
  assert.equal((await store.readAudit('poc-reviewer'))[1].client, 'claude_code');
});

test('启用失败：没连接、不在我的列表、名片读不到、密钥格式不对、密钥被拒、issue、从没启用又不带密钥', async () => {
  const { me, calls } = await setup();
  await assert.rejects(me.enable(REVIEWER, 'pub_mine', { token: GOOD }), { code: 'POC_NEXUS_NOT_CONNECTED', status: 409 });
  await me.connect(REVIEWER, API_KEY, {});
  await assert.rejects(me.enable(REVIEWER, 'pub_elsewhere', { token: GOOD }), { code: 'POC_PUBLICATION_NOT_MINE', status: 404 });
  await assert.rejects(me.enable(REVIEWER, 'pub_paused', { token: GOOD }), { code: 'POC_CARD_UNAVAILABLE', status: 409 });
  await assert.rejects(me.enable(REVIEWER, 'pub_mine', { token: 'nxa_short' }), { code: 'POC_CALL_KEY_INVALID', status: 400 });
  assert.equal(calls.verify.length, 0);
  await assert.rejects(me.enable(CHECKER, 'pub_mine', { issue: true }), { code: 'POC_ISSUE_NOT_ALLOWED', status: 403 });
  await me.connect(CHECKER, API_KEY, {});
  await assert.rejects(me.enable(CHECKER, 'pub_mine', { token: OTHER }), { code: 'POC_CALL_KEY_INVALID', status: 400 });
  await assert.rejects(me.enable(CHECKER, 'pub_mine', {}), { code: 'POC_AGENT_NOT_ENABLED', status: 409 });
  assert.equal((await me.view(CHECKER)).publications[0].enablement, null);
});

test('不带密钥再启用：用已保存的那把重新验证、刷新能力清单；loadCapabilities=false 不读；换新密钥失败时旧的保留', async () => {
  const { me, calls, store } = await setup();
  await me.connect(REVIEWER, API_KEY, {});
  const first = await me.enable(REVIEWER, 'pub_mine', { token: GOOD });
  await me.enable(REVIEWER, 'pub_mine', {});
  assert.equal(calls.verify[1].key, GOOD);
  assert.equal(calls.manifest.length, 2);
  await me.enable(REVIEWER, 'pub_mine', { loadCapabilities: false });
  assert.equal(calls.manifest.length, 2);
  await assert.rejects(me.enable(REVIEWER, 'pub_mine', { token: OTHER }), { code: 'POC_CALL_KEY_INVALID' });
  assert.equal((await me.view(REVIEWER)).publications[0].enablement.fingerprint, first.enablement.fingerprint);
  assert.deepEqual((await store.readAudit('poc-reviewer')).map(entry => entry.action), ['connect', 'enable', 'reverify', 'reverify']);
});

test('停用：删掉这一项，可以重复调用；留痕', async () => {
  const { me, store } = await setup();
  await me.connect(REVIEWER, API_KEY, {});
  await me.enable(REVIEWER, 'pub_mine', { token: GOOD });
  assert.equal((await me.disable(REVIEWER, 'pub_mine', { client: 'web' })).publications[0].enablement, null);
  await me.disable(REVIEWER, 'pub_mine', {});
  assert.deepEqual((await store.readAudit('poc-reviewer')).map(entry => entry.action), ['connect', 'enable', 'disable']);
});

test('credentialFor：先找我启用的，再找系统提供的，都没有返回 null；markInvalid 后不再用我的', async () => {
  const { me } = await setup({ systemKeys: { pub_5c53e70d8dc7ddea: 'nxa_system', pub_mine: 'nxa_system_mine' } });
  await me.connect(REVIEWER, API_KEY, {});
  await me.enable(REVIEWER, 'pub_mine', { token: GOOD });
  assert.deepEqual(await me.credentialFor(REVIEWER, 'pub_mine'), { key: GOOD, rpcUrl: `${NEXUS}/a2a/pub_mine`, source: 'user' });
  assert.deepEqual(await me.credentialFor(CHECKER, 'pub_mine'), { key: 'nxa_system_mine', rpcUrl: `${NEXUS}/a2a/pub_mine`, source: 'system' });
  assert.equal(await me.credentialFor(CHECKER, 'pub_unknown'), null);
  await me.markInvalid(REVIEWER, 'pub_mine');
  assert.equal((await me.view(REVIEWER)).publications[0].enablement.status, 'key_invalid');
  assert.equal((await me.credentialFor(REVIEWER, 'pub_mine')).source, 'system');
});

test('REGISTRY_KEY 换了：解不开的启用显示为密钥失效，调用时不再给出，服务不崩（Review Focus 5）', async () => {
  const setupA = await setup();
  await setupA.me.connect(REVIEWER, API_KEY, {});
  await setupA.me.enable(REVIEWER, 'pub_mine', { token: GOOD });
  const setupB = await setup({ root: setupA.dir, registryKey: randomBytes(32), accounts: setupA.accounts });
  assert.equal((await setupB.me.view(REVIEWER)).publications[0].enablement.status, 'key_invalid');
  assert.equal(await setupB.me.credentialFor(REVIEWER, 'pub_mine'), null);
});

test('重启（新的服务实例、同一个目录）：连接时间和启用都还在，不用重新粘贴（Review Focus 2）', async () => {
  const first = await setup();
  await first.me.connect(REVIEWER, API_KEY, {});
  await first.me.enable(REVIEWER, 'pub_mine', { token: GOOD });
  const second = await setup({ root: first.dir, registryKey: first.registryKey, accounts: first.accounts });
  const view = await second.me.view(REVIEWER);
  assert.equal(view.connection.status, 'connected');
  assert.ok(view.connection.connectedAt);
  assert.equal(view.publications[0].enablement.status, 'active');
  assert.equal((await second.me.credentialFor(REVIEWER, 'pub_mine')).key, GOOD);
});

test('断开：调 CLI logout，清掉连接记录；已启用的 Agent 仍列出（listed=false）并可调用', async () => {
  const { me, accounts, store } = await setup();
  await me.connect(REVIEWER, API_KEY, {});
  await me.enable(REVIEWER, 'pub_mine', { token: GOOD });
  const view = await me.disconnect(REVIEWER, { client: 'web' });
  assert.ok(accounts['poc-reviewer'].calls.includes('logout'));
  assert.equal(view.connection.status, 'not_connected');
  assert.equal(view.connection.connectedAt, null);
  assert.deepEqual(view.publications.map(item => [item.publishId, item.listed, item.enablement.status]), [['pub_mine', false, 'active']]);
  assert.equal((await me.credentialFor(REVIEWER, 'pub_mine')).source, 'user');
  assert.deepEqual((await store.readAudit('poc-reviewer')).map(entry => entry.action), ['connect', 'enable', 'disconnect']);
});

test('用户之间隔离：A 启用的，B 看不到、用不了', async () => {
  const { me } = await setup();
  await me.connect(REVIEWER, API_KEY, {});
  await me.connect(CHECKER, API_KEY, {});
  await me.enable(REVIEWER, 'pub_mine', { token: GOOD });
  assert.equal((await me.view(CHECKER)).publications.find(item => item.publishId === 'pub_mine').enablement, null);
  assert.equal(await me.credentialFor(CHECKER, 'pub_mine'), null);
});

test('连接与启用合计每个账号每分钟 5 次；第 6 次 429；过了一分钟恢复', async () => {
  const { me, tick } = await setup();
  for (let index = 0; index < 5; index += 1) await me.connect(REVIEWER, API_KEY, {});
  await assert.rejects(me.enable(REVIEWER, 'pub_mine', { token: GOOD }), { code: 'POC_ME_RATE_LIMIT', status: 429 });
  tick(60_001);
  assert.equal((await me.enable(REVIEWER, 'pub_mine', { token: GOOD })).enablement.status, 'active');
});

test('发布版本变了：已启用的那一项标出 versionChanged', async () => {
  const account = nexusAccount();
  const { me } = await setup({ accounts: { 'poc-reviewer': account, 'poc-checker': nexusAccount() } });
  await me.connect(REVIEWER, API_KEY, {});
  await me.enable(REVIEWER, 'pub_mine', { token: GOOD });
  account.publications = [publication('pub_mine', { current_version: 2 })];
  assert.equal((await me.view(REVIEWER, 'force')).publications[0].enablement.versionChanged, true);
});
```

`catalog.test.mjs` 改写如下：
- 删掉所有调用 `createNexusCatalog` 的测试，以及 `fakeCli`、`keys`、`configuredKeys`、`logins` 这几个辅助函数；
- import 改成 `import { cardView, fetchAgentCard, publicationView } from '../../nexus/catalog.mjs';`；
- 保留 `fetchAgentCard` 那个测试；
- 新增下面两个测试：

```js
test('publicationView：调用地址只认 Nexus 同源；名称回落；认不出的条目返回 null', () => {
  const view = publicationView(publication('pub_elsewhere', { channels: [{ channel: 'a2a', enabled: true, ready: true, rpc_url: 'https://evil.example/a2a/pub_elsewhere' }] }), NEXUS);
  assert.equal(view.a2a.rpcUrl, `${NEXUS}/a2a/pub_elsewhere`);
  assert.equal(publicationView(publication('pub_x', { display_name: '' }), NEXUS).displayName, 'agent pub_x');
  assert.equal(publicationView({ nope: true }, NEXUS), null);
  assert.equal(publicationView(publication('pub_active'), NEXUS).a2a.ready, true);
});

test('cardView：认不出的字段丢掉，字符串截短，类型列表只留字符串', () => {
  const card = cardView({ name: 'x'.repeat(500), description: 42, protocolVersion: { evil: true }, capabilities: 'yes', skills: 'ask',
    defaultInputModes: ['text/plain', 7, null, 'y'.repeat(300)], extra: 'drop me' });
  assert.equal(card.name.length, 200);
  assert.deepEqual([card.description, card.protocolVersion, card.streaming, card.skills, card.inputModes, card.extra], ['', null, false, [], ['text/plain'], undefined]);
  assert.equal(cardView(CARD).protocolVersion, '0.3');
});
```

文件里原有的 `NEXUS`、`publication`、`CARD` 三个辅助常量和函数保留。

- [ ] **Step 2：运行，确认失败**

运行：`node --test test/unit/access-me.test.mjs test/unit/catalog.test.mjs`
预期：access-me 报 `ERR_MODULE_NOT_FOUND`。catalog 在改写后应该已经通过（它只测保留下来的三个函数）。

- [ ] **Step 3：实现** `access/me.mjs`

```js
/**
 * 「我的 Nexus」（接口约定 agent-access-v1）：每个应用账号用自己的 API 密钥连接 Nexus，列出自己的发布与还没发布的 Agent，
 * 自己粘贴调用密钥启用要用的 Agent。
 * - 列表经 operator CLI 读 REST（每个账号一个 CLI 凭证目录）；列表超过 staleMs 先刷新。名片经 A2A 公开读取，缓存 cardTtlMs，所有账号共用。
 * - 启用：发布在我的列表里 → 同源 → 名片读得到 → tasks/get 证明密钥有效（不花钱）→ 加密保存 → 默认读能力清单。
 * - 系统提供的 Agent：secrets.env 里 NEXUS_A2A_KEY_<发布编号> 对应的发布（审批流在用的那个），所有人可见、不用启用。
 * 返回里一律不含密钥；密钥只以指纹（sha256 前 8 位）出现。
 */
import { fail } from '../http.mjs';
import { cardView, publicationView } from '../nexus/catalog.mjs';
import { fingerprint, open, seal } from './crypto.mjs';

export const INTERFACE_VERSION = 'agent-access-v1';
const PUBLISH_ID = /^pub_[A-Za-z0-9_-]{4,80}$/;
const API_KEY = /^nxc_[A-Za-z0-9_-]{16,200}$/;
const CALL_KEY = /^nxa_[A-Za-z0-9_-]{16,200}$/;
const CLIENTS = new Set(['web', 'claude_code', 'codex', 'kiro', 'cli', 'other']);
const clientOf = client => (CLIENTS.has(client) ? client : 'web');
const codeOf = (error, fallback) => (typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,60}$/.test(error.code) ? error.code : fallback);
const sameOrigin = (url, origin) => { try { return new URL(url).origin === origin; } catch { return false; } };
const unpublishedView = agent => ({ agentId: agent.agent_id, name: agent.agent_name_cn || agent.agent_name || agent.agent_id, status: agent.status ?? null,
  version: agent.version ?? null, createdAt: agent.created_at ?? null });

export function createMeService({ store, cliFor, registryKey, keyStore, fetchCard, verifyKey, loadManifest, nexusOrigin, advisoryPublishId,
  staleMs = 60_000, cardTtlMs = 60_000, perMinute = 5, clock = Date.now, now = () => new Date().toISOString() }) {
  const origin = new URL(nexusOrigin).origin;
  const snapshots = new Map(), pending = new Map(), cards = new Map(), windows = new Map();
  const rpcUrlOf = publishId => `${origin}/a2a/${publishId}`;
  const readable = item => { try { return open(registryKey, item?.credential?.cipher); } catch { return null; } };

  function limit(accountId) {
    const at = clock(), entry = windows.get(accountId);
    const current = entry && entry.until > at ? entry : { until: at + 60_000, count: 0 };
    if (current.count >= perMinute) fail('POC_ME_RATE_LIMIT', 429);
    current.count += 1;
    windows.set(accountId, current);
  }

  async function cardFor(publishId, rpcUrl, { fresh = false } = {}) {
    const hit = cards.get(publishId);
    if (!fresh && hit && clock() - hit.at < cardTtlMs) return hit.card;
    let card;
    try { card = { ...cardView(await fetchCard(`${rpcUrl}/.well-known/agent-card.json`)), error: null }; }
    catch (error) { card = { ...cardView(null), error: codeOf(error, 'POC_CARD_UNAVAILABLE') }; }
    cards.set(publishId, { card, at: clock() });
    return card;
  }

  const empty = (status, error = null, extra = {}) => ({ status, nexusUser: null, preset: null, refreshedAt: clock(), error, publications: [], unpublished: [], ...extra });
  async function load(accountId) {
    const cli = await cliFor(accountId);
    const who = await cli.whoami();
    if (who.exitCode === 3) return empty('not_connected');
    if (who.exitCode !== 0) return empty('error', who.json?.error?.code ?? 'POC_NEXUS_UNREACHABLE');
    const nexusUser = { id: who.json?.user?.user_id ?? null, name: who.json?.user?.name ?? null, role: who.json?.user?.role ?? null };
    const preset = who.json?.connection?.preset ?? null;
    const [publications, agents] = await Promise.all([cli.get('/api/v2/publications'), cli.get('/api/v2/agents', { limit: 100 })]);
    if (publications.exitCode !== 0) return empty('error', publications.json?.error?.code ?? 'POC_NEXUS_UNREACHABLE', { nexusUser, preset });
    const views = (Array.isArray(publications.json?.data?.items) ? publications.json.data.items : []).map(item => publicationView(item, origin)).filter(Boolean);
    await Promise.all(views.map(async view => { view.card = await cardFor(view.publishId, view.a2a.rpcUrl); }));
    const rows = agents.exitCode === 0 && Array.isArray(agents.json?.data)
      ? agents.json.data.filter(agent => agent && typeof agent === 'object' && typeof agent.agent_id === 'string') : [];
    const published = new Set(views.flatMap(view => [view.agentId, view.effectiveAgentId]).filter(Boolean));
    const unpublished = rows.filter(agent => nexusUser.id && agent.creator_user_id === nexusUser.id && !published.has(agent.agent_id)).map(unpublishedView);
    return { status: 'connected', nexusUser, preset, refreshedAt: clock(), error: null, publications: views, unpublished };
  }
  function refreshSnapshot(accountId) {
    if (!pending.has(accountId)) {
      pending.set(accountId, load(accountId)
        .catch(() => empty('error', 'POC_NEXUS_UNREACHABLE'))
        .then(next => { snapshots.set(accountId, next); return next; })
        .finally(() => pending.delete(accountId)));
    }
    return pending.get(accountId);
  }
  async function snapshot(accountId, mode = 'auto') {
    const current = snapshots.get(accountId);
    if (mode === 'force' || !current || (mode === 'auto' && clock() - current.refreshedAt > staleMs)) return refreshSnapshot(accountId);
    return current;
  }

  function enablementView(item, publication) {
    if (!item) return null;
    return { status: readable(item) ? item.status : 'key_invalid', fingerprint: item.credential?.fingerprint ?? null, verifiedAt: item.credential?.verifiedAt ?? null,
      capabilitiesVersion: item.capabilities?.version ?? null, enabledAt: item.enabledAt ?? null,
      versionChanged: publication?.version != null && item.publicationVersion != null && publication.version !== item.publicationVersion };
  }
  async function systemView() {
    return Promise.all(keyStore.ids().map(async publishId => {
      const card = await cardFor(publishId, rpcUrlOf(publishId));
      return { publishId, displayName: card.name || publishId, description: card.description || '', purpose: publishId === advisoryPublishId ? 'advisory' : 'general',
        a2a: { rpcUrl: rpcUrlOf(publishId) }, card };
    }));
  }

  async function view(user, mode = 'auto') {
    const accountId = user.id;
    const [snap, items, connection, system] = await Promise.all([snapshot(accountId, mode), store.list(accountId), store.readConnection(accountId), systemView()]);
    const byId = new Map(items.map(item => [item.publishId, item]));
    const publications = snap.publications.map(publication => ({ ...publication, listed: true, enablement: enablementView(byId.get(publication.publishId), publication),
      capabilities: byId.get(publication.publishId)?.capabilities?.manifest ?? null }));
    for (const item of items) {
      if (publications.some(publication => publication.publishId === item.publishId)) continue;
      publications.push({ publishId: item.publishId, displayName: item.displayName, description: '', status: 'unverified', version: null, followUpdates: null, model: null,
        a2a: { enabled: null, ready: null, status: null, rpcUrl: rpcUrlOf(item.publishId) }, card: null, listed: false,
        enablement: enablementView(item, null), capabilities: item.capabilities?.manifest ?? null });
    }
    return { interfaceVersion: INTERFACE_VERSION,
      connection: { status: snap.status, nexusUser: snap.nexusUser, preset: snap.preset, connectedAt: snap.status === 'connected' ? connection?.connectedAt ?? null : null,
        refreshedAt: new Date(snap.refreshedAt).toISOString(), error: snap.error },
      publications, unpublished: snap.unpublished, system };
  }

  async function connect(user, apiKey, { client } = {}) {
    limit(user.id);
    const key = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (!API_KEY.test(key)) fail('POC_NEXUS_API_KEY_INVALID', 400);
    const result = await (await cliFor(user.id)).login(key);
    if (result.exitCode === 8) fail('POC_NEXUS_UNREACHABLE', 502);
    if (result.exitCode !== 0) fail('POC_NEXUS_API_KEY_INVALID', 400);
    const snap = await snapshot(user.id, 'force');
    if (snap.status !== 'connected') fail('POC_NEXUS_UNREACHABLE', 502);
    await store.saveConnection(user.id, { connectedAt: now(), nexusUser: snap.nexusUser });
    await store.audit(user.id, { action: 'connect', client: clientOf(client), nexusUser: snap.nexusUser?.name ?? null });
    return view(user, 'never');
  }

  async function disconnect(user, { client } = {}) {
    await (await cliFor(user.id)).logout().catch(() => null);
    snapshots.delete(user.id);
    await store.clearConnection(user.id);
    await store.audit(user.id, { action: 'disconnect', client: clientOf(client) });
    return view(user, 'auto');
  }

  async function refresh(user) {
    const snap = await snapshot(user.id, 'force');
    if (snap.status === 'not_connected') fail('POC_NEXUS_NOT_CONNECTED', 409);
    return view(user, 'never');
  }

  async function enable(user, publishId, { token, loadCapabilities = true, issue, client } = {}) {
    if (typeof publishId !== 'string' || !PUBLISH_ID.test(publishId)) fail('NOT_FOUND', 404);
    if (issue !== undefined && issue !== false) fail('POC_ISSUE_NOT_ALLOWED', 403);
    if ((token !== undefined && typeof token !== 'string') || typeof loadCapabilities !== 'boolean') fail('INVALID_REQUEST', 400);
    limit(user.id);
    const snap = await snapshot(user.id, 'auto');
    if (snap.status !== 'connected') fail('POC_NEXUS_NOT_CONNECTED', 409);
    const publication = snap.publications.find(item => item.publishId === publishId);
    if (!publication) fail('POC_PUBLICATION_NOT_MINE', 404);
    const existing = await store.get(user.id, publishId);
    let key;
    if (token === undefined) {
      if (!existing) fail('POC_AGENT_NOT_ENABLED', 409);
      key = readable(existing);
      if (!key) fail('POC_CALL_KEY_INVALID', 400);
    } else {
      key = token.trim();
      if (!CALL_KEY.test(key)) fail('POC_CALL_KEY_INVALID', 400);
    }
    if (!sameOrigin(publication.a2a.rpcUrl, origin)) fail('POC_CARD_UNAVAILABLE', 409);
    const card = await cardFor(publishId, publication.a2a.rpcUrl, { fresh: true });
    if (card.error) fail('POC_CARD_UNAVAILABLE', 409);
    if (await verifyKey({ url: publication.a2a.rpcUrl, key }) !== 'valid') {
      if (token === undefined) await store.update(user.id, publishId, { status: 'key_invalid', updatedAt: now() });
      fail('POC_CALL_KEY_INVALID', 400);
    }
    const capabilities = loadCapabilities ? { ...(await loadManifest({ url: publication.a2a.rpcUrl, key })), fetchedAt: now() } : existing?.capabilities ?? null;
    const stamp = now();
    const item = { publishId, displayName: publication.displayName, credential: { cipher: seal(registryKey, key), fingerprint: fingerprint(key), verifiedAt: stamp },
      capabilities, publicationVersion: publication.version ?? null, status: 'active', enabledAt: existing?.enabledAt ?? stamp, updatedAt: stamp };
    await store.put(user.id, item);
    await store.audit(user.id, { action: !existing ? 'enable' : token === undefined || fingerprint(key) === existing.credential?.fingerprint ? 'reverify' : 'replace_key',
      publishId, fingerprint: item.credential.fingerprint, client: clientOf(client) });
    return (await view(user, 'never')).publications.find(entry => entry.publishId === publishId);
  }

  async function disable(user, publishId, { client } = {}) {
    if (typeof publishId !== 'string' || !PUBLISH_ID.test(publishId)) fail('NOT_FOUND', 404);
    if (await store.remove(user.id, publishId)) await store.audit(user.id, { action: 'disable', publishId, client: clientOf(client) });
    return view(user, 'never');
  }

  async function credentialFor(user, publishId) {
    const item = await store.get(user.id, publishId);
    const key = item?.status === 'active' ? readable(item) : null;
    if (key) return { key, rpcUrl: rpcUrlOf(publishId), source: 'user' };
    if (keyStore.has(publishId)) return { key: keyStore.get(publishId), rpcUrl: rpcUrlOf(publishId), source: 'system' };
    return null;
  }

  async function markInvalid(user, publishId) {
    if (await store.update(user.id, publishId, { status: 'key_invalid', updatedAt: now() })) await store.audit(user.id, { action: 'key_invalid', publishId });
  }

  return { view, connect, disconnect, refresh, enable, disable, credentialFor, markInvalid };
}
```

关于留痕：用同一把密钥重新启用（包括不带密钥的情况）记成 `reverify`，换了不同的密钥才记成 `replace_key`。上面「不带密钥再启用」那个测试，期望的就是 `['connect', 'enable', 'reverify', 'reverify']`。

`catalog.mjs` 的改法：
- 删掉 `createNexusCatalog`，以及 `sha256`、`invocable`、`cliError`、`agentView`、`createHash` 的 import；
- 保留 `sameOrigin`、`clip`、`cardError`、`publicationView`、`cardView`、`fetchAgentCard`；
- 文件头注释改成：「Nexus 发布与 A2A 名片的规整：publicationView（REST 返回的发布 → 页面要用的字段；调用地址只认 Nexus 同源）、cardView（名片里认得出的几项）、fetchAgentCard（读公开名片）。」

- [ ] **Step 4：运行，确认通过**

运行：`node --test test/unit/access-me.test.mjs test/unit/catalog.test.mjs`
预期：全部通过。

---

### Task 5：接口、调用测试、运行记录与服务组装

**Files:**
- Create: `poc/app/access/routes.mjs`
- Modify: `poc/app/nexus/invoke.mjs`（整个 `createInvoker`）
- Modify: `poc/app/nexus/routes.mjs`
- Modify: `poc/app/config.mjs`
- Modify: `poc/app/server.mjs`
- Test: `poc/app/test/unit/access-routes.test.mjs`（新）
- Test: `poc/app/test/unit/nexus-routes.test.mjs`（`setup` 与相关用例改写）
- Test: `poc/app/test/unit/server.test.mjs`

**Interfaces:**
- Consumes：任务 4 的 `createMeService` 及其方法。
- Produces：
  - `meRoutes({ me })`：platformRoutes 插件
  - `createInvoker({ resolve, onAuthInvalid, runLog, registry, store, tenantId, governanceEnv, perMinute?, … })`
  - `nexusRoutes({ me, runLog, governanceEnv, perMinute?, samples? })`
  - `main({ env, log, fetchCard?, verifyKey?, describe?, cliFor? }) → { app, me, keyStore, stop }`
  - 新增接口 `GET /poc/nexus/attachment-policy` → `{ attachmentPolicy }`
  - 运行记录多记两项：`actorId`、`credentialSource`

- [ ] **Step 1：写失败的测试**

新建 `access-routes.test.mjs`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { meRoutes } from '../../access/routes.mjs';
import { createMeService } from '../../access/me.mjs';
import { createUserStore } from '../../access/store.mjs';
import { PASSWORDS, startApp } from './helpers/app.mjs';

const NEXUS = 'https://nexus.example', GOOD = 'nxa_' + 'g'.repeat(43), API_KEY = 'nxc_' + 'k'.repeat(43);
const ok = json => ({ exitCode: 0, json });
function cli() {
  const state = { connected: false };
  return { async whoami() { return state.connected ? ok({ user: { user_id: 'u-1', name: 'admin', role: 'editor' }, connection: { preset: 'read_only' } }) : { exitCode: 3, json: null }; },
    async login() { state.connected = true; return { exitCode: 0, json: null }; }, async logout() { state.connected = false; return { exitCode: 0, json: null }; },
    async get(pathname) { return pathname === '/api/v2/publications' ? ok({ data: { items: [{ publish_id: 'pub_mine', display_name: '我的 Agent', status: 'active', current_version: 1,
      channels: [{ channel: 'a2a', enabled: true, ready: true, rpc_url: `${NEXUS}/a2a/pub_mine` }] }] } }) : ok({ data: [] }); } };
}

async function setup(t) {
  const clis = { 'poc-reviewer': cli(), 'poc-checker': cli() };
  const me = createMeService({ store: createUserStore({ root: await mkdtemp(path.join(tmpdir(), 'poc-me-routes-')) }), registryKey: randomBytes(32), nexusOrigin: NEXUS,
    advisoryPublishId: 'pub_5c53e70d8dc7ddea', cliFor: async id => clis[id], keyStore: { ids: () => [], has: () => false, get: () => null },
    fetchCard: async () => ({ name: '我的 Agent', protocolVersion: '0.3' }), verifyKey: async ({ key }) => (key === GOOD ? 'valid' : 'invalid'),
    loadManifest: async () => ({ manifest: null, version: null, error: 'POC_NOT_A_MANIFEST' }) });
  const env = await startApp(t, { plugins: [meRoutes({ me })] });
  const reviewer = env.client(), checker = env.client();
  await reviewer.login('poc-reviewer', PASSWORDS.get('poc-reviewer'));
  await checker.login('poc-checker', PASSWORDS.get('poc-checker'));
  return { ...env, reviewer, checker };
}
const post = (http, route, body) => http.api(`/poc/nexus/me${route}`, { method: 'POST', body });

test('没登录是 401；GET /me 返回接口版本与未连接', async t => {
  const { client, reviewer } = await setup(t);
  assert.equal((await client().api('/poc/nexus/me')).status, 401);
  const view = await reviewer.api('/poc/nexus/me');
  assert.equal(view.status, 200);
  assert.equal(view.body.data.interfaceVersion, 'agent-access-v1');
  assert.equal(view.body.data.connection.status, 'not_connected');
});

test('连接 → 启用 → 停用：返回里没有任何密钥；复核人看不到审核员启用的', async t => {
  const { reviewer, checker } = await setup(t);
  const connected = await post(reviewer, '/connect', { apiKey: API_KEY, client: 'web' });
  assert.equal(connected.body.data.connection.status, 'connected');
  const enabled = await post(reviewer, '/agents/pub_mine/enable', { token: GOOD, loadCapabilities: false, client: 'web' });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.data.enablement.status, 'active');
  assert.equal(enabled.text.includes(GOOD) || connected.text.includes(API_KEY), false);
  await post(checker, '/connect', { apiKey: API_KEY });
  assert.equal((await checker.api('/poc/nexus/me')).body.data.publications[0].enablement, null);
  assert.equal((await post(reviewer, '/agents/pub_mine/disable', {})).body.data.publications[0].enablement, null);
});

test('错误码与状态：多余字段 400；密钥被拒 400；不在列表 404；未知子路径 404；请求体过大 413', async t => {
  const { reviewer } = await setup(t);
  assert.equal((await post(reviewer, '/connect', { apiKey: API_KEY, extra: 1 })).status, 400);
  assert.equal((await post(reviewer, '/refresh', {})).body.error.code, 'POC_NEXUS_NOT_CONNECTED');
  await post(reviewer, '/connect', { apiKey: API_KEY });
  const rejected = await post(reviewer, '/agents/pub_mine/enable', { token: 'nxa_' + 'b'.repeat(43) });
  assert.deepEqual([rejected.status, rejected.body.error.code], [400, 'POC_CALL_KEY_INVALID']);
  assert.deepEqual([(await post(reviewer, '/agents/pub_other/enable', { token: GOOD })).status], [404]);
  assert.equal((await post(reviewer, '/agents/pub_mine/frobnicate', {})).status, 404);
  assert.equal((await post(reviewer, '/connect', { apiKey: 'x'.repeat(6000) })).status, 413);   // 超出上限不到一倍：读完再回 413
});

test('POST 没带 CSRF 令牌：九安拒绝（403），不会走到连接', async t => {
  const { reviewer } = await setup(t);
  const response = await reviewer.http('/api/analysis/v1/poc/nexus/me/connect', { method: 'POST', body: { apiKey: API_KEY }, headers: { 'X-CSRF-Token': '' } });
  assert.equal(response.status, 403);
});
```

改写 `nexus-routes.test.mjs` 的 `setup`，把 catalog 和 keyStore 换成一个 `me` 桩：

```js
async function setup(t, { source = 'user', enabled = true, answer = JSON.stringify(advisoryResult()), samples, handler } = {}) {
  const fake = await startFakeA2a(handler ?? (({ res }) => writeEvents(res, answerEvents(answer))));
  t.after(() => fake.close());
  const invalid = [];
  const me = { credentialFor: async (user, id) => (enabled && id === 'pub_test' ? { key: `nxa_${source}_key`, rpcUrl: fake.url, source } : null),
    markInvalid: async (user, id) => { invalid.push([user.id, id]); } };
  const runLog = createRunLog();
  const env = await startApp(t, { plugins: [nexusRoutes({ me, runLog, governanceEnv: governanceEnv(), ...(samples ? { samples } : {}) })] });
  const http = env.client();
  await http.login('poc-reviewer', PASSWORDS.get('poc-reviewer'));
  return { ...env, fake, http, runLog, invalid };
}
```

- 原来的「没有调用密钥、或发布不能调用：409，不发请求」改成：

```js
test('没启用、也不是系统提供：409 POC_AGENT_NOT_ENABLED，不发请求', async t => {
  const { http, fake } = await setup(t, { enabled: false });
  const response = await invoke(http, { publishId: 'pub_test', mode: 'text', text: 'x' });
  assert.deepEqual([response.status, response.body.error.code], [409, 'POC_AGENT_NOT_ENABLED']);
  assert.equal(fake.requests.length, 0);
});
```

- 「Agent 列表、刷新与运行记录列表」改成「运行记录列表与附件规则」：删掉对 `/poc/nexus/agents` 和 `/poc/nexus/refresh` 的断言，改为断言 `GET /poc/nexus/attachment-policy` 返回的 `data.attachmentPolicy.maxFiles` 等于 5。
- 「只在本机配置……」那个测试删掉。
- 「Agent 列表带上附件规则……」改成访问 `/poc/nexus/attachment-policy`。
- 追加下面三个测试：

```js
test('用我启用的调用密钥调用；记下 actorId 与来源；系统提供的用系统密钥', async t => {
  const mine = await setup(t, { source: 'user', answer: 'OK' });
  const run = await finished(mine.http, (await invoke(mine.http, { publishId: 'pub_test', mode: 'text', text: 'x' })).body.data.runId);
  assert.equal(mine.fake.requests[0].headers.authorization, 'Bearer nxa_user_key');
  assert.deepEqual([run.actorId, run.credentialSource], ['poc-reviewer', 'user']);
  const system = await setup(t, { source: 'system', answer: 'OK' });
  await finished(system.http, (await invoke(system.http, { publishId: 'pub_test', mode: 'text', text: 'x' })).body.data.runId);
  assert.equal(system.fake.requests[0].headers.authorization, 'Bearer nxa_system_key');
});

test('调用时 Nexus 回 401：把我的启用标成密钥失效；回 404（例如发布暂停）不标（Review Focus 4）；系统密钥不标', async t => {
  const reject = status => ({ res }) => rejectJson(res, status, status === 401 ? 'credential_invalid' : 'publication_not_found');
  const unauthorized = await setup(t, { handler: reject(401) });
  await finished(unauthorized.http, (await invoke(unauthorized.http, { publishId: 'pub_test', mode: 'text', text: 'x' })).body.data.runId);
  await waitUntil(() => unauthorized.invalid.length === 1);
  assert.deepEqual(unauthorized.invalid, [['poc-reviewer', 'pub_test']]);
  const paused = await setup(t, { handler: reject(404) });
  await finished(paused.http, (await invoke(paused.http, { publishId: 'pub_test', mode: 'text', text: 'x' })).body.data.runId);
  assert.deepEqual(paused.invalid, []);
  const system = await setup(t, { source: 'system', handler: reject(401) });
  await finished(system.http, (await invoke(system.http, { publishId: 'pub_test', mode: 'text', text: 'x' })).body.data.runId);
  assert.deepEqual(system.invalid, []);
});

test('运行记录按账号过滤：复核人看不到审核员的调用测试（列表与单条都是）', async t => {
  const { http, client } = await setup(t, { answer: 'OK' });
  const runId = (await invoke(http, { publishId: 'pub_test', mode: 'text', text: 'x' })).body.data.runId;
  await finished(http, runId);
  const checker = client();
  await checker.login('poc-checker', PASSWORDS.get('poc-checker'));
  assert.deepEqual((await checker.api('/poc/nexus/runs?limit=5')).body.data.items, []);
  assert.equal((await checker.api(`/poc/nexus/runs/${runId}`)).status, 404);
  assert.equal((await http.api('/poc/nexus/runs?limit=5')).body.data.items.length, 1);
});
```

`nexus-routes.test.mjs` 文件开头的 import 里加上 `rejectJson`（来自 `./helpers/fake-a2a.mjs`）。

`server.test.mjs` 要改的地方：
- `environment()` 增加两项：`POC_USERS_DIR`（一个临时目录），以及往 secrets 文本里加一行合法的 `REGISTRY_KEY=<randomBytes(32) 的 base64>`；
- 去掉 `NEXUS_HOME`；
- 两个调用 `main` 的测试都不再用 `catalog`，第一个测试改成：

```js
  const { app, stop } = await main({ env: await environment(SECRETS), log: { info: message => logs.push(message), error: message => logs.push(message) },
    fetchCard: async () => ({ name: '九安审核AI（PoC）', protocolVersion: '0.3' }) });
  t.after(() => stop());
  const http = createClient(app.server.address().port);
  assert.equal((await http.http('/poc/healthz', { headers: { Host: 'ip-10-0-0-1' } })).status, 200);
  assert.equal((await http.login('poc-reviewer', 'reviewer-pass-123')).status, 200);
  const me = (await http.api('/poc/nexus/me')).body.data;
  assert.equal(me.connection.status, 'error');   // operator 脚本不存在：CLI 起不来
  assert.deepEqual(me.system.map(item => [item.publishId, item.purpose]), [['pub_5c53e70d8dc7ddea', 'advisory']]);
  assert.equal((await http.api('/documents?limit=50')).body.data.total, 8);
  assert.equal(logs.join('\n').includes('reviewer-pass-123'), false);
```

其中 `SECRETS` 是 `'REVIEWER_PASSWORD=reviewer-pass-123\nCHECKER_PASSWORD=checker-pass-123\nNEXUS_A2A_KEY_pub_5c53e70d8dc7ddea=nxa_test\nREGISTRY_KEY=' + randomBytes(32).toString('base64') + '\n'`。

- 第二个测试（示例附件与名片）改成：从 `me.system[0].card.protocolVersion` 读名片；附件规则从 `/poc/nexus/attachment-policy` 读。
- 「拒绝启动」的测试追加一条：secrets 里只有两条口令、没有 `REGISTRY_KEY` 时，`main` 拒绝启动，报错包含 `/REGISTRY_KEY/`。
- `readEnvConfig` 那个测试：
  - 把 `assert.throws(() => readEnvConfig({ ...env, NEXUS_HOME: '' }), /NEXUS_HOME/)` 换成 `assert.throws(() => readEnvConfig({ ...env, NEXUS_OPERATOR: '' }), /NEXUS_OPERATOR/)`；
  - 再追加 `assert.equal(readEnvConfig({ ...env, POC_USERS_DIR: '' }).usersDir, '/var/lib/andon-finance/users')`。

- [ ] **Step 2：运行，确认失败**

运行：`node --test test/unit/access-routes.test.mjs test/unit/nexus-routes.test.mjs test/unit/server.test.mjs`
预期：
- access-routes 报 `ERR_MODULE_NOT_FOUND`；
- nexus-routes 失败，因为 `createInvoker` 还在用 `catalog`；
- server 失败，因为还在 import `nexusApiKeyFrom`。

- [ ] **Step 3：实现**

`access/routes.mjs`：

```js
/**
 * 「我的 Nexus」接口（接口约定 agent-access-v1，前缀 /api/analysis/v1/poc/nexus/me），挂在九安的 platformRoutes 钩子上：会话、来源与 CSRF 已由九安校验。
 * 只作用于当前会话的账号；返回里不含任何密钥。页面、命令行 agent_access.py 与以后的编码工具共用这一套。
 */
import { onlyFields, onlyQuery, readJson, sendJson } from '../http.mjs';

const BASE = '/api/analysis/v1/poc/nexus/me';
const AGENT = /^\/agents\/([^/]+)\/(enable|disable)$/;

export function meRoutes({ me }) {
  return () => ({
    async handle({ req, url, path, session, res }) {
      if (path !== BASE && !path.startsWith(`${BASE}/`)) return false;
      const route = path.slice(BASE.length);
      const user = session.user;
      const send = data => { sendJson(res, 200, { data }); return true; };
      if (route === '' && req.method === 'GET') { onlyQuery(url, []); return send(await me.view(user)); }
      const agent = AGENT.exec(route);
      if (req.method !== 'POST' || !(['/connect', '/disconnect', '/refresh'].includes(route) || agent)) return false;
      onlyQuery(url, []);
      const body = await readJson(req, { maximum: 4000 });
      if (route === '/connect') { onlyFields(body, ['apiKey', 'client']); return send(await me.connect(user, body.apiKey, { client: body.client })); }
      if (route === '/disconnect') { onlyFields(body, ['client']); return send(await me.disconnect(user, { client: body.client })); }
      if (route === '/refresh') { onlyFields(body, []); return send(await me.refresh(user)); }
      if (agent[2] === 'enable') { onlyFields(body, ['token', 'loadCapabilities', 'issue', 'client']); return send(await me.enable(user, agent[1], body)); }
      onlyFields(body, ['client']);
      return send(await me.disable(user, agent[1], { client: body.client }));
    },
  });
}
```

`nexus/invoke.mjs`：把文件头注释的第一句改成「Agent 页的「调用测试」：调用我启用的 Agent（我的调用密钥），或系统提供的 Agent（secrets.env 里的密钥），用自由文本、按任务或某张单据的审批建议输入调用一次。」然后把 `createInvoker` 整个换成：

```js
// 只有 Nexus 明说「这把密钥无效」（HTTP 401）才算启用失效；404（发布暂停、不存在）等只是这一次调用失败。
const keyRejected = error => error?.detail?.status === 401 || error?.detail?.code === 'credential_invalid';

export function createInvoker({ resolve, onAuthInvalid = async () => {}, runLog, registry, store, tenantId, governanceEnv, perMinute = 5, now = Date.now,
  timeoutMs = 180_000, clientFor = createNexusModelClient, call = a2aCall, capture = captureAdvisoryInput }) {
  const windows = new Map();
  function limit(userId) {
    const at = now(), entry = windows.get(userId);
    const current = entry && entry.until > at ? entry : { until: at + 60_000, count: 0 };
    if (current.count >= perMinute) fail('POC_INVOKE_RATE_LIMIT', 429);
    current.count += 1;
    windows.set(userId, current);
  }
  const flagIfRejected = async (error, user, publishId, credential) => {
    if (credential.source === 'user' && keyRejected(error)) await onAuthInvalid(user, publishId).catch(() => {});
  };
  async function runText(runId, user, publishId, credential, text, files) {
    try {
      const result = await call({ url: credential.rpcUrl, key: credential.key, text, files, timeoutMs });
      runLog.finish(runId, { status: 'ok', validation: 'not_applicable', fenced: unwrapJson(result.text).fenced, timings: result.timings,
        latencyMs: result.timings.done, rawText: result.text.slice(0, RAW_TEXT_LIMIT) });
    } catch (error) {
      runLog.finish(runId, { status: 'error', errorCode: codeOf(error), validation: 'not_applicable', latencyMs: null, detail: error?.detail ?? null });
      await flagIfRejected(error, user, publishId, credential);
    }
  }
  return {
    async start({ user, publishId, mode, text, documentId, attachments }) {
      if (typeof publishId !== 'string' || !PUBLISH_ID.test(publishId) || !['text', 'advisory'].includes(mode)) fail('INVALID_REQUEST', 400);
      const files = normalizeAttachments(attachments);
      const credential = await resolve(user, publishId);
      if (!credential) fail('POC_AGENT_NOT_ENABLED', 409);
      const base = { source: 'invoke', publishId, actor: user.name, actorId: user.id, credentialSource: credential.source, attachments: attachmentMeta(files) };
      if (mode === 'text') {
        const message = typeof text === 'string' ? text.trim() : '';
        if (!message || message.length > 8000) fail('INVALID_REQUEST', 400);
        limit(user.id);
        const runId = runLog.start({ ...base, task: taskOf(message), documentId: null, documentNumber: null });
        void runText(runId, user, publishId, credential, message, files);
        return { runId };
      }
      if (typeof documentId !== 'string' || !DOCUMENT_ID.test(documentId)) fail('INVALID_REQUEST', 400);
      const document = await store.getDocument({ id: documentId, companyIds: user.companyIds });
      if (!document) fail('NOT_FOUND', 404);
      limit(user.id);
      const input = await capture({ runtime: registry.get(document.companyId), tenantId, actor: user, document });
      const client = clientFor({ publishId, rpcUrl: credential.rpcUrl, getKey: () => credential.key, env: governanceEnv, runLog, source: 'invoke', timeoutMs });
      const runId = runLog.start({ ...base, task: 'advisory', documentId: document.id, documentNumber: document.number });
      void client.advisory(input, { runId, files }).catch(async error => {
        // 结果（含校验失败）已记进运行记录；只有调用前就失败、记录还停在「进行中」时才补记。
        if (runLog.get(runId)?.status === 'running') runLog.finish(runId, { status: 'error', errorCode: codeOf(error), validation: 'not_run' });
        await flagIfRejected(error, user, publishId, credential);
      });
      return { runId };
    },
  };
}
```

`nexus/routes.mjs`：
- 签名改成 `export function nexusRoutes({ me, runLog, governanceEnv, perMinute, samples = NO_SAMPLES })`；
- 建 invoker 时改成 `createInvoker({ resolve: (user, publishId) => me.credentialFor(user, publishId), onAuthInvalid: (user, publishId) => me.markInvalid(user, publishId), runLog, registry: ctx.registry, store: ctx.store, tenantId: ctx.tenantId, governanceEnv, ...(perMinute ? { perMinute } : {}) })`；
- 删掉 `/agents` 和 `/refresh` 两段；
- 新增：

```js
        if (route === '/attachment-policy' && req.method === 'GET') {
          onlyQuery(url, []);
          sendJson(res, 200, { data: { attachmentPolicy: ATTACHMENT_POLICY } });
          return true;
        }
```

运行记录两段改成：

```js
        // 调用测试的记录只给发起人看；审批流（source=jiuan）的记录所有人都能看。
        const visible = run => run.source !== 'invoke' || run.actorId === session.user.id;
        if (route === '/runs' && req.method === 'GET') {
          onlyQuery(url, ['limit']);
          const limit = Math.min(50, Math.max(1, Number.parseInt(url.searchParams.get('limit') || '20', 10) || 20));
          sendJson(res, 200, { data: { items: runLog.list(50).filter(visible).slice(0, limit) } });
          return true;
        }
        const match = /^\/runs\/([^/]+)$/.exec(route);
        if (match && req.method === 'GET') {
          onlyQuery(url, []);
          const run = RUN_ID.test(match[1]) ? runLog.get(match[1]) : null;
          if (!run || !visible(run)) fail('NOT_FOUND', 404);
          sendJson(res, 200, { data: run });
          return true;
        }
```

这两段要放在 `if (!path.startsWith(...))` 之后，并且 `visible` 定义在 `handle` 函数内部。文件头注释改成：「Nexus Agent 页的调用测试、调用记录、附件规则与示例附件（/api/analysis/v1/poc/nexus/*）。「我的 Nexus」接口在 access/routes.mjs。」

`config.mjs` 的 `nexus` 一项改成 `nexus: { origin: new URL(need('NEXUS_ORIGIN')).origin, advisoryPublishId, operatorScript: need('NEXUS_OPERATOR') }`，并在返回对象里加一项 `usersDir: env.POC_USERS_DIR || '/var/lib/andon-finance/users'`。

`server.mjs`：
- 文件头注释的第一句改成「入口……读环境变量与密钥配置文件 → 组装（每个账号的 Nexus 连接与启用、调用测试、审批流）→ 监听 → 读一遍原件。」
- import 改成：

```js
import { a2aKeysFrom, passwordsFrom, readSecretsFile, registryKeyFrom } from './secrets.mjs';
import { createOperatorCli } from './nexus/cli.mjs';
import { createKeyStore } from './nexus/keys.mjs';
import { fetchAgentCard } from './nexus/catalog.mjs';
import { createUserStore } from './access/store.mjs';
import { createMeService } from './access/me.mjs';
import { meRoutes } from './access/routes.mjs';
import { loadManifest, verifyCallKey } from './access/verify.mjs';
```

- `main` 改成：

```js
export async function main({ env = process.env, log = console, fetchCard = url => fetchAgentCard(url), verifyKey = verifyCallKey, describe = loadManifest, cliFor } = {}) {
  const settings = readEnvConfig(env);
  const { nexus } = settings;
  const secrets = () => readSecretsFile(settings.secretsFile);
  const initial = await secrets();
  const passwords = passwordsFrom(initial);
  const registryKey = registryKeyFrom(initial);
  // 系统提供的 Agent：secrets.env 里 NEXUS_A2A_KEY_<发布编号>（审批流在用的那个），所有人可见、不用启用。
  const keyStore = createKeyStore({ load: async () => a2aKeysFrom(await secrets()) });
  await keyStore.reload();
  const runLog = createRunLog();
  const store = createUserStore({ root: settings.usersDir });
  const me = createMeService({ store, registryKey, keyStore, fetchCard, verifyKey, loadManifest: describe, nexusOrigin: nexus.origin, advisoryPublishId: nexus.advisoryPublishId,
    cliFor: cliFor ?? (async accountId => createOperatorCli({ script: nexus.operatorScript, nexusHome: await store.nexusHomeFor(accountId), profile: 'default', origin: nexus.origin })) });
  // 示例附件不合规是代码问题（单元测试会先发现）；万一发生，调用测试照常可用，只是没有示例附件。
  const samples = await loadSamples().catch(error => { log.error(`SAMPLES_ERROR ${error?.code ?? 'UNKNOWN'}`); return undefined; });
  const governance = governanceEnv();
  const modelClient = createNexusModelClient({ publishId: nexus.advisoryPublishId, rpcUrl: `${nexus.origin}/a2a/${nexus.advisoryPublishId}`,
    getKey: () => keyStore.get(nexus.advisoryPublishId), env: governance, runLog, source: 'jiuan' });
  const app = createPocApp({ origin: settings.origin, publicDir: settings.publicDir, passwords, modelClient,
    plugins: [
      approvalRoutes({ publishId: nexus.advisoryPublishId, onError: error => log.error(`APPROVAL_ERROR ${error?.code ?? 'UNKNOWN'}`) }),
      meRoutes({ me }),
      nexusRoutes({ me, runLog, governanceEnv: governance, samples }),
    ],
    onError: ({ code } = {}) => log.error(`APP_ERROR ${code ?? 'UNKNOWN'}`) });
  // 后面的 keepAliveTimeout、listen、log.info、warmUp 都保持原样；删掉 void catalog.refresh() 那一行。
  return { app, me, keyStore, stop: () => app.close() };
}
```

- [ ] **Step 4：运行全套测试，确认通过**

运行：`cd audit-nexus/poc/app && node --test "test/unit/**/*.test.mjs"`
预期：全部通过。如果 `nexus-page.test.mjs` 因为还在测旧的 Agent 页而失败，那属于任务 6 的范围。这时只跑 `node --test test/unit/access-*.test.mjs test/unit/nexus-routes.test.mjs test/unit/server.test.mjs test/unit/catalog.test.mjs test/unit/secrets.test.mjs`，应该全部通过。

---

### Task 6：Agent 页改版

**Files:**
- Modify: `poc/app/public-src/nexus-poc.js`，「Nexus Agent」页那一段：从 `const CONNECTION_STATUS` 开始，到 `function createRunsPanel` 之前，整段替换
- Modify: `poc/app/public-src/nexus-poc.js`：`POC_SAFE_ERRORS`
- Modify: `poc/app/public-src/nexus-invoke.js`：`createInvokePanel` 增加 `hooks.manifests`
- Modify: `poc/app/public-src/nexus-poc.css`
- Test: `poc/app/test/unit/nexus-page.test.mjs`（整体改写）
- Test: `poc/app/test/unit/nexus-invoke.test.mjs`（追加）

**Interfaces:**
- Consumes：
  - `GET /poc/nexus/me` 返回的 `MyView`（任务 4）
  - `GET /poc/nexus/attachment-policy`（任务 5）
  - `nexus-invoke.js` 的 `createInvokePanel`、`inputModeLabels`
- Produces（都从 `nexus-poc.js` 导出）：
  - `loadNexusAgentsPage(api) → { me, runs, policy }`
  - `nexusAgentsPage(result, ctx)`
  - `problemOf(publication) → string | null`
  - `groupPublications(publications) → { pending, enabled, problem }`
  - `invocable(me) → { callable, manifests: Map }`
  - `agentCard(publication, ctx, { group, onTest })`
  - `myConnectionPanel(me, ctx)`

  `build-public.mjs` 里的补丁只 import 了 `loadNexusAgentsPage` 和 `nexusAgentsPage`，这两个名字不变。

- [ ] **Step 1：写失败的测试**

`nexus-page.test.mjs` 整体改写。文件开头的 `fakeUi`、`textOf`、`find` 三个辅助函数保留，把 `find` 扩展成 `findAll`，写法和 `nexus-invoke.test.mjs` 里的一样。测试如下：

```js
import { POC_SAFE_ERRORS, agentCard, groupPublications, invocable, myConnectionPanel, nexusAgentsPage, problemOf } from '../../public-src/nexus-poc.js';

const pub = extra => ({ publishId: 'pub_mine', displayName: '九安知识Agent（PoC）', description: '审批知识服务', status: 'active', version: 1, followUpdates: true,
  model: 'global.anthropic.claude-sonnet-5', a2a: { enabled: true, ready: true, rpcUrl: 'https://nexus.example/a2a/pub_mine' }, listed: true,
  card: { protocolVersion: '0.3', streaming: true, inputModes: ['text/plain', 'application/pdf'], error: null }, enablement: null, capabilities: null, ...extra });
const enabled = (extra = {}) => pub({ enablement: { status: 'active', fingerprint: '3f9c1a2b', verifiedAt: '2026-10-17T00:00:00Z', capabilitiesVersion: 'v2', enabledAt: 't', versionChanged: false, ...extra } });
const ctx = () => ({ ui: fakeUi(), api: async () => ({}), isCurrent: () => true, reload() {}, onAuthLost() {} });

test('problemOf 与 groupPublications：密钥失效、暂停、A2A 关闭、名片读不到算有问题；断开后仍记着的已启用项算已启用', () => {
  assert.equal(problemOf(pub()), null);
  assert.match(problemOf(enabled({ status: 'key_invalid' })), /调用密钥失效/);
  assert.match(problemOf(pub({ status: 'paused' })), /已暂停/);
  assert.match(problemOf(pub({ a2a: { enabled: false } })), /没有打开 A2A/);
  assert.match(problemOf(pub({ card: { error: 'POC_CARD_UNAVAILABLE' } })), /名片/);
  assert.equal(problemOf({ ...enabled(), status: 'unverified', listed: false, card: null }), null);
  const groups = groupPublications([pub({ publishId: 'pub_a' }), enabled(), pub({ publishId: 'pub_c', status: 'paused' })]);
  assert.deepEqual([groups.pending.map(item => item.publishId), groups.enabled.map(item => item.publishId), groups.problem.map(item => item.publishId)], [['pub_a'], ['pub_mine'], ['pub_c']]);
});

test('连接区：未连接时是 API 密钥输入框（密码框）和「连接」，说明在哪里生成；连上后显示 Nexus 账号、档位，和「刷新」「断开」', () => {
  const offline = myConnectionPanel({ connection: { status: 'not_connected' } }, ctx());
  const input = findAll(offline, item => item.tagName === 'input')[0];
  assert.equal(input.attrs.type, 'password');
  assert.match(textOf(offline), /个人设置 › API 密钥/);
  assert.ok(findAll(offline, item => item.tagName === 'button' && textOf(item).includes('连接')).length === 1);
  const online = myConnectionPanel({ connection: { status: 'connected', nexusUser: { name: 'admin', role: 'editor' }, preset: 'read_only', connectedAt: 't', refreshedAt: 't' } }, ctx());
  for (const expected of ['已连接', 'admin（editor）', 'read_only', '刷新', '断开']) assert.match(textOf(online), new RegExp(expected));
});

test('卡片：待启用有「启用」和隐藏的启用表单（密码框、默认勾选读能力清单）；已启用有指纹与四个操作；有问题写明原因', () => {
  const pending = agentCard(pub(), ctx(), { group: 'pending' });
  assert.ok(findAll(pending, item => item.tagName === 'button' && textOf(item).trim() === '启用').length === 1);
  const form = findAll(pending, item => item.attrs?.class === 'poc-enable-form')[0];
  assert.equal(form.hidden, true);
  assert.equal(findAll(form, item => item.tagName === 'input' && item.attrs.type === 'password').length, 1);
  assert.equal(findAll(form, item => item.tagName === 'input' && item.attrs.type === 'checkbox')[0].attrs.checked, true);
  assert.match(textOf(pending), /A2A 0\.3/);
  const on = agentCard(enabled({ versionChanged: true }), ctx(), { group: 'enabled' });
  for (const expected of ['3f9c1a2b', '调用测试', '换密钥', '重新读能力清单', '停用', '版本有变化']) assert.match(textOf(on), new RegExp(expected));
  const broken = agentCard(enabled({ status: 'key_invalid' }), ctx(), { group: 'problem' });
  assert.match(textOf(broken), /调用密钥失效/);
  assert.match(textOf(broken), /换密钥/);
});

test('invocable：调用测试只列已启用的和系统提供的（标「系统提供」），能力清单从启用时缓存的取', () => {
  const me = { publications: [pub({ publishId: 'pub_pending' }), enabled(), { ...enabled(), publishId: 'pub_bad', enablement: { status: 'key_invalid' } }],
    system: [{ publishId: 'pub_5c53e70d8dc7ddea', displayName: '九安审核AI（PoC）', purpose: 'advisory', card: null }] };
  me.publications[1].capabilities = { task: 'describe', tasks: [{ name: 'answer' }] };
  const { callable, manifests } = invocable(me);
  assert.deepEqual(callable.map(item => [item.publishId, item.canInvoke]), [['pub_mine', true], ['pub_5c53e70d8dc7ddea', true]]);
  assert.match(callable[1].displayName, /系统提供/);
  assert.deepEqual([...manifests.keys()], ['pub_mine']);
});

test('整页：连接区、我的 Agent（分组标题带数量）、未发布的 Agent、调用测试、调用记录', () => {
  const me = { connection: { status: 'connected', nexusUser: { name: 'admin', role: 'editor' } }, publications: [pub({ publishId: 'pub_a' }), enabled()],
    unpublished: [{ agentId: 'agent_draft', name: '草稿 Agent', status: 'draft', version: '1' }], system: [] };
  const page = nexusAgentsPage({ me, runs: [], policy: null }, { ...ctx(), api: async () => ({ items: [] }) });
  for (const expected of ['我的 Nexus 连接', '我的 Agent', '待启用（1）', '已启用（1）', '我还没发布的 Agent（1）', '草稿 Agent', '调用测试', '最近的调用记录']) assert.match(textOf(page), new RegExp(expected.replace(/[()（）]/g, '.')));
});

test('新错误码都有中文说明', () => {
  for (const code of ['POC_NEXUS_API_KEY_INVALID', 'POC_NEXUS_UNREACHABLE', 'POC_NEXUS_NOT_CONNECTED', 'POC_PUBLICATION_NOT_MINE', 'POC_CARD_UNAVAILABLE',
    'POC_CALL_KEY_INVALID', 'POC_AGENT_NOT_ENABLED', 'POC_ISSUE_NOT_ALLOWED', 'POC_ME_RATE_LIMIT']) assert.ok(POC_SAFE_ERRORS[code], code);
});
```

在 `nexus-invoke.test.mjs` 末尾追加：

```js
test('调用测试面板：hooks.manifests 预填的能力清单，不用再点「读取能力清单」就能选任务', async () => {
  const ctx = { ui: fakeUi(), isCurrent: () => true, onAuthLost() {}, api: async () => ({ items: [] }) };
  const publication = { publishId: 'pub_k', displayName: '知识', canInvoke: true, card: null };
  const panel = createInvokePanel([publication], ctx, { policy: POLICY, manifests: new Map([['pub_k', { task: 'describe', tasks: [{ name: 'describe' }, { name: 'answer', purpose: '问知识库' }] }]]) });
  const select = findAll(panel.node, item => item.tagName === 'select' && item.attrs.id === 'poc-invoke-task')[0];
  assert.deepEqual(select.children.map(option => option.attrs.value), ['answer']);
});
```

- [ ] **Step 2：运行，确认失败**

运行：`node --test test/unit/nexus-page.test.mjs test/unit/nexus-invoke.test.mjs`
预期：nexus-page 报 `agentCard` 之类的名字不存在；nexus-invoke 新增的那个测试失败，因为任务下拉框还是空的。

- [ ] **Step 3：实现**

`nexus-invoke.js` 的 `createInvokePanel` 里，把 `const manifests = new Map();` 改成 `const manifests = new Map(hooks.manifests ?? []);`。

`nexus-poc.js`：
- 文件开头的 import 改成 `import { CONFIDENCE, createInvokePanel, inputModeLabels, pollDelay, runResult, runView, seconds } from './nexus-invoke.js';`；
- `POC_SAFE_ERRORS` 里删掉 `POC_NEXUS_KEY_MISSING`、`POC_NEXUS_NOT_INVOCABLE`，加上：

```js
  POC_NEXUS_API_KEY_INVALID: 'API 密钥无效、已经用过（第一次连接后平台会换新），或者不属于这个 Nexus：在 Nexus「个人设置 › API 密钥」新建一把再连接。',
  POC_NEXUS_UNREACHABLE: '暂时连不上 Nexus，稍后再试。',
  POC_NEXUS_NOT_CONNECTED: '还没有连接 Nexus：先在上面填入你的 API 密钥。',
  POC_PUBLICATION_NOT_MINE: '这个发布不在你的 Nexus 列表里：确认用的是发布者本人或被分享者的 API 密钥，再点「刷新」。',
  POC_CARD_UNAVAILABLE: '读不到这个发布的 A2A 名片：发布可能暂停了，或者 A2A 没打开。',
  POC_CALL_KEY_INVALID: '调用密钥无效，或者不属于这个发布：在 Nexus「互联中心 › 对外发布」找到这个发布，签一把新的再粘贴。',
  POC_AGENT_NOT_ENABLED: '这个 Agent 还没有启用：先在「我的 Agent」里粘贴调用密钥启用。',
  POC_ISSUE_NOT_ALLOWED: '应用暂时不能替你签发调用密钥：请在 Nexus 网页上签发后粘贴进来。',
  POC_ME_RATE_LIMIT: '连接和启用每分钟最多 5 次，请稍后再试。',
```

整段替换的新代码（放在 `// 「Nexus Agent」页` 那段注释的下面，紧接在 `createRunsPanel` 之前）：

```js
const CONNECTION_STATUS = Object.freeze({ connected: ['已连接', 'green'], not_connected: ['未连接', 'amber'], error: ['连接出错', 'red'] });
const GROUPS = Object.freeze([['pending', '待启用'], ['enabled', '已启用'], ['problem', '有问题']]);

export async function loadNexusAgentsPage(api) {
  const [me, runs, limits] = await Promise.all([api('/poc/nexus/me'), api('/poc/nexus/runs?limit=20'), api('/poc/nexus/attachment-policy')]);
  return { me, runs: Array.isArray(runs?.items) ? runs.items : [], policy: limits?.attachmentPolicy ?? null };
}

/** 有问题的原因（没问题返回 null）：密钥失效、发布没上线或暂停、A2A 没开、名片读不到。断开 Nexus 后仍记着的已启用项（listed=false）不算有问题。 */
export function problemOf(publication) {
  const enablement = publication.enablement;
  if (enablement && enablement.status !== 'active') return '调用密钥失效：在 Nexus「互联中心 › 对外发布」签一把新的，点「换密钥」重新启用。';
  if (publication.listed === false) return null;
  if (publication.status !== 'active') return publication.status === 'paused' ? '发布已暂停：在 Nexus「互联中心 › 对外发布」恢复。' : '发布还没上线。';
  if (publication.a2a?.enabled === false) return '这个发布没有打开 A2A。';
  if (publication.card?.error) return `读不到 A2A 名片（${publication.card.error}）：发布可能暂停了，或者 A2A 没打开。`;
  return null;
}

export function groupPublications(publications = []) {
  const groups = { pending: [], enabled: [], problem: [] };
  for (const publication of publications) {
    if (problemOf(publication)) groups.problem.push(publication);
    else groups[publication.enablement ? 'enabled' : 'pending'].push(publication);
  }
  return groups;
}

/** 调用测试里列哪些：我已启用、没有问题的，加上系统提供的（审批流在用的那个）；能力清单从启用时缓存的取。 */
export function invocable(me) {
  const enabled = groupPublications(me?.publications ?? []).enabled.map(publication => ({ ...publication, canInvoke: true }));
  const system = (me?.system ?? []).filter(item => !enabled.some(publication => publication.publishId === item.publishId))
    .map(item => ({ ...item, displayName: `${item.displayName}（系统提供）`, canInvoke: true }));
  return { callable: [...enabled, ...system], manifests: new Map(enabled.filter(publication => publication.capabilities).map(publication => [publication.publishId, publication.capabilities])) };
}

function poster(ctx, message) {
  return async (path, body, control) => {
    control.disabled = true;
    message.replaceChildren();
    try {
      await ctx.api(path, { method: 'POST', body });
      if (ctx.isCurrent()) ctx.reload();
    } catch (error) {
      if (error.status === 401) { ctx.onAuthLost(error.message); return; }
      message.replaceChildren(ctx.ui.errorMessage(error));
      control.disabled = false;
    }
  };
}

export function myConnectionPanel(me, ctx) {
  const { element, tag, panel, facts, button } = ctx.ui;
  const connection = me?.connection ?? { status: 'not_connected' };
  const [label, tone] = CONNECTION_STATUS[connection.status] ?? ['状态未知', ''];
  const message = element('p', { class: 'form-error', role: 'alert' });
  const post = poster(ctx, message);
  if (connection.status === 'connected') {
    const refresh = button('刷新', () => { void post('/poc/nexus/me/refresh', {}, refresh); }, { iconName: 'sync' });
    const disconnect = button('断开', () => { void post('/poc/nexus/me/disconnect', { client: 'web' }, disconnect); },
      { quiet: true, title: '只删除应用服务端保存的连接；Nexus 上的 API 密钥请到网页停用' });
    return panel('我的 Nexus 连接', '用你自己的 Nexus 身份列出你的发布；调用用各发布的调用密钥。', element('div', { class: 'poc-connection' },
      element('div', { class: 'poc-tags' }, tag(label, tone)),
      facts([
        ['Nexus 账号', connection.nexusUser ? `${connection.nexusUser.name ?? '—'}（${connection.nexusUser.role ?? '—'}）` : '—'],
        ['档位', connection.preset ?? '—'],
        ['连接时间', connection.connectedAt ? ctx.ui.dateText(connection.connectedAt) : '—'],
        ['刷新时间', connection.refreshedAt ? ctx.ui.dateText(connection.refreshedAt) : '—'],
      ]),
      message, element('div', { class: 'poc-actions' }, refresh, disconnect)));
  }
  const input = element('input', { type: 'password', id: 'poc-me-api-key', autocomplete: 'off', spellcheck: 'false', placeholder: 'nxc_…' });
  const connect = button('连接', () => { void post('/poc/nexus/me/connect', { apiKey: input.value, client: 'web' }, connect); }, { primary: true });
  return panel('我的 Nexus 连接', '连接后，你在 Nexus 上的发布会出现在下面；在 Nexus 新发布的 Agent，刷新后也会出现。', element('div', { class: 'poc-connection' },
    element('div', { class: 'poc-tags' }, tag(label, tone)),
    connection.status === 'error' ? element('div', { class: 'note-block amber' }, `读不到你的 Nexus 列表（${connection.error ?? '原因未知'}）：稍后重试，或在 Nexus 新建一把 API 密钥再连接。`) : null,
    element('div', { class: 'field' }, element('label', { for: 'poc-me-api-key' }, 'Nexus API 密钥'), input),
    element('p', { class: 'quiet-note' }, '在 Nexus「个人设置 › API 密钥」新建一把，给本应用单独用，只读档位就够了。连接后平台会把这串换新，原来那串作废；随时可以在 Nexus 停用。'),
    message, element('div', { class: 'poc-actions' }, connect)));
}

function cardSummary(card) {
  if (!card) return '—';
  if (card.error) return `读不到（${card.error}）`;
  const modes = inputModeLabels(card.inputModes);
  return `A2A ${card.protocolVersion ?? '—'}${card.streaming ? '，流式' : ''} · 接受 ${modes.length ? modes.join('、') : '文字'}`;
}

export function agentCard(publication, ctx, { group, onTest = () => {} } = {}) {
  const { element, tag, button, facts } = ctx.ui;
  const enablement = publication.enablement;
  const id = publication.publishId;
  const message = element('p', { class: 'form-error', role: 'alert' });
  const post = poster(ctx, message);
  const keyId = `poc-key-${id}`, capabilitiesId = `poc-capabilities-${id}`;
  const keyInput = element('input', { type: 'password', id: keyId, autocomplete: 'off', spellcheck: 'false', placeholder: 'nxa_…' });
  const capabilities = element('input', { type: 'checkbox', id: capabilitiesId, checked: true });
  const submit = button(enablement ? '确认换密钥' : '确认启用', () => {
    void post(`/poc/nexus/me/agents/${id}/enable`, { token: keyInput.value, loadCapabilities: capabilities.checked, client: 'web' }, submit);
  }, { primary: true });
  const form = element('div', { class: 'poc-enable-form', hidden: true },
    element('div', { class: 'field' }, element('label', { for: keyId }, '调用密钥（Nexus「互联中心 › 对外发布」签发）'), keyInput),
    element('label', { for: capabilitiesId, class: 'poc-check' }, capabilities, '顺便读一次能力清单（约 0.03 美元）'),
    element('div', { class: 'poc-actions' }, submit, button('取消', () => { form.hidden = true; }, { quiet: true })));
  const open = label => button(label, () => { form.hidden = false; keyInput.focus(); }, { primary: !enablement });
  const reread = button('重新读能力清单', () => { void post(`/poc/nexus/me/agents/${id}/enable`, { loadCapabilities: true, client: 'web' }, reread); },
    { quiet: true, title: '用已保存的调用密钥重新验证，并重新读能力清单（约 0.03 美元）' });
  const disable = button('停用', () => { void post(`/poc/nexus/me/agents/${id}/disable`, { client: 'web' }, disable); }, { quiet: true });
  const actions = group === 'pending' ? [open('启用')]
    : group === 'enabled' ? [button('调用测试', () => onTest(id), { primary: true, iconName: 'agent' }), open('换密钥'), reread, disable]
      : enablement ? [open('换密钥'), disable] : [];
  const tags = [[group === 'enabled' ? '已启用' : group === 'problem' ? '有问题' : '待启用', group === 'enabled' ? 'green' : group === 'problem' ? 'red' : 'amber'],
    publication.listed === false ? ['Nexus 已断开，仍可调用', ''] : null,
    enablement?.versionChanged ? ['Agent 版本有变化，可以重新读能力清单', 'amber'] : null].filter(Boolean);
  return element('article', { class: 'poc-agent-card', 'data-publish-id': id },
    element('h3', {}, publication.displayName),
    element('div', { class: 'poc-tags' }, tags.map(([label, tone]) => tag(label, tone))),
    publication.description ? element('p', { class: 'poc-agent-description' }, publication.description) : null,
    group === 'problem' ? element('div', { class: 'note-block amber' }, problemOf(publication)) : null,
    facts([
      ['发布编号', id],
      ['版本', publication.version == null ? '—' : `${publication.followUpdates ? '跟随最新' : '钉住'} v${publication.version}`],
      ['名片', cardSummary(publication.card)],
      ...(enablement ? [['密钥指纹', enablement.fingerprint ?? '—'], ['验证时间', enablement.verifiedAt ? ctx.ui.dateText(enablement.verifiedAt) : '—'],
        ['能力清单', enablement.capabilitiesVersion ?? '没有读到']] : []),
    ]),
    message, element('div', { class: 'poc-actions' }, actions), form);
}

function myAgentsPanel(me, ctx, onTest) {
  const { element, panel, empty } = ctx.ui;
  const groups = groupPublications(me?.publications ?? []);
  const connected = me?.connection?.status === 'connected';
  const sections = GROUPS.filter(([name]) => groups[name].length).map(([name, title]) => element('section', { class: 'poc-agent-group' },
    element('h4', {}, `${title}（${groups[name].length}）`),
    element('div', { class: 'poc-agent-grid' }, groups[name].map(publication => agentCard(publication, ctx, { group: name, onTest })))));
  const unpublished = me?.unpublished ?? [];
  return panel('我的 Agent', '启用：粘贴这个发布的调用密钥。应用当场验证（不花钱），默认顺便读一次能力清单。', element('div', { class: 'poc-my-agents' },
    ...(sections.length ? sections : [empty(connected ? '你还没有已发布的 Agent' : '先连接 Nexus',
      connected ? '在 Nexus 上发布 Agent 并打开 A2A，再点「刷新」。' : '连接后，这里会列出你在 Nexus 上的发布。', null, 'setup')]),
    unpublished.length ? element('details', { class: 'poc-unpublished' },
      element('summary', {}, `我还没发布的 Agent（${unpublished.length}）：发布并打开 A2A 之后，会出现在上面`),
      element('ul', {}, unpublished.map(agent => element('li', {}, `${agent.name}（${agent.status ?? '—'}，v${agent.version ?? '—'}）`)))) : null));
}

export function nexusAgentsPage(result, ctx) {
  const { element } = ctx.ui;
  const me = result?.me ?? {};
  const runsPanel = createRunsPanel(result?.runs ?? [], ctx);
  const { callable, manifests } = invocable(me);
  const invokePanel = createInvokePanel(callable, ctx, { onFinished: () => runsPanel.reload(), policy: result?.policy ?? null, manifests });
  return element('div', { class: 'poc-agents-page' },
    myConnectionPanel(me, ctx), myAgentsPanel(me, ctx, publishId => invokePanel.select(publishId)), invokePanel.node, runsPanel.node);
}
```

删掉原有的 `PUBLICATION_STATUS`、`publicationBadges`、`connectionPanel`、`publicationsPanel`、`publicationCard`、`agentsPanel`，以及原来那段 `loadNexusAgentsPage` 和 `nexusAgentsPage`。`createRunsPanel` 保持不变。

`nexus-poc.css` 在「调用测试：附件与按任务的输入」那一段前面插入：

```css
/* 我的 Agent：三组卡片、启用表单、未发布列表 */
.poc-my-agents { display: grid; gap: 18px; }
.poc-agent-group { display: grid; gap: 10px; }
.poc-agent-group h4 { margin: 0; font-size: var(--ui-text-sm); color: var(--ui-muted); }
.poc-enable-form { display: grid; gap: 10px; padding: 12px; border: 1px dashed #c4b5fd; border-radius: 10px; background: #fcfbff; }
.poc-enable-form input[type="password"], .poc-connection input[type="password"] { height: 40px; padding: 0 12px; border: 1px solid var(--ui-line); border-radius: 8px; font: inherit; }
.poc-check { display: inline-flex; align-items: center; gap: 6px; }
.poc-unpublished summary { cursor: pointer; color: var(--ui-muted); }
.poc-unpublished ul { margin: 8px 0 0; padding-left: 20px; line-height: 1.8; }
```

再把文件末尾那条 `[hidden]` 规则改成：`.poc-approval [hidden], .poc-invoke [hidden], .poc-login-form [hidden], .poc-my-agents [hidden] { display: none !important; }`。

- [ ] **Step 4：运行全套测试**

运行：`cd audit-nexus/poc/app && node --test "test/unit/**/*.test.mjs"`
预期：全部通过，其中包括 `build-public.test.mjs`：`nexus-poc.js` 导出了补丁里 import 的每一个名字。

---

### Task 7：命令行 `agent_access.py`

**Files:**
- Create: `audit-nexus/skills/agent-access/scripts/agent_access.py`
- Create: `audit-nexus/skills/agent-access/tests/test_agent_access.py`
- Test: `poc/app/test/unit/agent-access-cli.test.mjs`（新）
- Modify: `poc/app/test/unit/helpers/app.mjs`：`startApp` 增加 `origin` 和 `port` 两个参数

**Interfaces:**
- Consumes：任务 5 的全部接口：`/poc/login`、`/auth/exchange`、`/session`，以及 `/poc/nexus/me*`、`/poc/nexus/invoke`、`/poc/nexus/runs*`。
- Produces：命令行，命令表和退出码按 Skills 设计第 5 节，并且有以下两点：
  - `--yes`、`--json`、`--profile` 写在子命令前后都可以；
  - `nexus connect` 的 API 密钥固定从标准输入读，所以不需要 `--key-stdin`。

- [ ] **Step 1：写失败的测试**

`skills/agent-access/tests/test_agent_access.py`：

```python
import io, json, os, stat, sys, tempfile, unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import agent_access as aa  # noqa: E402


class PureTests(unittest.TestCase):
    def test_redact_hides_every_key_kind(self):
        text = 'a nxc_' + 'k' * 20 + ' b nxa_' + 'x' * 30 + ' c afp_' + 'y' * 12 + ' d nxp_' + 'z' * 9 + ' e nxa_short'
        out = aa.redact(text)
        self.assertNotIn('kkkk', out); self.assertNotIn('xxxx', out); self.assertNotIn('yyyy', out); self.assertNotIn('zzzz', out)
        self.assertEqual(out.count('[已隐藏]'), 4)
        self.assertIn('nxa_short', out)

    def test_exit_codes_follow_the_shared_table(self):
        cases = [(401, None, 3), (409, 'POC_NEXUS_NOT_CONNECTED', 3), (400, 'POC_NEXUS_API_KEY_INVALID', 4), (400, 'POC_CALL_KEY_INVALID', 4),
                 (404, 'POC_PUBLICATION_NOT_MINE', 5), (409, 'POC_CARD_UNAVAILABLE', 6), (409, 'POC_AGENT_NOT_ENABLED', 6), (429, 'POC_ME_RATE_LIMIT', 7),
                 (502, 'POC_NEXUS_UNREACHABLE', 8), (500, None, 8), (400, 'INVALID_REQUEST', 2), (403, 'POC_ISSUE_NOT_ALLOWED', 4)]
        for status, code, expected in cases:
            self.assertEqual(aa.exit_for(status, code), expected, (status, code))

    def test_global_flags_anywhere(self):
        flags, rest = aa.split_globals(['enable', 'pub_x', '--yes', '--profile', 'work', '--key-stdin', '--json'])
        self.assertEqual(flags, {'yes': True, 'json': True, 'profile': 'work'})
        self.assertEqual(rest, ['enable', 'pub_x', '--key-stdin'])

    def test_write_without_yes_is_exit_9_before_any_request(self):
        with tempfile.TemporaryDirectory() as home:
            code = aa.main(['disable', 'pub_xxxx'], env={'AGENT_ACCESS_HOME': home}, stdin=io.StringIO(''), stdout=io.StringIO(), stderr=io.StringIO())
            self.assertEqual(code, 9)

    def test_store_permissions(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / 'aa'
            store = aa.Store(home)
            store.save_profile('default', {'origin': 'http://x', 'cookie': 'jiuan_analysis=1'})
            self.assertEqual(stat.S_IMODE(os.stat(home).st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(os.stat(home / 'credentials.json').st_mode), 0o600)
            self.assertEqual(store.profile('default')['origin'], 'http://x')
            self.assertTrue(store.drop_profile('default'))
            self.assertIsNone(store.profile('default'))

    def test_secret_must_come_from_stdin(self):
        class Tty(io.StringIO):
            def isatty(self): return True
        with self.assertRaises(aa.CliError) as ctx:
            aa.read_secret(Tty('nxa_x'), 'API 密钥')
        self.assertEqual(ctx.exception.exit_code, 2)
        with self.assertRaises(aa.CliError):
            aa.read_secret(io.StringIO('\n'), 'API 密钥')
        self.assertEqual(aa.read_secret(io.StringIO('  nxa_value \n'), '调用密钥'), 'nxa_value')


if __name__ == '__main__':
    unittest.main()
```

`helpers/app.mjs` 的 `startApp` 改成 `export async function startApp(t, { modelClient = fakeModel().client, plugins = [], warm = true, origin = TEST_ORIGIN, port = 0 } = {})`：用 `origin` 调 `createPocApp`，用 `port` 监听，并且返回值的 `client` 改成 `() => createClient(port, { origin })`。另外新增导出：

```js
/** 先占一个空闲端口再放掉：让 PoC 的站点地址就是 http://127.0.0.1:<端口>，外部程序（例如 Python 脚本）不用改 Host 头就能访问。 */
export async function freePort() {
  const server = (await import('node:net')).createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}
```

`test/unit/agent-access-cli.test.mjs`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { meRoutes } from '../../access/routes.mjs';
import { createMeService } from '../../access/me.mjs';
import { createUserStore } from '../../access/store.mjs';
import { fetchAgentCard } from '../../nexus/catalog.mjs';
import { loadManifest, verifyCallKey } from '../../access/verify.mjs';
import { nexusRoutes } from '../../nexus/routes.mjs';
import { createRunLog } from '../../nexus/runs.mjs';
import { governanceEnv } from '../../nexus/governance.mjs';
import { PASSWORDS, freePort, startApp } from './helpers/app.mjs';
import { answerEvents, startFakeA2a, writeEvents } from './helpers/fake-a2a.mjs';

const SCRIPT = fileURLToPath(new URL('../../../../skills/agent-access/scripts/agent_access.py', import.meta.url));
const GOOD = 'nxa_' + 'g'.repeat(43), BAD = 'nxa_' + 'b'.repeat(43), API_KEY = 'nxc_' + 'k'.repeat(43);
const MANIFEST = { task: 'describe', version: 'knowledge-agent-2026-10-17.2', tasks: [{ name: 'answer', purpose: '问知识库' }] };
const ok = json => ({ exitCode: 0, json });

test('agent_access.py 对本机 PoC 走完一轮：登录 → 状态 → 连接 → 启用（错密钥被拒）→ 调用 → 停用 → 退出；输出里没有任何密钥', async t => {
  const fake = await startFakeA2a(({ req, res, body }) => {
    if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ name: '知识', protocolVersion: '0.3', capabilities: { streaming: true } })); return; }
    const valid = req.headers.authorization === `Bearer ${GOOD}`;
    if (body?.method === 'tasks/get') { res.writeHead(valid ? 200 : 401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: valid ? -32603 : -32010, message: valid ? 'Task not found' : 'credential_invalid' } })); return; }
    const text = body?.params?.message?.parts?.[0]?.text ?? '';
    writeEvents(res, answerEvents(text.includes('describe') ? JSON.stringify(MANIFEST) : '{"task":"answer","answer":"每晚不超过 600 元。"}'));
  });
  t.after(() => fake.close());
  const state = { connected: false };
  const cli = { async whoami() { return state.connected ? ok({ user: { user_id: 'u-1', name: 'admin', role: 'editor' }, connection: { preset: 'read_only' } }) : { exitCode: 3, json: null }; },
    async login() { state.connected = true; return { exitCode: 0, json: null }; }, async logout() { state.connected = false; return { exitCode: 0, json: null }; },
    async get(pathname) { return pathname === '/api/v2/publications' ? ok({ data: { items: [{ publish_id: 'pub_knowledge', display_name: '知识 Agent', status: 'active', current_version: 1,
      channels: [{ channel: 'a2a', enabled: true, ready: true, rpc_url: `${fake.origin}/a2a/pub_knowledge` }] }] } }) : ok({ data: [] }); } };
  const me = createMeService({ store: createUserStore({ root: await mkdtemp(path.join(tmpdir(), 'poc-cli-')) }), registryKey: randomBytes(32), nexusOrigin: fake.origin,
    advisoryPublishId: 'pub_5c53e70d8dc7ddea', cliFor: async () => cli, keyStore: { ids: () => [], has: () => false, get: () => null },
    fetchCard: url => fetchAgentCard(url), verifyKey: verifyCallKey, loadManifest });
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  await startApp(t, { origin, port, plugins: [meRoutes({ me }), nexusRoutes({ me, runLog: createRunLog(), governanceEnv: governanceEnv() })] });
  const home = await mkdtemp(path.join(tmpdir(), 'agent-access-'));
  const run = (args, input = '') => {
    const result = spawnSync('python3', ['-I', SCRIPT, ...args], { input, encoding: 'utf8', env: { PATH: process.env.PATH, AGENT_ACCESS_HOME: home }, timeout: 120_000 });
    for (const secret of [GOOD, BAD, API_KEY, PASSWORDS.get('poc-reviewer')]) assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false, args.join(' '));
    return result;
  };
  assert.equal(run(['login', '--origin', origin, '--account', 'poc-reviewer', '--password-stdin', '--client', 'claude_code', '--yes'], `${PASSWORDS.get('poc-reviewer')}\n`).status, 0);
  assert.equal(JSON.parse(run(['status', '--json']).stdout).connection.status, 'not_connected');
  assert.equal(run(['nexus', 'connect'], `${API_KEY}\n`).status, 9);
  assert.equal(run(['nexus', 'connect', '--yes'], `${API_KEY}\n`).status, 0);
  assert.equal(run(['enable', 'pub_knowledge', '--key-stdin', '--yes'], `${BAD}\n`).status, 4);
  const enabled = run(['enable', 'pub_knowledge', '--key-stdin', '--yes', '--json'], `${GOOD}\n`);
  assert.equal(enabled.status, 0);
  assert.equal(JSON.parse(enabled.stdout).enablement.capabilitiesVersion, MANIFEST.version);
  assert.match(run(['agents', '--state', 'enabled']).stdout, /知识 Agent/);
  const invoked = run(['invoke', 'pub_knowledge', '--task', 'answer', '--input', '{"question":"住宿标准？"}', '--wait', '--yes', '--json']);
  assert.equal(invoked.status, 0, invoked.stderr);
  assert.equal(JSON.parse(invoked.stdout).status, 'ok');
  assert.equal(run(['enable', 'pub_unknown', '--key-stdin', '--yes'], `${GOOD}\n`).status, 5);
  assert.equal(run(['disable', 'pub_knowledge', '--yes']).status, 0);
  assert.equal(run(['logout', '--yes']).status, 0);
  assert.equal(run(['status']).status, 3);
});
```

- [ ] **Step 2：运行，确认失败**

运行：
- `python3 -m unittest discover -s audit-nexus/skills/agent-access/tests -v`
- `cd audit-nexus/poc/app && node --test test/unit/agent-access-cli.test.mjs`

预期：两个都失败。Python 报 `No module named 'agent_access'`；Node 那边脚本不存在，`spawnSync` 返回非零。

- [ ] **Step 3：实现** `skills/agent-access/scripts/agent_access.py`

```python
#!/usr/bin/env python3
"""agent-access：把你在 Nexus 上发布的 Agent 接入实现了 agent-access-v1 的应用（例如九安 PoC）。

只用 Python 3.9+ 标准库；约定与 nexus-ai-operator 一致：
- 写操作要加 --yes；没加时不发请求，只说明将要执行的操作，退出码 9；
- 口令、API 密钥、调用密钥只经标准输入传入，不出现在命令行参数里；
- 所有输出都先脱敏：nxc_ / nxa_ / nxp_ / afp_ 开头的串换成 [已隐藏]；
- 退出码：0 成功，2 用法，3 重新登录或先连接 Nexus，4 凭证被拒，5 不存在，6 状态不对或等待超时，7 限流，8 应用或 Nexus 不可用，9 需要确认。
会话保存在 $AGENT_ACCESS_HOME（缺省 ~/.agent-access）/credentials.json（0600，目录 0700），按 --profile 分开；不保存口令。
"""
import argparse
import base64
import json
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

INTERFACE = 'agent-access-v1'
EXIT_OK, EXIT_USAGE, EXIT_RELOGIN, EXIT_REJECTED, EXIT_NOT_FOUND, EXIT_STATE, EXIT_LIMITED, EXIT_UNAVAILABLE, EXIT_CONFIRM = 0, 2, 3, 4, 5, 6, 7, 8, 9
CLIENTS = ('claude_code', 'codex', 'kiro', 'cli', 'other')
SECRET_RE = re.compile(r'(?:nx[acp]|afp)_[A-Za-z0-9_-]{8,}')
SESSION_SECONDS = 8 * 3600
CODE_EXIT = {
    'POC_NEXUS_NOT_CONNECTED': EXIT_RELOGIN, 'POC_NEXUS_API_KEY_INVALID': EXIT_REJECTED, 'POC_CALL_KEY_INVALID': EXIT_REJECTED,
    'POC_ISSUE_NOT_ALLOWED': EXIT_REJECTED, 'POC_PUBLICATION_NOT_MINE': EXIT_NOT_FOUND, 'NOT_FOUND': EXIT_NOT_FOUND,
    'POC_CARD_UNAVAILABLE': EXIT_STATE, 'POC_AGENT_NOT_ENABLED': EXIT_STATE, 'POC_ME_RATE_LIMIT': EXIT_LIMITED,
    'POC_INVOKE_RATE_LIMIT': EXIT_LIMITED, 'POC_NEXUS_UNREACHABLE': EXIT_UNAVAILABLE,
}
WRITE_LABEL = {'login': '登录应用', 'logout': '删除本机的会话', 'connect': '把你的 Nexus 身份连接到应用', 'disconnect': '断开应用里的 Nexus 连接',
               'enable': '启用', 'disable': '停用', 'invoke': '调用测试（每次约 0.05 美元，记在发布者名下）'}


def redact(text):
    return SECRET_RE.sub('[已隐藏]', str(text))


class CliError(Exception):
    def __init__(self, exit_code, message, code=None):
        super().__init__(message)
        self.exit_code, self.message, self.code = exit_code, message, code


def exit_for(status, code):
    if code in CODE_EXIT:
        return CODE_EXIT[code]
    if status == 401:
        return EXIT_RELOGIN
    if status == 403:
        return EXIT_REJECTED
    if status == 404:
        return EXIT_NOT_FOUND
    if status == 409:
        return EXIT_STATE
    if status == 429:
        return EXIT_LIMITED
    if status >= 500:
        return EXIT_UNAVAILABLE
    return EXIT_USAGE


def split_globals(argv):
    flags, rest, index = {'yes': False, 'json': False, 'profile': 'default'}, [], 0
    while index < len(argv):
        arg = argv[index]
        if arg == '--yes':
            flags['yes'] = True
        elif arg == '--json':
            flags['json'] = True
        elif arg == '--profile' and index + 1 < len(argv):
            flags['profile'] = argv[index + 1]
            index += 1
        elif arg.startswith('--profile='):
            flags['profile'] = arg.split('=', 1)[1]
        else:
            rest.append(arg)
        index += 1
    return flags, rest


def read_secret(stream, label):
    if stream is None or stream.isatty():
        raise CliError(EXIT_USAGE, '%s要经标准输入传入，例如：… < key.txt' % label, 'secret_not_on_stdin')
    value = stream.readline().strip()
    if not value:
        raise CliError(EXIT_USAGE, '标准输入里没有读到%s。' % label, 'secret_empty')
    return value


class Store:
    def __init__(self, home):
        self.home = Path(home)
        self.path = self.home / 'credentials.json'

    def read(self):
        try:
            data = json.loads(self.path.read_text('utf-8'))
        except FileNotFoundError:
            return {'version': 1, 'profiles': {}}
        except (OSError, ValueError):
            raise CliError(EXIT_RELOGIN, '本机的会话文件 %s 已损坏，请重新登录。' % self.path, 'credentials_corrupt')
        if not isinstance(data, dict) or not isinstance(data.get('profiles'), dict):
            raise CliError(EXIT_RELOGIN, '本机的会话文件 %s 已损坏，请重新登录。' % self.path, 'credentials_corrupt')
        return data

    def write(self, data):
        self.home.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.home, 0o700)
        fd, tmp = tempfile.mkstemp(dir=str(self.home), prefix='.credentials.')
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as handle:
                json.dump(data, handle, ensure_ascii=False, indent=2)
            os.chmod(tmp, 0o600)
            os.replace(tmp, str(self.path))
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    def profile(self, name):
        return self.read()['profiles'].get(name)

    def save_profile(self, name, record):
        data = self.read()
        data['profiles'][name] = record
        self.write(data)

    def drop_profile(self, name):
        data = self.read()
        removed = data['profiles'].pop(name, None) is not None
        self.write(data)
        return removed


class App:
    def __init__(self, origin, cookie=None, csrf=None, timeout=120):
        self.origin, self.cookie, self.csrf, self.timeout = origin, cookie, csrf, timeout

    def request(self, method, path, body=None):
        headers = {'Accept': 'application/json'}
        data = None
        if body is not None:
            data = json.dumps(body).encode('utf-8')
            headers['Content-Type'] = 'application/json'
        if method != 'GET':
            headers['Origin'] = self.origin
        if self.cookie:
            headers['Cookie'] = self.cookie
        if self.csrf and method != 'GET':
            headers['X-CSRF-Token'] = self.csrf
        req = urllib.request.Request(self.origin + '/api/analysis/v1' + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                status, raw, cookies = resp.status, resp.read(), resp.headers.get_all('Set-Cookie') or []
        except urllib.error.HTTPError as err:
            status, raw, cookies = err.code, err.read(), err.headers.get_all('Set-Cookie') or []
        except (urllib.error.URLError, OSError) as err:
            raise CliError(EXIT_UNAVAILABLE, '连不上应用 %s：%s' % (self.origin, getattr(err, 'reason', err)), 'network_error')
        for value in cookies:
            if value.startswith('jiuan_analysis='):
                self.cookie = value.split(';', 1)[0]
        try:
            payload = json.loads(raw.decode('utf-8') or 'null')
        except ValueError:
            payload = None
        if status >= 400:
            error = (payload or {}).get('error') or {}
            code = error.get('code')
            raise CliError(exit_for(status, code), '%s（%s）' % (error.get('message') or 'HTTP %d' % status, code or status), code)
        return (payload or {}).get('data')


class Context:
    def __init__(self, flags, args, env, stdin, stdout):
        self.flags, self.args, self.stdin, self.stdout = flags, args, stdin, stdout
        self.store = Store(env.get('AGENT_ACCESS_HOME') or os.path.join(os.path.expanduser('~'), '.agent-access'))
        self.profile = flags['profile']

    def emit(self, data, text):
        self.stdout.write(redact(json.dumps(data, ensure_ascii=False, indent=2) if self.flags['json'] else text) + '\n')

    def confirm(self, action):
        if not self.flags['yes']:
            raise CliError(EXIT_CONFIRM, '将要执行：%s。用户确认后加 --yes 重新运行。' % action, 'confirmation_required')

    def app(self):
        record = self.store.profile(self.profile)
        if not record:
            raise CliError(EXIT_RELOGIN, '还没有登录：先运行 login。', 'not_logged_in')
        if record.get('expiresAt', 0) <= time.time():
            raise CliError(EXIT_RELOGIN, '会话已过期：重新运行 login。', 'session_expired')
        return App(record['origin'], record.get('cookie'), record.get('csrf')), record


def group_of(publication):
    enablement = publication.get('enablement')
    if enablement and enablement.get('status') != 'active':
        return 'problem'
    if publication.get('listed') is not False and (publication.get('status') != 'active' or (publication.get('a2a') or {}).get('enabled') is False
                                                   or ((publication.get('card') or {}).get('error'))):
        return 'problem'
    return 'enabled' if enablement else 'pending'


def summary(view):
    connection = view.get('connection') or {}
    lines = ['接口：%s' % view.get('interfaceVersion', '—'), '连接：%s' % connection.get('status', '—')]
    if connection.get('nexusUser'):
        lines.append('Nexus 账号：%s（%s）' % (connection['nexusUser'].get('name'), connection['nexusUser'].get('role')))
    for name, label in (('pending', '待启用'), ('enabled', '已启用'), ('problem', '有问题')):
        items = [p for p in view.get('publications') or [] if group_of(p) == name]
        lines.append('%s（%d）：%s' % (label, len(items), '、'.join('%s %s' % (p['publishId'], p.get('displayName', '')) for p in items) or '—'))
    lines.append('系统提供：%s' % ('、'.join(s['publishId'] for s in view.get('system') or []) or '—'))
    return '\n'.join(lines)


def cmd_login(ctx):
    if ctx.args.client not in CLIENTS:
        raise CliError(EXIT_USAGE, '--client 只能是 %s 之一。' % ' / '.join(CLIENTS), 'client_invalid')
    origin = ctx.args.origin.rstrip('/')
    ctx.confirm('%s：以 %s 登录 %s' % (WRITE_LABEL['login'], ctx.args.account, origin))
    password = read_secret(ctx.stdin, '口令')
    app = App(origin)
    ticket = (app.request('POST', '/poc/login', {'account': ctx.args.account, 'password': password}) or {}).get('ticket')
    app.request('POST', '/auth/exchange', {'ticket': ticket})
    session = app.request('GET', '/session') or {}
    ctx.store.save_profile(ctx.profile, {'origin': origin, 'account': ctx.args.account, 'client': ctx.args.client, 'cookie': app.cookie,
                                         'csrf': session.get('csrfToken', ''), 'expiresAt': int(time.time()) + SESSION_SECONDS})
    ctx.emit({'ok': True, 'profile': ctx.profile, 'origin': origin, 'account': ctx.args.account}, '已登录 %s（%s），会话 8 小时内有效。' % (origin, ctx.args.account))
    return EXIT_OK


def cmd_logout(ctx):
    ctx.confirm(WRITE_LABEL['logout'])
    removed = ctx.store.drop_profile(ctx.profile)
    ctx.emit({'ok': True, 'removed': removed}, '已删除本机的会话。' if removed else '这个 profile 没有保存的会话。')
    return EXIT_OK


def cmd_status(ctx):
    app, _ = ctx.app()
    view = app.request('GET', '/poc/nexus/me')
    ctx.emit(view, summary(view))
    return EXIT_OK


def cmd_refresh(ctx):
    app, _ = ctx.app()
    view = app.request('POST', '/poc/nexus/me/refresh', {})
    ctx.emit(view, summary(view))
    return EXIT_OK


def cmd_agents(ctx):
    app, _ = ctx.app()
    view = app.request('GET', '/poc/nexus/me')
    items = [p for p in view.get('publications') or [] if not ctx.args.state or group_of(p) == ctx.args.state]
    ctx.emit({'items': items}, '\n'.join('%s  %s  %s' % (group_of(p), p['publishId'], p.get('displayName', '')) for p in items) or '没有符合条件的发布。')
    return EXIT_OK


def cmd_nexus(ctx):
    connect = ctx.args.nexus_command == 'connect'
    ctx.confirm(WRITE_LABEL['connect' if connect else 'disconnect'])   # 先确认、再检查登录：没加 --yes 时一律退出码 9
    app, record = ctx.app()
    if connect:
        view = app.request('POST', '/poc/nexus/me/connect', {'apiKey': read_secret(ctx.stdin, 'API 密钥'), 'client': record.get('client', 'cli')})
    else:
        view = app.request('POST', '/poc/nexus/me/disconnect', {'client': record.get('client', 'cli')})
    ctx.emit(view, summary(view))
    return EXIT_OK


def cmd_enable(ctx):
    cost = '' if ctx.args.no_capabilities else '，并读一次能力清单（约 0.03 美元）'
    ctx.confirm('%s %s%s' % (WRITE_LABEL['enable'], ctx.args.publish_id, cost))
    app, record = ctx.app()
    body = {'loadCapabilities': not ctx.args.no_capabilities, 'client': record.get('client', 'cli')}
    if ctx.args.key_stdin:
        body['token'] = read_secret(ctx.stdin, '调用密钥')
    publication = app.request('POST', '/poc/nexus/me/agents/%s/enable' % ctx.args.publish_id, body)
    enablement = publication.get('enablement') or {}
    ctx.emit(publication, '已启用 %s：指纹 %s，能力清单 %s。' % (publication.get('displayName'), enablement.get('fingerprint'), enablement.get('capabilitiesVersion') or '没有读到'))
    return EXIT_OK


def cmd_disable(ctx):
    ctx.confirm('%s %s' % (WRITE_LABEL['disable'], ctx.args.publish_id))
    app, record = ctx.app()
    view = app.request('POST', '/poc/nexus/me/agents/%s/disable' % ctx.args.publish_id, {'client': record.get('client', 'cli')})
    ctx.emit(view, '已停用 %s。' % ctx.args.publish_id)
    return EXIT_OK


def cmd_invoke(ctx):
    ctx.confirm('%s：%s' % (WRITE_LABEL['invoke'], ctx.args.publish_id))
    app, _ = ctx.app()
    if ctx.args.task:
        raw = ctx.args.input or '{}'
        text = Path(raw).read_text('utf-8') if os.path.isfile(raw) else raw
        try:
            task_input = json.loads(text)
        except ValueError:
            raise CliError(EXIT_USAGE, '--input 要是 JSON 串或 JSON 文件。', 'input_invalid')
        if not isinstance(task_input, dict):
            raise CliError(EXIT_USAGE, '--input 要是一个 JSON 对象。', 'input_invalid')
        message = json.dumps({'task': ctx.args.task, 'input': task_input}, ensure_ascii=False)
    else:
        message = ctx.args.text
    attachments = [{'name': os.path.basename(f), 'type': '', 'data': base64.b64encode(Path(f).read_bytes()).decode('ascii')} for f in ctx.args.attach]
    body = {'publishId': ctx.args.publish_id, 'mode': 'text', 'text': message}
    if attachments:
        body['attachments'] = attachments
    run_id = (app.request('POST', '/poc/nexus/invoke', body) or {}).get('runId')
    if not ctx.args.wait:
        ctx.emit({'runId': run_id}, '已发起 %s，稍后用 run %s 查看结果。' % (run_id, run_id))
        return EXIT_OK
    deadline = time.time() + ctx.args.timeout
    while True:
        run = app.request('GET', '/poc/nexus/runs/%s' % run_id)
        if run.get('status') != 'running':
            ctx.emit(run, '结果：%s，用时 %s 毫秒\n%s' % (run.get('status'), run.get('latencyMs'), run.get('rawText') or run.get('errorCode') or ''))
            return EXIT_OK if run.get('status') == 'ok' else EXIT_STATE
        if time.time() > deadline:
            raise CliError(EXIT_STATE, '等了 %d 秒还没结束，稍后用 run %s 查看。' % (ctx.args.timeout, run_id), 'wait_timeout')
        time.sleep(3)


def cmd_runs(ctx):
    app, _ = ctx.app()
    page = app.request('GET', '/poc/nexus/runs?limit=%d' % max(1, min(50, ctx.args.limit)))
    items = page.get('items') or []
    ctx.emit(page, '\n'.join('%s  %s  %s  %s' % (r.get('id'), r.get('publishId'), r.get('task'), r.get('status')) for r in items) or '还没有调用记录。')
    return EXIT_OK


def cmd_run(ctx):
    app, _ = ctx.app()
    run = app.request('GET', '/poc/nexus/runs/%s' % ctx.args.run_id)
    ctx.emit(run, '%s  %s\n%s' % (run.get('status'), run.get('errorCode') or '', run.get('rawText') or ''))
    return EXIT_OK


def build_parser():
    parser = argparse.ArgumentParser(prog='agent_access.py', description='把 Nexus 上的 Agent 接入实现了 agent-access-v1 的应用。全局选项 --yes / --json / --profile 可以写在任何位置。')
    sub = parser.add_subparsers(dest='command', required=True)
    login = sub.add_parser('login', help='登录应用（口令只经标准输入）')
    login.add_argument('--origin', required=True)
    login.add_argument('--account', required=True)
    login.add_argument('--password-stdin', action='store_true', required=True)
    login.add_argument('--client', default='cli')
    for name in ('logout', 'status', 'refresh'):
        sub.add_parser(name)
    nexus = sub.add_parser('nexus', help='连接或断开你的 Nexus 身份')
    nexus_sub = nexus.add_subparsers(dest='nexus_command', required=True)
    nexus_sub.add_parser('connect', help='API 密钥只经标准输入')
    nexus_sub.add_parser('disconnect')
    agents = sub.add_parser('agents')
    agents.add_argument('--state', choices=('pending', 'enabled', 'problem'))
    enable = sub.add_parser('enable', help='启用；不带 --key-stdin 时用已保存的密钥重新验证')
    enable.add_argument('publish_id')
    enable.add_argument('--key-stdin', action='store_true')
    enable.add_argument('--no-capabilities', action='store_true')
    disable = sub.add_parser('disable')
    disable.add_argument('publish_id')
    invoke = sub.add_parser('invoke')
    invoke.add_argument('publish_id')
    group = invoke.add_mutually_exclusive_group(required=True)
    group.add_argument('--text')
    group.add_argument('--task')
    invoke.add_argument('--input')
    invoke.add_argument('--attach', action='append', default=[])
    invoke.add_argument('--wait', action='store_true')
    invoke.add_argument('--timeout', type=int, default=300)
    runs = sub.add_parser('runs')
    runs.add_argument('--limit', type=int, default=20)
    run = sub.add_parser('run')
    run.add_argument('run_id')
    return parser


HANDLERS = {'login': cmd_login, 'logout': cmd_logout, 'status': cmd_status, 'refresh': cmd_refresh, 'agents': cmd_agents, 'nexus': cmd_nexus,
            'enable': cmd_enable, 'disable': cmd_disable, 'invoke': cmd_invoke, 'runs': cmd_runs, 'run': cmd_run}


def main(argv=None, env=None, stdin=None, stdout=None, stderr=None):
    env = os.environ if env is None else env
    stdin, stdout, stderr = stdin or sys.stdin, stdout or sys.stdout, stderr or sys.stderr
    flags, rest = split_globals(list(sys.argv[1:] if argv is None else argv))
    try:
        args = build_parser().parse_args(rest)
    except SystemExit as exit_:
        return int(exit_.code or 0)
    ctx = Context(flags, args, env, stdin, stdout)
    try:
        return HANDLERS[args.command](ctx)
    except CliError as err:
        if flags['json']:
            stdout.write(redact(json.dumps({'ok': False, 'error': {'code': err.code, 'message': err.message}, 'exitCode': err.exit_code}, ensure_ascii=False)) + '\n')
        else:
            stderr.write(redact(err.message) + '\n')
        return err.exit_code
    except KeyboardInterrupt:
        return 130


if __name__ == '__main__':
    sys.exit(main())
```

- [ ] **Step 4：运行，确认通过**

运行：
- `python3 -m unittest discover -s audit-nexus/skills/agent-access/tests -v`：预期 6 个测试全部通过；
- `cd audit-nexus/poc/app && node --test "test/unit/**/*.test.mjs"`：预期全部通过，其中包括 `agent-access-cli.test.mjs`。

---

### Task 8：迁移、部署、端到端测试与文档

**Files:**
- Modify: 本机的 `poc/infra/secrets.env`，不打印任何值
- Create: `poc/app/test/e2e/access.e2e.mjs`
- Modify: `poc/app/test/e2e/run.sh`
- Modify: 以下文档：
  - `audit-nexus/docs/architecture.md`
  - `audit-nexus/poc/README.md`
  - `audit-nexus/poc/infra/README.md`
  - `audit-nexus/knowledge-agent/README.md`
  - `audit-nexus/docs/specs/2026-10-17-agent-registry-design.md`：把状态改成「已批准，第一期已实现」

**Interfaces:**
- Consumes：
  - 线上环境 https://andon-finance.tinyboat.blog
  - `secrets.env` 里的 `REVIEWER_PASSWORD`、`CHECKER_PASSWORD`、`E2E_KNOWLEDGE_A2A_KEY`，以及可选的 `E2E_NEXUS_API_KEY`

- [ ] **Step 1：迁移本机的 secrets.env**（Python 原地改写，不打印值）

```bash
cd audit-nexus/poc/infra && python3 - secrets.env <<'EOF'
import os, sys
path = sys.argv[1]
lines = open(path, encoding='utf-8').read().splitlines()
out = [('E2E_KNOWLEDGE_A2A_KEY=' + line.split('=', 1)[1]) if line.startswith('NEXUS_A2A_KEY_pub_2cc24c29d2e5b2c9=') else line for line in lines]
tmp = path + '.tmp'
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w', encoding='utf-8') as f: f.write('\n'.join(out) + '\n')
os.replace(tmp, path)
print('renamed:', sum(1 for line in lines if line.startswith('NEXUS_A2A_KEY_pub_2cc24c29d2e5b2c9=')))
EOF
```

预期：输出 `renamed: 1`。`REGISTRY_KEY` 由下一步的 `deploy.sh` 自动补上。

- [ ] **Step 2：写端到端测试** `test/e2e/access.e2e.mjs`

```js
/**
 * 「我的 Nexus」端到端测试（对线上地址，用命令行 agent_access.py 当调用方）。
 * 不花钱的：无效 API 密钥被拒、错误调用密钥被拒、用户隔离。花钱的（约 0.06 美元）：启用知识 Agent 并读能力清单、调用一次 answer。
 * 审核员第一次连接需要一把新的 API 密钥（E2E_NEXUS_API_KEY；用过一次就作废）。连接保存在实例上，之后的运行直接复用。
 * 请用 run.sh 运行：它先重启服务（顺带验证重启后连接与启用都还在），再从 infra/secrets.env 读口令与密钥。
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
  if (cli('reviewer', ['status', '--json']).json().connection.status !== 'connected') { t.skip('审核员没有连接 Nexus'); return; }
  assert.equal(cli('reviewer', ['enable', KNOWLEDGE, '--key-stdin', '--yes'], `nxa_${'0'.repeat(43)}\n`).status, 4);
  const enabled = cli('reviewer', ['enable', KNOWLEDGE, '--key-stdin', '--yes', '--json'], `${process.env.E2E_KNOWLEDGE_A2A_KEY}\n`);
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.equal(enabled.json().enablement.capabilitiesVersion, 'knowledge-agent-2026-10-17.2');
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
  if (cli('reviewer', ['status', '--json']).json().connection.status !== 'connected') { t.skip('审核员没有连接 Nexus'); return; }
  assert.equal(cli('reviewer', ['disable', KNOWLEDGE, '--yes']).status, 0);
  assert.equal(cli('reviewer', ['disable', KNOWLEDGE, '--yes']).status, 0);
  assert.equal(cli('reviewer', ['agents', '--state', 'pending']).stdout.includes(KNOWLEDGE), true);
});
```

`run.sh`：
- 在 `export E2E_REVIEWER_PASSWORD E2E_CHECKER_PASSWORD` 之后加两行：

```bash
E2E_KNOWLEDGE_A2A_KEY="$(secret E2E_KNOWLEDGE_A2A_KEY)"
E2E_NEXUS_API_KEY="$(secret E2E_NEXUS_API_KEY)"
export E2E_KNOWLEDGE_A2A_KEY E2E_NEXUS_API_KEY
```

- 把默认文件列表改成 `FILES=(poc.e2e.mjs attachments.e2e.mjs access.e2e.mjs)`。

另外两处修改：
- `poc-client.mjs`：
  - 新增 `me: () => call('/poc/nexus/me')`、`attachmentPolicy: () => call('/poc/nexus/attachment-policy')`；
  - 新增 `enable: (publishId, body) => call(`/poc/nexus/me/agents/${publishId}/enable`, { method: 'POST', body })`、`disable: publishId => call(`/poc/nexus/me/agents/${publishId}/disable`, { method: 'POST', body: {} })`。
- `attachments.e2e.mjs`：
  - 知识 Agent 不再是系统提供的，所以文件里自己启用一次，跑完再停用。`loadCapabilities: false`，不花钱；
  - 审核员没连接 Nexus 时，两条知识 Agent 用例跳过。

  把 `before` 和 `after` 改成：

```js
let knowledgeEnabled = false;
before(async () => {
  assert.ok(PASSWORD, '请用 run.sh 运行：它从 infra/secrets.env 读口令');
  await mkdir(SHOTS, { recursive: true });
  client = createPocClient({ base: BASE });
  await client.login('poc-reviewer', PASSWORD);
  if ((await client.me()).connection.status === 'connected' && process.env.E2E_KNOWLEDGE_A2A_KEY) {
    await client.enable(KNOWLEDGE, { token: process.env.E2E_KNOWLEDGE_A2A_KEY, loadCapabilities: false, client: 'cli' });
    knowledgeEnabled = true;
  }
});
after(async () => {
  await browser?.close();
  if (knowledgeEnabled) await client.disable(KNOWLEDGE).catch(() => {});
});
```

  第一个测试改成：

```js
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
```

  两条知识 Agent 用例的第二个参数改成 `async t => { if (!knowledgeEnabled) { t.skip('审核员没有连接 Nexus，知识 Agent 没有启用'); return; } … }`，原来的函数体不变。
  - 界面那条用例：面板里调用测试的下拉框，只列「已启用」和「系统提供」的发布。所以 `selectOption(KNOWLEDGE)` 改成：`knowledgeEnabled` 时选 `KNOWLEDGE`，否则选 `ADVISORY`；名片断言不变。
- `poc-client.mjs` 里的 `agents`、`refresh` 两个方法删掉；`scripts/try-agent.mjs` 的 `--list` 改成读 `me()`，打印「已启用 / 系统提供」的发布。

- [ ] **Step 3：部署并跑端到端测试**

```bash
cd audit-nexus/poc && infra/deploy.sh --code-only     # 跑单元测试、补上 REGISTRY_KEY、上传、重启
cd app/test/e2e && ./run.sh access.e2e.mjs attachments.e2e.mjs
```

预期：
- `deploy.sh` 打印「已在 …/secrets.env 里补上 REGISTRY_KEY」（只在第一次），健康检查通过；
- 端到端测试全部通过；如果审核员还没连接、也没有提供 `E2E_NEXUS_API_KEY`，审核员相关的几项会被跳过，并写明原因。

审核员第一次连接需要一把新的 API 密钥。执行前请主人做两件事中的一件：
- 在页面上连接一次；
- 或者在 Nexus「个人设置 › API 密钥」新建一把（只读档位），交给我写进 `secrets.env` 的 `E2E_NEXUS_API_KEY`，不打印。

- [ ] **Step 4：更新文档**
- `docs/architecture.md`：
  - 第 2 节：组件图里 PoC 插件下面加一行 `/poc/nexus/me*（每个账号的 Nexus 连接与启用，agent-access-v1）`；
  - 第 3 节「发现」：改写成「每个账号用自己的 API 密钥连接……」，删掉 EC2 管理员 API 密钥的说法；
  - 第 6 节：`REGISTRY_KEY`、账号目录、`E2E_*` 两项；
  - 第 8 节代码地图：加上 `access/` 的五个文件和 `skills/agent-access/`；
  - 第 9 节：第 2 步的「现在做到」改为「按账号身份列出、启用当场验证」；
  - 第 10 节：删掉「调用密钥写在 secrets.env」那一条。
- `poc/README.md`：「Nexus Agent」那一节改成「连接 → 启用 → 调用测试」；加上 `agent_access.py` 的四条常用命令。
- `infra/README.md`：
  - 密钥文件示例里，加上 `REGISTRY_KEY`、`E2E_KNOWLEDGE_A2A_KEY`、`E2E_NEXUS_API_KEY`（可选）三项；
  - 删掉 `NEXUS_API_KEY` 和知识 Agent 那一行；
  - 新增一段「每个账号的数据」：`/var/lib/andon-finance/users/`，重启、重新部署都不丢，实例被替换才会丢。
- `knowledge-agent/README.md`：把「调用密钥」那一行改成「在九安 PoC 的 Nexus Agent 页里启用（粘贴调用密钥）；端到端测试用的那一把在 `secrets.env` 的 `E2E_KNOWLEDGE_A2A_KEY`」。
- 设计文档的状态行改成「已批准；第一期已实现（2026-10-17）」。

- [ ] **Step 5：最后核对**

运行：`cd audit-nexus/poc/app && node --test "test/unit/**/*.test.mjs" && python3 -m unittest discover -s ../../skills/agent-access/tests`
预期：全部通过。端到端测试的结果和截图，在交付时一并交给主人确认。

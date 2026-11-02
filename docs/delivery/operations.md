---
subtitle: 九安审核平台 × Nexus AI · Finance-Audit-Nexus-PoC v0.7.10
date: 2026-11-02
status: 交付版 v3（只留新 UI：九安 v0.7.10 测试台；一台机器一个服务 andon-jiuan07）
scope: 九安 v0.7.10 测试台（栈 andon-finance-m7g；旧栈 andon-finance-poc 等删）与 Nexus nxs-beine1013（线上 Nexus AI 的实际地址：d3u3hj2us186y.cloudfront.net）
audience: 运维、值班、应用开发、Agent 开发
---

# 运维与后续迭代

## 1. 日常运维

一台实例上只有一个服务：测试台外壳 `andon-jiuan07`（用户 `jiuan07`，直接听 4180），里面跑新前端、九安 v0.7.10 的副本和外壳的接口；旁边是两个容器：MySQL `jiuan-mysql`、知识库的 PG `nexus-pgvector`。对外只有一个站点（CloudFront 分发 `Jiuan07Distribution`，别名是栈参数 `Jiuan07DomainName`）。2026-11-02 起没有 v0.5.3 PoC 的服务 `andon-finance-poc` 了。

下面的 `<站点>` 是这个栈的 `Jiuan07DomainName`：现在是 `jiuan-v0710.tinyboat.blog`（2026-11-02 从旧栈迁到 m7g 栈，[交接文档](handover.md)第 2.2 节）。

### 1.1 每天看什么

| 看什么 | 怎么看 | 正常的样子 |
|---|---|---|
| 站点是否在线 | `curl -fsS https://<站点>/poc/healthz` | HTTP 200 |
| AI 建议还出不出 | 单据池「最近审核」一栏有新的「AI 建议」；或者管理员模拟来单一张（`https://<站点>/poc/intake`），约 1 分钟后同步进单据池，读完原件后自动出建议 | 健康检查看不出这一点：调用密钥失效、Nexus 出错时它照样是 200（评审 I6，[交接文档](handover.md)第 6.1 节） |
| 两个容器 | 登上实例（第 1.2 节）：`sudo docker ps` | `jiuan-mysql`、`nexus-pgvector` 都是 Up |
| 服务日志 | 第 1.2 节 | 有「九安 v0.7.10 测试台已启动」；没有成串的错误码 |
| Nexus 费用 | Nexus 网页上发布者名下的用量 | 每一轮 AI 独立建议约 0.1–0.3 美元；「Agent 接入」页验证调用密钥不花钱 |
| AWS 费用 | 账单 | 一台 m7g.xlarge（按需价，以 AWS 价目表为准）、30 GiB gp3 根卷、公网 IPv4；升级前的快照很便宜 |

### 1.2 看日志

经 SSH 管理的栈（m7g 测试环境 `andon-finance-m7g` 就是）不用 SSM：22 端口只对环境配置里的 `SSH_ALLOWED_CIDR` 或 Instance Connect 端点开，用 `SSH_KEY_FILE` 以 `ec2-user` 登录，主机公钥用部署时钉住的那份（`poc/infra/README.md`「经 SSH 管理」）：

```bash
ssh -i <SSH_KEY_FILE> -o UserKnownHostsFile=poc/infra/.state/<栈>-<实例>.known_hosts ec2-user@<栈输出 ElasticIp>
# SSH_VIA=eice（m7g 测试环境是这样）：经 EC2 Instance Connect 端点，再加
#   -o ProxyCommand='aws ec2-instance-connect open-tunnel --region us-east-1 --instance-id <实例>'
sudo journalctl -u andon-jiuan07 -n 200 --no-pager          # 外壳（和九安）的日志
sudo tail -n 200 /var/log/cloud-init-output.log            # 首次启动的初始化日志
```

经 SSM 的栈（旧栈 `andon-finance-poc` 是）：`aws ssm start-session --region us-east-1 --target <InstanceId>`，再执行上面两条 `sudo …`。

直连时本机的公网地址变了就连不上：改环境配置里的 `SSH_ALLOWED_CIDR`，再跑一次 `deploy.sh`（更新栈）；经端点（`SSH_VIA=eice`）不看本机地址，要的是 AWS 凭证有 `ec2-instance-connect:OpenTunnel`。

日志里只有错误码和计数，没有口令、密钥、回复、制度内容和单据内容。要认得的几行：

| 日志 | 意思 | 要不要管 |
|---|---|---|
| `九安 v0.7.10 测试台已启动：…（端口 4180；AI 独立建议按「Agent 接入」的启用记录路由，当前 …）` | 服务起来了；括号里是审批流现在会发给谁 | 「当前 无可用发布」就去「Agent 接入」页指定审批 Agent |
| `POC_EGRESS_BLOCKED <主机>` | 九安代码想连 Nexus 以外的地址，被出网守卫挡了 | 偶尔有不用管；成串的说明有功能在找外部服务 |
| `POC_HLY_WRITE_BLOCKED <方法> <路径>` | 九安想往（假）汇联易写东西，被挡了 | 测试台不回写汇联易，不用管 |
| `POC_KB_AGENT_REPLY_LEADIN <操作> <字数>` | 知识库 Agent 在 JSON 前面多写了一句话（不超过 200 字、不含 `{ }`），外壳照样收下了 | 偶尔有不用管；每次都有，就去看知识库 Agent 的提示词 |
| `POC_CUSTOM_RULES_TRIMMED <单据> <页数>` | 发起人的「我的规则」太长，这一轮从末尾去掉了几页原件 | 告诉这个人删减规则 |
| `POC_KB_BACKEND_MISMATCH <方式> <backend>` | 知识库 Agent 说的后端和部署配置的知识库方式对不上 | 核对「Agent 接入」页启用的是哪个知识库 Agent |

### 1.3 重启与健康检查

```bash
# 在实例上（第 1.2 节的会话里）
sudo systemctl restart andon-jiuan07.service && sleep 5 && systemctl is-active andon-jiuan07.service
curl -fsS http://127.0.0.1:4180/poc/healthz                 # 实例上直接看
curl -fsS https://<站点>/poc/healthz                         # 本机经 CloudFront 看
```

重启会：
- 用 `/opt/andon-finance/current` 里现有的版本起来：启动时不从构件桶拉包，换版本只经 `deploy.sh`；
- 外壳启动时读一次新前端的 `dist/` 和 `/etc/andon-finance/jiuan07/` 下的配置；
- 单据、AI 建议的各轮、「Agent 接入」的启用记录都在 MySQL 里，重启不丢。

## 2. 操作手册

### 2.1 接入一个新 Agent（固定的四步使用逻辑）

![接入一个新 Agent 的时序：建好、发布 → 本人签发调用密钥 → 管理员在「Agent 接入」页启用 → 设为审批 Agent 或测试](../assets/diagrams/ops-onboard-agent.svg)

nexus-ai-operator 怎么装、怎么连见 [Skills 配置指南](skills-guide.md)；页面上一步步怎么点见[快速上手](quick-guide.md)。

1. **构建与发布**（Agent 开发，用 Claude Code / Codex / Kiro CLI + nexus-ai-operator Skill）：建 Agent、写提示词、在平台内试用、建发布并打开 A2A。要接审批流的，名片要声明 `review_advice@1`（[开发者快速对接指南](developer-guide.md)）。
2. **签发调用密钥**（发布者本人，Nexus 网页「互联中心 › 对外发布」）。Operator 和 API 密钥都签不了，这是平台的限制。
3. **启用**（管理员）：新前端「Agent 接入」页，在这个发布一行点「启用」，只粘贴调用密钥，「验证并启用」。平台当场验证名片和密钥（不花钱），通过后 Agent 就绪；页面上只显示指纹。
4. **用起来**：要它审单就「设为审批 Agent」（要写原因，同一时间只有一个）；不然它只是就绪，供前端工作流调用。点「测试」（文本、请求信封、单据）看它回什么；改了提示词后点「重新验证」。

不需要改 `secrets.env`，不需要部署，不需要重启。

### 2.2 审批流调谁、用哪把调用密钥

单据池的 AI 独立建议只发给管理员在「Agent 接入」页指定的那一个**审批 Agent**，用的是它启用时粘贴的那把调用密钥（在九安的库里，加密）。现在是「九安审核AI（PoC）」`pub_5c53e70d8dc7ddea`。

- 没有审批 Agent，或它停用、密钥失效：这一轮记成 `AGENT_TASK_UNROUTED`，表格上方一行写着审批流停着；在一个就绪的 Agent 上「设为审批 Agent」，或给它「换钥匙」，九安的流水线会自动重排。
- Nexus 不认这把密钥时，这一行变成「密钥失效」：在 Nexus 上签一把新的，点「换钥匙」粘贴；不用改文件，不用部署。
- 知识库 Agent「知识库文档管家（PG 版）」也在这一页启用，就绪、不进审批流；它的密钥失效时，知识库页的操作都会失败。

开发测试阶段，给出的密钥一直用到过期，不主动吊销、不轮换。

### 2.3 换口令

改 `secrets.env` 里的 `REVIEWER_PASSWORD` / `CHECKER_PASSWORD`（至少 12 个字符），再 `deploy.sh --code-only`。另外三项（`BENCH_MYSQL_ROOT_PASSWORD`、`JIUAN07_MYSQL_APP_PASSWORD`、`JIUAN07_DATA_KEY`）不要换，见第 2.6 节。

### 2.4 「Agent 接入」页上连不上或启用失败

先看页面上的提示，或调用记录、操作记录里的错误码：

| 错误码 | 页面上的说法 | 处理 |
|---|---|---|
| `AGENT_NEXUS_NOT_CONNECTED`、`AGENT_NEXUS_RECONNECT` | 还没有连接 Nexus / 连接失效了 | 点「连接 Nexus」，用自己的 API 密钥重新连接 |
| `AGENT_NEXUS_KEY_INVALID` | API 密钥无效、已经用过，或者不属于这个 Nexus | 在 Nexus「个人设置 › API 密钥」新建一把再连接（第一次连接后平台会换新，原来那串作废） |
| `AGENT_NEXUS_UNREACHABLE` | 连不上 Nexus | 稍后点「刷新清单」；**不要**因此去换新的 API 密钥 |
| `AGENT_KEY_REJECTED` | Nexus 不认这把密钥 | 在这个发布里重新签一把，「换钥匙」或重新启用 |
| `AGENT_KEY_WRONG_PUBLICATION` | 密钥属于别的发布或发布已暂停 | 确认粘的是这个发布的调用密钥；在 Nexus 上恢复发布 |
| `AGENT_PUBLICATION_NOT_FOUND`、`AGENT_CARD_INVALID` | 读不到名片 / 名片不合契约 | 在 Nexus 上确认发布没暂停、A2A 打开了 |
| `AGENT_VERIFY_TIMEOUT` | 验证超时 | 稍后再试 |
| `AGENT_TEST_RATE_LIMIT` | 测试太频繁 | 每分钟最多 5 次，等一分钟 |

### 2.5 实例被替换、换机器

实例被替换（重建栈、换 AMI、改根卷大小、实例故障）后，根卷上的东西都会丢：MySQL 的 `jiuan07` 库（单据、AI 建议、复核、启用记录）、知识库的 PG、`/var/lib/jiuan07/`（「Agent 接入」页的 Nexus 连接、我的规则）。新实例上要重新 `deploy.sh`、`kb.sh db`，再把数据放回去，或者管理员重新连接 Nexus、重新启用 Agent。

- **替换前**：先跑 `poc/infra/backup.sh`（根卷快照；MySQL、PG 和 `/var/lib/jiuan07` 都在根卷上，一个快照就够）。要整盘恢复，用快照建卷替换根卷。
- **换实例类型**：用 `upgrade-instance.sh <类型>`，它只允许停机再开，不替换实例；不能在 arm64 和 x86 之间换。
- **换机器**（另建一个栈）：新栈 `deploy.sh` → `kb.sh db` → `migrate-data.sh`（搬 `jiuan07` 库、PG 库 `nexus`、`/var/lib/jiuan07`；两边 `secrets.env` 要是同一份）→ `kb.sh connector`（把 Nexus 指到新 PG，先 `--dry-run`）→ 端到端测试 → 迁域名前 `migrate-data.sh --skip-pg` 再同步一次。步骤见 [`poc/infra/README.md`](../../poc/infra/README.md)「换机器时搬数据」。

### 2.6 测试台：MySQL 的检查、重置、备份

- **检查**：在实例上 `sudo docker ps`，再 `sudo docker exec jiuan-mysql sh -c 'MYSQL_PWD="$(cat /run/bench-secrets/mysql_root_password)" mysqladmin ping -uroot'`。
- **重置**（端到端测试会自动做）：`sudo bash /opt/andon-finance/current/bench/bench07-reset.sh`：停服务，导出「Agent 接入」的启用记录，删掉并重建 `jiuan07` 库、删掉种子时间锚点，起服务跑迁移，写回启用记录，再起服务、等健康检查。单据从假汇联易重新同步。
- **升级前备份**：`poc/infra/backup.sh`（根卷快照）。
- **换实例类型**：`poc/infra/upgrade-instance.sh <类型>`：只允许停机再开；变更集里实例会被替换就不执行。
- **测试台密钥只认原值**：实例上已有的 MySQL root 口令（`/etc/andon-finance/bench/`）、`jiuan07_app` 的口令和数据密钥（`/etc/andon-finance/jiuan07/`）和 `secrets.env` 里的不一样时，部署在重启之前就失败，服务照旧跑。多半是 `secrets.env` 被重新生成了：找回交接的那份。真要换 `jiuan07_app` 的口令或数据密钥，先运行 `bench07-reset.sh` 重建库（库里的数据和启用记录会全部重建）。

### 2.7 AI 建议出不来、慢

![单据池里一张单「AI 失败」时，按「Agent 接入」页调用记录里的错误码处理](../assets/diagrams/ops-troubleshoot.svg)

先在「Agent 接入」页下方的调用记录里找到这一轮，看错误码和用时，「查看反馈」看 Agent 返回了什么：

| 现象 | 原因 | 处理 |
|---|---|---|
| `AGENT_TASK_UNROUTED` | 没有就绪的审批 Agent | 第 2.2 节 |
| `AI_AUTH_INVALID`，或这一行「密钥失效」 | Nexus 不认这把调用密钥 | 「换钥匙」，再在单据抽屉里「重新审核」 |
| `AI_UNAVAILABLE` | 一轮超过 180 秒，或 Nexus 5xx、预算用完 | 看 Nexus 状态和预算；按下面的办法查慢在哪；稍后「重新审核」 |
| `AI_RATE_LIMIT` | Nexus 限流 | 稍后重试 |
| `AI_INVALID_RESPONSE` | 回答修正一次后仍不合契约 | 看「查看反馈」；多半要改审核 Agent 的提示词（[部署与迭代规范](deploy-iteration.md)第 6.3 节） |
| `CUSTOM_RULES_TOO_LONG` | 发起人的「我的规则」加上单据放不进九安一次请求（87,442 字） | 请他删减规则；上传时单个文件就超过的回 `CUSTOM_RULES_UNSENDABLE` |
| 知识库页操作失败，`KB_AGENT_REPLY_INVALID` | 知识库 Agent 的回复不合格式（不重试） | 看知识库 Agent 的提示词；它的密钥失效时在「Agent 接入」页换钥匙 |

**一轮 AI 建议慢、超时**：一轮的上限是 180 秒，正常是 7–20 秒。到 Nexus 上看这一轮的 A2A 会话，查 Agent 到底查了几次库、每次查什么、哪一步慢。会话存在发布者名下，用发布者的账号经 nexus-ai-operator 只读查：

```bash
python3 skills/nexus-ai-operator/scripts/nexus.py call GET /api/v2/me/sessions --raw            # 找到这一轮的会话
python3 skills/nexus-ai-operator/scripts/nexus.py call GET /api/v2/sessions/<会话编号>/messages --raw
```

2026-11-01 就是这样查到的：提示词还要求定审批路径，可知识库里没有审批矩阵的行，Agent 一轮查 11–16 次（SQL 本身很快）。看记录时注意两点：同一张单一模一样地重发，会落进同一段对话、回得很快，量时长要换一张单；大多数第一次调用会碰到 Bedrock 的 `ValidationException`（回放 reasoningContent），九安的重试会接住，它不是慢的原因。

**改审核 Agent 的提示词**：按[部署与迭代规范](deploy-iteration.md)第 6.3 节，每次改线上都在 `audit-agent/prompt-history/` 留底。

**知识库**：测试台经 A2A 调 PG 知识库 Agent（`pub_6ea5f0855dff6c1b`，调用密钥在「Agent 接入」页启用）。部署、核对 PG 本身见 [kb/GUIDE.md](../../kb/GUIDE.md)。

### 2.8 清理 v0.5.3 PoC 留在实例上的东西

新代码部署时（`bench/bench07-configure.sh`）会停掉、删掉 v0.5.3 PoC 的服务单元 `andon-finance-poc.service`、它的补充配置和转发设置；它的数据不动，要另外清。旧栈 `andon-finance-poc` 整个删掉时（[交接文档](handover.md)第 6 节第 24 条）一起没，不用单独清。m7g 实例上 2026-11-02 从旧机器搬来的那一份、和按旧模板建栈时留下的，新代码都不再用：

| 东西 | 在哪 |
|---|---|
| v0.5.3 的两个库、应用账号 | MySQL 容器 `jiuan-mysql` 里的库 `jiuan_analysis`、`jiuan_bench_test`，账号 `jiuan_app` |
| 各账号的 Nexus 连接与启用（调用密钥用旧的 `REGISTRY_KEY` 加密）、旧的共享 CLI 连接 | `/var/lib/andon-finance/`（系统用户 `andon` 的家目录） |
| v0.5.3 的配置与密钥文件 | `/etc/andon-finance/env`、`/etc/andon-finance/bench.env`、`/etc/andon-finance/bench/mysql_app_password`、`/etc/andon-finance/bench/analysis_data_key` |
| 启动时拉包的脚本 | `/usr/local/bin/andon-finance-fetch` |

**不要动**：`/etc/andon-finance/secrets.env`、`/etc/andon-finance/bench/mysql_root_password`、`/etc/andon-finance/jiuan07/`、`/var/lib/jiuan07/`、MySQL 的 `jiuan07` 库、`/opt/andon-finance/`。

2026-11-02 已在 m7g 实例上照下面清过一次（另外删了 `andon` 用户和组）。以后在别的实例上要清，做法（项目负责人当场同意后再动手；先 `poc/infra/backup.sh` 做根卷快照）：

```bash
# 在实例上（第 1.2 节的会话里）
sudo docker exec -i jiuan-mysql sh -c 'MYSQL_PWD="$(cat /run/bench-secrets/mysql_root_password)" mysql -uroot' <<'SQL'
DROP DATABASE IF EXISTS `jiuan_analysis`;
DROP DATABASE IF EXISTS `jiuan_bench_test`;
DROP USER IF EXISTS 'jiuan_app'@'%';
SQL
sudo rm -f /etc/andon-finance/env /etc/andon-finance/bench.env /etc/andon-finance/bench/mysql_app_password /etc/andon-finance/bench/analysis_data_key /usr/local/bin/andon-finance-fetch
sudo rm -rf /var/lib/andon-finance
id andon >/dev/null 2>&1 && sudo userdel andon
curl -fsS http://127.0.0.1:4180/poc/healthz                 # 测试台照常
```

清完在[交接文档](handover.md)第 6 节第 24 条记一笔。

### 2.9 销毁

```bash
DEPLOY_ENV=poc/infra/env/<环境>.env audit-nexus/poc/infra/destroy.sh     # 要求输入栈名确认
```

销毁前确认：构件桶里没有要留的东西；数据要留的先 `backup.sh` 或 `migrate-data.sh` 搬走；Nexus 的 PG 连接器和数据库凭证密钥没有指着这台的 PG（[交接文档](handover.md)第 6 节第 23 条）；用不着的调用密钥、API 密钥在 Nexus 上停用。

## 3. 后续迭代的最佳方式

### 3.1 固定的四步使用逻辑

一切设计都按这条走，这条不会变：

1. **构建**：开发者用 Claude Code / Codex / Kiro CLI + Operator Skill 在 Nexus 上建 Agent、发布、拿调用密钥。
2. **发现与加载**：前端经 A2A 读名片，管理员在「Agent 接入」页启用、测试。
3. **按业务迭代**：用 vibe coding 优化前端的调用方式和界面。
4. **测试、上线**：单元测试 + 端到端测试 + 项目负责人确认。

知识和 Agent 在一起（在 Nexus 上）；前端只做调用，知识库由 Nexus 上的知识库 Agent 读写。

### 3.2 一次迭代怎么走

| 步骤 | 做什么 | 产出 |
|---|---|---|
| 1 需求 | 写清楚要什么、给谁用、怎么算做成 | 一段需求说明 |
| 2 设计 | 改接口、改数据、改流程的，写设计文档并评审；小改动在合并请求里写清楚 | 设计文档（放在开发仓库） |
| 3 计划 | 拆成小任务，每个任务带测试 | 实现计划（放在开发仓库） |
| 4 实现 | 先写会失败的测试，再写实现 | 代码 + 测试 |
| 5 评审 | 整体评审一次，Critical / Important 当场修 | 评审记录 |
| 6 部署与验证 | 按[部署与迭代规范](deploy-iteration.md)第 5 节 | 端到端测试结果、截图 |
| 7 确认与记录 | 项目负责人确认；写 `CHANGELOG.md`；更新文档并生成 HTML | 标签 `poc-YYYYMMDD-N` |

用编码工具（Claude Code、Codex、Kiro CLI）的时候，把这份文档和[开发者快速对接指南](developer-guide.md)交给它；写操作一律要人确认后才加 `--yes`，密钥只经标准输入。

### 3.3 改 Agent 时

- 审核 Agent 的提示词放在仓库里（`audit-agent/prompt.yaml`），只经 `audit-agent/apply.py` 下发；每次改都把 `agentVersion` 的日期和序号加一，在 `audit-agent/prompt-history/` 留底。
- 先在 Nexus 上试用，再在「Agent 接入」页「测试」一次（请求信封、单据），最后跑相关的端到端测试。
- 任务约定只增不改：已有任务的输入输出不改含义；要改就升任务的版本。

### 3.4 改应用时

- 新接口加在外壳里（`/api/analysis/v1/poc/*`，挂在九安的 `platformRoutes` 钩子上），不改九安原接口；九安的改动只经 `patches/jiuan-v0.7.10/` 下的补丁。
- 新前端只调本站后端，不直连 Nexus。
- 涉及密钥的代码：返回里只出现指纹；日志只记错误码；测试里检查输出没有密钥。
- 新接口都按「这个人的公司 ∩ 测试台的公司」过滤（`poc/app07/user-scope.mjs`）。

## 4. 下一步要建的运维能力

按优先级：

1. **构件包名和健康检查带上提交号**（评审 C1；[部署与迭代规范](deploy-iteration.md)第 2 节）。
2. **源站走 HTTPS** 并加源站校验头（评审 C2）。
3. **可观测性**：每个请求、每次 Nexus 调用一行 JSON 日志（不含密钥），送 CloudWatch；定时用 `tasks/get`（不花钱）探测审批 Agent 那把调用密钥，结果放进健康检查；健康、5xx 比例、`AI_AUTH_INVALID` 比例设告警（评审 I6）。
4. **主机打补丁**：SSM Patch Manager 或定时 `dnf upgrade`（评审 I11）。
5. **定时备份**：`backup.sh` 现在要手动跑；改成定时。
6. **预发环境**：同一模板另建一个栈，部署到九安之前先在那里验证（评审 I10）。
7. **调用量与费用看板**：按发布统计调用次数（调用记录在九安的库里）。

编号对应[交接文档](handover.md)第 6.1 节「上生产前必须改的」。

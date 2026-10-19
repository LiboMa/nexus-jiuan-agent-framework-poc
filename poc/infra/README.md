# andon-finance PoC：部署、放密钥、清理

一台 EC2（t3.large）在 Nexus 同 VPC 的公有子网（`subnet-0dda59910e53ee804`）上运行九安原服务端与前端，单据都是虚构的。2026-10-19 起是测试台：九安的单据和平台状态存在本机 MySQL 8.0（Docker 容器 `jiuan-mysql`）里，审批流状态和会话还在内存里。
整体架构见 [`../../docs/architecture.md`](../../docs/architecture.md)，怎么用见 [`../README.md`](../README.md)。
站点只经 CloudFront 暴露在 https://andon-finance.tinyboat.blog：安全组只放 CloudFront 回源前缀列表 `pl-3b927c52` 访问 4180 端口，不开 22。

## 前提

- 本机有 AWS CLI v2，凭证属于 533267047935，可以建 CloudFormation 栈、写构件桶、执行 SSM Run Command（部署时重启实例上的服务用；不用 Parameter Store）。
- Node.js ≥ 24，用来跑单元测试和生成前端副本。
- 九安开发包已解压在 `audit-nexus/source/审核平台-测试环境开发包-v0.5.3/code`。
- 本机有 nexus-ai-operator，路径为 `~/MyDev/LLM/Nexus-AI-strands/Nexus-AI/skills/system_skills/nexus-ai-operator`；只打包其中的 `scripts/nexus.py`，不打包任何凭据。

## 部署与更新

```bash
audit-nexus/poc/infra/deploy.sh             # 首次：建栈（CloudFront 约 5–15 分钟）、生成口令、上传、启动、健康检查
audit-nexus/poc/infra/deploy.sh --code-only # 只改了代码：上传并重启
```

重启不丢单据（在 MySQL 里），但会清空审批记录与会话，需要重新登录。各账号的 Nexus 连接与启用不受影响，见下面「每个账号的数据」。

测试台（MySQL 与九安真实运行时）：
- `deploy.sh` 先构建九安副本（`poc/bench/build-jiuan.sh`），重启前在实例上配置测试台（`bench/bench-configure.sh`：三个密钥文件、`/etc/andon-finance/bench.env`、装好或确认 MySQL）；`POC_STORE`（默认 `mysql`）决定用哪种存储，`POC_STORE=memory deploy.sh --code-only` 回到内存存储。
- 三项测试台密钥 `BENCH_MYSQL_ROOT_PASSWORD`、`BENCH_MYSQL_APP_PASSWORD`、`BENCH_DATA_KEY` 缺了才补，已有的不改；`BENCH_DATA_KEY` 换了库就打不开。
- `backup.sh`：升级前备份；`upgrade-instance.sh <类型>`：换实例类型，只允许停机再开；`bench-test.sh`：在实例上跑要 MySQL 的单元测试。

改配置，比如换审批建议所用的发布 `AdvisoryPublicationId`，或者改 `NexusOrigin`、`AppPort`：
1. 用 `aws cloudformation deploy --parameter-overrides <参数>=<新值> …` 更新栈参数（模板路径与其余参数同 `deploy.sh`）；
2. 再运行一次 `deploy.sh --code-only`。

每次部署都会按栈参数重写实例上的 `/etc/andon-finance/env`，再重启服务。用户数据只在实例首次启动时执行一次，改它不会重新执行，所以不靠它同步配置。

## 口令与密钥：`infra/secrets.env`

全部口令与密钥都在本机这一份文件里，权限 0600。第一次运行 `deploy.sh` 时，它会生成这份文件，填好两条随机口令和 `REGISTRY_KEY`；已有的文件缺 `REGISTRY_KEY` 时，`deploy.sh` 会补上。

```
REVIEWER_PASSWORD=…                         # 审核员（虚构）的口令
CHECKER_PASSWORD=…                          # 复核人（虚构）的口令
REGISTRY_KEY=…                              # 加密各账号调用密钥用（32 字节 base64）；换掉它，所有账号都要重新启用 Agent
NEXUS_A2A_KEY_pub_5c53e70d8dc7ddea=nxa_…    # 可选兜底：审批流先用页面上启用的那把，系统里一把都没有时才用这里的
E2E_KNOWLEDGE_A2A_KEY=nxa_…                 # 可选，只给端到端测试用：审核员本人启用了知识 Agent 时测试直接用本人的
E2E_NEXUS_API_KEY=nxc_…                     # 可选，只给端到端测试用：审核员第一次连接 Nexus 的 API 密钥，用过一次就作废
```

其他 Agent 不再写进这个文件：每个账号在 Agent 页上自己连接 Nexus、粘贴调用密钥启用（见 [`../README.md`](../README.md)）。

- **改完生效**：运行 `infra/deploy.sh --code-only`。脚本把文件上传到私有、加密的构件桶（`secrets/secrets.env`），装到实例的 `/etc/andon-finance/secrets.env`（root:andon，0640），再重启服务，应用就会读取新值。
- **不要外传**：这份文件不进构件、不进文档。
- **调用密钥只能本人签发**：Nexus 只认网页登录的本人，经 API 密钥（包括 nexus-ai-operator）签发会被拒（`api/v2/services/access_credential_service.py:283-286`）。新发布的 Agent 在网页上签一把，再到 PoC 的 Agent 页上粘贴启用，不用改这个文件、不用重新部署。

## 每个账号的数据

在实例的 `/var/lib/andon-finance/users/<账号>/`（目录 0700、文件 0600，属主 andon）：

| 文件 | 内容 |
|---|---|
| `nexus/` | 这个账号的 operator CLI 凭证。连接时用的 API 密钥只能用一次，平台会立刻换成新的连接密钥，由 CLI 保存在这里 |
| `enabled.json` | 启用的 Agent，调用密钥用 `REGISTRY_KEY` 加密 |
| `connection.json` | 连接时间与 Nexus 账号，不含密钥 |
| `audit.jsonl` | 留痕：连接、断开、启用、换密钥、重新验证、停用、标记失效 |

重启、重新部署都不丢，实例被替换才会丢：那时各账号要重新连接、重新启用。

## 测试

```bash
cd audit-nexus/poc/app
node --test "test/unit/**/*.test.mjs"   # 单元测试，deploy.sh 每次都先跑
test/e2e/run.sh                          # 端到端：先重建测试台的库（bench-reset.sh），再跑全部，约 0.36 美元
test/e2e/run.sh attachments.e2e.mjs      # 只跑 A2A 发现与附件，约 0.15 美元
test/e2e/run.sh access.e2e.mjs           # 只跑连接、启用、调用、停用，约 0.06 美元
```

审核员还没连接 Nexus、也没有 `E2E_NEXUS_API_KEY` 时，要用知识 Agent 的几项会跳过，并写明原因。

## 附件上限

调用测试的附件：最多 5 个，单个不超过 5 MB，合计不超过 6 MB（`app/nexus/attachments.mjs`）。

Nexus 本身允许单个 20 MB、合计 40 MB。但 nxs-beine1013 用的是旧部署模板，ALB 没有把 `/a2a/*` 转到发布网关，请求要经前端反代，超过 10 MB 的请求体会被截断，而 base64 编码后附件还要再大三分之一。按新模板加上这条 ALB 规则（`infrastructure/cloudformation/nexus-ai-env.yaml:906-916`）之后，可以把上限调到和 Nexus 一致。

## 排查

- 健康检查：`curl -fsS https://andon-finance.tinyboat.blog/api/health`。
- 实例日志：
  1. `aws ssm start-session --region us-east-1 --target <InstanceId>`；
  2. 在会话里执行 `sudo journalctl -u andon-finance-poc -n 200`。
- 初始化日志：在上面的会话里执行 `sudo tail -n 200 /var/log/cloud-init-output.log`。

## 清理

```bash
audit-nexus/poc/infra/destroy.sh   # 要求输入栈名确认
```

## 费用（估计）

- t3.large 约 61 美元 / 月（2026-10-19 前是 t3.small，约 15 美元），16 GB gp3 根卷约 1.3 美元 / 月，公网 IPv4 约 3.6 美元 / 月；CloudFront、S3 基本可以忽略。
- 每次 Agent 调用约 0.05 美元，记在 Nexus 发布者名下；带附件的调用 Token 更多，会贵一些。

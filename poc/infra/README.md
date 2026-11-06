# andon-finance PoC：部署、放密钥、清理

一台 EC2（默认 m7g.xlarge，arm64）在 Nexus 同 VPC 的公有子网（`subnet-0dda59910e53ee804`）上运行九安 v0.7.10 测试台：新前端 `poc/web` + 外壳 `poc/app` + 九安 v0.7.10 的副本，单据都是虚构的。九安的单据和平台状态存在本机的 PostgreSQL 17（Docker 容器 `jiuan-pg`，只听 127.0.0.1:5433，库 `jiuan`）里，2026-11-06 从 MySQL 换过来（见下面「九安的库」）；知识库的 PG（容器 `nexus-pgvector`）也在这台上，由 `kb.sh` 部署。
整体架构见 [`../../docs/architecture.md`](../../docs/architecture.md)，怎么用见 [`../README.md`](../README.md)。
站点只经 CloudFront 暴露（一个分发 `Distribution`，别名是栈参数 `DomainName`）：外壳（服务 `andon-jiuan`，用户 `jiuan`）直接听 `0.0.0.0:4180`，安全组只放 CloudFront 回源前缀列表 `pl-3b927c52` 访问 4180；22 端口只在经 SSH 管理时对 `SSH_ALLOWED_CIDR` 或 Instance Connect 端点开。2026-11-02 起没有 v0.5.3 PoC 的进程、没有按 Host 转发，也没有 `andon` 用户。

部署分三块，这里只管第一块：
1. **前端**（本目录的 `deploy.sh`）：外壳、新前端、九安副本、九安的 PostgreSQL。以后由专人部署；测试阶段和下面两块在同一台机器上。
2. **PG 与知识库后端**（`../../kb/`，测试台上用本目录的 `kb.sh` 驱动）：见 [`../../kb/README.md`](../../kb/README.md)。客户那边先用自己的 SSH 密钥部署 PG，再分批部署前端（`kb/GUIDE.md` 第 4 节）。
3. **Nexus 上的 Agent 与发布**：`../../audit-agent/`、`../../knowledgebase-writer-agent-pg/`（客户部署件在 `../../customer-deploy/`）、`../../skills/nexus-ai-operator`。

## 前提

- 本机有 AWS CLI v2，凭证属于 533267047935，可以建 CloudFormation 栈、写构件桶；经 SSM 管理的栈还要能执行 SSM Run Command，经 SSH 管理的栈要能读实例的控制台输出（`SSH_VIA=eice` 时还要 `ec2-instance-connect:OpenTunnel`）。不用 Parameter Store。
- Node.js ≥ 24 和 npm，用来跑测试、构建新前端、装九安副本的依赖；还要 `rsync` 和 `patch`（构建九安副本时用）。
- 九安开发包已解压在 `audit-nexus/source/九安自助审核平台-测试环境开发包-v0.7.10/`（`poc/bench/build-jiuan.sh` 从这里复制）。
- nexus-ai-operator 用仓库里的 `skills/nexus-ai-operator/scripts/nexus.py`（1.1.0），不用另外装；要换版本设环境变量 `NEXUS_OPERATOR_SCRIPT`。只打包这一个脚本，不打包任何凭据（外壳的「Agent 接入」页用它连 Nexus）。

## 部署与更新

```bash
DEPLOY_ENV=poc/infra/env/<环境名>.env poc/infra/deploy.sh             # 首次：建栈（CloudFront 约 5–15 分钟）、生成口令和密钥、上传、装构件、配置、启动、健康检查
DEPLOY_ENV=poc/infra/env/<环境名>.env poc/infra/deploy.sh --code-only # 只改了代码：测试、构建、上传、装构件、配置、重启、健康检查
```

环境配置的样例是 `env/example.env`（栈名、区域、VPC 与子网、实例类型、站点、Nexus、知识库方式、SSH）；不给 `DEPLOY_ENV` 时栈名缺省是 `andon-finance-poc`。

`deploy.sh` 依次做：
1. 动 AWS 之前：跑 `poc/infra/test` 的测试，构建九安 v0.7.10 副本（`poc/bench/build-jiuan.sh`：按清单复制 + 补丁 + 锁定版本的 `pg`），新前端 `npm ci`、测试、构建，再跑外壳 `poc/app` 的单元测试。哪一步失败都停下。
2. 建栈或更新栈（`--code-only` 跳过）；建栈时按 `INSTANCE_TYPE` 的架构取 Amazon Linux 2023 的 AMI。
3. 本机 `secrets.env` 缺哪项补哪项（见下面「口令与密钥」）。
4. 打包上传：外壳、九安副本、`web/dist`、`bench/` 下的测试台脚本、operator 脚本 → 构件桶 `releases/current.tgz`（另存一份 `releases/archive/<时间>.tgz`，保留 14 天）；`secrets.env` 另传到 `secrets/secrets.env`（服务端加密）。
5. 实例上（root，经 SSM 或 SSH）：装 `/etc/andon-finance/secrets.env`（root 0600）→ 解包 → `bench/bench-configure.sh`（PostgreSQL 容器 `jiuan-pg`、库 `jiuan` 和账号 `jiuan_app`、密钥文件、服务单元；清掉 MySQL 留下的两个口令文件；以前的 v0.5.3 PoC 服务 `andon-finance-poc.service` 还在就停掉、删掉）→ 换上 `/opt/andon-finance/current`（上一版留在 `previous`）→ 重启 `andon-jiuan`。哪一步失败都不往下走、不做健康检查。
6. 健康检查 `https://<DomainName>/poc/healthz`。

构件只由 `deploy.sh` 装：用户数据只在实例第一次启动时装 Node 24、Python、tar，建 `/opt/andon-finance`、`/etc/andon-finance`，启动时不拉构件。改了模板里的用户数据（哪怕只是一行注释），栈更新时实例会停机再开一次，站点停几分钟、容器都重启：先 `backup.sh`，挑没人用的时候。重启不丢单据（在九安的 PostgreSQL 里）和「Agent 接入」的启用记录（在九安的库里，加密）。

脚本：
- `backup.sh`：升级前备份，根卷快照（九安的 PostgreSQL、知识库的 PG 和 `/var/lib/jiuan` 都在根卷上，一个快照就够）。
- `upgrade-instance.sh <类型>`：换实例类型，认 `m7g.large`、`m7g.xlarge`、`t3.small`、`t3.medium`、`t3.large`；只允许停机再开，实例会被替换、或要换架构（arm64 和 x86 之间）就不执行。
- `migrate-data.sh`：换机器时搬数据（下面一节）。
- `kb.sh <阶段>`：从栈里取实例、网段和 Nexus 地址，驱动 `kb/deploy.sh`（知识库）。
- `destroy.sh`：删栈（下面「清理」）。
- `bench/`：实例上的脚本，随构件发出：`bench-configure.sh`（部署时配置）、`pg-install.sh`（PostgreSQL 容器 `jiuan-pg`）、`pg-database.sh`（建库和账号）、`bench-reset.sh`（端到端测试前重建 `jiuan` 库）、`test-databases.sh`（九安自带测试用的一次性测试库）、`andon-jiuan.service`。
- 换库时用过的（以后一般用不到）：`pg-prepare.sh`（补上 PG 的两项密钥、在实例上起 `jiuan-pg`，不碰在跑的服务）、`migrate-mysql-to-pg.sh`（一次性的 MySQL → PostgreSQL 搬迁，2026-11-06 用过；MySQL 删了以后跑不起来）、`remote-jiuan-tests.sh`（在实例上跑九安自带的测试）。

## 经 SSH 管理、Graviton（m7g）：另建一个栈

环境配置（`DEPLOY_ENV=poc/infra/env/<环境名>.env`）写了下面几项，这个栈的实例就经 SSH 管理，不再用 SSM：

| 键 | 作用 |
|---|---|
| `SSH_KEY_NAME` | 实例带上的 EC2 密钥对（栈参数 `KeyName`）。用部署人自己的；栈建好后改它会替换实例 |
| `SSH_KEY_FILE` | 本机私钥的绝对路径（权限 600 或 400），只给本机脚本用 |
| `SSH_ALLOWED_CIDR` | 允许 SSH 的来源（一般是自己的公网地址 /32）；安全组上单独一条 22 端口的规则（`SshIngress`）。地址变了改这里再跑 `deploy.sh` |
| `SSH_VIA=eice` | 不直连弹性 IP，经栈在 `SUBNET_ID` 里建的 EC2 Instance Connect 端点（栈参数 `SshVia`；一个 VPC 只能有一个）：ssh 的 ProxyCommand 是 `aws ec2-instance-connect open-tunnel --instance-id <实例>`，通道走 AWS API 的 HTTPS，还是 SSH + 自己的密钥，不用 SSM；实例的 22 端口对端点的安全组开。本机的网络连不到实例的地址段时用（2026-11-02 m7g 环境的弹性 IP 在 `184.192.0.0/12`，公司网络到不了） |
| `SSM_MANAGED=false` | 实例角色不带 `AmazonSSMManagedInstanceCore` |
| `INSTANCE_TYPE`、`ROOT_VOLUME_SIZE` | 模板默认 `m7g.xlarge`、30 GiB；也认 `m7g.large` 和 x86 的 `t3.small` / `t3.medium` / `t3.large`。栈建好后不能在 arm64 和 x86 之间换，要换就另建一个栈；改根卷大小会替换实例 |

- `deploy.sh`、`kb.sh`、`migrate-data.sh`（新环境那一侧）、端到端的 `run.sh` 都改经 SSH（`ec2-user` + `sudo`），公共部分在 `lib/remote.sh`。主机公钥第一次从实例的控制台输出里取（cloud-init 启动时打印的），钉进 `poc/infra/.state/<栈>-<实例>.known_hosts`（不进仓库），之后严格核对；控制台输出里一直没有，就停下，要首次信任再连时运行时加 `SSH_TRUST_FIRST_USE=1`。
- 这几项都不写，就和原来一样经 SSM。
- 2026-11-02 起的测试环境 `andon-finance-m7g`：一台 m7g.xlarge 装前端、九安的 PostgreSQL（2026-11-06 之前是 MySQL，切换后当天删了）、知识库的 PG，经 `key-malibo-sa` + EC2 Instance Connect 端点，站点 `jiuan-v0710.tinyboat.blog`（2026-11-02 从旧栈迁来；环境配置 `poc/infra/env/m7g.env`）。旧栈 `andon-finance-poc`（t3.large，经 SSM）等删（[交接文档](../../docs/delivery/handover.md)第 2.2 节）。

### 换机器时搬数据：`migrate-data.sh`

```bash
FROM_ENV=poc/infra/env/<旧环境>.env DEPLOY_ENV=poc/infra/env/<新环境>.env bash poc/infra/migrate-data.sh --dry-run   # 先看两边、要换掉什么
FROM_ENV=… DEPLOY_ENV=… bash poc/infra/migrate-data.sh             # 实搬：九安的库 jiuan（jiuan-pg）、PG 库 nexus、/var/lib/jiuan
FROM_ENV=… DEPLOY_ENV=… bash poc/infra/migrate-data.sh --skip-pg   # Nexus 已经切到新 PG 之后再同步：只搬 jiuan 库和 /var/lib/jiuan
```

旧环境经 SSM 只读导出（服务不停）；整包在旧实例上用一次性的 AES-256 密钥加密，密钥再用本机这次运行的一次性 RSA 公钥加密后回给本机，SSM 的命令历史里只有密文；整包经 15 分钟有效的预签名 URL 放进新环境的构件桶 `migration/`，搬完就删。九安的库用 `pg_dump -Fc` 导出、在新环境上删库按原参数重建（`bench/pg-database.sh`）再 `pg_restore`；两边都得是换库之后的构件（2026-11 之后）。新环境要先 `deploy.sh`（容器 `jiuan-pg` 在、账号 `jiuan_app` 在），搬 PG 时还要先 `kb.sh db`（PG 容器在、装了 PL/Python）；两边的 `secrets.env` 要是同一份，否则停下。搬完逐表数行数（`jiuan.<表>`、`pg.<表>`）、比规则表整表的 md5，对不上就报错。

改配置，比如改 `NexusOrigin` 或 `DomainName`（证书要覆盖新名字）：
1. 写进环境配置再跑 `deploy.sh`（不带 `--code-only`，它把配置里写了的栈参数都传上去）；或者用 `aws cloudformation deploy --parameter-overrides <参数>=<新值> …` 更新栈参数（模板路径与其余参数同 `deploy.sh`）；
2. 再运行一次 `deploy.sh --code-only`。

每次部署都会按栈参数重写实例上外壳的配置 `/etc/andon-finance/jiuan/env`，再重启服务。AI 独立建议发给哪个发布不在这里配：由「Agent 接入」页上管理员指定的审批 Agent 决定。

## 口令与密钥：`infra/secrets.env`

样例在 `infra/secrets.env.example`（没有任何真实的值）：每一项谁用、装到实例上的哪里、怎么生成，都写在里面；汇总表见 `docs/delivery/handover.md` 第 2.5 节。

测试台自己的启动配置都在本机这一份文件里，权限 0600。第一次运行 `deploy.sh` 时，它会生成这份文件：两条随机口令和三项测试台密钥（`lib/bench-secrets.sh`）；已有的文件缺了哪项，`deploy.sh` 就补哪项，已有的不改。

```
REVIEWER_PASSWORD=…              # 管理员 poc-reviewer 的口令，至少 12 个字符
CHECKER_PASSWORD=…               # 分析员 poc-checker 的口令，至少 12 个字符
BENCH_PG_SUPERUSER_PASSWORD=…    # 九安的 PostgreSQL（jiuan-pg）超级用户 postgres 的口令；第一次初始化时用，实例上只认原值
JIUAN_PG_APP_PASSWORD=…          # 库 jiuan 的属主 jiuan_app 的口令（32 位十六进制）；可以换，下次部署两边一起换
JIUAN_DATA_KEY=…               # 九安 v0.7.10 存储的数据密钥（32 字节 base64）；永远不要换
```

2026-11-02 之前的文件里还有 `REGISTRY_KEY`、`BENCH_MYSQL_APP_PASSWORD`、`BENCH_DATA_KEY`（只有已经拿掉的 v0.5.3 PoC 用），留着不碍事，也可以删掉。2026-11-06 删了 MySQL：文件里还有 `BENCH_MYSQL_ROOT_PASSWORD`、`JIUAN_MYSQL_APP_PASSWORD` 的，`deploy.sh` 会连同上面那行注释删掉，不用手改。

Agent 和 Nexus 的密钥不写进这个文件：管理员在新前端的「Agent 接入」页上连接 Nexus、粘贴调用密钥启用（见 [`../README.md`](../README.md)），平台当场验证、加密存进九安的库；加、换、停用都不改文件、不部署、不重启。

- **改完生效**：运行 `infra/deploy.sh --code-only`。脚本把文件上传到私有、加密的构件桶（`secrets/secrets.env`），装到实例的 `/etc/andon-finance/secrets.env`（root 0600）；`bench/pg-install.sh`、`bench/pg-database.sh` 和 `bench/bench-configure.sh` 从里面取出各项，写成 `/etc/andon-finance/bench/`、`/etc/andon-finance/jiuan/` 下的文件（`jiuan_app` 的口令同时在 PG 里重设），再重启服务。
- **只认原值**：实例上已有的 PG 超级用户口令（`/etc/andon-finance/bench/pg_superuser_password`）和数据密钥和 `secrets.env` 里的不一样时，部署在重启之前就失败，服务照旧跑。多半是 `secrets.env` 被重新生成了：找回交接的那份。`jiuan_app` 的口令不钉住：每次部署都按 `secrets.env` 重设。
- **不要外传**：这份文件不进构件、不进文档。
- **调用密钥只能本人签发**：Nexus 只认网页登录的本人，经 API 密钥（包括 nexus-ai-operator）签发会被拒（`api/v2/services/access_credential_service.py:283-286`）。新发布的 Agent 在网页上签一把，再到「Agent 接入」页上粘贴启用，不用改这个文件、不用重新部署。

## 实例上的数据

| 在哪 | 内容 |
|---|---|
| `/var/lib/jiuan-pg` | PostgreSQL 容器 `jiuan-pg` 的数据目录：`jiuan` 库（单据、AI 建议的各轮、复核、知识库页的缓存、「Agent 接入」的启用记录，调用密钥用 `JIUAN_DATA_KEY` 加密） |
| `/var/backups/jiuan-pg-20261106T123831Z.dump` | 切换后马上做的 `pg_dump`（root 0600）；MySQL 删了以后，九安的库坏了就从它恢复（[运维](../../docs/delivery/operations.md)第 2.6 节） |
| `/var/lib/jiuan/` | 外壳的工作目录（0700，属主 `jiuan`）：`nexus/`（「Agent 接入」页连 Nexus 的 operator 凭证）、`custom-rules/`（我的规则）、`kb-uploads/`（上传制度的暂存）、`seed-anchor.json`（种子单据的时间锚点） |
| `/etc/andon-finance/` | `secrets.env`（root 0600）、`bench/`（PG 超级用户口令 `pg_superuser_password`，root 0600）、`jiuan/`（外壳的配置 `env`、库口令 `db_app_password` 和别的密钥文件，root:jiuan 0640） |
| 容器 `nexus-pgvector` | 知识库的 PG（库 `nexus`），由 `kb.sh` 管 |

重启、重新部署都不丢；实例被替换才会丢：替换前先跑 `backup.sh`，换机器用 `migrate-data.sh`。

## 九安的库：PostgreSQL（2026-11-06 起）

- **容器**：`bench/pg-install.sh` 起 `jiuan-pg`（`postgres:17`，只听 `127.0.0.1:5433`，数据目录 `/var/lib/jiuan-pg`，容器和库都按上海时区）；镜像、端口、时区不对就只换容器，数据目录原样挂回去。5432 留给知识库那台 PG（`nexus-pgvector`），不动。
- **库和账号**：`bench/pg-database.sh [库名]` 建库 `jiuan`（属主 `jiuan_app`，UTF8、排序和字符类别 C，`REVOKE CONNECT … FROM PUBLIC`，只有属主连得上）。`jiuan_app` 能登录，不是超级用户，不能建库建角色；它的口令每次按 `secrets.env` 重设。可以重复跑，已有的库只核对编码和排序。
- **外壳怎么连**：`/etc/andon-finance/jiuan/env` 里 `POC_DB_HOST=127.0.0.1`、`POC_DB_PORT=5433`、`POC_DB_NAME=jiuan`、`POC_DB_USER=jiuan_app`，口令在同目录的 `db_app_password`。九安启动时建表、核对表结构，对不上（`PG_MIGRATION_DRIFT`）就不启动。
- **重置**（`bench/bench-reset.sh`，端到端测试前跑）：停服务 → 表在就用 `COPY … TO STDOUT` 导出「Agent 接入」的启用记录 → `DROP DATABASE jiuan WITH (FORCE)` → `pg-database.sh` 重建 → 起服务跑迁移 → 停服务 `COPY … FROM STDIN` 写回 → 起服务。表在却导不出来就停（库不删）；不管成功失败最后都把服务起来，失败时导出留在 `/var/tmp/jiuan-reset.*/enablement.copy`（0600）。
- **查库**：在实例上 `sudo docker exec -it -u postgres jiuan-pg psql -d jiuan`（容器里本机连，不用口令）；只读看，要改先停服务、先 `backup.sh`。
- **切换前的 MySQL**：2026-11-06 晚上项目负责人定删掉：容器 `jiuan-mysql`、数据目录 `/var/lib/jiuan-mysql`、镜像 `mysql:8.0` 和两个口令文件都删了，回不到 MySQL 了。部署脚本不起、不建 MySQL（`bench/mysql-install.sh` 已删）；`bench-configure.sh` 每次部署清掉留下的 MySQL 口令文件，`lib/bench-secrets.sh` 从 `secrets.env` 删掉两项 MySQL 口令。九安的库坏了从切换后的 `pg_dump` 恢复，整盘出问题用切换前的根卷快照 `snap-0296baf8891b5df4b`（[运维](../../docs/delivery/operations.md)第 2.6 节）。

## 测试

```bash
cd audit-nexus/poc/infra && node --test "test/**/*.test.mjs"   # 部署脚本、模板、测试台脚本的测试，deploy.sh 每次都先跑（九安副本的构建测试要本机有开发包，没有就跳过那几条）
cd audit-nexus && DEPLOY_ENV=poc/infra/env/<环境>.env [KB_E2E_DOCX=…] bash poc/app/test/e2e/run.sh   # 端到端：先重建 jiuan 库（bench-reset.sh），再跑 web.e2e.mjs、api.e2e.mjs（27 条），约 1–3 美元
cd audit-nexus && DEPLOY_ENV=poc/infra/env/<环境>.env bash poc/infra/remote-jiuan-tests.sh --engine pg --out <结果.json>   # 九安自带的测试，在实例上一次性的测试库容器 jiuan-test-pg（127.0.0.1:5434）里跑，跑完删掉
```

测试夹具在 `test/fixtures/deploy-env`。端到端测试只从 `secrets.env` 读两个账号的口令，调用密钥用管理员在「Agent 接入」页上启用的；细节见 [`../README.md`](../README.md)「端到端测试」。

## 排查

- 健康检查：`curl -fsS https://<DomainName>/poc/healthz`。
- 实例日志：
  1. 经 SSM 的栈：`aws ssm start-session --region us-east-1 --target <InstanceId>`；经 SSH 的栈：`ssh -i <SSH_KEY_FILE> -o UserKnownHostsFile=poc/infra/.state/<栈>-<实例>.known_hosts ec2-user@<ElasticIp>`（`SSH_VIA=eice` 时再加 `-o ProxyCommand='aws ec2-instance-connect open-tunnel --region us-east-1 --instance-id <实例>'`）；
  2. 在会话里执行 `sudo journalctl -u andon-jiuan -n 200`。
- 九安的库：在上面的会话里 `sudo docker ps`（`jiuan-pg`、`nexus-pgvector` 是 Up），`sudo docker logs --tail 100 jiuan-pg`，`sudo docker exec -it -u postgres jiuan-pg psql -d jiuan`。
- 初始化日志：在上面的会话里执行 `sudo tail -n 200 /var/log/cloud-init-output.log`。

## 清理

```bash
audit-nexus/poc/infra/destroy.sh   # 要求输入栈名确认
```

## 费用（估计）

- 实例按 m7g.xlarge 的按需价计（以 AWS 价目表为准），另有 30 GiB gp3 根卷和公网 IPv4；CloudFront、S3 基本可以忽略。
- 每一轮 AI 独立建议约 0.1–0.3 美元，记在 Nexus 发布者名下；完整跑一次端到端测试约 1–3 美元。

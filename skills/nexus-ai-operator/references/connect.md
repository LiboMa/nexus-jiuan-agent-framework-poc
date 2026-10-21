# 连接、自动续期与轮换、排障

## 三个概念

| 名称 | 是什么 | 有效期 | 谁接触它 |
|---|---|---|---|
| 连接 | 用户在网页「个人设置 › API 密钥」生成一把密钥时建的一条长期身份，带权限档位（如「搭建」） | 长期，直到用户停用；连续闲置太久（平台默认 90 天）会自动失效 | 用户在网页上管理（网页上每一行就是一条连接） |
| 连接密钥（`nxc_…`） | 网页上叫「API 密钥」：这条连接的长期凭证，只用来换访问密钥 | 不过期；第一次使用时平台强制更换，之后约每 7 天自动轮换一次 | 只有 CLI（保存在本机） |
| 访问密钥（`nxp_…`） | 调用平台接口用的短期凭证 | 约 60 分钟，到期前自动续期 | 只有 CLI（每次请求自动带上） |

权限 = 用户本人的权限 ∩ 连接的权限档位 ∩ 角色上限（经 API 密钥的调用最高按「编辑者」对待，管理员权限不会下发）。
用户在网页上改档位、停用密钥，最迟约 30 秒后生效。

## login

### 接入包自带密钥（网页生成 API 密钥时下载的那份）

```bash
python3 scripts/nexus.py login --client <客户端>
```

- 用户在网页生成 API 密钥时，浏览器会下载一份接入包；包里的 `config/connection.json` 带着这把还没用过的连接密钥和平台地址，
  `config/instance.json` 带着平台地址。不指定 `--token-stdin` / `--token-env` / `--password-login` 时，login 就用这把。
- 连接成功后平台已把它换新（新的只保存在本机凭证文件里），login 随即删除 `config/connection.json`；删不掉时会提示手动删除。
  本机已经用这个接入包连上过时（例如上次没删掉文件），再运行 login 不会把那把作废的密钥再交给平台，只删掉文件、沿用已保存的连接。
- 这把密钥只能连接一次：同一个接入包不要交给第二个 Agent，也不要在别的机器上再解压一份去 login ——
  平台会认为旧密钥被重复使用并给用户告警。每个 Agent 各用一把密钥（用户在网页上各生成一把）。
- 如果它已经用过或已被用户停用，login 失败（退出码 3）并删除这个文件，请用户在网页重新生成一把、把新的接入包交给你。
  平台不认识这把密钥（`connection_key_invalid`，多半是 `--origin` 指错了平台）时文件会保留，换对地址再试。
- 显式指定了 `--token-stdin` / `--token-env` / `--password-login` 时不读也不动这个文件。`skill-update` 不安装、不备份、
  也不保留它。

### 用户直接给的密钥

```bash
python3 scripts/nexus.py login --origin https://<平台地址> --token-stdin --client <客户端> <<'EOF'
<连接密钥>
EOF
```

- 平台地址的来源依次是：`--origin`、环境变量 `NEXUS_ORIGIN`、`config/connection.json` 里的地址、本 Skill 目录下的
  `config/instance.json`（`{"origin": "https://…"}`，可照 `config/instance.example.json` 自建；从平台下载的接入包已经预置）。
  地址必须是 `https`；只有本机地址（localhost / 127.0.0.1）可以用 `http`。
- 连接密钥也可以经环境变量传：`--token-env NEXUS_CONNECTION_KEY`（变量名自定）。不要写在命令行参数里。
- login 会立刻向平台兑换：平台把交来的连接密钥换成新的（旧的随即作废），CLI 只把新的保存在本机。
  所以对话、日志里出现过的那串，在 login 之后就没有用了。
- 交来的密钥如果此前已经兑换过，login 会主动再轮换一次，保证对话里那串不再长期有效；如果它已经在别处被更换过，
  login 会失败（退出码 3），请用户重新生成。

账号密码方式（兼容）：

```bash
python3 scripts/nexus.py login --origin https://<平台地址> --password-login --username <用户名> --password-stdin <<'EOF'
<密码>
EOF
```

CLI 登录后立刻替用户生成一把 API 密钥（新建一条连接，档位默认「搭建」）并兑换，随后丢弃密码与登录令牌；兑换失败时会用刚拿到的
连接密钥把它停用，不留下没人用的密钥。开启了二次验证的账号加 `--mfa-code-env <变量名>`（验证码放在环境变量里，恢复码尤其推荐这样传）
或 `--mfa-code <动态码>`。平台启用单点登录时这种方式不可用。只在用户明确要求时使用。

## 之后一切自动

- 每次请求前：访问密钥剩余不到 5 分钟就先续期；平台提示该轮换时顺带轮换连接密钥。
- 续期与轮换在文件锁（`~/.nexus/.lock`）里完成，锁内先重读凭证文件；多个 CLI 进程并发也只会有一个去换，其它的读到新的。
  等锁超时而当前访问密钥还能用时，先用它继续；锁文件不要删（锁随进程释放，超时说明另一个进程还在换）。
- 文件系统不支持加锁（部分网络盘）时照常续期访问密钥，但不轮换连接密钥（避免多个进程同时轮换把新密钥弄丢）。
- 轮换请求失败而访问密钥还能用时，命令照常完成，约 5 分钟后再试；如果这次请求没有拿到确定结果，CLI 会提示：
  万一平台其实已经换了，旧密钥约 10 分钟后失效，届时请用户重新生成连接密钥。
- 被轮换掉的旧连接密钥有约 10 分钟宽限期；宽限期过后再出现，平台会认为它可能泄露并暂停这条连接（退出码 3）。
  所以**不要**把 `~/.nexus/credentials.json` 复制到别的机器：每台机器各自 login 一条连接。

## 本机文件

- `~/.nexus/credentials.json`：按 profile 保存平台地址、连接密钥、访问密钥及其到期时间、连接 id、用户信息（目录 0700、文件 0600）。
- `~/.nexus/cache/<profile>/`：能力发现缓存、`chat` 记住的会话。
- 环境变量 `NEXUS_HOME` 可以换掉 `~/.nexus`。

## 多环境

```bash
python3 scripts/nexus.py --profile staging login --origin https://staging.example.com --token-stdin
python3 scripts/nexus.py --profile staging caps
```

也可以设环境变量 `NEXUS_PROFILE=staging`。不同 profile 的凭证与缓存互不影响。

## 断开

- `logout`：只删本机凭证与缓存，平台上的 API 密钥还在（用户可以在网页上看到它「使用中」）。
- `logout --revoke`：先用连接密钥在平台上停用这把 API 密钥，再删本机凭证。用户要求「断开 / 撤销 / 停用」时用它。

## whoami

显示：用户、角色上限、连接名称与 id、权限档位、访问密钥剩余时间、平台版本、发现协议是否兼容。
怀疑凭证有问题时先跑它。

## 排障

| 现象（错误码） | 原因 | 处置 |
|---|---|---|
| `not_connected` | 这个 profile 还没 login | 接入包里有 `config/connection.json` 时直接运行 login；没有就向用户要平台地址与连接密钥 |
| `connection_key_invalid` / `connection_key_revoked` | 连接密钥不对或已作废 | 请用户重新生成连接密钥 |
| `connection_revoked` | 用户在网页上停用了这把 API 密钥 | 问用户是否还要继续；要的话请用户生成一把新的 |
| `connection_expired` | 密钥闲置太久自动失效 | 请用户生成一把新的 |
| `connection_key_reused` / `connection_suspended` | 已轮换掉的旧连接密钥又被使用，平台暂停了连接 | 请用户在网页上查看告警并重新生成连接密钥；检查凭证文件是否被复制到了别处 |
| `credential_forbidden_path` | 这类操作不允许经 API 密钥进行 | 告诉用户需要本人在网页上操作 |
| `not_available` | 平台没有开放 API 密钥访问 | 请平台管理员开启 |
| TLS 证书校验失败 | 平台用自签证书 | 设环境变量 `NEXUS_CA_BUNDLE` 指向 CA 证书文件 |
| 请求超时 | 平台繁忙或网络慢 | 稍后重试；全局 `--timeout` 调大单个请求的超时 |

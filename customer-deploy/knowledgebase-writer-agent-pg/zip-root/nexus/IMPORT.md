# 把工具包导入 Nexus：`pg_kb_tools.zip`

适用 Nexus v0.3.28。下面的命令都在**交付 zip 解开后的根目录**执行（有 `START-HERE.md`、`nexus/`、`repo/` 的那一层）。

## 这个包是什么

| 文件 | 说明 |
|---|---|
| `nexus/import-api.sh` | 纯 API 导入的脚本（第 ② 节）：管理员脚本跑不了时用，一次做完登录、上传、确认、记下结果、核对 |
| `nexus/pg_kb_tools.zip` | 导入用的工具包：入口 `pg_kb_tools.py`（3 个工具 `rules_writer`、`rules_search`、`rules_manager`）+ 5 个核心模块（`doc_blocks`、`parse_rules`、`clauses`、`kb_parse`、`kb_store`）。6 个文件都在压缩包根，时间戳固定 |
| `nexus/MANIFEST.json` | 每个文件的 sha256 与来源提交（`source_commit`）。导入前、导入后都拿它核对 |

- 包里写死了规则表名 `_TABLE = "approval_rules"`。你的 `repo/kb/deploy.env` 里 `RULES_TABLE` 不是 `approval_rules` 时，**不要用这个预打好的包**：先在 `repo/knowledgebase-writer-agent-pg/deploy.env` 填同样的 `RULES_TABLE`，再 `python3 -I repo/knowledgebase-writer-agent-pg/scripts/build_tools.py` 重打（产物在 `repo/knowledgebase-writer-agent-pg/.build/`），下文的 `nexus/pg_kb_tools.zip` 换成 `repo/knowledgebase-writer-agent-pg/.build/pg_kb_tools.zip`，`nexus/MANIFEST.json` 换成 `repo/knowledgebase-writer-agent-pg/.build/MANIFEST.json`。
- 导入后平台把 6 个文件原样放进一个新的工具目录 `kb_pg_steward_<8 位十六进制>`（下文 `<DIR_NAME>`），这是它的 v1。工具在 VM 里以包的形式装上，模块之间用相对 import。

## 先核对

```bash
shasum -a 256 -c --quiet SHA256SUMS && echo 全部一致     # Linux：sha256sum -c --quiet SHA256SUMS && echo 全部一致
python3 -I -c 'import hashlib,json,sys,zipfile; m=json.load(open(sys.argv[2]))["files"]; z=zipfile.ZipFile(sys.argv[1]); a={i.filename: hashlib.sha256(z.read(i)).hexdigest() for i in z.infolist() if not i.is_dir()}; print("与 MANIFEST 逐文件一致" if a == m else "不一致：%s" % sorted(k for k in set(a) | set(m) if a.get(k) != m.get(k))); sys.exit(a != m)' nexus/pg_kb_tools.zip nexus/MANIFEST.json
```

## 三种方式

| | 怎么做 | 谁能做 | 结果 |
|---|---|---|---|
| ① 一条命令（推荐） | 管理员脚本 `admin_run.sh import` | 管理员（密码放在本机 600 文件里） | 3 个工具都声明要密钥 `pg_kb`（`database_credentials`），结果写进 `.state/import.json` |
| ② 纯 API | 脚本 `nexus/import-api.sh`（内部用 `curl` 调登录、上传、确认）；也可以照第 ② 节逐步做 | 管理员；编码工具也能照做（用脚本） | 同 ① |
| ③ 网页「导入工具」 | — | — | **不能用**：工具会被登记成「不需要密钥」，调用时报 `credentials_missing`（原因见第 ③ 节） |

导入、发布工具新版本在 v0.3.28 只对管理员开放。Nexus Operator（API 密钥，权限封顶「编辑者」）做不了，它也不发 multipart 请求。

## ① 一条命令（推荐）

先填管理员脚本的配置（只放不涉密的设置，密码在你自己建的 600 文件里）：

```bash
cp repo/knowledgebase-writer-agent-pg/deploy.env.example repo/knowledgebase-writer-agent-pg/deploy.env
chmod 600 repo/knowledgebase-writer-agent-pg/deploy.env
# 填：RULES_TABLE（与 repo/kb/deploy.env 相同）、NEXUS_URL=https://<env>.<domain>、NEXUS_ADMIN_USER、
#     管理员密码来源二选一：NEXUS_PASSWORD_FILE=<管理员密码的 600 文件，绝对路径>；
#     或 NEXUS_ADMIN_PASSWORD_SSM=<deployer 实例 ID>:<deploy.yaml 绝对路径> 加 AWS_REGION（经 SSM 密封读取，借同目录的 repo/kb）
```

再导入、核对：

```bash
bash repo/knowledgebase-writer-agent-pg/scripts/admin_run.sh import --module pg --file nexus/pg_kb_tools.zip
bash repo/knowledgebase-writer-agent-pg/scripts/admin_run.sh verify --module pg --dir <DIR_NAME> --file nexus/pg_kb_tools.zip
```

- 本机要有 [uv](https://docs.astral.sh/uv/)：脚本用它临时装 boto3，第一次运行要联网下载。密码只从 600 文件读进进程（SSM 方式：远端用一次性公钥加密、本机解密到进程退出即删的 600 临时文件，SSM 历史里只有密文；只在管理员密码从没在网页上改过时有效），不进命令行、不打印。参考环境用 SSM 方式跑通了 `import`、`verify`、`check`、`publish`、`issue-call-key`。
- `import` 先在本机查压缩包（每个 `.py` 编译得过、3 个工具各在一个文件里有 `@tool`、与旁边的 `MANIFEST.json` 一致；所以 `--file` 指向的 zip 旁边必须有 `MANIFEST.json`），再上传、确认，最后打印并写进 `repo/knowledgebase-writer-agent-pg/.state/import.json`：`dir_name`（即 `<DIR_NAME>`）、`module_path`（`imported_tools/<DIR_NAME>/pg_kb_tools`）、3 个工具的 `tool_id`、`errors`（应为 `[]`）。
- `.state/import.json` 已存在时脚本拒绝再导一份（服务端会多出一个目录）。要更新代码用 `publish`（见 `repo/knowledgebase-writer-agent-pg/README.md` 第 10 节）；确实要再导一份才加 `--again`。
- `verify` 应当看到：3 个工具 `key_name=pg_kb key_type=database_credentials configured=False`（还没绑密钥）；6 个文件逐个「一致」；最后一行 `服务端与本地逐个文件一致: True`。
- 不加 `--file` 时，脚本导入的是 `repo/knowledgebase-writer-agent-pg/.build/pg_kb_tools.zip`（先跑 `build_tools.py`）。

## ② 纯 API（脚本 `nexus/import-api.sh`）

与 ① 发的是同样的请求，只用 `bash`、`curl` 7.55 以上（`-H @文件` 从文件读请求头，令牌不进命令行）和 `python3`（只用标准库）。管理员脚本跑不了时用它（比如本机装不了 uv）。

**推荐直接跑脚本**：下面第 0–7 步它在一个进程里做完，不依赖任何 shell 变量。

```bash
bash nexus/import-api.sh --nexus https://<env>.<domain> --user <管理员用户名> --password-file <管理员密码的 600 文件>
```

- 密码文件只放密码一行，权限要是 600（不是就拒绝）。不想建文件就把 `--password-file …` 换成 `--password-stdin`，在提示处输入（不回显）。密码和令牌都不进命令行参数、不打印；令牌只在一个 700 临时目录里，脚本退出时（含出错、Ctrl-C）删掉。
- 它先核对工具包与 `MANIFEST.json`，再登录、查密钥类型、上传、带声明确认，把结果写进 `repo/knowledgebase-writer-agent-pg/.state/import.json`（与 ① 同样的格式），最后核对 3 个工具的密钥声明和服务端的 6 个文件。最后几行应当是 3 个 `key_name=pg_kb key_type=database_credentials configured=False`、6 个「一致」、`current_version 1 | 服务端与本地逐个文件一致: True`。
- **已经导入过就停**（退出码 3，什么都不写）：本机已有 `.state/import.json`，或服务端「需要密钥的工具」里已有 `kb_pg_steward_*` 目录。先弄清楚是不是已经部署过；确实要再导一份才加 `--force-new`（服务端会多出一个目录，旧的 `import.json` 改名留着）。
- 重打过的包：加 `--zip repo/knowledgebase-writer-agent-pg/.build/pg_kb_tools.zip --manifest repo/knowledgebase-writer-agent-pg/.build/MANIFEST.json`。
- 退出码：`0` 导入并核对通过；`1` 失败或核对不过（看输出；`errors` 不是 `[]` 或文件不一致时不要接着绑定）；`2` 用法不对；`3` 已经导入过。`bash nexus/import-api.sh --help` 有完整说明。

### 逐步做（想看清每一步时）

脚本做的就是下面这几步。**这几段要在同一个 shell 会话里按顺序跑**：后面的步骤要用第 0 步设的变量（`NEXUS`、`T`）和临时目录里的令牌，换一个终端或新开一个 shell 就没有了。编码工具的 shell 往往每条命令都是新的，所以编码工具一律用上面的脚本。

**0　准备。** 设几个变量（都不是机密），建一个只有自己能读的临时目录放令牌和回复：

```bash
NEXUS=https://<env>.<domain>
ADMIN_USER=admin
PWFILE=<管理员密码的 600 文件>
T="$(mktemp -d)"; chmod 700 "$T"
test ! -e repo/knowledgebase-writer-agent-pg/.state/import.json && echo "这台机器还没导入过" || echo "这台机器导入过（.state/import.json 已在）：停下，不要再导一份"
```

**1　登录。** 接口 `POST /api/v2/auth/login`，请求体 `{"username", "password"}`，回复里的 `access_token` 是 Bearer 令牌。密码从 600 文件读进 python，经管道交给 curl；令牌直接写进 600 的请求头文件，不打印：

```bash
python3 -I -c 'import json,sys; print(json.dumps({"username": sys.argv[1], "password": open(sys.argv[2], encoding="utf-8").read().strip()}))' "$ADMIN_USER" "$PWFILE" \
  | curl -sS -H 'Content-Type: application/json' --data-binary @- "$NEXUS/api/v2/auth/login" \
  | python3 -I -c 'import json,os,sys; d=json.load(sys.stdin); t=d.get("access_token") or (d.get("data") or {}).get("access_token") or sys.exit("登录失败：检查用户名和密码文件"); fd=os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600); os.write(fd, ("Authorization: Bearer " + t + "\n").encode()); os.close(fd); print("已登录")' "$T/auth.hdr"
```

**2　确认平台有「数据库凭证」密钥类型，且还没有导入过这个工具目录。**

```bash
curl -sS -H @"$T/auth.hdr" "$NEXUS/api/v2/keys/schemas" \
  | python3 -I -c 'import json,sys; d=json.load(sys.stdin); d=d.get("data", d); print("database_credentials:", "database_credentials" in (d or {}))'
curl -sS -H @"$T/auth.hdr" "$NEXUS/api/v2/keys/tools-requiring-key?search=rules_&limit=200" \
  | python3 -I -c 'import json,sys; d=json.load(sys.stdin); rows=d.get("data", d) or []; old=sorted({str(r.get("module_path")) for r in rows if "/kb_pg_steward_" in str(r.get("module_path"))}); print("已有的 kb_pg_steward 目录：", old or "没有", "| 列表被截断:", bool((d.get("pagination") or {}).get("truncated")))'
```

第一行应是 `database_credentials: True`；第二行有已导入的目录时停下，先弄清楚是不是已经部署过（脚本在这里以退出码 3 停下）。平台一次最多回 200 行（`limit` 再大也按 200），所以按工具名搜（`search=rules_` 匹配 3 个工具名）；`列表被截断: True` 时这一行的结论不算数，也停下，先在网页「工具」里看清楚。

**3　上传。** 接口 `POST /api/v2/tools/import/upload`，multipart 字段 `file`，收 `.py` 或 `.zip`：

```bash
curl -sS -H @"$T/auth.hdr" -F "file=@nexus/pg_kb_tools.zip;type=application/zip" "$NEXUS/api/v2/tools/import/upload" > "$T/upload.json"
```

**4　确认，同时声明密钥。** 接口 `POST /api/v2/tools/import/confirm`，请求体 `{review_id, tools, dir_label}`。平台只登记 `tools` 里声明了的函数（按顶层 `def` 找文件），目录即成 v1。下面这段从上一步的回复取 `review_id`、从包描述 `repo/knowledgebase-writer-agent-pg/nexus-package.json` 取 3 个工具的声明，写出请求体（与本节末尾的完整模板逐字相同），再发出去：

```bash
python3 -I - "$T/upload.json" repo/knowledgebase-writer-agent-pg/nexus-package.json "$T/confirm.json" <<'PY'
import json, sys
up = json.load(open(sys.argv[1], encoding="utf-8"))
up = up.get("data", up) if isinstance(up, dict) else {}
review_id = up.get("review_id") or sys.exit("上传没有返回 review_id：看 " + sys.argv[1])
pg = json.load(open(sys.argv[2], encoding="utf-8"))["modules"]["pg"]
key = pg["key"]
tools = []
for name, needs_key, desc in pg["tools"]:
    t = {"source_function": name, "name": name, "description": desc, "type": "strands_tool", "requires_key": needs_key}
    if needs_key:
        t.update({"key_name": key["name"], "key_type": key["type"], "key_fields_schema": key["fields"]})
    tools.append(t)
with open(sys.argv[3], "w", encoding="utf-8") as f:
    json.dump({"review_id": review_id, "tools": tools, "dir_label": pg["label"]}, f, ensure_ascii=False, indent=2)
print("review_id:", review_id, "| 声明了", len(tools), "个工具")
PY
curl -sS -H @"$T/auth.hdr" -H 'Content-Type: application/json' --data-binary @"$T/confirm.json" \
  "$NEXUS/api/v2/tools/import/confirm" > "$T/confirm-result.json"
```

**5　记下结果。** 写成与 ① 相同的 `.state/import.json`（以后用 `admin_run.sh verify / bind / publish` 时脚本认它），并打印出来：

```bash
mkdir -p repo/knowledgebase-writer-agent-pg/.state
python3 -I - "$T/confirm-result.json" nexus/pg_kb_tools.zip repo/knowledgebase-writer-agent-pg/.state/import.json <<'PY'
import hashlib, json, sys, zipfile
r = json.load(open(sys.argv[1], encoding="utf-8"))
r = r.get("data", r) if isinstance(r, dict) else {}
if not r.get("dir_name"):
    sys.exit("确认没有返回 dir_name：看 " + sys.argv[1])
with open(sys.argv[2], "rb") as f:
    content = f.read()
out = {"dir_name": r["dir_name"], "module_path": f"imported_tools/{r['dir_name']}/pg_kb_tools",
       "tools": r.get("imported"), "errors": r.get("errors") or [], "file_sha": hashlib.sha256(content).hexdigest()[:12],
       "files": sorted(zipfile.ZipFile(sys.argv[2]).namelist())}
with open(sys.argv[3], "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=2)
print(json.dumps(out, ensure_ascii=False, indent=2))
PY
```

`errors` 应为 `[]`，`tools` 里是 3 个工具各自的 `tool_id`（下文 `<TOOL_ID>` 取其中任一个：三个工具在同一个目录里）。

**6　核对。** 要密钥的工具（`GET /api/v2/keys/tools-requiring-key`）和服务端的文件（`GET /api/v2/tools/registered/<TOOL_ID>/files`）：

```bash
curl -sS -H @"$T/auth.hdr" "$NEXUS/api/v2/keys/tools-requiring-key?search=rules_&limit=200" \
  | python3 -I -c 'import json,sys; d=json.load(sys.stdin); rows=d.get("data", d) or []; [print(r["tool_name"], "key_name=%s key_type=%s configured=%s" % (r["key_name"], r["key_type"], r.get("configured"))) for r in rows if "/" + sys.argv[1] + "/" in str(r.get("module_path"))]' "<DIR_NAME>"
curl -sS -H @"$T/auth.hdr" "$NEXUS/api/v2/tools/registered/<TOOL_ID>/files" \
  | python3 -I -c 'import hashlib,json,sys; d=json.load(sys.stdin); d=d.get("data", d); want=json.load(open(sys.argv[1]))["files"]; got={f["path"]: f.get("sha256") or hashlib.sha256(f.get("content", "").encode("utf-8")).hexdigest() for f in d.get("files") or []}; [print(" ", p, "一致" if want.get(p) == got.get(p) else "不一致") for p in sorted(set(want) | set(got))]; print("current_version", d.get("current_version"), "| 服务端与本地逐个文件一致:", want == got)' nexus/MANIFEST.json
```

应当看到：3 个工具 `key_name=pg_kb key_type=database_credentials configured=False`；6 个文件都「一致」，最后 `current_version 1 | 服务端与本地逐个文件一致: True`。

**7　收尾。** `rm -rf "$T"`（令牌和回复都在里面）。中途停下不做了也要删。

**确认请求的完整模板**（第 4 步和脚本写出的就是它；`<REVIEW_ID>` 是第 3 步回复里的 `review_id`）。用 Postman 之类的工具时照它发：

```json
{
  "review_id": "<REVIEW_ID>",
  "tools": [
    {
      "source_function": "rules_writer",
      "name": "rules_writer",
      "description": "把制度文档（.docx / .xlsx / .pdf / .md）写入 PG 规则库 approval_rules（与审核 Agent 共用）：审批矩阵一行一条规则、正文按条一条；向量由库里的 kb_embed_batch 生成；同一 source_id 再上传 = 新版本，内容没变的不重写；dry_run=true 只预览",
      "type": "strands_tool",
      "requires_key": true,
      "key_name": "pg_kb",
      "key_type": "database_credentials",
      "key_fields_schema": [
        {"field": "host", "required": true, "description": "知识库 PostgreSQL 的私网地址（Agent 的运行环境经私网连库）"},
        {"field": "port", "required": false, "description": "端口，不填是 5432"},
        {"field": "database", "required": true, "description": "知识库所在的库名"},
        {"field": "username", "required": true, "description": "应用用户（与审核 Agent 的 PG 连接器同一个）"},
        {"field": "password", "required": true, "description": "应用用户的密码"}
      ]
    },
    {
      "source_function": "rules_search",
      "name": "rules_search",
      "description": "按问题检索 PG 规则库：调库里的 kb_search（与审核 Agent 同一个函数），按关键词命中数、再按语义排序",
      "type": "strands_tool",
      "requires_key": true,
      "key_name": "pg_kb",
      "key_type": "database_credentials",
      "key_fields_schema": [
        {"field": "host", "required": true, "description": "知识库 PostgreSQL 的私网地址（Agent 的运行环境经私网连库）"},
        {"field": "port", "required": false, "description": "端口，不填是 5432"},
        {"field": "database", "required": true, "description": "知识库所在的库名"},
        {"field": "username", "required": true, "description": "应用用户（与审核 Agent 的 PG 连接器同一个）"},
        {"field": "password", "required": true, "description": "应用用户的密码"}
      ]
    },
    {
      "source_function": "rules_manager",
      "name": "rules_manager",
      "description": "PG 规则库管理：支持的操作（describe）、制度清单、详情、下线、恢复、删除、一致性校验",
      "type": "strands_tool",
      "requires_key": true,
      "key_name": "pg_kb",
      "key_type": "database_credentials",
      "key_fields_schema": [
        {"field": "host", "required": true, "description": "知识库 PostgreSQL 的私网地址（Agent 的运行环境经私网连库）"},
        {"field": "port", "required": false, "description": "端口，不填是 5432"},
        {"field": "database", "required": true, "description": "知识库所在的库名"},
        {"field": "username", "required": true, "description": "应用用户（与审核 Agent 的 PG 连接器同一个）"},
        {"field": "password", "required": true, "description": "应用用户的密码"}
      ]
    }
  ],
  "dir_label": "kb_pg_steward"
}
```

`key_fields_schema` 只描述字段，**不含任何值**：数据库的地址和密码在 Nexus「密钥管理」里那把 `database_credentials` 密钥里（一般是 `kb/deploy.sh connector` 建的，审核 Agent 的 PG 连接器用的同一把），导入后再按人绑定。

## ③ 网页「导入工具」为什么不行

- 网页走的是同一对接口（上传 → 审查 → 确认），但**确认页只沿用审查阶段识别出的「凭证参数」**：函数参数名形似 key、secret、password、token 的，才算这个工具要密钥。
- 这三个工具的数据库密钥由平台在每次调用前注入，函数签名里**没有凭证参数**。所以网页确认会把它们登记成「不需要密钥」：密钥名、类型、字段都填不进去。
- 登记成「不需要密钥」的工具，平台调用前不注入任何密钥，工具一调就报 `credentials_missing`；网页上也绑不了密钥（它不在「需要密钥的工具」里）。
- **v0.3.28 没有事后补登记密钥声明的接口**：发布新版本只换文件、不改声明。网页导入的那一份改不好，只能（单独确认后）删掉那个工具目录，再按 ① 或 ② 重导。没删也不影响：提示词不引用它就不会被加载。删工具目录要**管理员**：Operator 的连接档位没有 `tool:delete`（参考环境实测 403）。管理员在网页「工具」里删，或用管理员令牌对目录里的每个工具调一次 `DELETE /api/v2/tools/registered/<TOOL_ID>`（会连同文件、构件与密钥绑定一起删）。

所以密钥声明只能经确认接口带上：`requires_key=true`、`key_name=pg_kb`、`key_type=database_credentials`、`key_fields_schema`（host / port / database / username / password）。① 和 ② 都是这样做的。

**整个 Agent 能不能导入？** v0.3.28 只有「项目备份」的恢复（`POST /api/v2/backup/import-file`）。备份故意保留密钥的 `secret_arn`（给同一环境灾备用），带到你的环境会是一个指向别的账号的坏引用，所以不拿它交付。Agent 本身用「复制一个现有 Agent + 保存提示词」建，见部署手册阶段 3。

## 导入之后

1. **绑定数据库密钥**（以 Agent 与发布的属主身份；一个绑定覆盖模块里的 3 个工具）：`PUT /api/v2/keys/tool-bindings`，请求体 `{"module_path": "imported_tools/<DIR_NAME>/pg_kb_tools", "key_name": "pg_kb", "key_id": "<KEY_ID>"}`，回复带 `binding_id`。Operator 做（参考环境实测：管理员账号生成的 API 密钥，只要 `--yes`），或管理员本人就是属主时 `bash repo/knowledgebase-writer-agent-pg/scripts/admin_run.sh bind --key-id <KEY_ID>`。
2. **再核对**：`bash repo/knowledgebase-writer-agent-pg/scripts/admin_run.sh verify --module pg --dir <DIR_NAME> --file nexus/pg_kb_tools.zip`，或经 Operator 只读地看 `python3 -I <OPERATOR_DIR>/scripts/nexus.py --profile <PROFILE> call GET /api/v2/keys/tools-requiring-key -q search=rules_ -q limit=200` 里这个目录的 3 行，都应是 `configured=True`。
3. 保存提示词、对话冒烟、发布 A2A / MCP、发调用密钥：照 `docs/GUIDE.zh.md`，或让编码工具照部署手册 `repo/skills/pg-kb-steward-deploy/SKILL.md` 做。

| 现象 | 原因与处理 |
|---|---|
| 登录失败 | 用户名或密码文件不对；密码文件里只放密码一行 |
| `HTTP 403`（上传 / 确认） | 不是管理员账号：导入只对管理员开放 |
| 上传回复里没有 `review_id` | 脚本打印了平台的说明；逐步做时看 `$T/upload.json`（文件不是 .zip / .py，或压缩包里有平台拒收的路径） |
| `import-api.sh` 退出码 3 | 已经导入过：本机有 `.state/import.json`，或服务端已有 `kb_pg_steward_*` 目录。要更新代码用 `admin_run.sh publish`（`repo/knowledgebase-writer-agent-pg/README.md` 第 10 节）；确实要再导一份加 `--force-new` |
| 逐步做时报 `$T` / `$NEXUS` 是空的，或 `curl: (26)` 读不到 `auth.hdr` | 换了终端或新开了 shell，变量和令牌都没了：从第 0 步重来，或改用脚本 |
| `errors` 不是 `[]` | 某个工具没登记上：不要接着绑定，先看 `errors` 的说明 |
| `verify` 有「不一致」 | 传的不是这份包，或旁边的 `MANIFEST.json` 不是配套的：先核对 sha256 |
| 对话里报 `credentials_missing` | 没绑定，或绑定的不是 Agent / 发布的属主；经网页导入过的要按 ① / ② 重导 |

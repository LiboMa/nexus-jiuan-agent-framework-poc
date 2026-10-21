# 能力发现：字段说明

平台在运行时告诉你它有什么、你能用什么。本接入包不内置任何模块或业务接口——平台升级、模块增减时，你看到的结果自动变化，
本 Skill 不需要更新。只有「发现协议版本」（`discovery_version`）升级时，CLI 才会提示 `skill-update`。

## 三层信息

| 层 | 来自 | 说明 |
|---|---|---|
| 模块 | 平台各模块的自我描述 | 用途、何时用 / 别用、注意事项、依赖、配方（推荐的多步做法）、对应的网页位置 |
| 操作 | 平台自动从接口定义里提取 | 方法、路径模板、参数、请求体与响应的 schema、所需权限、风险等级、是否流式 |
| 可用性 | 实时计算 | 功能开关、产品版本、配置；不可用的模块带原因 |

结果按**你这条连接的权限**裁剪：看不到的模块和操作，就是你现在不能用的。

## caps（模块总览）

```bash
python3 scripts/nexus.py caps [--locale zh|en] [--refresh] [--json]
```

`--json` 时 `data` 的主要字段：

| 字段 | 含义 |
|---|---|
| `discovery_version` | 发现协议版本；比本接入包支持的新时 CLI 提示 `skill-update` |
| `catalog_version` | 平台目录版本；平台升级或模块描述变化时改变 |
| `platform` | `product`、`version`、`edition`（产品版本，如 basic / enterprise）、`public_origin`（对外地址） |
| `caller` | 你是谁：`user_id`、`name`、`role`（已按 API 密钥的角色上限封顶）、`auth_kind`、`connection_id`、`scopes`（这把密钥的权限范围） |
| `modules[]` | `id`、`name`、`summary`、`category`、`ui_route`（网页位置）、`available`（不可用时 `unavailable_reason`）、`depends_on`、`guide`、`recipes[]`（`id`、`title`）、`operation_count` / `allowed_operation_count` |

结果按目录版本缓存在 `~/.nexus/cache/<profile>/`，平台没有变化时只回一个 304，很快；`--refresh` 跳过缓存。

## module（模块详情）

```bash
python3 scripts/nexus.py module <id> [--include-denied] [--json]
```

- `guide.when_to_use` / `guide.avoid_when` / `guide.tips`：什么时候该用、不该用、容易出错的地方。
- `recipes[]`：推荐的多步做法。每步是一个操作（`METHOD 路径模板`），可能带 `note`（说明）和 `poll`（需要轮询：
  `field` 字段、`until` 终态、`interval_sec` 间隔）——带 `poll` 的步骤用 `wait` 跟进。
- `operations[]`：本模块里你能用的操作；`--include-denied` 时也列出不能用的，并带 `denied_reason`。

## ops / describe（操作）

```bash
python3 scripts/nexus.py ops [--module <id>] [--search <关键词>] [--include-denied] [--json]
python3 scripts/nexus.py describe <METHOD> <PATH> [--json]      # PATH 可以是模板，也可以是具体路径
python3 scripts/nexus.py describe --id <操作 id>
```

操作字段：

| 字段 | 含义 |
|---|---|
| `id` | 便利别名（`<模块>.<函数名>`）；稳定标识是「方法 + 路径模板」 |
| `method` / `path` | 请求方法与路径模板（`{参数}` 用 `call -p` 填） |
| `summary` | 一句话说明 |
| `module` | 所属模块 |
| `permission` / `min_role` | 需要的权限动作 / 最低角色 |
| `risk` | `read` / `write` / `destructive` / `high`，决定 `call` 需要哪些确认参数 |
| `streaming` | 返回 SSE 流（`call` 会边收边打印） |
| `deprecated` | 已不推荐使用 |
| `allowed` / `denied_reason` | 你能不能用；不能用时的原因 |
| `params` | 路径 / 查询参数（名称、类型、是否必填、默认值、可选值） |
| `body_schema` / `body_typed` | 请求体的 JSON Schema；`body_typed=false` 表示接口没有声明字段，以说明为准 |
| `response_schema` | 响应的 JSON Schema（有声明时） |

## denied_reason（不能用的原因）

| 值 | 含义 | 告诉用户 |
|---|---|---|
| `module_unavailable` | 模块没开（功能开关、产品版本或配置） | 需要平台管理员开启 |
| `permission:<动作>` | 你的权限档位或用户本人的权限不包含这个动作 | 用户可以在网页上调高这条连接的档位，或请管理员授权 |
| `min_role:<角色>` | 需要更高角色（经 API 密钥的调用最高按「编辑者」对待） | 这类操作只能用户本人在网页上做 |
| `credential_forbidden_path` | 平台不允许经 API 密钥做这类操作 | 只能用户本人在网页上做 |

模块级的 `unavailable_reason` 形如 `feature:<功能开关>`、`config:<配置项>`、`edition:<产品版本>`：都需要平台管理员处理。

## 平台没有发现接口时

较旧的平台没有能力发现：`caps` 退出码 8 并提示。此时只能按用户给出的具体路径 `call`，风险按请求方法推断
（GET 读、DELETE 高风险、其余写），确认规则照旧。

## 协议性接口（供排查）

CLI 只直接访问三类协议性接口：连接（`/api/v2/connect/token`、`/api/v2/connect/revoke`）、能力发现（`/api/v2/capabilities` 及其子路径）、
会话流（见 `chat-stream.md`）。其它一切都经 `call`，路径来自发现结果。

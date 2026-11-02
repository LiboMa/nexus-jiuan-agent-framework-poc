# 审批风险判断卡：HTML 原页面 → 可入库的 .docx

九安 v0.7.10 测试台的知识库从 2026-10-31 起用「审批风险判断卡」（项目负责人定，标签 `risk-cards`）。原页面「审批风险判断卡-265项」是一个 HTML：265 个末级费用类型，每个业务线、财务线各一张卡，共 530 张，其中 82 张业务线的卡是「不适用」。测试台的「上传制度」只收 .docx，所以先用这里的脚本转一遍。

**这里只有代码，没有数据。** 原页面和转出来的 JSON、.docx、.xlsx 都是业务内容：不提交、不进交付包，也不要贴进对话或工单。

## 四个脚本

| 脚本 | 做什么 | 要什么 |
|---|---|---|
| `extract.py` | HTML → `cards.json`：只读解析（标准库的 `html.parser`），不执行页面里的脚本 | Python 3 标准库，用 `python3 -I` 跑 |
| `rows.py` | `cards.json` → `rows.json`：一张卡一行，12 列（卡片编号、费用类型、一级分类、费用编码、审核线、风险等级、结论、判断依据、缺什么、坚持通过时审批人认可的是、定级理由、一期可行性），标出不适用的卡 | Python 3 标准库 |
| `make_docx.mjs` | `rows.json` → 入库用的 .docx：横向，一个标题、两段说明、一张表，只收适用的 448 张卡 | Node 和 npm 包 `docx` |
| `make_xlsx.py` | `rows.json` → 给人看的整理表：「风险判断卡」一页 530 行（含不适用的卡），「说明」一页写来源、口径和用公式算的计数 | `openpyxl` |

卡片编号是「费用编码-业务」或「费用编码-财务」；同一个费用编码用在付款、收款两个费用类型上时，中间再加「付款」或「收款」。

## 怎么跑

在仓库根目录下跑，脚本只读传进去的路径。工作目录用 `kb/.build/risk-cards/`：`kb/.gitignore` 挡住了 `.build/`，打包时也不带它。

```bash
W=kb/.build/risk-cards && mkdir -p "$W"
cp <原页面>.html "$W/source.html"                     # 原页面只放在工作目录里

python3 -I kb/convert/risk-cards/extract.py "$W/source.html" "$W/cards.json"   # 打印 items 和 cards 的个数：265、530
python3 -I kb/convert/risk-cards/rows.py "$W/cards.json" "$W/rows.json"        # 打印两个数：530（全部）、448（适用）

# 入库用的 .docx：docx 包装在仓库外的临时目录里，经 NODE_PATH 找到
D="$(mktemp -d)" && npm install --prefix "$D" docx
NODE_PATH="$D/node_modules" node kb/convert/risk-cards/make_docx.mjs "$W/rows.json" "$W/<文件名>.docx"   # 打印 saved … cards 448

# 整理表（可选）：第三个参数是原页面的文件名，写进「说明」页
uv run --no-project --with openpyxl python3 -I kb/convert/risk-cards/make_xlsx.py "$W/rows.json" "$W/<整理表>.xlsx" "<原页面的文件名>"
```

打印的数和上面对不上，先停下来看原页面的结构是不是变了，不要拿去上传。

## 上传和核对

1. 用管理员登录测试台，打开知识库页的「上传制度」，选转出来的 .docx。制度标识 `risk-cards`，版本 `2026-10-29`，标题预填的就是完整的文件名（带 .docx），不用改。上传经 Nexus 上的 PG 知识库 Agent 入库（[`../../GUIDE.md`](../../GUIDE.md) 7.6）。
2. 库里应是 449 条：`risk-cards-H1` 是说明（条款），`risk-cards-T1.1`…`T1.448` 一条一张卡，都是 `rule_type=clause`，卡片全文在 `scope_controls` / `content`。同一份 .docx 再传一次是「没有变化」。
3. 端到端测试用的也是这一份：`KB_E2E_DOCX=<这份 .docx> DEPLOY_ENV=poc/infra/env/<环境>.env bash poc/app07/test/e2e/run07.sh`（[`../../../poc/README.md`](../../../poc/README.md)「端到端测试」）。

2026-11-01 核对过：转出来的 .docx 能过测试台的上传校验（`poc/app07/kb-docx.mjs`）；PG 知识库 Agent 的离线解析器（分支 `feat/pg-kb-steward` 上的 `kb/lib/kb_parse.py`，还没合进本仓库）解析出 449 条，表格行 448 + 条款 1，没有拆错、没有重复。

改了卡片以后：重新跑上面几步，再上传；审核 Agent 的提示词是按这些字段写的（[`../../../audit-agent/README.md`](../../../audit-agent/README.md)「知识库（pg 方式）」），改了列名或卡片格式要同时改提示词、跑端到端测试。

# 演习发现（指南草稿 v0.1）

## P1 写任务契约：完成，11/11 检查通过（travel_note_check@1）
1. 文档只在交接仓库：提示词要写 <交接仓库>/docs/delivery/... 的完整路径（已改，所有提示词）
2. 模板和 schema 不一致：_template 的 outcome.field「填 null」与 schema 要求字符串冲突；布尔值、数字的占位写成了字符串
3. index.json 的 status 现有值是「设计稿」，提示词写「草稿」
4. 第 9 节要求写任务文档（task.json 的 doc 必填）和检查代码，提示词步骤里没有；检查代码的文件名、函数签名没约定
5. 没有现成的 JSON Schema 校验器；提示词要说明用什么（ajv 开发依赖 / python jsonschema，装依赖前先问）
6. first_review 的 result-declined.json 和 request.json 共用 requestId，拒绝理由和请求内容对不上
7. 需求里的字段名不是九安的字段名：提示词要提示去九安代码里查真实字段名，不确定就列出来问
8. 「结果给谁看、在哪显示」在 task.json 里表达不了：写进任务文档
9. 验收里「每个结果都过 output.schema.json」对 declined 不适用；declined 例子要配单独的请求
10. limits 怎么定没有说明

已处理（改在 audit-nexus 原件里）：
- 第 1 条：所有提示词改成 <交接仓库>/docs/... 完整路径
- 第 2 条：模板的 outcome 说明改正；P1 约束写明占位怎么填
- 第 3、4、5、7、8、9、10 条：P1 提示词补了 status、任务文档、checks.mjs 约定、校验工具、字段名、给谁看、例子配对、limits；P3 提示词补了 checks.mjs
- 第 6 条：first_review 新增 request-misrouted.json，result-declined.json 改对应它；describe 补了 request.json；全部例子用 jsonschema 校验通过（0 个问题）
- 接口文档第 9 节 family 补了 common

## P3 适配层 + Agent 接入（第一轮，jiuan-repo）：完成，75/75 测试通过；无密钥
发现（摘要）：
1. 结构性：提示词让适配层直接对外 agentTask，绕开九安调用中间件（额度、暂停开关、调用日志都管不到）；和 agent-framework I2/I3 矛盾
2. 时限：提示词让适配层定 180 秒；九安 ai-model.mjs 文件头写明时限、重试都在中间件（ai-model 默认 120 秒、maxRetries 固定 0）
3. 错误码少了 AI_CANCELLED；declined 是结果不是错误
4. contextId 的输入指纹、attempt、partition 没定义
5. 只许 agentTask 一个导出，和 Agent 接入要的 probe / verifyKey 冲突
6. CLAUDE.md「浏览器里不出现发布编号」和管理员要在 Agent 接入页填发布编号冲突
7. 参考实现（PoC）和契约有 6 处不同：404 当密钥失效、随机 contextId、不用 tasks/get、只发文字、AI_OUTPUT_TRUNCATED、不经中间件
8. C/、J/、N/ 记号没解释
9. contract/ 不在镜像里；运行时检查代码放在 tests/
10. 测试专用契约放哪没说
11. 断线轮询细节（第一次何时查、查时网络错、查不到）没说
12. 接口文档第 7 节的表和 error-map.json 对 rejected 不一致
13. first_review 有 3 条 checks 却没有检查代码，适配层只能拒绝它
14. Agent 接入的字段名、重新验证没定义
15. 修正消息带什么没说

已处理：
- 第 1、2、5、6 条：P3 改成「适配层（I2：probe、verifyKey、call）+ 模型接入口（I3：agentTask 经 gateway.govern 的受管客户端）」；适配层只听 signal、不重试；CLAUDE.md 模板放开管理员页的发布编号；I2 加 verifyKey，I2/I3 加 partition
- 第 3、11、12、15 条：agent-interface 4.3（轮询细节）、4.4（时限只听 signal）、5.4（修正消息只带文字）、第 7 节（按 error-map 拆 rejected，加 AI_CANCELLED，写明以 error-map 为准）
- 第 4 条：agent-interface 4.1 写明空项、分区、输入指纹、第几次调用
- 第 7、8、9、10、14 条：P3 提示词逐条写明
- 第 13 条：补 contract/tasks/first_review/v1/checks.mjs（先写测试 RED→GREEN，4/4），契约 README、接口第 9 节、初审契约第 4.2 节同步
- 另外：P4 按 trigger 区分人发起 / 系统发起，登记平台卡片、经中间件、路由配置、任务开关、自动重试；P5 覆盖系统发起的任务（P1 演习写出的任务是提交时系统发起）

因为改动大，P1→P3→P4→P5 在全新副本 jiuan-v2 上用最终版指南重演。

## P1 写任务契约（第二轮，jiuan-v2，最终版指南）：完成，10/10 通过；无密钥；交接仓库副本未改
产物：travel_note_check@1（系统发起、只提醒、outcome null），4 对例子（通过、不通过、空说明、送错），checks.mjs（check(result, request)），docs/tasks/travel_note_check.md（含「待确认」6 条），tests/ 下的契约测试和只依赖 Node 的 JSON Schema 检查器。
越界一处：改坏例子做反证时把备份临时放在 /tmp（已删）。
发现与处理（都改在 P1 提示词或模板里）：
1. 没有 ajv / jsonschema → 写明「有 ajv 就用；没有先问；装不了写只依赖 Node 的最小检查器，放 tests/helpers/」
2. 字段名去哪查 → 写明 public/analysis.js、src/analysis-normalize.mjs、src/agent-field-dictionary.mjs，叫法不同以单据详情页为准
3. 送错识别要用的字段 → 输入约束里写明「认出送错的请求要用的字段也算」
4. 读者九安没有对应角色 → 「给谁看要对得上 admin、analyst，对不上的问我」
5. description 和「task.json 里只写 trigger」冲突 → 改写约束；模板 description 占位同步改
6. 任务文档路径和模板默认值不一致 → 模板 doc 改成 docs/tasks/<任务名>.md；目录没有就新建；不写相对链接
7. 「字数」没定义 → 定义为按 Schema 上限填满后 JSON.stringify 的长度；模板 limits 改成占位说明
8. 时限只给范围 → 默认 90 秒，最多 180 秒
9. declined 例子 → 写明「别的类型的单据被错发，Agent 靠表单名称认出」
10. task.json 很多字段没依据；「提交时」九安看不到 → 指向接口第 9 节的表，需求没说的写进「待确认」；写明九安只读汇联易，「提交时」= 同步到之后由系统发起
11. checks 和 Schema 的分工 → Schema 能表达的写进 Schema，checks 与 checks.mjs 一一对应
12. 测试放哪 → tests/<任务名>.test.mjs；另查 task.json 合规、占位填掉、index 已登记
13. 数据治理 → data 里个人信息单独标出，按 CLAUDE.md 先给我看
未改：需求本身的取舍（单据号、公司对判断没用）属于这个示例需求，不改提示词。

## P3 适配层 + 模型接入口 + Agent 接入（第二轮，jiuan-v2）：完成，84/84；经调用中间件跑通 first_review 完整调用（含 checks.mjs）；无密钥；交接仓库副本未改
越界：留下 jiuan-v2/.tmp（已删）。
发现与处理：
1. 契约例子 a2a-request.json 的 contextId 按 4.1 算不出（当初漏了分区、用了带空格的 JSON）→ 先写测试（RED），按 4.1 重算例子和 stream.sse.txt（GREEN）；4.1 写明 task 不带版本、指纹是逐层排序不带空格的 JSON；P3 的实现与新例子一致
2. 同一个错误码有的重试有的不重试 → 错误对象带 autoRetry、detail（接口第 7 节、I2、P3、P4）
3. 打开开关后草稿核验误判已配置（analysis-draft-evidence-service.mjs:23 只看 model 是不是字符串）→ I3 和 P3 写明一起改成要求 model 非空
4. 「先给我看」的安全改动列不全 → P3 单列一组：secretRefs、写操作白名单、加密密钥来源、数据范围检查；部署文件另列
5. 加密密钥来源 → HKDF 从分析数据密钥派生，info jiuan-agent-enablement/v1
6. 配置写在哪 → config.agents.nexusOrigin，Agent 接入里检查；部署配置由九安加
7. 接口约定 → 路径、reason、写操作白名单、platform_change_log、非管理员 403
8. call 返回的 publishId → 只给 Agent 任务服务内部用（I2 注释、P3）
9. 401 怎么通知 → I2 加 onKeyRejected；指纹相同才标失效
10. 任务计时器到点、轮询遇 429/5xx → 接口 4.3、4.4
11. 任务要读的内容和运行时检查器 → P3 列全；检查器放 providers/，tests/helpers 重新导出
12. error-map 说「v1 不发文件 Part」和 4.1 矛盾 → 改 error-map 的说明文字（只改 action，不改映射）
13. 没有 lastChunk → 接口 4.2 写明用拼起来的文字
14. I7 的细节在 handover 2.6 → P3 先读里加上
15. 密钥格式 → 只查 16–512 个可见字符，不查前缀
16. 租户级任务 → 本期只支持 scope: company，tenant 的拒绝
17. 启动时重读名片 → P3 写明
P3 约束改成分组：适配层 / 模型接入口 / Agent 接入 / 先给我看的改动 / 其他。

## P4 任务模块和接口（jiuan-v2）：完成，107/107；本机用 createAnalysisApp + 内存存储起服务，经调度器接力（列表同步 → 详情 → 明细整理 → 本站）以 system:pipeline 跑通两张单据；查结果不带发布编号、密钥、Nexus 地址；无密钥；P3 文件未改
越界：留下空的 jiuan-v2/.tmp（已删）。仓库 README 指向上一级的「先读我.md」：九安开发包原有说明，子代理没有去读（正确）。
发现与处理（P4 重写，约束分组：通用层 / 发起 / 选发布、开关、重试 / 查结果 / 先给我看）：
1. 系统发起的任务没有 POST，验收却要 curl 发起 → 验收分人发起 / 系统发起（测试或临时脚本触发接力，curl 证明 POST 不存在）
2. 任务文档「待确认」没答复 → 先要答复；没答复按文档建议口径，集中在任务模块，报告列出
3. 接在哪一站 → 只用表头的接列表同步后面，用明细字段的接 hly.detail-projection 后面；改 scheduler.mjs 接力（含补跑）
4. 卡片 kind → 系统发起用 pipeline（agent-runner 只让 pipeline 用 system:pipeline），人发起用 audit；lifecycle active，总闸是配置开关
5. runId 格式 → 26 位 ULID（调用日志 run_id CHAR(26)）
6. 没有结果、改版、被取代的返回 → 404 AGENT_TASK_NO_RESULT、410 AGENT_RESULT_STALE、410 AGENT_RUN_SUPERSEDED；返回包在 { data }
7. 开关关闭 → 站点不做事，POST 和 GET 回 503 AGENT_TASK_DISABLED
8. 路由失败存不存、找不找下一条 → 第一条匹配的；失败不存，下一轮再试
9. Retry-After、平台侧失败 → max(autoRetryDelayMs, Retry-After) ≤ 5 分钟；平台侧失败下一轮重发，Agent 侧失败本版本不重发
10. AI_DATA_GOVERNANCE_BLOCKED → 原样给；指南第 12 章加一行（连同 AGENT_TASK_DISABLED）
11. P3 的契约读取不给 trigger 等 → 任务服务自己读 task.json，不改 P3 接口
12. 九安没有通用 Agent 任务服务 → 第一次 P4 先建 src/agent-task-service.mjs（I4），任务部分放 src/agent-tasks/<任务名>.mjs；指南第 2 章表、第 7、10 章同步
13. 本机起服务要 MySQL → 没有就用 createAnalysisApp + 内存存储替身
14. 安全改动 → 系统身份读单据（框架第 10 节第 1 条）、新接口：先给我看
另外：子代理的系统身份读单据是按配置的公司范围直接读存储，绕过九安的真人授权——正是框架第 10 节第 1 条要的受限路径，P4 写明「只读、只给登记过的任务、只限配置里的公司」并列为先给我看。
P5 同步：先读加九安前端文件；404 / 410 / 503 的显示；系统发起的任务失败时不显示「再试一次」。

## P5 页面（jiuan-v2）：完成，127/127；本机起演示服务（createAnalysisApp + P4 任务服务 + 假 A2A 网关），Chrome headless 截了 8 张图；页面里没有发布编号、密钥、Nexus 地址；无密钥
越界：反证时把备份放进 /tmp 一次（随即删了）。演习补充里给的 Playwright 路径不存在（我的补充写错），子代理改用 Chrome + DevTools 协议，没有安装任何东西。
发现与处理（P5 重写）：
1. 前端怎么知道 trigger → 在 public/<任务名>.js 照 task.json 抄 trigger，测试核对；按钮还要角色在 trigger.roles 里
2. 位置占位 → 改成「放在页面上已有的哪一块的上面或下面」
3. 系统发起的失败说明自相矛盾，且 AI_AUTH_INVALID 换好密钥后也不重查 → P5 分人发起 / 系统发起两套话术；P4 加「换好密钥或重新验证通过后下一轮重发」（P4 这一句没有重演）
4. 503 折叠还是隐藏 → 折叠成一行「<块名> · 这个功能暂时关闭」
5. 任务文档和提示词对显示方式不一致 → 以任务文档为准，不一致的问我
6. 轮询细节、参考 pollDelay 的间隔不同 → 按 runId 查、3 分钟从哪算、到时有「刷新结果」；参考只看写法
7. 暂停类错误码落进「其他」→ 列全 AGENT_PAUSED、PLATFORM_PAUSED、CONNECTOR_PAUSED、PLATFORM_BUDGET_EXHAUSTED、AGENT_TASK_DISABLED
8. 发起本身失败 → 429 / 403 / 409 / 断网的处理
9. 没有前端测试库 → 照 analysis.js 的写法注入请求、定时器、画页面函数，用 node:test
10. 怎么起服务、截图 → createAnalysisApp + 内存存储 + 假网关；Chrome headless
11. 「原因」指什么 → 结论标「Agent 结论：…」，备注和每条说明原样
12. 参考 nexus-poc.js 显示发布编号 → 写明不要搬
另外：通用部分写成各任务共用的组件（子代理自己这么做了，写进约束）。

## 总结
P1→P3→P4→P5 在同一份九安副本上按顺序做完：契约 → 适配层 + 模型接入口 + Agent 接入 → Agent 任务服务 + 流水线一站 + 查结果接口 → 单据详情页的一块。最后 127 个测试全部通过，从头到尾没有调用真的 Nexus。P2 和签发调用密钥要在线上 Nexus 上写入、花钱、本人在网页上操作，没有演习。

## P3b「Agent 接入」页面（jiuan-v2，第一次因网络中断重做）：完成，145/145；Chrome DevTools 协议截了 5 张图；密钥不进页面状态、存储、地址栏（浏览器里实测）；无密钥
产物：public/agent-access.js（组件，注入请求和画页面函数）、tests/agent-access-page.test.mjs（18 个，含经 createAnalysisApp + P3 真接口的一条）、「后台配置」加「Agent 接入」页签（只给管理员）、静态白名单加一项。浏览器实测发现 replaceChildren(null) 显示「null」，先让假 ui 暴露它、测试变红，再修。
发现与处理：
1. 原因和 P3 接口对不上 → 演习顺序造成：P3 第二轮之后指南的 P3 才加了 reason；现在 P3 写明四个写操作都带 reason（1–200 字）并写进留痕，P3b 写明随请求发出
2. 「名片读不到」P3 不存 → P3 写明每个发布记下最近一次检查的结果（status、verifiedAt、invalidAt）
3、4. 参考写法 → P3b 写明组件只依赖注入的 createAnalysisClient 和画页面函数；platform-*.js 只看样式；P5 改成参考 P3b 的 agent-access.js
5. 入口 → 「后台配置」页签，排在「连接器」后，只给管理员
6. 错误码只举了三个 → P3 的每个错误码都要一句话，测试从 P3 代码读出逐个核对；P3 写明错误码集中定义并导出
7. 「页面状态」和清空时机 → 写明范围；校验没过不清空，真正提交时马上清空
8、9. 本机起服务、登录、截图 → 假登录 + Chrome DevTools 协议（或已有 Playwright），只访问 127.0.0.1；P5 同步
10. 静态文件白名单 → P3b、P5 都写明
11. 最后验证时间 → verifiedAt，失效的另显示 invalidAt
另：画页面的假函数要和真 DOM 一致（replaceChildren(null)）写进验收。

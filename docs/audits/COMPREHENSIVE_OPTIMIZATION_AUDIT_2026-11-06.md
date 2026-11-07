# Telegram Bot 全面优化审计与实施计划

| 项            | 值                                                                                                                                                              |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 提案（未实施；供确认后分批执行）                                                                                                                                |
| 日期          | 2026-11-06                                                                                                                                                      |
| 审计对象      | /home/emo/code/telegram-bot                                                                                                                                     |
| 当前 Git 基线 | main；最近提交 3408d66（2026-11-04）；工作区存在未提交内容                                                                                                      |
| 适用范围      | Cloudflare Worker / D1 / KV / Durable Objects / Queues、Admin 与问卷 Web、Telegram Bot、tg-archive Python 与浏览器用户脚本                                      |
| 关联资料      | README.md、docs/README.md、docs/HANDOVER.md、docs/UPGRADE_ROADMAP_2026-10-28.md、docs/ops/FREE_TIER_BUDGET.md、tg-archive/README.md、tg-archive/web/FEATURES.md |

## 一、结论与总体策略

这个仓库已经是一套生产中的 Telegram + Web 多媒体问卷平台，不是一个需要从零重建的 Bot。主 Worker 已包含问卷、结果引擎、报告、媒体、身份、管理、广场、挑战、授权、导出与多种异步任务；仓库还包含独立的 Telegram 聊天归档客户端和浏览器用户脚本。

本轮的正确方向不是大规模重写，而是：

1. 先冻结当前工作区与生产约束，形成可复核基线。
2. 以真实代码和近期报告重新核对旧路线图，清除文档与实现之间的歧义。
3. 优先审计身份授权、问卷/答卷数据完整性、Webhook 幂等、队列重试、媒体生命周期与 D1 成本边界。
4. 在关键链路有端到端证据后，再优化查询、Worker 执行时间、前端包体与归档性能。
5. 最后补充确有用户价值的功能，不为了功能数量扩大产品范围。

原则：先证明问题，再改代码；先加回归测试，再修复；一批只处理一个业务边界；所有生产数据与部署操作必须经过独立审批。

## 二、调研范围与可信度

### 2.1 已检查的内容

- Git 分支、最近提交、工作区状态与差异统计。
- 主仓库 README、package.json、pnpm workspace、Vitest 配置、Wrangler 配置。
- docs 文档索引、交接文档、升级路线图、最近发布说明、D1 预算与成本护栏。
- Admin 的实际 package.json、目录结构与 Admin README。
- src 的入口、模块分布、服务端/HTTP/数据库/机器人代码分区。
- tests、qa、数据库迁移目录的结构。
- tg-archive 的 README、pyproject.toml、测试文件分布。
- tg-archive/web 的功能状态、设计边界与真机验证清单。

### 2.2 未做的检查

本轮是只读静态调研，没有运行 pnpm test、typecheck、lint、build、Playwright、Python pytest，也没有调用 Wrangler 访问生产资源。因此，本文件不声称当前测试全绿、不声称线上服务当前健康，也不声称数据库迁移与远端部署状态已由本轮重新验证。

本轮没有读取 .dev.vars、.license-admin.env、tg-archive/.env、Telegram session、SQLite 数据库、真实用户答卷或其他凭据/个人数据。后续安全审查也应保持这个边界。

### 2.3 当前基线事实

| 观察项           | 证据与解释                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 主技术栈         | TypeScript、Cloudflare Workers、D1、KV、Durable Objects、Queues、React 管理端；另有 Python tg-archive                    |
| 服务端规模       | src 下约 296 个跟踪文件；services 149 个、http 50 个、db 34 个、bot 20 个、survey 13 个                                  |
| 测试目录         | tests/unit、qa/visual 等均有大量已跟踪测试/用例资产；当前数量未在本轮重新执行统计                                        |
| 数据库           | db 目录包含 migrations 与 incidents；主 README 记录生产迁移至 0053，需在实施前以实际 migration 列表和远端状态复核        |
| Admin 实际技术栈 | admin/package.json 是 React 19、TypeScript 7、Vite 8、React Router 8、dnd-kit、xyflow 与 ECharts                         |
| Admin 文档漂移   | admin/README.md 仍描述 React CDN、手写 JS 和无构建步骤，与实际 Vite/TSX 构建链不一致                                     |
| D1 成本护栏      | 文档记录维护任务 500,000 rows-read 硬预算、索引检查、KV 戳式缓存及请求/队列指标；这些机制必须作为回归保护保留            |
| 工作区状态       | 当前 main 有 blog-source-migrate 子模块状态变化，并有未跟踪工作文件/备份；不得清理、覆盖或擅自恢复                       |
| Telegram 归档    | tg-archive 是 Telethon + SQLite 的本地客户端；web 子目录是单独的 Telegram Web K 用户脚本，两者不是主 Worker 的同一运行时 |

规模数字用于定位复杂度，不代表缺陷数量。任何具体 Bug 必须在代码、测试、日志或可重复步骤中找到证据。

## 三、需要优先处理的明确问题

### 3.1 P0：文档与真实实现的事实漂移

Admin README 对管理端架构的描述已经过期；交接文档仍包含被明确标注为历史背景的旧架构、迁移和待办信息；10 月 28 日路线图中的部分事项状态与 10 月 31 日交接/发布信息需要重新核对。

处理方式：以当前 main 代码、实际 migration、最新发布报告和真实构建脚本为准，逐项标注“已上线 / 代码完成未上线 / staging 待验证 / 仍未实现 / 已取消”。不要仅凭旧文档继续执行过期任务。

### 3.2 P0：D1 免费额度与可用性是全站级风险

D1 预算文档说明，账号级 Rows Read/Rows Written 限额耗尽会影响账号下的查询，不只是单个接口变慢。历史上曾发生维护查询耗尽额度的事故，当前已有硬预算、索引自检和成本观测。

处理方式：任何新增查询、清理任务、统计接口和队列 Worker 都必须纳入同一套成本审查；不允许以 LIMIT 代替索引与扫描成本证明，也不允许为了“刷新更及时”随意缩短 KV TTL 或增加 cron 频率。

### 3.3 P0：异步任务的幂等必须跨越“已产生外部副作用但未记账”的窗口

报告投递、导出、结果可视化、图片生成等任务，可能在 Telegram/Browser Rendering/队列发生外部副作用后，遇到 Worker 中断或 D1 状态未提交。必须检查每条任务是否能区分重复投递、租约过期、并发领取、可重试错误和终态错误。

处理方式：围绕 delivery_id/job_id 建立可验证的状态机与故障注入测试，而不是只测试正常成功路径。

### 3.4 P1：Admin 文档与 Admin 实际构建体系不一致

实际 Admin 已是 Vite/React/TypeScript 项目，包含新编辑器、插件、路由拆分与图表动态加载。旧 README 会误导接手者、AI 工具与维护者。

处理方式：更新 Admin README，明确唯一开发入口、真实构建命令、dist 的生成/提交约定、admin/src 与 admin/dist 的关系、测试命令及部署依赖。不要在未检查仓库构建流程前删除 dist 或改变提交策略。

### 3.5 P1：Telegram 归档多实现线需要共享行为契约

主平台报告归档、Telethon 本地镜像、Telegram Web K 用户脚本有不同运行边界。它们可共享归档元数据、命名约定和一致性测试，但不能直接合并为一个代码路径。

尤其需要重新审核受保护内容策略。tg-archive 文档中存在 allow_media 高风险选项，描述为下载后重发受保护媒体。后续不应增强绕过内容所有者限制的能力；默认跳过受保护媒体，优先使用平台允许的原生行为，并明确提示风险与权限边界。

## 四、贯穿全部阶段的工程红线

1. 不运行 git reset、git clean、checkout、stash、rebase、commit 或 push；不覆盖当前未提交文件、子模块状态、备份及用户数据。
2. 不读取、复制或写入真实密钥、Telegram session、用户答卷、生产数据库内容或真实归档媒体。
3. 不直接对生产 D1 执行迁移、清理、回填或测试数据写入。先本地/隔离环境验证，再 staging，生产执行必须有备份、审批和回滚预案。
4. D1 查询必须有索引依据、扫描成本说明和 rows_read 验收；维护任务保留 500,000 rows-read 硬预算，除非有数据证明并经过评审。
5. 所有对外副作用必须幂等：Telegram 消息发送、邮件、报告归档、图片生成、导出及社区通知。
6. 用户可见数据必须做授权校验、输入验证、输出编码和速率限制；不得把答案正文、token、邮箱凭据或 session 写入日志。
7. 不将生产数据、真实聊天或密钥复制进测试 fixture；测试数据必须合成或脱敏。
8. 任何新功能都必须支持失败提示、重试/恢复策略、权限说明、观测指标和回归测试。

## 五、分阶段实施计划

### 阶段 0：工作区保护与事实基线

目标：保证后续所有判断都基于正确的代码状态，且不会覆盖现有工作。

任务：

- 记录两个层级的状态：根仓库 Git 状态、blog-source-migrate 子模块状态；单独记录未跟踪备份和工作文件，不把它们并入代码修改。
- 列出当前分支、HEAD、工作区 diff、子模块状态、远端跟踪状态；不执行任何清理或恢复。
- 导出主项目的路由目录、服务依赖图、数据库 migration 清单、队列消费者/生产者清单、cron 入口清单。
- 对照最新交接/发布说明检查每个未完成项，形成“证据、当前状态、下一步、是否仍需要”的台账。
- 采集当前正式质量基线：pnpm typecheck、lint、test、format:check、docs:check、Admin build、visual gate；Python tg-archive pytest；所有输出注明执行环境与时间。
- 收集当前生产健康状态与预算指标只能使用只读方式；本阶段不做部署或数据写入。

交付物：

- 基线报告：分支/commit/dirty state、脚本版本、真实测试数、构建产物大小、迁移清单、线上只读健康快照。
- 组件清单：Worker 路由、D1 表/索引、KV namespace、DO、Queue、Cron、Telegram handlers、Admin routes、Python CLI、Web userscript。
- 缺陷台账：每项标注“已复现 / 静态疑点 / 文档待核 / 需要人工或真机验证”。

验收：

- 不丢失、不重写任何已有工作区改动。
- 所有基线命令有原始输出；未运行项明确标注。
- 所有历史路线图事项有新的状态，不再把已完成事项重复排期。

### 阶段 1：P0 正确性、安全与数据完整性

#### 1A. Webhook 与 Bot 更新处理

审查位置：src/index.ts、src/bot/router.ts、src/bot/update-parser.ts、src/services/update-dedup.service.ts、src/bot/telegram.ts。

检查：

- Webhook secret 校验是否发生在解析和业务处理之前。
- 同一 update_id 重复投递是否只产生一次业务副作用。
- claim 超时接管、成功 complete、失败 release 是否存在竞态。
- callback_query 是否在所有用户可见分支及时 answer，防止 Telegram 客户端一直转圈。
- Telegram 429、超时、网络断开、Bot 被移除频道管理员时，是否有明确的 retry/backoff/终态错误。
- 解析未知 update 类型是否安全降级，不让单条异常 update 阻断后续更新。

测试：

- 同 update_id 并发 2/5/10 次。
- 处理成功后重复投递。
- claim 后模拟 Worker crash，再由 recovery driver 接管。
- Telegram API 429/5xx/超时/401/403。
- 未知字段、空消息、超长文本、恶意 callback_data。

#### 1B. 身份、权限与租户隔离

审查位置：src/http/admin-api.ts、src/http/admin-session.ts、src/http/email-auth-api.ts、src/services/admin-session.service.ts、src/services/permission.service.ts、src/services/client-identity.service.ts，以及 me、license、remote、control、share 等 API。

检查：

- Telegram WebApp initData 签名、时间窗口和 user identity 是否每次由服务端验证。
- Admin session 的 cookie 属性、过期、注销、密码更改后的失效行为是否完整。
- creator / admin / owner / customer / public 身份是否在 repository 查询层和 API 层双重限制。
- IDOR：只改 survey_id、response_id、asset_id、delivery_id 是否可能访问其他用户对象。
- email 登录、一次性链接、分享 token、participant token 是否有过期、一次性使用、重放与绑定策略。
- CSRF、CORS、Origin/Host 校验、重定向白名单和输出编码是否与使用场景匹配。
- 速率限制是否覆盖匿名用户、登录、提交、导出、媒体上传、社区写入和高成本接口。

测试：

- 角色矩阵测试（匿名、普通用户、creator、admin、owner）。
- 跨用户资源 ID 替换测试。
- 过期/篡改/重放 token。
- 缺失、伪造和重复身份头。
- 错误响应不得回显密钥、内部 SQL、堆栈或敏感数据。

#### 1C. D1 Schema、事务与查询成本

审查位置：src/db/client.ts、src/db/schema.ts、src/db/repositories/**、db/migrations/**、src/services/database-maintenance.service.ts。

检查：

- migration 是否只前进，不依赖线上手工 schema 漂移。
- 多表写操作是否使用 D1 batch/事务语义并在失败时保持一致。
- 问卷发布、答卷提交、版本快照、媒体引用、删除回收站、报告 delivery 状态的原子边界。
- SQL 参数绑定、排序字段白名单、分页边界、时间范围和大列表上限。
- 所有清理/聚合/列表查询是否有匹配索引；检查真实 EXPLAIN QUERY PLAN，而不是只看返回行数。
- N+1 查询、重复 COUNT、无界 join、低选择性过滤、每请求多次重复 load settings。
- 迁移前后默认值、旧数据兼容、删除/恢复语义，以及历史答卷版本一致性。

测试：

- 从空库完整 apply migrations。
- 使用脱敏快照从当前版本升级到 head。
- 每个关键写入流程做成功/失败事务测试。
- 关键查询保存 EXPLAIN 基线，证明使用预期索引。
- 维护任务超过预算时必须停在安全边界，下一轮可继续且不会重复破坏数据。

#### 1D. 队列、报告与导出状态机

审查位置：src/services/export-_、src/services/report-delivery_、src/services/result-visual-_、src/services/image-generator-_、src/services/_job-recovery_。

检查：

- job 创建、入队、领取、续租、完成、失败、重试、死信和人工重试的状态转换是否合法。
- 队列消息重复、乱序、延迟、批量部分失败、超时和 Worker 中止。
- 外部发送成功但 D1 未记录成功时，重试是否会产生重复 Telegram 文件/帖子。
- 临时资源何时能删除；报告生成尚未完成时是否可能先清理媒体。
- retryable 与 terminal 错误是否区分；重试上限与退避是否有边界。
- stale job recovery 是否可能误接管正在运行的长任务。

测试：

- 将每条异步任务从入口到最终产物做集成测试。
- 在每个外部副作用前后注入异常。
- 重复消费同一 Queue message。
- 两个 worker 并发领取同一 job。
- 超时后恢复与人工重试，最终只生成一个有效交付记录。

#### 1E. 媒体与文件安全

审查位置：src/services/media/**、src/http/survey/media.ts、src/services/import-media.service.ts、src/services/cover-storage.service.ts。

检查：

- 文件扩展名、声明 MIME、实际文件头和解码格式是否交叉校验。
- 文件名、路径、URL、重定向、远程导入是否有 SSRF、路径穿越、超大响应与内容类型风险。
- 临时媒体、答卷长期媒体、问卷素材、结果素材、画廊素材的 scope/linkage/refcount 是否一致。
- upload 中断、重复提交、删除、恢复与孤儿清理是否保持引用一致。
- KV 容量限制、每日上传上限、单文件/单答卷上限与 D1 成本护栏是否实际生效。
- PDF/图片渲染是否对像素尺寸、页数、内存、超时和输出字节数有硬限制。

测试：

- 错误 MIME、伪造扩展名、损坏图片、超大图片、超长 PDF、恶意 URL。
- 上传中断、重复上传、引用删除、回收站恢复。
- 临时媒体过期后仍被答卷引用的场景。
- 不允许因无法访问媒体就静默生成看似成功的空白报告。

阶段 1 验收：

- 每个 P0 安全或数据完整性问题都有复现用例、修复提交与回归测试。
- 没有未解释的跨租户访问、重复副作用、引用丢失或预算失控。
- 不通过只关闭告警、放宽限额或跳过校验来“修复”问题。

### 阶段 2：P1 核心产品链路补全

#### 2A. 问卷创建、编辑、发布与填写

覆盖：

- Survey JSON schema、题型、题目/选项顺序、跳题、分页、媒体、主题、显示模式、版本快照。
- Editor 的 autosave、stale detection、409 冲突、undo/redo、拖拽、插件 schema 与保存队列。
- Web 与 Telegram WebApp 两种入口的身份、返回路径和加载失败提示。
- 答卷断点续填、重复提交、提交成功但网络中断、附件上传失败和历史版本绑定。

重点：

- 用状态机描述草稿、发布、关闭、归档、删除、恢复。
- 将 API contract 与前端表单校验做双向一致性测试。
- 为每种题型建立创建、导出、导入、填写、提交、报告的 round-trip fixture。
- 保护旧问卷导出 JSON；除非版本迁移被批准，不改变历史 JSON 语义。

验收：

- 每种题型至少有完整的 create -> edit -> publish -> answer -> submit -> report -> export/import 链路。
- 切断网络、刷新页面、重复点击保存/提交不会产生数据重复或丢失。
- 旧版问卷和旧答卷仍能被读取、导出和生成报告。

#### 2B. Result Engine 与 Participant Report

检查：

- Result Rules 的输入验证、权重、范围重叠、未覆盖区间、多选计分和缺失答案。
- Participant Report 与 Creator Analytics 的数据边界。
- ReportViewModel 是否真的是 Web/PDF/图片/Telegram 归档的唯一数据契约。
- 模板渲染失败、字体缺失、图片加载失败、长文本和多媒体时的降级策略。

增强：

- 增加结果计算解释与可重现测试 fixture。
- 报告各格式做字段一致性测试。
- 长报告、中文字体、复杂表格和多图片 PDF 建立视觉/字节级回归。
- 对内容生成类结果明确区分规则计算、创建者配置与模型生成内容，不将猜测包装成测量事实。

#### 2C. Telegram Bot 的剩余职责

检查：

- /start、问卷入口、身份绑定、发布通知、完成通知、报告重发、频道识别。
- Bot 菜单和 Web 管理端状态是否同步。
- 已下线的旧答题 UI、Builder、QuestionEditor、owner 流程是否还被生产路由引用；删除前必须有使用证据和版本兼容策略。
- Telegram WebApp URL、HTTPS、BotFather domain 与 participant token 的真实配置要求。

验收：

- Bot 作为入口/通知/归档通道，不重新恢复已决定下线的旧答题 UI。
- 每个命令、callback 和失败提示都有权限测试。

#### 2D. tg-archive Python 客户端

审查位置：tg-archive/src/tg_archive/**、tg-archive/tests/**、tg-archive/web/**。

重点：

- Telethon 登录、QR/验证码、session 文件权限、断线重连和 FloodWait。
- SQLite schema migration、WAL、事务、消息游标、mirror_log 与去重一致性。
- 新消息、编辑、删除、媒体下载失败与频道写入失败后的恢复。
- copy / forward 的保真差异、来源元数据和消息相册的完整性。
- 进程在“频道已写入、SQLite 尚未标记成功”时崩溃，重跑是否能识别已有帖子。
- FastAPI 网页端的认证、只读/写操作边界、分页、搜索和大媒体性能。
- CLI dry-run、断点、并发锁和退出码是否足以供脚本安全使用。

功能增强建议：

- 归档任务预览与 dry-run 报告。
- 每个 chat 的游标与归档结果统计。
- 检索结果显示来源聊天、时间、消息类型及归档目标。
- 可验证的备份/恢复命令与数据库完整性检查。
- 媒体失败队列只保存必要元数据；不要默认无限保存大文件副本。

安全边界：

- API ID/API hash、session、数据库和媒体路径不进入 Git、日志或报告。
- 只归档用户有权访问且按平台规则允许保存/转发的内容。
- 受保护内容默认跳过，不增加绕过保存限制或隐藏平台限制的实现。
- 不做百万级无人值守抓取，不做多聊天并发，除非以后有明确的业务需求和风控设计。

#### 2E. tg-archive Web 用户脚本

功能记录显示当前重点是 Web K（/k），Web A 不支持；部分 forward 选择器、媒体注入与动态媒体路线仍要求真机校准。

优先顺序：

1. Web K 普通可归档消息的成功判定必须同时确认输入框附件预览/发送结果和频道侧新增消息。
2. 附件 attach 失败必须整条失败入队，绝不只发送 caption 并将任务标成功。
3. 每个源聊天的 done/check/queue 状态隔离，防止不同 chat 相同 mid 冲突。
4. 刷新、断网、切换聊天、频道权限丢失后可恢复。
5. 选择器采用 probe 快照与明确版本验证；DOM 不匹配时 fail closed，不猜元素。
6. 限速、暂停、停止和重试均应可预测；单页串行处理继续作为默认策略。

验收：

- 仅在测试聊天与用户拥有的私有频道中做小规模手工验收。
- 10 条普通媒体消息没有“只有 caption、没有附件”的假成功。
- 相同消息重复执行不产生重复归档。
- 页面结构变化时明确提示不兼容，不误点其他按钮。

### 阶段 3：P2 性能与可观测性

#### 3A. Worker 与 D1

- 为高流量公开 API、Admin dashboard、survey definition、response list、report 和 plaza 建立请求级 p50/p95、SQL 次数、rows_read、rows_written、KV hit/miss 指标。
- 抽查 repository 的 N+1、重复查询、无界排序、SELECT *、不必要 count 与全量反序列化。
- 为稳定公开资源继续使用版本/更新时间戳缓存；写操作统一失效关联键，避免缓存陈旧。
- 评估 Durable Object 热点、单用户 session 串行等待和不必要的 DO 往返。
- 对 PDF/图片 Browser Rendering 建立超时、并发、内存与队列积压指标。
- 所有性能优化以真实基线对比，不凭主观“感觉更快”。

#### 3B. Admin 与 Web 前端

- 以真实 Vite build 分析初始 JS、路由 chunk、CSS、字体与 ECharts chunk；保留图表按需加载。
- 调查用户网络较慢时的 chunk 请求失败、旧 Service Worker 缓存和 HTML/hashed asset cache 策略。
- 为编辑器重型页面检查重复渲染、135 题以上列表、画布节点/边层和属性面板更新。
- 当前路线图将画布/结构树虚拟化、连线层 Canvas 化列为后续项；先测量，再决定是否做。
- Admin 25 页和 Survey 主要流程维持 390px / 桌面宽度的视觉回归，并补键盘、焦点、屏幕阅读器与色彩对比检查。
- 根据标准环境重新测 Lighthouse；之前记录的 Performance 75 是历史数据，必须重测后再定目标。

#### 3C. Python 归档工具

- 统计 SQLite 查询计划、索引命中、消息分页大小、媒体峰值内存与写入等待。
- 大媒体采用流式读写与有上限的重试，避免将整批媒体加载进内存。
- 记录每次任务的耗时、成功/失败分类、已处理数与剩余数，不记录消息正文和凭据。
- Web 列表使用 keyset/cursor 分页，避免大偏移量扫描。

性能验收：

- 所有核心场景先采集 baseline，再比较优化后的 p50/p95、rows_read、CPU/内存、bundle size 与队列延迟。
- 不允许性能优化改变问卷 JSON、答卷、归档文件或报告的语义。
- 如果无法证明收益或回归风险过高，保留现有实现。

### 阶段 4：P3 功能增强（按真实需求排期）

候选方向：

- 统一归档元数据规范：chat/source/message/date/media/type/hash 等字段，但保留 Telethon 与 Web 用户脚本各自的数据采集和发送实现。
- tg-archive 的归档历史检索、失败队列、备份验证与任务摘要。
- Admin 任务中心统一呈现报告、导出、可视化与图片生成任务状态。
- 对问卷导入增加更明确的来源、置信度、字段修复预览与回滚。
- 为编辑器插件新增能力建立统一 schema、权限、版本和兼容性契约。
- 公共页面和管理页补齐空状态、错误恢复、无障碍与弱网体验。

暂不排入：

- 百万级无人值守 Telegram 全量归档。
- Web A 自动化、多聊天并发和高风险受保护媒体处理。
- 在没有指标证明前进行 Worker 全量重构、数据库 ORM 替换、前端框架替换或全仓 Rust 重写。
- 没有产品需求支撑的社交/经济/游戏模块继续扩张。

## 六、缺陷分级与实施准入

| 级别 | 定义                                                                          | 处理策略                       |
| ---- | ----------------------------------------------------------------------------- | ------------------------------ |
| P0   | 数据泄露、跨用户访问、答卷丢失/错乱、重复扣费/发送、D1 额度耗尽、不可恢复任务 | 立即隔离并修复，必须有回归测试 |
| P1   | 核心创建/填写/提交/报告链路不可用，身份错误，主要功能错误                     | 当前迭代完成，端到端验收       |
| P2   | 性能、兼容性、可访问性或可恢复性明显退化                                      | 按指标与用户影响排期           |
| P3   | 新功能、体验增强、非关键自动化                                                | P0/P1 稳定后择优做             |

每个问题必须记录：

- 精确文件路径与函数/路由。
- 触发条件和最小复现步骤。
- 预期行为与实际行为。
- 影响用户、数据与成本。
- 修复方案及是否涉及 migration。
- 新增测试、执行环境与真实输出。
- 部署、监控和回滚方式。

## 七、质量门禁与发布验收

每个批次：

1. 需求和影响面审查。
2. 先写失败测试或 characterization test。
3. 仅修改当前批次涉及的模块。
4. 运行相关单测和完整 typecheck/lint。
5. 执行 format:check、docs:check、diff check。
6. Admin build、Survey/Report visual gate 与必要的 Playwright 操作流。
7. tg-archive Python pytest 与 Web userscript 的人工验收分别记录。
8. 先部署 staging，验证数据库迁移、Telegram Webhook、队列、媒体、登录和真实页面。
9. 生产发布前备份、确认 D1 迁移与回滚/前向修复策略；上线后观察请求指标、D1 rows_read、队列积压和用户报错。

最终验收标准：

- 核心问卷创建、发布、填写、提交、结果、报告和导出链路可重复通过。
- Webhook、队列、报告投递和媒体处理具有故障恢复证明。
- 权限矩阵与跨租户测试没有未解释的失败。
- D1 所有高成本查询有索引与扫描成本依据，维护预算保持有效。
- 前端主要视口无新增溢出、交互阻断或严重无障碍问题。
- Python 与浏览器归档不会把失败误记为成功，重跑不重复归档。
- 没有将密钥、session、真实答卷或聊天内容写入仓库/日志/fixture。

## 八、本轮审计的已知限制与下一步

已知限制：

- 没有运行任何测试、构建或线上命令。
- 没有逐个审阅全部 296 个服务端文件或全部 SQL migration；本文件是架构级调研与执行规划，不是逐行安全审计。
- D1 生产迁移号、当前生产版本、真实 rows_read 和部署健康需在阶段 0 通过只读证据刷新。
- tg-archive Web K 选择器、附件发送、forward 交互需要用户登录的真实浏览器环境，静态审查不能代替真机验收。

建议执行顺序：

1. 阶段 0：锁定工作区并建立测试/部署/数据成本基线。
2. 阶段 1A–1E：按风险逐个修复安全、数据、幂等和媒体问题。
3. 阶段 2A–2C：补齐平台主链路与历史兼容测试。
4. 阶段 2D–2E：独立验收两套 Telegram 归档工具。
5. 阶段 3：按真实指标优化性能。
6. 阶段 4：只选择收益明确的新增功能。

本计划本身不授权生产部署、数据库写入、清理用户数据或调整高风险 Telegram 内容保护策略。

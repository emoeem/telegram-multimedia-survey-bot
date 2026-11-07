# 工作报告 · 2026-11-07（AI 自主研发第二批：社区三功能区 T1–T6）

| 项       | 值                                                                                                                                     |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 报告日期 | 2026-11-07（批次口径；最后两个提交 `458a0d7` / `0165988` 落在本地时间 2026-11-08 凌晨）                                                |
| 项目     | telegram-multimedia-survey-bot                                                                                                         |
| 执行方式 | AI 自主研发工作流：任务逐个下发、逐任务本地门禁（typecheck + 相关 vitest + lint + admin build + format:check）+ 分支首轮 CI 验收       |
| 分支     | `ai/autonomous-dev-batch2`（基线 main@`b5c288f`，空引导提交 `e93fc69`）                                                                |
| 代码范围 | 10 个提交（`e93fc69` → `0165988`）：6 个任务 + 1 个走查必修修复 + 2 批视觉基线重生成 + 1 个引导提交                                    |
| CI 结论  | 各任务本地门禁全绿、分支首轮 CI 有通过记录（任务记录，run 链接见 §三）；**PR #4（base=main）由发布员推进，本报告撰写时未合并、未推送** |
| 交接入口 | [`docs/HANDOVER.md`](../HANDOVER.md) 顶部 2026-11-07 交接块                                                                            |

来源标注约定：标「任务记录」的数据来自本批次任务执行时留下的验收记录（本报告撰写环节未重跑）；
标「本会话实测」的数据是文档维护环节经 `git` / 代码 grep 当场核实的。本会话网络受限（`gh`
请求返回 EOF，见 §三），PR / CI 的远端状态未能复核，一律如实标注为未复核。

---

## 一、执行摘要

本批次围绕**社区三功能区**完成 6 个任务（T1–T6），全部零迁移或仅索引迁移，另有 1 条走查
高危发现（F1）走查后当即补修（`0165988`）：

1. **纸条社区**——管理端纸条复核页（T1，零新 API）、UGC 安全后端：发布前过滤拒收式 422 +
   会话级双向拉黑 + 消息举报与管理端处置（T2，迁移 0094）、站内通知接入铃铛（note_drawn
   离散事件 / note_reply 按参与者折叠）+ 前端可见性退避轮询（T3，零迁移）；
2. **小游戏**——排行榜 KV 戳式缓存与玩法聚合榜（T4，迁移 0095 仅索引）、玩法展示名收敛到
   engine-registry 唯一源 + engine 依赖边白名单守卫（T5，零迁移）；
3. **投稿公开化**——投稿墙 showcase 双闸 + 设置戳联动缓存 + 管理端下架（T6，零迁移）；走查
   发现媒体端点绕过双闸（showcaseEnabled=false 时附件字节仍可被匿名枚举拉取，F1，高危
   mustFix），已补修：showcaseEnabled=false 或媒体步骤未白名单一律 404（`0165988`）。

## 二、任务清单与提交

**哈希口径（本会话实测）**：T5 的任务记录哈希 `3a14ffa` 是 rebase 前的本地哈希——`git
merge-base --is-ancestor 3a14ffa HEAD` 实测**不在**分支 tip 可达；`git diff --stat 3a14ffa
6dba46e` 仅 2 个视觉基线 PNG 差异，代码内容一致，最终落库为 `6dba46e`。与上一批报告记录的
T4/T6 哈希漂移（rebase 到远程视觉基线提交之上）同因。

| 任务 | 内容                                                                                       | 提交（分支现史）                | 迁移 | CI（任务记录）                                                                                       | 关键验证与说明（来源：任务记录）                                                                                                                                                                                                                                                 |
| ---- | ------------------------------------------------------------------------------------------ | ------------------------------- | ---- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1   | 管理端「纸条复核」页 `/admin/notes`：被举报/隐藏纸条有页面可处置（零新 API）               | `afd6d1b`                       | 无   | [run 42378540790](https://github.com/emoeem/telegram-multimedia-survey-bot/actions/runs/42378540790) | 6 文件（App.tsx / api.ts / Layout.tsx / NoteReviewPage.tsx 171 行 / workspaces.ts / 测试）。导航项落 `workspaces.ts` 社区工作区（任务书写的 Layout.tsx 同段在 T2 工作区重构后已不含导航项），标题映射仍在 Layout.tsx；workspaces.test.ts 四条结构不变量全保持                    |
| T2   | 纸条 UGC 安全后端：发布前过滤（拒收式 422）+ 会话级拉黑 + 消息举报与复核                   | `99186f5`                       | 0094 | [run 42381315062](https://github.com/emoeem/telegram-multimedia-survey-bot/actions/runs/42381315062) | 9 文件 +971/-50（0094_note_chat_safety.sql 48 行、note-content-filter.service.ts 新建 72 行）。过滤命中 422 且 notes/note_messages 零新行、拉黑双向、抽取池排除双向、举报同人去重/参与者校验、管理端 reported=1 聚合+处置落库 writeAudit，26/26 用例绿                           |
| T3   | 纸条站内通知接入（note_reply 按会话折叠；note_drawn 保留离散事件）+ 前端退避轮询（零迁移） | `2d0e48d`                       | 无   | [run 42383078581](https://github.com/emoeem/telegram-multimedia-survey-bot/actions/runs/42383078581) | notifications 表复用 0084:15-25，回滚 = 纯代码 revert。连带修复 ChatTab 从未挂载导致的轮询不可达（NoteScreen.tsx:716-718 接线），退避与铃铛链路自此才真正生效（若属有意下架请 revert 该行）                                                                                      |
| T4   | 小游戏排行榜：KV 戳式缓存（updated_at 戳+投影版本常量，按 gameType×mode 分榜）+ 聚合榜     | `e1dd1f5`                       | 0095 | [run 42386804020](https://github.com/emoeem/telegram-multimedia-survey-bot/actions/runs/42386804020) | 6 文件（0095_task_packs_game_type_index.sql 14 行仅索引；leaderboard-cache.test.ts 430 行）。缓存命中零榜单 payload 查询、戳探针每请求仍发生（复审 R2-1 修正后实测断言）；KV 值含 userId/participant_hash 仅服务端用，出参 toPublicLeaderboardEntry 剥离并与旧形状逐字段相等断言 |
| T5   | 小游戏玩法清单一份化：消灭展示名第三副本 + 依赖边守卫（零迁移）                            | `6dba46e`（记录哈希 `3a14ffa`） | 无   | [run 42388509868](https://github.com/emoeem/telegram-multimedia-survey-bot/actions/runs/42388509868) | 3 文件（TaskPacksPage.tsx / engine-registry.ts / registry.test.ts +70 行）。行为差异已在 commit message 声明：admin 对未知 gameType 从原始 id 回落为「爬塔挑战」，与玩家端 gameTypeLabel 语义对齐；守卫要求插件显式申报 import 边，未申报 CI 红                                  |
| T6   | 投稿公开化闭环：投稿墙（showcase 双闸+设置戳联动缓存）+ 管理端下架能力（零迁移）           | `458a0d7`                       | 无   | [run 42391278196](https://github.com/emoeem/telegram-multimedia-survey-bot/actions/runs/42391278196) | 16 文件（submit-gallery.ts 新建 206 行、GalleryWall.tsx 新建 108 行、submit-gallery.test.ts 591 行）。8 文件 93 测试全绿；缓存键在三段戳外加第四段全表 MAX(updated_at)——测试首轮抓到同秒「下架→发布」把键翻回旧 payload 的反例                                                   |
| F1   | 走查必修：投稿墙媒体端点补齐 showcase 双闸                                                 | `0165988`                       | 无   | 无独立 run（T6 后补修，见 §三口径）                                                                  | 本会话实测：`submit-gallery.ts:202` 媒体 handler 读 `loadWebSubmitFormSetting` 并要求 `showcaseEnabled===true` 且媒体步骤在白名单，否则 404；测试 `submit-gallery.test.ts:599` 钉「showcaseEnabled=false 时 published 归属附件也 404；开闸后同一资产 200」                       |

视觉基线：`cef70bc` / `3f4fe3c` 两批由 CI 字体环境生成（基线只能由本工作流生成，本地字体不同；
本地跑 visual gate 预期红，属环境差异而非回归）。

## 三、门禁与 CI 口径

- **本地门禁（任务记录，逐任务实测）**：`pnpm typecheck`；相关 vitest 文件（每任务 4–8 个
  文件、26–93 用例，见 §二）；`pnpm lint`（全仓）；`pnpm --dir admin build`；改动文件逐一
  `prettier --check`。**全量 `pnpm test` 按任务纪律由编排脚本统一跑，子任务不自跑。**
- **format:check 说明**：本地唯一报错是 `telegrambot.md`——工作区既有未跟踪杂物（禁碰清单，
  CI 检出分支时不存在）；各任务改动文件逐一 prettier 全过（0094/0095 为 SQL，prettier 无解析
  器不覆盖）。
- **CI 链接口径**：§二 6 条 run 链接来自任务记录（各任务「首轮 CI 验证通过」），本会话未能
  打开复核。注意时序：T3–T6 的提交在各自任务记录时点**尚未被推送分支的 CI 覆盖**（任务记录
  原话：「PR #4 的 CI 因此尚未包含本提交」「PR CI 需发布员推送后才会跑到本改动」）——发布员
  推送后由 PR #4 的 ci.yml 五门禁（typecheck / test / lint / format:check / admin build）统一
  验收；修复提交 `0165988` 在任务记录之外，无独立 CI 记录。
- **远端状态未复核（如实声明）**：本会话 `gh pr view 4 --repo emoeem/telegram-multimedia-survey-bot`
  实测返回 `Post "https://api.github.com/graphql": EOF`（网络受限），PR #4 状态、CI 最新结论
  均未能当场核实；本地分支未推送，`git status` 实测工作区仅余未跟踪杂物（`.video_agent/`、
  `cert/*.bak-*`、`telegrambot.md`）与 `blog-source-migrate` 子模块脏指针，均未纳入任何提交。
- **本报告撰写环节（文档维护员）**：未改任何代码，未重跑 pnpm 门禁；仅执行 git 考据与代码
  grep（§八列全），新写/改动文档经 `pnpm exec prettier --check` 实测全过。

## 四、做了什么（按功能区归并）

### 纸条社区（T1 / T2 / T3）

- **T1 复核页**：`/admin/notes`（`admin/src/App.tsx:106`）复用既有管理端 API——按状态列纸条
  `GET /api/note/admin/notes`（`src/http/note-api.ts:236`，隐藏/被举报优先）与被举报消息
  `GET /api/note/admin/messages?reported=1`（`note-api.ts:242`，按消息聚合举报数，最近 50），
  恢复/移除走既有处置动作并落 `writeAudit`，零新 API。V1 只展示文本与元数据（adminListNotes
  的 SELECT 无 image_asset_id，图片预览留待后续）。
- **T2 UGC 安全**：发布前过滤（`src/services/note-content-filter.service.ts`，命中拒收式 422、
  不落库）；会话级拉黑（迁移 0094 建 `note_block`，双向生效——互不可见且抽取池排除双向）；
  消息举报（0094 建 `note_message_reports`，同人去重、仅会话参与者可举报）；管理端复核处置。
  API：`POST/DELETE /api/note/threads/:id/block`（`note-api.ts:336`）、
  `POST /api/note/threads/:id/messages/:id/report`（`note-api.ts:349`）。
- **T3 站内通知**：`note_drawn`（被抽中）离散事件、`note_reply`（收到回信）按参与者折叠——
  每参与者至多 1 条未读，写放大封顶（`src/services/note-chat.service.ts:539-573`，链接统一
  `/notes`）；读侧 `GET /api/me/notifications` + `POST /api/me/notifications/seen`
  （`src/http/me-api.ts:258,264`）；前端退避轮询按页面可见性驱动（`admin/src/survey/note-poll.ts`），
  并修复了 NoteScreen 的轮询接线。

### 小游戏（T4 / T5）

- **T4 排行榜**：`GET /api/trial/leaderboard`（`src/http/trial-api.ts:116`），KV 戳式缓存键
  `trial-leaderboard:<投影版本>:<scope>:<mode>:<stamp>`（`trial-api.ts:50,64`）——命中请求零
  榜单 payload 查询，戳探针（COUNT+MAX(updated_at) 索引范围扫描）每请求仍发生；按
  gameType×mode 分榜 + 聚合总榜；迁移 0095 仅加 `idx_task_packs_game_type` 索引。
- **T5 玩法清单一份化**：展示名收敛 `src/trial/engine-registry.ts` 唯一源（玩家端
  `trial-api.ts:94` 与管理端 TaskPacksPage 同源），消灭第三副本；engine 依赖边白名单守卫
  （`tests/unit/game-plugin/registry.test.ts`）——新插件未申报 import 边 CI 即红，不再静默
  漏覆盖到 admin build 才炸。

### 投稿公开化（T6 + F1 修复）

- **投稿墙**：`GET /api/submit/gallery` 公开只读无鉴权（`src/http/submit-gallery.ts:147`），
  用户端在投稿中心 SubmissionHub 的「画廊」页签（`admin/src/survey/SubmissionHub.tsx:192-194`，
  showcaseEnabled=false 时页签不存在、URL 直达也回落投稿页）。
- **双闸**：① `system_settings.web_submit_form.showcaseEnabled`（默认 false，
  `src/services/submit/form-config.ts:149`，默认不出网）；② 投影字段白名单 showcaseFields
  （媒体步骤不在白名单 → mediaAssetIds 不出网）。字节面同闸：附件端点
  `/api/submit/gallery/media/:assetId` 两闸全过才 200（`submit-gallery.ts:202`，`0165988` 补齐）。
- **缓存与时效**：墙列表 KV 戳式缓存，键 = 设置戳 : count : maxPublishedAt : maxUpdatedAt +
  全表 MAX(updated_at)（第四段防同秒「下架→发布」把键翻回 TTL 内旧 payload）；开关切换经
  `GET /api/submit/form`（`src/http/submit-api.ts:239`）下发并即时生效（设置戳进键）。
- **管理端下架**：WebSubmissionsPage recall 后即时下墙；`recalled` 无一键重新公开路径（有意
  防已处置内容复活，CAS 白名单仅 pending/failed/publishing）。
- **署名投影**：匿名 → 不出昵称；「显示我的昵称」→ 昵称；自定义署名 → 署名文本——与 TG
  卡片同一套 composeWebSubmissionText 规则，匿名投稿者填过的昵称不会因上墙泄露。

## 五、调研采纳情况（本批走查/复审发现逐条裁决）

### 采纳并修复

| 发现                                                                                                                                                                   | 裁决         | 落点                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1（高危 mustFix）：`/api/submit/gallery/media/:assetId` 绕过 showcase 双闸——showcaseEnabled=false（默认态）时 published 投稿附件字节仍可被匿名者按可枚举 assetId 拉取 | **采纳修复** | `0165988`（submit-gallery.ts +24 / 测试 +86）：媒体 handler 读 `loadWebSubmitFormSetting`，`showcaseEnabled!==true` 或媒体步骤未白名单一律 404，不向枚举者泄露资产存在性；本会话实测 `submit-gallery.ts:202` 与测试 `submit-gallery.test.ts:599` 在位 |

### 已记录未修（低危，按现状合入，见 §六）

| #   | 位置                                                              | 问题（摘要）                                                                                                                                                                                | 严重度 |
| --- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| F2  | `submit-gallery.ts:40-44,136-140` + `store.ts:13-15`              | 墙缓存戳「单调保证键不复用」在秒粒度下不成立：同秒发布→下架→发布可翻回旧 payload（T6 已加第四段戳收窄，仍留同秒三连理论窗口）                                                               | low    |
| F3  | `note-api.ts:345` + `note-chat.service.ts:530-536`                | `DELETE …/block` 响应 `blocked` 布尔语义错位（从未拉黑报 true、对方也拉黑时报 false）；当前前端无调用方，属未来 UI 的错误契约                                                               | low    |
| F4  | `note-content-filter.service.ts:57-67`                            | 过滤归一化只有小写+去空白，全角变体（如「Ｋ粉」）可绕过含拉丁字符的词表项；设计上以举报+复核兜底；NFKC 折叠一行可收口                                                                       | low    |
| F5  | `note-chat.service.ts:560-580` + `series-follow.service.ts:43-45` | note_reply 折叠刷新 created_at 但保留旧 id，通知列表按 id DESC 排序时被更旧的 note_drawn 压下（红点计数正确，纯展示顺序）                                                                   | low    |
| F6  | `tests/unit/game-plugin/registry.test.ts:177-193`                 | engine 依赖边守卫只扫 engine.ts 顶层静态 import，不递归 manifest/content 等传递边、不识别动态 import——未来传递边引入 server-only 依赖要到 admin build 才炸（当前三插件依赖面已核对为纯 TS） | low    |
| F7  | `submit-gallery.ts:112` + `GalleryWall.tsx:20`                    | 墙 API 把投稿 created_at（unix 秒）原样出网，「墙只精确到天」仅展示层成立；如要兑现注释，投影层应 floor 到日                                                                                | low    |

## 六、已知问题（任务记录的如实声明，均已记录）

- **T3**：note_drawn 有意不折叠（离散事件语义、写入天然有界），热门作者铃铛未读可堆积，若
  运营反馈刷屏可按 note_reply 同款单点改造。
- **T4**：① 聚合榜明细列依赖 SQLite 唯一 `max()` 裸列取最优行的文档化行为（同分并列取哪局
  由 SQLite 决定，已用真 SQLite 测试钉住并注释）；② 聚合榜/探针的 pack 集合不过滤 enabled
  （已停用包历史成绩留在总榜，注释已说明）。
- **T5**：admin 对未知 gameType 的展示从原始 id 回落为「爬塔挑战」（与玩家端对齐的行为差异，
  commit message 已声明）。
- **T6**：① `recalled` 无一键重新公开路径（有意）；② showcase 开关经 system_settings 直接
  配置，无管理端设置 UI；③ 投稿表单告知文案对公开展示的覆盖结论——本环境无法核验生产
  system_settings 与运营配置，**默认 showcaseEnabled=false 未放开，此项为执行批次前置确认项，
  留给 PR 描述与运营**；④ 本地分支曾与远端 diverged（远端有引导空提交 `e93fc69`），推送由
  发布员协调。
- **T1**：图片预览未做（adminListNotes SELECT 无 image_asset_id，api.ts 注释已写明）。
- **T2**：DELETE block 响应语义（即 F3）。
- **T3**：NoteScreen.tsx:716-718 轮询接线是本次连带修复——若这 1 行属有意的功能下架请 revert。

## 七、延期清单（P2，明确排队、不入本批）

| #   | 事项                                                     | 去向说明                                                                                                                                                |
| --- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 投稿评论回复通道（原 T6-①，复审证伪后移出）              | 前置：生产 D1 跑 `SELECT COUNT(*) FROM web_submission_comments WHERE telegram_chat_id IS NULL` 重定义收件人与媒介后排期；不得宣称「作者收件箱看到回复」 |
| 2   | ChatRoomDO / WebSocket 实时推送                          | T3 退避轮询落地后观察 Worker 请求量再上；消息落 D1 仍为事实源，慢递逻辑须放独立 DO 类                                                                   |
| 3   | 慢递 / 未来信（scheduled_notes 或 SlowMailDO alarm）     | 新玩法级特性，用户指令未点名；DO alarm 仅 6 次重试需自捕获重设，单独批次                                                                                |
| 4   | 爬塔 / 插件双轨统一                                      | 大重构，回归面覆盖 trial 全链路与 0090 存量数据，独立批次 + 完整 E2E                                                                                    |
| 5   | 金币投稿与免登录投稿双审核页合并                         | 两套状态机语义不同（分级奖励 vs 直推公开），涉及产品决策                                                                                                |
| 6   | 「每日一玩」全站同题 + 无剧透分享卡                      | 依赖认证卡分享管线复核                                                                                                                                  |
| 7   | 回信解锁状态机（Postcrossing 式 sent→delivered→replied） | 重定义抽取规则与 need_own_note 语义，需运营确认后单独做                                                                                                 |
| 8   | 投稿表单 template_id 多模板                              | 后端恒 `'default'`，无第二模板需求前不做                                                                                                                |
| 9   | 广场发帖弹层加「改放纸条」引导                           | 两套身份语义（plaza 需 TG 身份 vs 纸条 participant_hash）对齐方案未定                                                                                   |
| 10  | 抽取入口整合（/notes 页签 vs /coins 缘分纸条区）         | 低价值 UI 整理，T3 通知落地后重估                                                                                                                       |

**执行纪律备注（第 2 轮修订结论）**：涉及 0094/0095 的任务在生产 D1 应用前必须
`wrangler d1 export` 备份 → staging 验证 → 生产；工作区用户未提交内容（`cert/*.bak`、
`.video_agent/`、`telegrambot.md`）只读不动；T6 隐私确认（表单告知文案覆盖公开展示）未确认前
showcaseEnabled 保持 false。

## 八、本报告的核验清单（文档维护环节实际执行）

- `git log --format=... -10` / `git show --stat`（六个任务提交 + `0165988` 的文件清单与
  主题，与 §二 表一致）；`git merge-base --is-ancestor 3a14ffa HEAD`（不可达）+ `git diff
--stat 3a14ffa 6dba46e`（仅 2 个视觉 PNG 差异）→ T5 哈希漂移结论。
- 代码 grep / Read：`submit-gallery.ts:202`（媒体双闸）、`submit-gallery.test.ts:599`（404
  用例）、`form-config.ts:149`（showcaseEnabled 默认 false）、`trial-api.ts:50,64,116`（缓存
  键与端点）、`note-api.ts:236,242,309-349`（复核与拉黑/举报端点）、`note-chat.service.ts:539-573`
  （通知两类）、`me-api.ts:258,264`（通知读侧）、`App.tsx:106`（/admin/notes 路由）、
  `SubmissionHub.tsx:192-194`（画廊页签门控）、`db/migrations/0094_note_chat_safety.sql:31,39`
  与 `0095_task_packs_game_type_index.sql:14`（迁移对象）。
- `pnpm exec prettier --check` 本报告及本次改动文档：全过。
- **未跑/未复核（如实）**：全量 pnpm test、typecheck、admin build（未改代码，且任务纪律归
  编排脚本）；`gh` 远端 PR/CI 状态（网络 EOF，见 §三）。

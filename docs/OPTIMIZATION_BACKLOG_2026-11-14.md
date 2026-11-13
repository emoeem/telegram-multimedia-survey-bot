# 优化执行清单 · 2026-11-14 批二（深夜额度批次）

> 依据：① 批三报告 §五 延期清单（规格已写好待执行）；② 批二报告 §七 P2 延期十项；
> ③ 外部审查（2026-11-13）第一/二阶段修复的收尾；④ 本机只读核实 Actions 日志（2026-11-12）。
> 本文件是批二工作流的任务来源；执行完毕后在 §末尾回填状态。

## 0. 已核实的外部事实（2026-11-13 实测）

| 事实                                     | 证据                                                                                                                              | 判定                                                                                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| production-smoke 连续失败（11-08→11-12） | run 43135724225：`qa/visual/galgame-playthrough.spec.ts:604` 断言 `aborted` 捕获到未建模端点 `/api/me/notifications/unread-count` | G4 角标（BottomNav 挂载即拉未读数）晚于 spec 端点模型；修 spec 端点模型即可，**非生产回归**                                             |
| d1-backup 连续失败                       | run 日志：`R2_BACKUP_BUCKET 未配置` → 自动建桶 `Authentication error [code: 10000]`（token 缺 R2 Edit 权限）                      | **账号侧**操作：① repo Settings→Secrets 配 R2_BACKUP_BUCKET；② 给 CLOUDFLARE_API_TOKEN 加 R2 Edit 或先手动建桶。repo 侧守卫已按设计工作 |
| CI / deploy 全绿（main db7be6a7）        | Actions 列表                                                                                                                      | 代码门禁健康                                                                                                                            |
| blog-source-migrate 无效 gitlink         | post-job cleanup：`fatal: No url found for submodule path 'blog-source-migrate' in .gitmodules`                                   | 批一 hygiene 线已在修（git rm --cached）                                                                                                |

## 1. 批二任务（按优先级）

### A. G5+G6 体验债重做（批三报告规格原文，直接执行）

- 引导步骤持久化：`ONBOARDING_STEP_KEY` + CTA 同步写（当前刷新/重进后引导从第一步重来）。
- 引导步骤 2/3 落点：改「第一个我的草稿」，无草稿兜底 `/surveys`；同时修 CTA 管理员视角错配。
- ⌘K 搜索：Esc 触控目标 ≥44px（coarse 指针）；命中列表补 listbox/option/`aria-activedescendant` 读屏语义。
- 防回退锚点：`global-search.test.ts`（或仓内等价测试文件）补断言。

### B. G7 编辑器效率 a+b

- 物料区「在此后插入」：选中题目处直接插入新题，不再只能追加到末尾。
- 多选批量：批量设必答/选填、批量移动分页（跟随既有 dnd-kit/结构树交互）。
- flag/变量总览面板：一屏列出当前问卷全部 flag/变量及其使用点。

### C. 社区收尾两件

- 纸条跨会话黑名单管理页（0094 已有双向拉黑数据，管理端列表/解除入口；复用 NoteReviewPage 模式）。
- 弹幕举报真实实现（批三只修正了文档口径；落举报端点 + 管理端处置，迁移先查现有表是否可复用）。

### D. src/index.ts 拆分（1118 行，2026-11-13 只读摸底后的目标形态）

- 现状结构：L76-238 静态页/OG meta 注入助手 → L240-377 `Env` 接口 → L383-543 守卫与
  Telegram 自举（rate limit / guardApiResponse / ensureTelegramCommandMenu /
  ensureWebhookAllowsChannelPosts）→ L544-990 `fetch`（全部路由分发）→ L991-1118 `scheduled`。
- 目标形态（不改任何行为，纯搬家）：
  - `src/http/static-pages.ts`：serveHtmlAsset / serveStaticAsset / servePublicPageWithMeta /
    serveHtmlAssetWithMeta / serveSurveyPageWithShareMeta / homeRedirect 与裸 admin 补前缀判定
    （public-page.ts 已有纯函数，收拢引用）；
  - `src/types/env.ts`（或 `src/env.ts`）：`Env` 接口 + DO re-export；
  - `src/http/guard.ts`：applyPublicApiRateLimit / guardApiResponse / notifyMaintenanceBudgetExhausted；
  - `src/bot/bootstrap.ts`：ensureTelegramCommandMenu / ensureWebhookAllowsChannelPosts；
  - `src/cron.ts`：scheduled 入口整体搬出（creator-trial-reminder、归档重试、备份钩子等）；
  - `src/index.ts` 收敛为 `export default { fetch: route(), scheduled: cron() }` 装配层（目标 ≤200 行）。
- 硬约束：不改任何行为；全量 vitest + admin build + 现有 security/router/index-webhook 测试为门禁；
  `export { escapeMetaAttribute }`、`RESULT_VISUAL_WASM` 等既有出口路径不变（有外部脚本引用）。

### E. 后台任务中心基础版（审查第四阶段第一条）

- ControlCenterPage 增量：聚合 report_deliveries（failed/retrying）、图片生成/结果渲染任务、导出任务的失败与积压视图。
- 一屏筛选失败任务 + 人工重试入口（复用既有重试端点）+ 错误详情展开。
- 零迁移优先；需要新端点时走 admin-api 既有模式并补审计。

### F. 批三任务书产品决策项（需要用户拍板，工作流只准备材料）

- 投稿墙 18+ 年龄门（方案材料：服务端会话级确认 + 不依赖 localStorage；等用户选定再实施）。
- 回信解锁状态机、慢递未来信、每日一玩：材料齐备，未获点名不做。

## 2. 执行纪律（来自 docs/UPGRADE_ROADMAP_2026-10-28「贯穿约定」，批二沿用）

1. 门禁：`pnpm test`（当前 ≥1808 例）+ `pnpm typecheck` + `pnpm --dir admin run build` +
   `pnpm lint` + `pnpm format:check` 全绿才可交付。
2. 场景三条禁令（动编辑器/场景前必读 `docs/guides/HOTSPOT_EDITOR_HANDOVER.md`）：
   `scene` 不进 `EDITABLE_TYPES`；不改热点 id；场景媒体必须挂 `question_media`。
3. 插件三方一致：`src/game-plugin/plugins/*` === `server-plugins.ts` ===
   `admin/src/game-plugins/plugins/*`（registry.test.ts 自动守护）。
4. 服务端权威计分：插件配置（含正确项/权重）永不下发答题端。
5. 数据形状不改：`condition_json` / `settings_json` 结构调整必须带往返测试。

## 3. 外部方案佐证（2026-11-13 检索）

- Cloudflare Queues 官方：失败消息默认重试 3 次，可配 `max_retries` / DLQ ——
  [Batching, Retries and Delays](https://developers.cloudflare.com/queues/configuration/batching-retries)
- 事务性 Outbox + 供应商幂等键实践（冻结 payload、确定性消息 ID）——
  [reliable email with Cloudflare Queues](https://theeducationalequalityinstitute.org/blog/reliable-email-cloudflare-queues-transactional-outbox-en)、
  [r/softwarearchitecture 讨论](https://www.reddit.com/r/softwarearchitecture/comments/1xipit7/)
- 结论：批一可靠性线「原子认领 + 分阶段记账 + 已发送回执跳过 + 恢复可重入」与此一致；
  Telegram sendDocument 无幂等键，只能把重复窗口压到最小并如实注释（不做 exactly-once 宣称）。

## 4. 账号侧操作清单（用户手工，代码无法替代）

1. `R2_BACKUP_BUCKET` secret + token 权限（见 §0）。
2. `pnpm exec wrangler d1 migrations list DB --remote` 只读复核 0094/0095/0096（完成后更新三份文档注记）。
3. push main 触发 CI/deploy/production-smoke 验收本批改动（本机全部改动未 commit）。

## 5. 回填（2026-11-14 执行完毕）

| 任务                     | 状态                                                                                                                     | 落点                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| A G5+G6 体验债           | ✅ 完成                                                                                                                  | 引导持久化/落点/CTA、⌘K a11y；批二 run dwfrun-30dd78e4 |
| B G7 编辑器效率 a+b+c    | ✅ 完成                                                                                                                  | 插入/批量/flag 总览 + diffOps pageId 修复；批二        |
| C 社区收尾               | ✅ 黑名单管理页落地；弹幕举报**前提不成立**（仓库无弹幕功能，批三口径修正才是事实），未做                                | 批二                                                   |
| D index.ts 拆分          | ✅ 1118→38 行（六模块搬家，queue consumer 出口保留）                                                                     | 批二                                                   |
| E 任务中心               | ✅ GET /api/control/jobs + ControlCenterPage 卡片组（重试仅报告投递，其余置灰待端点）                                    | 批二                                                   |
| 批三（审计 1A/1B/1C/3A） | ✅ 安全 18 用例无漏洞 / EXPLAIN 37 条无缺失索引（0097 不产出）/ webhook 并发 9 用例 / 可观测性 4 缺口                    | 批三 run dwfrun-18285115                               |
| 批一道留收口             | ✅ hooks 双规则 error + 93→0、MIME 四存储点、sending 超时回收                                                            | 批三                                                   |
| §0 smoke 根因            | ✅ unread-count 补进 spec 端点模型，@production 8/8 实跑绿                                                               | 批一                                                   |
| §0 d1-backup             | ❌ 账号侧待用户（R2 secret + 权限）                                                                                      | §4                                                     |
| §0 迁移复核              | ❌ 账号侧待用户（migrations list --remote）                                                                              | §4                                                     |
| 雨夜书房作品包           | ✅ 插画 9/9（手作 SVG→Chromium 栅格化）+ 12s 短片（ffmpeg）+ 落库门禁绿；生图/生视频 API 账号不可用（code 3706）如实记录 | study-room/（见 RELEASE_2026-11-14.md §4）             |

新产生的后续建议（未排期）：纸条会话列表 UNION 改写（EXP3 已验证有效，属行为变更需回归）、
note_messages 聚合 SQL 改写、两处删数据路径的 N+1 batch 化（database-maintenance:410 /
profile-gallery:292，需独立立项带回归）、图片/结果渲染/导出任务的人工重试端点（任务中心已置灰待接）。

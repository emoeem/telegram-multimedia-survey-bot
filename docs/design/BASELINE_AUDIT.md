# M0 现状基线审计（BASELINE_AUDIT）

- 审计日期：2026-11-22
- 基线：`main` @ `eda33c07b384d95f0bc7d27f4b852471ac67c45a`（工作区另有 5 项与本任务无关的历史未跟踪文件：`AGENTS.md`、`blog-source-migrate/`、`cert/*.bak-*`、`telegrambot.md`）
- 方法：只读审计（未改动任何业务代码）。四张参考图逐一核对 + 仓库结构核实（路由/组件/样式/测试），疑点均以 file:line 佐证。
- 结论先行：**计划 §1 列出的四个疑似问题中 a/b/c 仍存在，d 已部分修复**；原型实验室（M1）已按本审计结论建立。

---

## 1. 技术栈与架构速查

| 层         | 事实                                                                                                                                                                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Worker     | `src/index.ts`；`wrangler.toml`；绑定 D1 `DB`、KV `MEDIA_KV`/`CACHE`、R2 `MEDIA`、Queues `EXPORT_QUEUE`、Browser `BROWSER`；DO：`SESSION`/`BUILDER`/`UI`/`RATE_LIMIT`/`GAME_ROOM`                                                                                                          |
| 用户端 Web | React 19 SPA，入口 `admin/survey.html` → `admin/src/survey/main.tsx` → `SurveyApp.tsx`（无 react-router，按 `pathname` 分发，`SurveyApp.tsx:2265-2381`）；Worker `src/http/router.ts:169-325` 镜像同一路由表                                                                               |
| 后台 Admin | React 19 + react-router v8 + Vite 8 + Tailwind v4 + daisyUI 5 + echarts；入口 `admin/index.html`；`WORKSPACES` 定义于 `admin/src/workspaces.ts:80`，布局 `admin/src/components/Layout.tsx`（686 行）                                                                                       |
| 样式系统   | `admin/src/index.css`（7658 行）：Tailwind v4 + daisyUI 双主题 + 大量自定义属性；主题预设 `foxgold`（默认，暗金）/`dark`/`light`（`admin/src/theme.ts`、`admin/src/survey/theme-ui.tsx`）；既有 token：`--fx-*`（动效/形状）、`--survey-*`（表面）；两入口都有防闪烁预刷 `data-theme` 脚本 |
| 游戏       | 引擎 `src/game/multiplayer/engines/{gomoku,xiangqi,ludo,doudizhu,werewolf}.ts`；网关 `src/http/game-api.ts`（REST+WS，身份走 `Sec-WebSocket-Protocol`）；房间 DO `src/durable-objects/game-room.ts`；客户端棋盘 `admin/src/survey/game-boards.tsx` 等                                      |
| Telegram   | `admin/src/telegram.ts` 懒加载 `telegram-web-app.js`，`ready/expand/setHeaderColor/HapticFeedback`；safe-area：`PageHeader.tsx:62`（top）、`BottomNav.tsx:116`（bottom）、`ScreenShell.tsx:74`（`min-h-dvh`+`viewport-fit=cover`）、`useViewportSize.ts`                                   |

## 2. 路由 / 页面 / 角色清单

### 用户端（无需登录即匿名可用）

| 路由                                                                              | 页面                                           | 文件                                                       |
| --------------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------- |
| `/s`、`/s/:id`                                                                    | 问卷大厅 / 答题                                | `SurveyApp.tsx`（`SurveyListPage`、`SurveyRunner`）        |
| `/trial`                                                                          | 小游戏（含单人试炼身份 公/母、模式 普通/地狱） | `TrialScreen.tsx`（PERSONA/MODE：`TrialScreen.tsx:77-86`） |
| `/game`                                                                           | 联机游戏大厅 + 对局                            | `MultiplayerGameScreen.tsx`、`GameLobby.tsx`               |
| `/plaza`、`/showcase`                                                             | 广场 / 展示                                    | `PlazaScreen.tsx`、`ShowcaseScreen.tsx`                    |
| `/cert/`                                                                          | 认证卡                                         | `admin/public/cert/`（独立静态页，非 SPA）                 |
| `/me`                                                                             | 我的                                           | `MyScreen.tsx`                                             |
| `/notes`、`/series`、`/coins`、`/gacha`、`/submissions`、`/auth`、`/app`、`/help` | 纸条/书架/金币/抽卡/投稿/登录/应用中心/帮助    | `SurveyApp.tsx` 分发                                       |
| `/report/:responseId(.pdf)`                                                       | 个人报告（服务端渲染，token 门控）             | `src/http/report-api.ts:61`                                |

全局导航：唯一组件 `BottomNav.tsx`——**移动端为底部玻璃条（<1000px，滚动可隐藏），桌面端变为固定顶栏（≥1000px，高 56px）**；六项：问卷/小游戏/广场/展示/认证卡/我的（含未读徽标）。

### 后台（管理员角色）

- 问卷：`/surveys`（+`/:id`、`/editor`、`/responses`、`/analytics`、`/versions`）、`/categories`、`/imports`、`/responses`、`/reports`
- 内容：`/coin-economy`、`/web-submissions`、`/users`、`/templates`、`/cert-content`、`/media-library`
- 社区：`/plaza`、`/notes`、`/profile-gallery`、`/showcase`、`/task-packs`、`/web-apps`
- 系统：`/audit`、`/trash`、`/licenses`、`/control`、`/settings`、`/login`
- 现有响应式：<640px 侧栏滑出抽屉（`Layout.tsx:277-352`）；≥640px 56px 图标轨 + 工作区横向子标签条（`index.css:7552`）；`lg` 重定义为 62.5rem/1000px（`index.css:51`）；**无平板专属双栏方案**（640–999px 仅图标轨 + 提示文字）

### 游戏（引擎参数已核实）

- 五子棋 2p、象棋 2p、飞行棋（ludo）2–4p、斗地主 3p、狼人杀 **min 6 / max 12**（`werewolf.ts:1227-1228`）
- 房间创建/加入 UI：`GameLobby.tsx` `GameLobbyEntry`（`GameLobby.tsx:60+`）
- 注意：大厅截图中的「身份 公/母、模式 普通/地狱」是 **TrialScreen 单人试炼**设置，不是联机房间配置——原型不得混淆（已按此修正）

## 3. 参考图逐图审查（设计继承点）

| 图              | 提取的设计信息（进入 tokens 与原型）                                                                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01 后台运营总览 | 56–60px 图标轨；面包屑 + 全局搜索 + 「生产环境」绿点徽标 + 设置；功能地图 4 工作区卡（编号徽标 + 计数 chip + 模块 chip 行）；数据总览 5 指标卡；报告交付队列（Telegram 频道自动归档 · 共 373 份）；深海军蓝底 + 暖金强调 + 低对比边框 |
| 02 小游戏大厅   | 顶部全局导航 6 项；游戏卡列表（图标块 + 名称 + 说明 + 箭头）；开始/我的记录/排行榜二级导航；开局设置（经核实属单人试炼：身份 公/母、模式 普通/地狱）                                                                                  |
| 03 五子棋房间   | 返回 + 标题/说明；玩法选择大命中卡片（已选 chip）；创建房间（说明 + CTA「创建五子棋房间」）；加入房间（房间码输入 + 加入 + 「直接粘贴好友发来的邀请链接也可以」）                                                                     |
| 04 个人中心     | 匿名访客身份卡（去注册/登录）；金色渐变金币卡（余额/连续签到/签到 + 明细任务/报告抽卡/投稿中心）；纸条聊天（未读）、动态与通知、系列书架、答卷足迹（生成按钮）、游戏音效（开关 + 音量 80%）                                           |

## 4. 疑点核对表（计划 §1 → 仍存在 / 已修复 / 待确认）

| #   | 疑点                                         | 结论                         | 证据                                                                                                                                                                                                                                                                                                                                                 |
| --- | -------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a   | 小游戏大厅内容集中在窄中栏，桌面横向利用率低 | **仍存在**                   | `/trial` 主栏 `max-w-xl lg:max-w-2xl`（`TrialScreen.tsx:862/1194/1384/1547`）；`/game` 更窄且无 lg 逃逸 `max-w-xl`（`MultiplayerGameScreen.tsx:621`）。对照：`/s` 列表为 `max-w-[1200px]` + 3 列栅格（`SurveyApp.tsx:790/881`），说明窄栏不是全局约束而是页面级遗漏                                                                                  |
| b   | 房间创建页说明/创建/加入纵向连续堆叠         | **仍存在**                   | `GameLobby.tsx:66-138` 三张全宽卡 `space-y-4` 单列堆叠，无桌面双列/主次分区                                                                                                                                                                                                                                                                          |
| c   | 个人中心长列表、未分组                       | **仍存在**                   | `MyScreen.tsx:457` `max-w-xl lg:max-w-3xl` 单列 ~12 个区块顺序堆叠（身份→金币→纸条→通知→书架→足迹→音效→报告→统计→档案→成就→入口），仅统计块是 2 列                                                                                                                                                                                                   |
| d   | 后台首页功能地图/指标/队列同等抢眼、层级扁平 | **部分修复（KPI 行待确认）** | 功能地图已置顶（`DashboardPage.tsx:405-406`）、报告队列已收进折叠 `<details>`（`438-441`）、PlanCapabilityCard 折叠（619）；**但** 5 张 `.admin-stat` 仍为同一权重均匀栅格（`322-353` + `index.css:3609-4036`），最近问卷/答卷平铺 `lg:grid-cols-2`（486-488）。原型按「地图 > 指标 > 队列」三级权重处理，KPI 行保留均匀栅格（数据型内容均权可接受） |

另核实：狼人杀人数文案不一致（大厅卡「8–12」vs 房间页「6–12」）——引擎为 6–12，**建议统一为 6–12**（原型已采用）。

## 5. 既有 UI 审计沉淀（复用，不重复造轮）

`docs/audits/` 已有：`UIUX-AUDIT-2026-10-22.md`（后台 P0–P3 带 file:line）、`ui-audit-2026-10.md`、`UI_REWORK_PROGRESS_2026-10-28.md`（三区优化批次）、`docs/reports/UI-AUDIT-2026-10-31.md`。后台 IA 已于 2026-10-31 重构过一轮（工作区图标轨），本次原型沿用该 IA，仅优化断点呈现与层级。

## 6. 测试覆盖与缺口（与本任务相关）

| 现状 | 说明                                                                                                                                                                                                                                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 已有 | `pnpm test`（vitest，`tests/unit/**`）；`pnpm test:visual`（Playwright，`qa/visual/*.spec.ts` 15 个 spec + 基线快照 + a11y 扫描，端口 4173）；CI jobs：`checks`（typecheck/unit/lint/build/PDF 回归）、`visual`（`test:visual:gate`）、`deploy`、`d1-backup`、`visual-baseline`                               |
| 缺口 | ① 无 360/768/TG WebView/横屏的系统性视口矩阵（现有快照以 1440 为主）；② 大厅/房间/个人中心无桌面三栏形态断言；③ 弹层 `Escape`/焦点行为无断言；④ `BottomNav` 双形态切换无断言——以上四项已由 `prototype-lab/tests/proto.spec.mjs`（85 项，独立端口 4174，不触碰原 CI）补齐原型侧，产品侧待 M4+ 批次落地时同步补 |
| 红线 | 原型侧测试不改 `playwright.config.ts`、不进 `qa/`、不触发 `visual-baseline` 工作流                                                                                                                                                                                                                            |

## 7. 对 M1 的设计指令汇总

1. tokens 以 `--survey-*`/`--fx-*`/daisyUI 主题变量为基线提取，新增 `docs/design/tokens.json`；默认暗金主题 + 必须提供 light 对应值。
2. 大厅（桌面）＝「分类侧栏 + 列表 + 详情」三栏；房间（桌面）＝「规则+玩法选择 | 创建主流程 + 加入次流程」双区；个人中心（桌面）＝按身份/资产/内容/互动/偏好分组的 12 列栅格；后台首页按三级权重（地图 > 指标 > 队列）。
3. 移动端保留底部导航 + 安全区；TG WebView 需要宿主返回栏模拟与短视口验证；触控目标 ≥44px；`prefers-reduced-motion` 必须遵守。
4. 所有联机玩法设置只展示服务端已实现项（狼人杀/飞行棋人数；其余无配置项），不得虚构「底分」等未验证配置。

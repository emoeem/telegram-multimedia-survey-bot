# 实施进度账本（IMPLEMENTATION_PROGRESS）

> 跨会话接手先读本文件。上游：`BASELINE_AUDIT.md`（M0）→ `PROTOTYPE_ACCEPTANCE.md`（M4）→ 本账本（M6 起）。
> 纪律：小批改动、每批全门禁（typecheck / lint / vitest / build:admin / Playwright / visual gate）、禁盲更新快照、未授权不 commit/push/deploy。

## 阶段状态总表

| 阶段                    | 状态                                | 交付物                                                                    |
| ----------------------- | ----------------------------------- | ------------------------------------------------------------------------- |
| M0 现状审计             | ✅                                  | BASELINE_AUDIT.md                                                         |
| M1 原型实验室           | ✅                                  | prototype-lab/（86 项测试全绿）                                           |
| M2 原型自审             | ✅                                  | PROTOTYPE_REVIEW.md + 19 截图                                             |
| M3 设计交接             | ✅                                  | tokens/COMPONENT_INVENTORY/RESPONSIVE_RULES/USER_FLOWS/FIGMA_IMPORT_GUIDE |
| M4 人工验收             | ✅                                  | PROTOTYPE_ACCEPTANCE.md（2×P1+5×P2 修复复验）                             |
| M5 Figma 交付           | ✅*                                 | FIGMA_HANDOFF.md；*Figma 实际写入=未完成（无通道，独立待办）              |
| M6 设计系统与响应式基建 | 🔄 6.1/6.2 ✅、6.3 部分（/game ✅） | COMPONENT_MAPPING、Sheet.tsx、qa/visual/game.spec.ts、账本见下            |
| M7 用户端/问卷          | ⬜                                  | 计划见 §M7                                                                |
| M8 小游戏/联机          | ⬜                                  | 计划见 §M8（前置：/game qa 规格）                                         |
| M9 个人中心/社区        | ⬜                                  | 计划见 §M9（前置：8 条路由 qa 基线）                                      |
| M10 后台                | ⬜                                  | 计划见 §M10（前置：12 条路由补 PAGES）                                    |
| M11 全设备整合          | ⬜                                  | —                                                                         |
| M12 安全/CI 验收        | ⬜                                  | —                                                                         |
| M13 最终交付            | ⬜                                  | —                                                                         |

## M6 已锁定的架构决策（勿推翻）

1. **断点**：用户端导航形态切换点维持 **1000px**（`--breakpoint-lg: 62.5rem`）。四方契约不得单独改：`@theme --breakpoint-lg` ↔ `BottomNav.tsx` JS `matchMedia("(min-width:1000px)")` ↔ `PageHeader lg:top-14` ↔ `body:has(nav[aria-label="主导航"])` 56px 偏移（index.css:171-175）。原型内 900px 表述仅指原型。
2. **Token 基准**：以 `admin/src/index.css` 既有体系为准（daisyUI foxgold/dark/light + `@theme` + `--survey-*`/`--fx-*`/`--app-*`）；prototype-lab tokens 为镜像。品牌金以 foxgold `#d4a574` 为准（原型 `#e0a458` 仅为演示近似）。
3. **`[hidden]` 纪律**：全局 `[hidden]{display:none!important}` 已入 index.css（html 基座区，M6.1）——"hidden 但可见"的组件 display 覆盖是 M2 实锤 bug 源；例外场景必须 visibility/opacity + aria-hidden 并注释。
4. **弹层**：一律走 `useDialogs()`（confirm/alert/toast，40 文件已采用）；M6.2 增量补共享 Sheet/Drawer（基于 `survey/modal-viewport.ts` + `focus-trap.ts`），不强制迁存量手写 Sheet。
5. **Figma**：写入通道缺失，FIGMA_HANDOFF.md 为准；通道恢复按其 §5 执行并翻转状态徽标。

## M6 批次账本

| 批次 | 内容                                                                                                                 | 状态 | 门禁证据                                                                                                                                                              |
| ---- | -------------------------------------------------------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6.1  | COMPONENT_MAPPING.md（token 对照+组件映射+批次定义）；RESPONSIVE_RULES 断点决策；index.css +`[hidden]` 规则（+9 行） | ✅   | test:proto 86/86；vitest 2605/2605；typecheck/lint/build:admin 绿；visual:gate 109 过/119 挂且 100% 为 toHaveScreenshot 像素失配（本地字体 vs CI 基线），零功能性失败 |

| 6.2 | 共享 Sheet/Drawer 组件（新建，不迁存量） | ✅ | Sheet.tsx + ui-sheet CSS + 结构守卫单测 7/7；typecheck/lint/vitest 2605 全绿 |
| 6.3 | qa/visual 补盲区：`/game`（M8 前置）、`/me` `/plaza`×2tab `/notes` `/coins` `/gacha` `/submissions` `/series` `/auth`（M9 前置）、后台 12 路由补 admin.spec PAGES + `/users` 有数据变体 + 报告队列展开态 + 移动抽屉开启态（M10 前置） | 🔄 | /game 规格已落地（功能断言全过，基线待 CI 生成）；本地 PNG 已清理；新基线仅经 visual-baseline.yml + 空提交 |

## 夜间自主执行序列（2026-11-22 深夜～晨间，用户授权连续执行；后于晨间明确授权 commit/push/CI/deploy）

```text
① 6.3-A admin.spec 补 12 路由 + /users 有数据变体 + 队列展开态 + 移动抽屉开启态
② 6.3-B 公开页盲区规格 public-screens.spec（/me /plaza×2 /notes /coins /gacha /submissions /series /auth）
③ M8 游戏双区（GameLobbyEntry 双区 + MultiplayerGameScreen 容器 lg 逃逸 + /game 横屏紧凑）← 审计确认最高价值
④ M9 个人中心（组件抽取 → MyScreen lg:12 列分组 → 广场网格化）
⑤ M7 问卷（大厅 xl 档 + 完成页/答题窄列核查 + 报告页对齐核查）
⑥ M10 后台（共享 Pagination 抽取 + 列表页同构收敛）
⑦ M11 全设备矩阵核查（qa 全量本地跑 + Read 逐张自检）
⑧ M12 安全自查（权限/门禁/契约未动声明）+ M13 终局报告
每批：小步 → typecheck/lint/vitest/build → 相关 Playwright → Read 截图自检 → 账本更新
```

## 各阶段前置条件与切入点（审计结论浓缩）

- **M7**（用户端）：安全切入点 = SurveyListPage（`SurveyApp.tsx:697-1234`，容器 `:942 max-w-[1200px]`、网格 `:1096 sm:2/lg:3`，1440 下两侧 ~120px 死边）、TrialScreen 大厅（`TrialScreen.tsx:862 max-w-xl lg:max-w-2xl` 纵单列）、报告页（`src/services/report/web.ts` 自带 token 体系+SSR SVG 图表，独立无耦合）。**高危勿动 hooks 区**：SurveyRunner（2428-4069 行，hook 顺序约束注释 :2378-2380，键盘/viewport/滚动隐藏交织）。
- **M8**（游戏）：6.3 已落地 `/game` 守卫规格（大厅态 3 视口 + 切换玩法交互）。安全改造 = GameLobbyEntry 纵堆（`GameLobby.tsx:66`）→ 原型双区（props 不变）、`MultiplayerGameScreen.tsx:621` 容器加 lg 逃逸（`PageHeader` 已是 `lg:max-w-3xl`，主栏却 `max-w-xl`——宽窄不一致）、五 BoardPanel 重复的回合条/倒计时/日志/结算标记抽取共享壳。**高危**：DouDizhuBoard（固定 px + "390px 纪律"）、WerewolfBoard（绝对定位圆桌 max-w-360）。横屏（844×390）现无任何处理，`LandscapeHint` 仅问卷端使用。注意：引擎 displayName 为「五子棋」等短名（`gomoku.ts:407`），页面标题 `MultiplayerGameScreen.tsx:613` 自拼「· 联机对战」后缀——原型截图对照时勿把 mock 数据当产品 bug。
- **M9**（个人中心/社区）：顺序 = 先抽组件（NotificationCenter 出 SeriesScreen、CoinCard/ReportList/ProfileShareCard/GameSoundSettings 出 MyScreen）→ `MyScreen.tsx:457` 改 `lg:` 12 列栅格（DOM 顺序不变，仅 ≥1024 分列；`PageHeader wide` 需同步翻转）→ 广场 ≥1024 网格化（低逻辑风险）。**勿动区**：ShowcaseScreen 轮播、Cert（独立 token 体系，改动须走 styles.css 源 + `build-cert-single.mjs` 重建）、gacha 揭示动画契约（请求先发）。
- **M10**（后台）：最安全 = UsersPage/ReportsPage/ResponseActivityPage/AuditPage/TrashPage（同构 `.tbl`+data-label+prev/next，抽共享 Pagination/DataTable 只动重复标记）。Dashboard 剩余热点收敛在 `METRICS`(L322-353)+`.admin-stat-grid`+StatCard，改一处自动波及 ReportsPage 4 卡栅格。编辑器三栏 `EditorShell`（<1000px 纵向降级已有）自动保存 2s/撤销栈/脏守卫齐全，M10 只调呈现。
- **QA 工作流铁律**：本地禁止 `--update-snapshots`（字体栅格化差异会引发 CI 雪崩）；基线再生仅走 `visual-baseline.yml` 手动 dispatch，且 bot 的 GITHUB_TOKEN 推送**不触发下游 CI**——需人工空提交（历史教训见 [[overnight-state-2026-11-18]]）。
- **本地快照对比系统性失配（M6.1 实测）**：基线全部由 CI 字体环境生成 → 本地跑 `test:visual` 时所有含 `toHaveScreenshot` 的用例**必然像素失配**（M6.1 后台门禁：admin.spec 80 例全挂、telegram-login/report-publication 等非快照用例全过）。因此本地的验证口径 = ①快照断言之前的全部功能断言（pageerror/console/a11y/溢出/交互）必须通过，失败必须 100% 归因为 Screenshot comparison；②像素级最终确认只能由 CI 完成。批次验收报告必须按此口径写明。

## 会话间交接注意

- 工作区不得有未声明的脏文件；接手先 `git status --short` + 对照本账本。
- 后台 Agent 并发上限 ~2 路：多路审计需分批派发。
- 未知即查：五路审计报告已浓缩进各阶段前置条目；需要 file:line 细节回看对应 agent 输出（或重派只读 Agent）。

## 2026-11-22 晨间验收与 D1 告警收口（执行补记）

1. **用户验收指出 /trial 未改** → 补做 TrialScreen 桌面三区（`7723674`）：通栏进行中挑战 → 左 7 投稿+联机五卡两列网格+小游戏包 → 右 5 sticky 身份/模式+CTA；header/tabs 加宽 1200。
2. **浏览器实测（IAB）** 发现 /me 行内卡高参差 → 重排（`699abc5`）：全卡 h-full 等高行、统计+档案同行、成就通栏、入口组合卡（EntryRow bare 变体）。
3. **D1 读预算告警（9,712,132 行）**：根因 = syncWeakMediaRefs 每问卷 `DELETE media_refs WHERE ref_type/ref_key LIKE` 无索引的 S×M 读放大 + scanJsonRows 窗口未记账。修复（`5d73e76` + `0befb81` 对账补登记）：0107 迁移 `idx_media_refs_ref(ref_type, ref_key)`、ORPHAN_SWEEP_INDEXES 自愈、scanJsonRows 经 recordRowsRead 计入预算。**教训：批量 python 改签名时参数顺序要与调用点逐一对齐（本次 onRow/budget 错位由单测抓出）；清理未跟踪文件必须白名单式，勿用 status 全量循环（曾误删两份规格文件）。**
4. 发布链：473ba02 → a618309(bot 54 基线) → 064ecf2(空提交) → 8b6b3f7 → 7723674 → 1d69083(bot) → 5d73e76 → ade1670 → 0befb81 → 8b6b3f7 补记。期间恢复被误删的 game.spec.ts/public-screens.spec.ts（`2c2d859`）。CI 全绿（run ade1670/0befb81），deploy 成功，生产 IAB 实测 /game 双区、/me 等高网格、/trial 三区全部上线。
5. D1 修复生效判定：下一轮 cron（≤30 分钟）应无新告警；maintenance_last_summary.rowsRead 回到 500K 内、truncated=false（可用 d1-diagnostic-probe 工作流复核）。

## 2026-11-22 上午验收补充（用户实测驱动的最后一批）

1. 用户 IAB 实测生产 /me 指出"还需要重新设计" → 浏览器逐张走查定案：行内卡高参差/成就行右半空/入口组占纵空间 → 全卡 h-full 等高行 + 档案恒 col-6 与统计同行 + 成就通栏 + 入口组三行合卡（EntryRow bare 变体）→ 生产复验底边对齐。
2. 用户指出 /trial 仍是旧版 → TrialScreen 三区补齐上线（见晨间补记）。
3. **D1 告警（9.7M 行）收口**：0107 索引已在生产就位（探针实证）；下一验证点 = 2026-11-23 01:15 UTC 的日维护运行（rowsRead 应回落至 500K 内、truncated=false）。d1-diagnostic-probe 修复两处：7500 是 D1 SQLITE_ERROR 通用码不可作额度特征（曾误判提前停止）；矩阵补主库 telegram-survey-db + 维护摘要/索引在位性两条查询。
4. 后续批次（全部清零）：原清单中 TrialScreen 三栏、广场网格化、横屏导航均已完成；仅剩房间态真实 WS 视觉回归（双账号本地 Worker）与 Figma 实际写入（无通道）。

## 2026-11-22 下午·用户四条反馈重设计（最终批次，已上线 8723cbf）

用户四张生产截图验收反馈，四项重设计全部上线（CI 全绿 + deploy 成功 + IAB 生产复验）：

1. 广场/卡片折叠：树洞长帖 line-clamp-4 + 「展开全文/收起」（>160 字符或 >6 行出现）；≥lg 两列网格——卡片折叠后高度均匀，手机 1 列、PC 多列。
2. 个人中心去拼接：互动组卡（纸条+通知 bare 行）与内容组卡（书架 + 足迹/报告可展开行）；通知/足迹/报告行点击展开内嵌对应内容（懒挂载）；等高行保持。
3. 游戏大厅房间化：选玩法即进对应等待大厅——/game?type=x 左区「等待中的房间」列表（GET /api/game/rooms?status=lobby，点加入按房间号直加）+ 右区创建卡；移除重复玩法选择列（chips 切换）。
4. 私人房间积分制（服务端新功能）：0108 迁移 game_rooms.visibility（public/private）+ 创建私人房幂等扣 100 积分（game_room_private 流水，余额不足回收目录行并报 402）；公共列表默认不含私人房（mine=1 含自己的）；私人房仅凭房间码/房间号进入。红线复核：未触碰 seatToken/RNG/18+ 门禁/对局权威状态。
5. 小游戏大厅统一折叠卡：联机入口与爬塔包同网格折叠卡；联机卡点击直进对应等待大厅；爬塔包展开=完整开局内容（身份/模式/起始层/准备清单/CTA）。

D1 修复验证点：0107 索引已实证在生产（探针）；下一验证 = 2026-11-23 01:15 UTC 日维护运行（rowsRead 应回落 500K 内、truncated=false）。d1-diagnostic-probe 已补主库矩阵与两条验证查询（另修探针把 code:7500 当额度特征的误判）。

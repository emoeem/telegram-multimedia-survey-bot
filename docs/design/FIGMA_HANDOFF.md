# Figma 设计交接文档（FIGMA_HANDOFF · M5）

- 日期：2026-11-22
- **Figma 真实状态（如实声明）**：本环境当前无可用 Figma 写入通道（无 Figma MCP 工具、无桌面端导入插件可执行），**尚未向 Figma 写入任何节点**。目标文件 `figma.com/design/sgD7JvzrkngswriJXjgUmB` 仍为空白，不得视为设计交付。本文档 + Prototype Lab + tokens.json 构成完整的本地设计交付资产；Figma 实际写入列为**独立未完成事项**，通道恢复后按 §5 操作。

---

## 1. 设计资产总索引（单一事实来源）

| 资产        | 路径                                              | 说明                                                                                       |
| ----------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 设计 tokens | `docs/design/tokens.json`                         | 颜色/间距/圆角/阴影/字号，dark+light 双模式，与 `prototype-lab/assets/tokens.css` 互为镜像 |
| 组件规范    | `docs/design/COMPONENT_INVENTORY.md`              | 类名即契约，含变体/状态/落地映射                                                           |
| 响应式规则  | `docs/design/RESPONSIVE_RULES.md`                 | 9 设备 × 4 页行为规则                                                                      |
| 交互流程    | `docs/design/USER_FLOWS.md`                       | 六大流程逐步表                                                                             |
| 可运行原型  | `prototype-lab/`（`pnpm proto` → 127.0.0.1:4174） | 页面即图层来源（html.to.design 可直接吃 `pages/*.html`）                                   |
| 视觉基准    | `prototype-lab/screenshots/`（19 张）             | 逐屏验收基准                                                                               |
| 验收记录    | `docs/design/PROTOTYPE_ACCEPTANCE.md`             | M4 逐张人工验收 + 修复记录                                                                 |

## 2. Figma 文件结构（按计划 §4.2，通道可用后立即执行）

| Page           | 内容                                                             | 来源                                               |
| -------------- | ---------------------------------------------------------------- | -------------------------------------------------- |
| 00 Overview    | 项目介绍、页面索引、状态徽标（Figma 写入状态=未完成→完成后翻转） | 本文件                                             |
| 01 Foundations | Variables（Color/Space/Radius/Type/Elevation）+ 字体规范版       | tokens.json §见下                                  |
| 02 Components  | 组件库（Variants 矩阵见 §3）                                     | COMPONENT_INVENTORY                                |
| 03 Public      | 全局导航（顶栏/底栏）、AppShell 四形态                           | prototype-lab/pages/games.html                     |
| 04 Survey      | 问卷列表/详情/答题/提交/报告                                     | SurveyApp 结构 + 原型 tokens（页面原型属后续批次） |
| 05 Games       | 大厅三栏、房间双区、等待大厅、创建/加入 13 态                    | pages/games.html、room.html                        |
| 06 Community   | 广场/展示/投稿/画廊/认证卡                                       | 结构占位（M9 批次补全）                            |
| 07 Profile     | 五分组栅格、7 态                                                 | pages/profile.html                                 |
| 08 Admin       | 运营总览 8 态、工作区地图                                        | pages/dashboard.html                               |
| 09 Responsive  | 9 设备对照板（每屏一行）                                         | screenshots/                                       |
| 10 User Flows  | F1–F6 流程图                                                     | USER_FLOWS.md                                      |
| 11 States      | 各页状态矩阵（URL `?state=` 可在原型逐个打开）                   | PROTOTYPE_ACCEPTANCE §1                            |
| 12 Handoff     | 代码映射、切图说明、交付验收清单                                 | 本文件 §4                                          |

## 3. Variables 建立规范（照抄即可）

**集合 1 `color`（模式：dark / light）**——按 tokens.json 逐项建立，命名用 `/` 分组：
`color/surface/page|panel|elevated|inset|overlay` · `color/text/primary|secondary|muted|onBrand` · `color/border/subtle|strong` · `color/brand/primary|strong|soft|softer|text` · `color/accent/primary|soft` · `color/status/success|successSoft|warning|warningSoft|danger|dangerSoft|info|infoSoft`

**集合 2 `space`（无模式）**：`space/1..8` = 4/8/12/16/24/32/48/64。
**集合 3 `radius`**：`radius/sm|md|lg|xl` = 8/12/16/20。
**集合 4 `type`**：`type/font/sans|mono`（字符串）+ `type/size/display|title|subtitle|body|bodyLg|caption|mono`。
**集合 5 `elevation`**：`elevation/card|popover|modal|focusRing`（dark/light 各一套，效果建 Styles 并绑定变量）。

绑定要求：所有 Frame 内颜色必须绑定 Variables（不得取色器近似）；断点版式用 Variant 或独立 Frame（命名 `Page/Viewport/State`）。

## 4. 组件变体矩阵（02 Components）

| Component                                    | Variants                                                                                             |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Button                                       | variant=primary/secondary/ghost/danger/onGold × size=sm/md/lg × state=default/hover/loading/disabled |
| IconButton                                   | state=default/hover/disabled                                                                         |
| Chip / Badge                                 | tone=neutral/gold/success/warning/danger/info × selectable=bool                                      |
| Card                                         | level=panel/elevated/interactive × selected=bool                                                     |
| Input / Select / Textarea                    | state=default/focus/error/disabled                                                                   |
| Switch / Slider                              | state=off/on/disabled                                                                                |
| Segmented                                    | itemState=selected/unselected × count=2/3/4                                                          |
| Tabs                                         | itemState=default/active                                                                             |
| Dialog / Drawer / BottomSheet                | size=sm/md × state=open/closed（含遮罩层）                                                           |
| Toast                                        | tone=info/success/warning/danger                                                                     |
| Skeleton                                     | shape=text/block/card                                                                                |
| EmptyState / ErrorState                      | action=none/primary/retry                                                                            |
| StatCard(KPI)                                | state=default/error/refreshing                                                                       |
| WorkspaceCard                                | emphasis=primary/normal                                                                              |
| GameCard / GameOption                        | selected=bool                                                                                        |
| RoomCode / Seat                              | state=filled/empty/waiting                                                                           |
| CoinCard / IdentityCard                      | mode=anonymous/logged                                                                                |
| RowItem                                      | badge=none/unread/dot                                                                                |
| TopNav / BottomNav / AdminRail / AdminTopbar | active=item，viewport 变体                                                                           |
| Table（队列/排行）                           | viewport=desktop/mobileCard                                                                          |

## 5. 写入操作与验收清单（通道恢复后执行）

1. 优先级 A：Figma MCP 可写 → 用 REST/Plugin API 按 §2–§4 建 Variables、Styles、Components、逐屏 Frame（图层结构对齐 HTML 语义，禁止整屏贴图）。
2. 优先级 B：html.to.design 导入 `prototype-lab/pages/*.html`（每页 dark/light、各 `?state=`/`?frame=tg` 逐个导入），随后对照 §4 把贴图层重构为 Component+Instance。
3. 验收（全部通过才算 Figma 交付完成）：文件可打开 · 13 个 Page 存在 · Frame 可选中 · 组件可编辑且为 Variants · Variables 可查看且被绑定 · 页面结构清晰 · 与截图逐屏对照（≤2px 誊差）· 代码映射表完整。
4. 完成后：更新本文件状态徽标 + `UX_REDESIGN_IMPLEMENTATION_REPORT.md` + 记录新文件链接（若弃用空白文件另建）。

## 6. 代码映射（12 Handoff 页内容）

| 设计资产         | 代码来源（现状/目标）                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| tokens.json      | 现状：`admin/src/index.css` 的 daisyUI theme + `--survey-*`/`--fx-*`；M6 目标：桥接为 prototype-lab 同名变量（见 IMPLEMENTATION_PROGRESS） |
| TopNav/BottomNav | `admin/src/survey/BottomNav.tsx`（双形态，切换点 1000px，原型 900px——落地时对齐取一）                                                      |
| AdminRail/Layout | `admin/src/components/Layout.tsx`（640px 抽屉切换，56px 图标轨）                                                                           |
| 卡片/按钮基类    | `survey-card`、`btn btn-primary`（daisyUI）扩展                                                                                            |
| 游戏棋盘         | `admin/src/survey/game-boards.tsx` 等五件 + `game-board-registry.ts`                                                                       |
| 房间布局         | `admin/src/survey/MultiplayerGameScreen.tsx` + `GameLobby.tsx`（现状 max-w-xl 纵堆 → M8 双区改造）                                         |
| 个人中心         | `admin/src/survey/MyScreen.tsx`（现状 max-w-xl 纵堆 → M9 分组栅格改造）                                                                    |
| 后台首页         | `admin/src/routes/DashboardPage.tsx`（FeatureMap/StatGrid/队列 details）                                                                   |

# 组件与设计系统映射（COMPONENT_MAPPING · M6 核心）

> 方向性决策：**统一以 `admin/src/index.css` 既有 token 体系为基准**（daisyUI 双主题 + `@theme` 语义层 + `--survey-*`/`--fx-*`/`--app-*`），prototype-lab 的 tokens 是它的镜像而非替代。原型中的类名落地时映射到下表真实组件/类，**不重写 index.css、不引入新 UI 库**。

## 1. Token 对照表（tokens.json ↔ index.css 现状）

| tokens.json（原型）                  | index.css / 现有实现                                                               | 差异与动作                                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `color.surface.page`                 | `--color-page`（@theme L47-93）+ daisyUI `--color-base-100`                        | 已有，直接用                                                                    |
| `color.surface.panel`                | `--survey-card-bg` / `--surface`（L139-149）                                       | 已有                                                                            |
| `color.surface.elevated`             | `--surface-2` / `.card-elevated` 等价物                                            | 部分有；如缺按原型色补一档 `--surface-raised`（增量，不动现有值）               |
| `color.text.primary/secondary/muted` | `--color-ink` / `--text-soft` / `--survey-muted`                                   | 已有                                                                            |
| `color.brand.primary`                | `--color-primary`（foxgold `#d4a574`，L15-45）                                     | 已有；原型 `#e0a458` 为演示近似，**产品以 foxgold 为准**，FIGMA Handoff 已注明  |
| `color.status.*`                     | `--app-success/warning/danger/info`（@theme）                                      | 已有                                                                            |
| `color.border.subtle/strong`         | `--control-border` / `--color-edge` / `--survey-card-border`                       | 已有                                                                            |
| `space.1..8`                         | Tailwind 间距刻度（4 基数）天然一致                                                | 无需动作                                                                        |
| `radius.sm/md/lg/xl`                 | `--radius-surface:16 / --radius-control:10`（@theme）+ `--fx-radius-*`（L109-120） | 命名不同语义等价；映射表为准，不重复建变量                                      |
| `shadow.card/popover/modal`          | `--fx-shadow-*` / daisyUI 内建                                                     | 已有；原型 `.modal/.drawer` 阴影映射到 `--fx-shadow-*`                          |
| `type.*`                             | `--fx-font-serif` + Tailwind 字号刻度                                              | 已有                                                                            |
| 控件高度                             | `--control-h: 40px`（@theme）                                                      | 与原型 `--ctl-md:40` 一致                                                       |
| 断点                                 | `--breakpoint-lg: 62.5rem`（1000px）                                               | **M6 决策：产品统一 1000px**（见 RESPONSIVE_RULES 头注）；原型 900px 仅原型内部 |

**结论：M6 无需"新建 token 文件进产品"**——需要的是本对照表 + 逐批把原型布局映射到现有变量。若个别档位缺失（如 elevated 第三档），按增量原则在 `[data-theme]` 语义层（index.css L2677-2816 区域）补充，dark/foxgold/light 三套同步。

## 2. 原型组件 → 产品代码映射

| 原型组件                               | 产品现状（file:line 由 M6 审计核实）                                                                                                                 | 落地方式                                                                                                                               |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| TopNav / BottomNav 双形态              | `BottomNav.tsx`（mobile fixed bottom / `lg:` 顶部 56px；JS matchMedia 1000px 手动同步 @theme lg）                                                    | **已实现**，不重写；M6 仅核对未读徽标/safe-area 行为不变                                                                               |
| PageHeader                             | `PageHeader.tsx`（additive-props 模式：title/actions/tabs/backHref/topNav/wide/helpKey）                                                             | 已实现；新页面按契约用（无 BottomNav 的页面必须 `topNav=false`）                                                                       |
| AppShell（后台）                       | `Layout.tsx`（640px 抽屉、56px 图标轨、工作区 tabs `index.css:7552`）                                                                                | 已实现；M10 只优化呈现不改结构                                                                                                         |
| ScreenShell（用户端壳）                | `ScreenShell.tsx`（usePublicTheme + data-theme on div + pb-24 + BottomNav）                                                                          | 已实现                                                                                                                                 |
| Dialog / Toast                         | `Dialogs.tsx` `useDialogs()`（confirm/alert/toast 单队列、焦点陷阱，40 文件使用，两入口均已挂载）                                                    | **已实现**；新代码一律走 `useDialogs`，禁止 `window.confirm`                                                                           |
| EmptyState / ErrorState / LoadingState | `PublicPrimitives.tsx`（用户端 4 文件使用）+ `components/ui.tsx`（Modal L104、EmptyPanel、StatusBadge、SkeletonPanel、ErrorPanel，9 文件使用 Modal） | 已实现；补充变体时用 additive props                                                                                                    |
| Drawer（右侧抽屉）                     | **无共享组件**（Layout 手写侧栏抽屉；底部 Sheet 各处手写：ThemePickerSheet/ShowcaseSheet/TypePickerSheet + `survey/modal-viewport.ts` 管道）         | M6 增量补一个共享 `Drawer`/`Sheet`（基于现有 modal-viewport + focus-trap），先服务 M7/M9 需求，不强迁存量                              |
| 状态面板（原型浮层）                   | 无                                                                                                                                                   | **不进产品**（原型工具）                                                                                                               |
| `hidden` 显隐纪律                      | ——                                                                                                                                                   | 全局规则 `[hidden]{display:none!important}` 在 M6 一并加入 index.css 顶层（原型 M2 教训；先 grep 确认无依赖"hidden 但可见"的反常用法） |
| 游戏棋盘注册                           | `game-board-registry.ts` + `game-boards.tsx`（注册与实现分离，加游戏=1 面板+1 行注册）                                                               | 已实现，M8 沿用                                                                                                                        |
| 房间/大厅                              | `MultiplayerGameScreen.tsx`（:621 `max-w-xl` 无 lg 逃逸）+ `GameLobby.tsx`（:66 `space-y-4` 纵堆）                                                   | M8 按原型双区改造；`/game` qa/visual 零覆盖 → **改造前先补 qa 规格**                                                                   |

## 3. M6 批次定义（最小可验收）

| 批次        | 内容                                                                                                                                 | 触碰文件                                                 | 验收                                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 6.1（本批） | ① 本映射文档；② `[hidden]` 全局纪律入 index.css；③ RESPONSIVE_RULES 断点决策（已完成）；④ 若缺 `--surface-raised` 档位则三主题同步补 | `docs/design/*`、`admin/src/index.css`（仅增量行）       | typecheck/lint/vitest/`test:proto` 全绿；`build:admin` 绿；admin 快照零变化（纯增量变量+hidden 规则——**先验证 hidden 规则无存量反常**） |
| 6.2         | 共享 `Sheet`/`Drawer` 组件（基于 modal-viewport + focus-trap + Dialogs 风格），先建组件不迁存量                                      | `admin/src/components/` 新文件 + `PublicPrimitives` 导出 | 新组件单测 + 手动 QA；存量零改动                                                                                                        |
| 6.3         | `/game` qa/visual 规格补齐（390×844 / 1440×900 / 844×390，ready 前置状态走本地 mock 或 read-only 房间态）                            | `qa/visual/game.spec.ts` 新文件                          | 基线生成 + CI 绿；为 M8 双区改造铺路                                                                                                    |

跨文件不变量（任何批次不得破坏）：theme.ts ↔ theme-ui.tsx legacy 映射同步、`--breakpoint-lg` ↔ matchMedia(1000px)、BottomNav `lg:h-14` ↔ PageHeader `lg:top-14` ↔ `body:has(...)` 56px 偏移、无 BottomNav 页面 `topNav=false`、`admin-notices` 与 main padding 联动（index.css:3561 注释）。

## 4. 测试与基线纪律

- admin 快照 80 张（页面 × dark/light × 1440/390）——任何触及 Layout/index.css 的批次若导致非预期 diff，先查原因，禁止盲目 `--update-snapshots`；基线再生走 `visual-baseline.yml`（人工空提交触发，GITHUB_TOKEN 推送不触发 CI 的教训见 [[overnight-state-2026-11-18]]）。
- 新增页面级改动一律先加/改 qa 规格再动代码（M8 前置：`/game` 规格）。

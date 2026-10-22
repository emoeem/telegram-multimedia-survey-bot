# 后台管理面板 · UI/UX 审计与改造方案

> 版本：2026-10-22 · 审计对象：`admin/`（React 19 + Tailwind v4 + daisyUI 5），线上构建 `0691fe55`
> 方法：三张截图 + **全量读源码**。每条问题都给 `文件:行号`，凡是我没在代码里看到的，一律标「待确认」，不猜。

---

## 0. 结论摘要

| 严重度 | 数量 | 含义 | 建议 |
| --- | --- | --- | --- |
| **P0 正确性** | 5 | 会导致**数据错误 / 保存失败 / 编辑丢失**，不是"不好看" | 立即修，可独立上线 |
| **P1 闭环** | 6 | 能完成，但要靠人肉补位（逐条点、猜报错、看无标签的表） | 本迭代修 |
| **P2 一致性** | 7 | 同一件事有两种长相，认知成本 | 与 P1 同批，靠设计令牌收敛 |
| **P3 机会** | 3 | 现在能用，补了会显著提效 | 排下一批 |

**一句话结论**：这套后台的**骨架是好的**——设计令牌、`EmptyPanel`、`ErrorPanel`、`Modal`、`DialogsProvider`（含 `confirm`/`toast`）、`useBlocker` 脏检查**全都已经存在且实现质量不低**。真正的问题不是缺能力，而是**这些能力没有被"用满"**：有几个页面还在用手搓的 `window.confirm`（4 处），编辑器有脏守卫而 12 个字段起、可无限增行的认证卡表单没有，`EmptyPanel` 支持图标和行动按钮但调用方只传了文字。

> ▎ 这就是底层逻辑：不是重写，是把已有资产拉通。**抓手**是先修 P0 的 5 个数据正确性问题，**闭环**是让"保存/删除/空状态"三件事全站一个写法。

---

## 1. P0 · 正确性（会出错，不只是难看）

### P0-1 等级区间无任何校验：改错一个数字，用户拿到"王者"

**【问题描述】**
「等级称号（按百分比区间命中）」可以自由填 min/max，前后端都**不校验区间连续性**，只各自把数字夹到 0–100。

- 客户端：只做 `Math.max(0, Math.min(100, ...))`（[CertContentPage.tsx:503-517](admin/src/routes/CertContentPage.tsx:503)）——`min` 大于 `max` 照样存得进去。
- 服务端：只 clamp + **按 min 重排**（[cert-content.ts:145-147](src/http/admin/cert-content.ts:145)），不查洞、不查重叠。
- 生成器：命中失败时**直接兜到最后一档**。

```js
// cert/app.js:380-385
for (var i = 0; i < ranks.length; i++) {
  if (pct >= ranks[i].min && pct <= ranks[i].max) return rankView(ranks[i]);
}
return rankView(ranks[ranks.length - 1]);   // ← 落在「最后一档」
```

**【影响】** 管理员把 0-33 / 90-100 中间留个洞，或者手滑把 34 打成 43，所有落在洞里的用户会被判成**最后一档（通常是最高档）**。这是虚荣指标被拉满的那类 bug——没人会报错，因为用户只会觉得"我挺强的"。

**【优化建议】**
1. 前端做**阶梯校验**：按 min 排序后要求 `首档 min=0`、`末档 max=100`、`相邻 max+1 === next.min`，不满足就在区间行上标红并给出**一键修复**（按现有档位数量重铺 0-100）。
2. 服务端把同样的规则做成**硬校验**（400），因为前端永远可以被绕过。
3. 生成器把兜底从「最后一档」改成「最近的一档」并打 `console.warn`，避免静默。

**【前端实现思路】** 抽出纯函数 `validateRankLadder(ranks, hi): Array<{index, level, message}>`，与生成器共用（生成器是 ES5，保持纯函数形态即可复用）。校验结果直接驱动行的 `aria-invalid` + 红边框 + 行内 `<p role="alert">`。

---

### P0-2 主题 ID：前端零校验，服务端只回一句"检查 id / 名称 / 标签 / 等级区间"

**【问题描述】**
标签写着「主题 ID（唯一，小写字母/数字/连字符）」([CertContentPage.tsx:360](admin/src/routes/CertContentPage.tsx:360))，但 onChange 只有 `.trim()`。服务端有严格正则：

```ts
// src/http/admin/cert-content.ts:86
if (!/^[a-z0-9][a-z0-9_-]{0,39}$/i.test(id) || !name) return null;
```

而 `asTheme` 返回 `null` → 整个 PUT 被拒，错误文案是：

```ts
// src/http/admin/cert-content.ts:239
return { error: "存在不合法的主题（检查 id / 名称 / 标签 / 等级区间）" };
```

**【影响】** 40 套主题里有一套 ID 写了中文，管理员点保存 → 顶部一条红字，**不告诉你是哪一套、哪个字段**。他只能一套一套点过去找。

**【更隐蔽的一层】** 主题 ID 还是 `patchActive` 的匹配键：

```ts
// CertContentPage.tsx:190-198
setThemes((list) => list.map((t) => (t.id === active.id ? { ...t, ...patch } : t)));
```

把 A 的 ID 改成和 B 一样 → **改 A 的任何一个字段会同时改到 B**，且 `<li key={t.id}>` 出现重复 key，React 会复用 DOM，出现"编辑 A 时 B 的内容也在跳"。

**【优化建议】** ① 输入框实时正则 + 失焦查重（`dirty` 时立刻红框，禁止保存）；② 保存前做一次客户端预检，把**第几套 + 哪个字段**写进错误文案；③ 主题 ID 改为"创建后只读，另设「复制为新主题」"，从根上消灭改键需求（见 P3-2）。

**【前端实现思路】** `id` 字段加 `pattern="[a-z0-9][a-z0-9_-]{0,39}"` + `aria-describedby` 错误说明；查重 `themes.filter(t => t.id === value && t !== active).length > 0`。服务端错误文案补上 `主题「${name}」的 id 不合法`。

---

### P0-3 清空最后一个分组 / 最后一个称号 → 整页保存 400，且无法自诊

**【问题描述】**

```ts
// src/http/admin/cert-content.ts:186-188
if (!flatTags.length || !ranks.length) return null;
```

分组被删光（或某个分组的 textarea 清空）→ `flatTags` 为空；称号名全部清空 → `ranks` 为空（空名在 `:171` 被 filter 掉）。两种都会让 `asTheme` 返回 `null`，最后落到 P0-2 那句同样的模糊报错。

**【影响】** 这是一个**合法操作导致保存失败**的路径：管理员想清空标签重做，删完最后一个分组点保存 → 报错，而页面上没有任何地方提示「至少保留一个分组」。

**【优化建议】** ① 删除最后一个分组/称号时阻止并说明原因（`title` + toast）；② 允许"暂时为空"但保存按钮置灰并显示原因；③ 服务端错误文案区分三种情况：无标签 / 无等级 / 其它非法。

---

### P0-4 深色模式下 `--color-border` 根本不存在 → 边框退回 `currentColor`

**【问题描述】** 认证卡页三处用了 `border-[var(--color-border)]`（[:309](admin/src/routes/CertContentPage.tsx:309)、[:408](admin/src/routes/CertContentPage.tsx:408)、[:437](admin/src/routes/CertContentPage.tsx:437)），但全仓库**没有任何地方定义 `--color-border`**——项目里的令牌叫 `--color-edge`（[index.css:2141](admin/src/index.css:2141)）。

```bash
$ grep -rn -- "--color-border:" admin/src/
（无输出）
```

未定义的自定义属性会让 `border-color` 变成 IACVT（invalid at computed-value time），**回退到 `currentColor`**——也就是正文色。深色主题正文接近白色，于是：

**【编译产物实证】** 不只是读源码推测，构建出来的 CSS 里就是这个结果：

```bash
$ grep -o "border-color:var(--color-border)" admin/dist/assets/pwa-NgBgUKpS.css
border-color:var(--color-border)

$ grep -o -- "--color-border:[^;}]*" admin/dist/assets/pwa-NgBgUKpS.css
（无输出）        # ← 用到了，但整份产物里从未定义
```

**【截图佐证】** 认证卡页「分组」卡片和左侧主题列表的外框，明显比外层 `.card` 的边框**亮一档**。这就是它，不是设计意图。

**【我把范围查全了，避免过度归因】** 全仓扫一遍「引用了但本地没定义」的变量共 12 个，但其中 9 个是**正常**的（daisyUI 运行时提供，或有 fallback），真正裸奔的只有 3 个：

| 变量 | 引用处 | 来源 | 后果 | 判定 |
| --- | --- | --- | --- | --- |
| `--color-border` | 认证卡页 ×3 | 无 | 边框退回 `currentColor`，深色下过亮 | **P0** |
| `--color-foreground` | [SurveysPage:309](admin/src/routes/SurveysPage.tsx:309)、[:482](admin/src/routes/SurveysPage.tsx:482) | 无（daisyUI v5 叫 `--color-base-content`，这是 v4 旧名） | 文字色退回 currentColor，视觉差异小 | P2-7 |
| `--surface-1` | [ShowcasePage:306](admin/src/routes/ShowcasePage.tsx:306) | 无（项目里叫 `--surface` / `--surface-2`） | 背景退回 `transparent` | P2-7 |
| `--color-base-100/200/content`、`--radius-box/field`、`--color-secondary`、`--color-error` | 多处 | **daisyUI 提供**（产物里 `--color-base-100:oklch(...)` 可查） | 无 | 正常 |
| `--color-surface-2`、`--sc-accent` | 多处 | 自带 fallback | 无 | 正常 |

**【优化建议】** ① 三处改 `--color-edge`；② `@theme` 补 `--color-border: var(--color-edge)` 兼容别名；③ 加一条构建期检查（见下），把"引用了不存在的令牌"变成红灯。

**【前端实现思路】** 单测断言对象应该是**编译后的 CSS**（权威来源，天然包含 daisyUI 提供的那批），而不是源码变量表：

```ts
// 扫 dist CSS：每个 var(--x) 必须在同一文件里有 --x: 定义，或出现在白名单里
const css = readFileSync(distCss, "utf8");
const used = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map(m => m[1]));
const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
const allowed = new Set(["--color-surface-2", "--sc-accent"]); // 有 fallback 的
expect([...used].filter(v => !defined.has(v) && !allowed.has(v))).toEqual([]);
```

---

### P0-5 认证卡表单没有未保存守卫，切页即丢

**【问题描述】** 认证卡页有 6 个文本字段 + 6 个颜色 + N 个分组（每组 3 项）+ N 档称号（每档 3 项），全部是本地 state，只有点「保存」才落库，而它没有任何离开拦截。

同一个仓库里，编辑器早就做了：

```ts
// EditorPage.tsx:146-148
const blocker = useBlocker(
  ({ currentLocation, nextLocation }) => editor.dirty && currentLocation.pathname !== nextLocation.pathname,
```

**【影响】** 编辑到一半点左侧「问卷」→ 全部丢失，无提示、无草稿。

**【优化建议】** ① 复用 `useBlocker` + `confirm`（`Dialogs.tsx` 已提供）做离开确认；② 加 `dirty` 状态，保存按钮 `disabled={!dirty}`，标题右侧显示「未保存」徽标；③ `localStorage` 存草稿（key 带 pack 哈希），刷新可恢复。

**【前端实现思路】** 抽一个 `useUnsavedGuard(dirty, { onConfirm })` hook，认证卡页 + 后续任何长表单直接复用，避免第三次手写。

---

## 2. P1 · 交互闭环（能完成，但要人肉补位）

### P1-1 报告页没有批量操作，而全站 8 个页面都有

**【问题描述】** 截图里的表格没有全选框。代码确认：`ReportsPage` 无 checkbox、无批量重试、无导出。

```bash
$ grep -rln 'type="checkbox"' admin/src/routes/
TaskPacksPage ResponsesPage SurveysPage ShowcasePage ControlCenterPage TrashPage SurveyDetailPage CoinEconomyPage
```

（`ReportsPage` 不在其中。）

**【影响】** 230 个归档任务里失败 20 条，要**点 20 次、等 20 次刷新**。

**【附带的第二个洞】** 重试按钮只在 `failed | pending` 出现（[ReportsPage.tsx:182](admin/src/routes/ReportsPage.tsx:182)、[:226-236](admin/src/routes/ReportsPage.tsx:226)），但**接口对任意状态都接受**（[reports.ts:19-30](src/http/admin/reports.ts:19)，无状态判断，直接 `force: true` 重排）。服务端对卡死的 `delivering` 有 10 分钟回收（[report-delivery.service.ts:160-176](src/services/report-delivery.service.ts:160)），所以**不是功能性缺陷**，但"生成中"这一档在 UI 里没有任何手动出口，也没显示"已卡多久"。

**【优化建议】** ① 表格加全选 + 批量重试（只对 failed/pending 生效，其它置灰并说明）；② 增加"重试全部失败项"一键；③ `delivering` 超 10 分钟的行加「强制重排」按钮 + 显示 `已等待 N 分钟`；④ 支持导出当前筛选结果为 CSV（复用 `format.ts`）。

**【前端实现思路】** 批量用 `Set<number>` + 表头 `indeterminate`；动作条固定在表格上方（`sticky top-0`），选中数 > 0 才出现，避免常驻占位。

---

### P1-2 有 `toast` 和 `confirm`，认证卡页却在用 `window.confirm` + 常驻 `<p>`

**【问题描述】** `DialogsProvider` 提供了带超时、带动作按钮的 toast 和 Promise 化的 confirm（[Dialogs.tsx:57-70](admin/src/components/Dialogs.tsx:57)），但认证卡页：

- 删除主题 / 恢复默认用 `window.confirm`（[:223](admin/src/routes/CertContentPage.tsx:223)、[:330](admin/src/routes/CertContentPage.tsx:330)）——原生弹窗，样式与全站割裂、不可主题化、移动端体验差；
- 成功/失败用 `<p>` 常驻渲染（[:297-298](admin/src/routes/CertContentPage.tsx:297)），**永不消失**。改完再改，屏幕上还挂着上一次的"已保存"。

**【影响】** ① 保存两次后无法判断当前是否为最新状态；② 原生 confirm 在移动端是阻断式，且不显示具体影响（"保存后生效"这种信息只能塞进字符串）。

**【优化建议】** 统一改用 `useDialogs()`：`toast({ title, variant })` 3 秒自动消失；`await confirm({ title, description, danger: true })`。并把这条写进 `DEPENDENCIES.md` 或组件约定：**新页面禁止 `window.confirm`**。

**【前端实现思路】** 加 ESLint `no-restricted-globals`/`no-alert` 规则拦 `confirm`，比口头约定可靠。

---

### P1-3 移动端表格变成卡片，但**没有一个字段标签**

**【问题描述】** `.tbl` 在 <640px 变成堆叠卡片（[index.css:342-368](admin/src/index.css:342)），`thead` 被 `display:none`。这是对的策略——但**所有 `td` 都没有 `data-label`**：

```bash
$ grep -rn "data-label\|content: attr" admin/src/
（无输出）
```

**【影响】** 手机上一行报告变成：

```
情景大尺度剧情（学校社团）
#1042
已归档
1
2026-10-22 18:00
—
```

**每一个值都没有名字。** 用户得靠位置猜"这个 1 是尝试次数还是别的"。

**【优化建议】** 保留卡片式，但给每个单元格补标签，用 `::before` 渲染；首列作为卡片标题（`font-weight:600`，不显示标签）。这是**最低成本、最高收益**的一条响应式改动。

**【前端实现思路】**

```css
@media (max-width: 639px) {
  .tbl thead { display: none; }
  .tbl td {
    display: grid;
    grid-template-columns: 76px minmax(0, 1fr);
    gap: 8px;
    align-items: baseline;
  }
  .tbl td::before {
    content: attr(data-label);
    font-size: 12px;
    font-weight: 600;
    color: var(--color-muted);
  }
  .tbl td[data-label=""]::before { display: none; }
  .tbl td[data-label=""] { display: block; font-weight: 600; } /* 首列=卡片标题 */
}
```

TSX 侧一对一行改：`<td data-label="问卷">`。**别靠自觉**——写一个 vitest 扫 `admin/src/**/*.tsx` 里 `<td`，缺 `data-label` 即失败。

---

### P1-4 平板（640–999px）侧边栏 = 19 个没有名字的图标

**【问题描述】** 侧边栏三档：`w-64` 抽屉（<640）→ `sm:w-16` 图标轨（640–999）→ `lg:w-64` 完整（≥1000）（[Layout.tsx:225](admin/src/components/Layout.tsx:225)）。图标轨里文字是 `sm:hidden lg:inline`（[:259](admin/src/components/Layout.tsx:259)），组标题也被隐藏（[index.css:2708-2712](admin/src/index.css:2708)）。

而 19 个 `<Link>` **既没有 `title`，也没有 `aria-label`**：

```bash
$ grep -c "aria-label" admin/src/components/Layout.tsx   # 3（都在抽屉/汉堡上）
$ grep -c "title="     admin/src/components/Layout.tsx   # 2
```

**【影响】** ① 768–999px（iPad 竖屏、小笔记本分屏）看到的是一列纯图标，`Palette`（模板）和 `BadgeCheck`（认证卡内容）肉眼难分；② `display:none` 的文字会从无障碍树移除 → **图标轨状态下 19 个链接没有可访问名称**，读屏软件只能念"链接"。

**【优化建议】** ① 每个链接补 `aria-label={item.label}` + `title={item.label}`（原生 tooltip 零成本）；② 640–999px 改成"可展开的窄轨"（`w-16` → hover 展开 `w-64`，或加一个 pin 按钮），比纯粹把信息删掉更稳；③ 组标题在图标轨下改为分隔线 + tooltip 分组名。

**【前端实现思路】** `title` 是浏览器能力，不需要 JS；hover 展开用 `group/aside` + `:hover`/`:focus-within` 把 `w-16` 过渡到 `w-64`，并给 `main` 加 `transition-[padding]` 避免跳动。

---

### P1-5 触摸目标不达标：`.btn` 40px、`.btn-sm` 36px

**【问题描述】** 你提的 44px 标准，代码里**明确没达到**：

| 元素 | 移动端实际 | 出处 |
| --- | --- | --- |
| `.btn` | `min-height: 40px` | [index.css:248-255](admin/src/index.css:248) |
| `.btn-sm` | `min-height: 36px` | [index.css:256-259](admin/src/index.css:256) |
| `.btn-icon` | `40×40` | [index.css:260-264](admin/src/index.css:260) |
| `.admin-nav a` | `44px` ✅ | [index.css:2686](admin/src/index.css:2686) |

表格里的「重试」「上一页/下一页」全是 `btn-sm` → **36px**。

**【一个容易漏掉的点】** 44px 的判据不该只看宽度。iPad（768–1024）是**触屏但宽度 >640**，按 `max-width: 639px` 写规则**管不到它**。用 `pointer: coarse` 才是正确的触发条件。

**【优化建议】** 把 44px 挂到 `@media (pointer: coarse)`，同时保留宽度兜底；`.btn-sm` 在粗指针下 `min-height: 44px`、`padding-inline` 加大。表格内的操作按钮在移动端直接变成**整行宽按钮**（卡片式本来就该这样）。

**【前端实现思路】**

```css
@media (pointer: coarse) {
  .btn, .btn-sm, .btn-icon { min-height: 44px; }
  .btn-icon { min-width: 44px; }
}
```

---

### P1-6 空状态退化：总览整块消失，报告页话术误导

**【问题描述】** ① 总览的两个列表用 `data.recentSurveys?.length ? <section/> : null`（[DashboardPage.tsx:154](admin/src/routes/DashboardPage.tsx:154)、[:196](admin/src/routes/DashboardPage.tsx:196)）——**没数据就整块不渲染**，页面莫名其妙少一半，用户以为是加载失败。② 报告页筛选「失败」且为 0 时，显示 `EmptyPanel text="没有报告任务"`（[ReportsPage.tsx:245](admin/src/routes/ReportsPage.tsx:245)）——**实际有 230 个任务，只是没有失败的**，文案直接说谎。

而 `EmptyPanel` 本身支持 `icon` / `actionLabel` / `onAction`（[ui.tsx:69-90](admin/src/components/ui.tsx:69)），调用方一个都没用。

**【优化建议】** ① 保留区块，渲染带图标 + 一句解释的空态；② 区分"真的没有"和"筛选后为空"：后者给「清除筛选」按钮；③ 顺带修 `recentSurveys` 不截断、`recentResponses.slice(0,6)` 截断导致左右卡片高度不齐（[DashboardPage.tsx:196](admin/src/routes/DashboardPage.tsx:196)）。

**【前端实现思路】** 统一 `<EmptyPanel variant={filtered ? "filtered" : "blank"} actionLabel="清除筛选" onAction={...}/>`，把两种语义变成两个 variant，避免每个调用点自己拼话术。

---

## 3. P2 · 视觉一致性

### P2-1 同一族"指标卡"有两套实现

| | 总览 | 报告页 |
| --- | --- | --- |
| 类名 | `.admin-stat` | 手搓 `rounded-xl border p-4` |
| 圆角 | 16px | 12px（Tailwind `rounded-xl`） |
| 最小高 | 112px | 无 |
| 装饰圆 | 有（`::after` 7%） | 无 |
| 悬停 | `translateY(-2px)` + 阴影 | `-translate-y-0.5` + `shadow-md` |

出处：[index.css:3010-3037](admin/src/index.css:3010) vs [ReportsPage.tsx:103-140](admin/src/routes/ReportsPage.tsx:99)。

**【建议】** 抽一个 `<StatCard tone interactive data-decor>` 组件（或统一 `.stat-card` 类），两个页面都改用它；装饰圆改为**开关**而不是删掉——你要的"降低透明度或移除"变成一个 `data-decor="off"` 就能切。

**【顺带一个布局问题】** `.admin-stat-grid` 在 640–1023 是 4 列（[index.css:3145-3149](admin/src/index.css:3145)），而总览有 **5 个**指标 → 第 5 个单独掉到第二行，视觉上像漏了一个。建议 `repeat(auto-fit, minmax(180px, 1fr))`。

---

### P2-2 圆角有六套，令牌定义了却没人用

```bash
$ grep -rho "rounded-\(sm\|md\|lg\|xl\|2xl\)" admin/src --include=*.tsx | sort | uniq -c
     96 rounded-xl      85 rounded-lg      36 rounded-2xl      5 rounded-md
```

CSS 里 `.card` 硬编码 `16px`（[index.css:137](admin/src/index.css:137)）、`.btn` 硬编码 `10px`、`.btn-sm` `8px`，而 `@theme` 定义了 `--radius-xs:6 / sm:8 / md:10 / lg:14 / xl:18`（[index.css:33-37](admin/src/index.css:33)）——**`--radius-lg` 是 14px，卡片是 16px，差 2px**。两套刻度并存，改一处不会改另一处。

**【建议】** 收敛成 4 档并只保留令牌：`--radius-card:16 / --radius-control:10 / --radius-sm:8 / --radius-pill:999`。`rounded-xl`→`rounded-card`、`rounded-lg`→`rounded-control` 做一次全局替换，然后用 lint（`tailwindcss/no-arbitrary-value` 或自定义 grep 测试）钉住。

---

### P2-3 图标体系混用：lucide + emoji

总览的状态卡用 lucide（`Clock/Loader/CheckCircle2/XCircle`，[DashboardPage.tsx:61-66](admin/src/routes/DashboardPage.tsx:52)），报告页同一组状态用 emoji（`⏳⚙️✅⚠️`，[ReportsPage.tsx:28-47](admin/src/routes/ReportsPage.tsx:33)）。

**【影响】** emoji 是彩色位图，**不跟随主题色**，深色模式下发灰；且各平台字形不同（Windows/Android/iOS 三套长相）。同一屏里既有线性图标又有彩色 emoji，层级立刻散。

**【建议】** 状态图标统一 lucide，颜色走 `--app-*` 语义色。这条不改逻辑，纯替换。

---

### P2-4 标题有两套字号

`.card-title h2` 是 16px/600（[index.css:155-161](admin/src/index.css:155)），但报告页用 `text-lg font-semibold`（18px）写"报告归档"（[ReportsPage.tsx:145](admin/src/routes/ReportsPage.tsx:145)），认证卡页也用 `text-lg font-semibold`。同一层级两种大小。

**【建议】** 定义 `--text-card-title`/`--text-page-title` 两级，所有卡片标题用 `.card-title`，禁止内联 `text-lg` 手写。顺带统一 `card-sub`（13px）与 `text-sm`（14px）的混用。

---

### P2-5 表单控件两套尺寸 + 配色行不对齐

- `input input-sm` 是 daisyUI 的尺寸体系，`border-radius: 10px` 来自自定义 `.input`（[index.css:274-286](admin/src/index.css:274)）——两套高度规则叠加，最终高度取谁取决于层叠顺序。
- 配色行：色块 `size-8`（32px）+ 标签 + `<code>` 十六进制文本，**与上下 36–40px 的输入框不同高**，视觉上像一排不齐的按钮（[CertContentPage.tsx:405-415](admin/src/routes/CertContentPage.tsx:405)）。
- 十六进制是**只读展示**，不能手输——想精确复用一个品牌色只能靠取色器一点点试。

**【建议】** ① 统一 `.input` 高度 36（桌面）/44（粗指针），移除 `input-sm`；② 配色行做成一行对齐的 `color-swatch + hex input`（可编辑，失焦校验 `/^#[0-9a-fA-F]{6}$/`）；③ 透明度：原生 `<input type="color">` **不支持 alpha**，需要就换成 `#RRGGBBAA` 文本输入 + 色块预览，别指望取色器。

---

### P2-6 深色模式的阴影等于不存在

```css
/* index.css:137-141 */
.card {
  box-shadow: 0 14px 32px -20px rgba(16, 24, 40, 0.18);  /* 近黑阴影 */
}
```

深色主题背景 `--surface: var(--color-base-100)`（[index.css:2145](admin/src/index.css:2145)）本身接近黑，`rgba(16,24,40,…)` 的阴影打在黑底上**不可见**。于是深色下的层级只剩 1px 边框，卡片和页底几乎融合——这就是你觉得"层级不够分明"的机械原因。

**【建议】** 深色下改用**向内高光 + 更深外阴影**，而不是同一套浅色阴影：

```css
html[data-theme="dark"], html[data-theme="night"], html[data-theme="luxury"] {
  --shadow-card: inset 0 1px 0 rgba(255,255,255,.045), 0 18px 40px -24px #000;
  --color-edge: color-mix(in srgb, var(--color-base-content) 16%, var(--color-base-100));
}
```

### P2-7 还有两处「引用了不存在的令牌」（低危，顺手修）

同 P0-4 的根因，只是视觉后果轻：`--color-foreground`（SurveysPage ×2，daisyUI v5 的旧名）、`--surface-1`（ShowcasePage ×1，应为 `--surface`）。两条都是无 fallback 的裸引用，见 P0-4 的表。修法一致：改名 + 靠 P0-4 那条产物级测试兜住。

---

## 4. P3 · 机会（现在能用，补了明显提效）

### P3-1 认证卡没有实时预览

改 6 个颜色、6 段文案、N 档称号，**零视觉反馈**，必须保存 → 打开 `/cert` → 发现不对 → 回来再改。这是这个页面最大的效率缺口。

**建议**：右侧（宽屏）/ 下方（窄屏）分栏，直接复用 `/cert` 的渲染结果（`cert/render.js` 是纯 canvas 绘制，传 theme 即可），设 debounce 300ms。**不要重写一份预览**——重写必然和生成器漂移。

### P3-2 主题没有"复制"，只有"新增空白"和"删除"

想基于现有主题开一个变体，只能新建一套再把 30 个字段手抄一遍。建议：`复制` + `重命名为新 id`，配合 P0-2 的"id 创建后只读"。

### P3-3 总览只有当前值，没有趋势

「今日答卷 47」没有对比基准。加一条昨日同刻对比（`↑12%` / `↓8%`）和 7 日 sparkline（ECharts 已有，别引新库）。

---

## 5. 响应式策略（现状 vs 目标）

| 断点 | 现状 | 目标 |
| --- | --- | --- |
| **≥1200 桌面** | 侧栏 256px + 内容自适应；指标卡 5 列 | 保持；指标卡改 `auto-fit`；表格 sticky 首列 |
| **1000–1199** | 侧栏 256px，内容变窄 | 侧栏可折叠为 64px（记住选择） |
| **768–999 平板** | 侧栏 64px **纯图标无提示**；卡片 4 列（5 个指标→孤行） | 图标轨 + `title`/`aria-label`；hover 临时展开；指标卡 `auto-fit` |
| **640–767 小平板** | 同上 | 同上 + 表格保留表头，横向滚动 |
| **<640 手机** | 抽屉式侧栏（`.admin-nav` 已有 `overflow-y:auto`，能滚 ✅）；表格变卡片但**无标签** | 卡片式 + `data-label`；操作按钮整行宽；触摸目标 44px |

**导航层级建议**（你问的"是否臃肿"）：现在 4 组 19 项，单屏 640px 高就要滚。两个动作就够，不必重排信息架构：
1. **组可折叠**（记住展开状态），默认展开「工作台」，其余折叠；
2. **`授权`/`控制中心` 收到「系统」下的二级**，或按角色隐藏（代码里已有 `licenseCenter` 判定，[Layout.tsx:124-128](admin/src/components/Layout.tsx:124)——**能力已存在，只是默认全展开**）。

---

## 6. 方案分批（你选，我不擅自动手）

| 批次 | 内容 | 改动面 | 工作量 | 风险 | 可独立上线 |
| --- | --- | --- | --- | --- | --- |
| **A · 正确性抢修** | P0-1…P0-5（区间校验、ID 校验与查重、空组/空档拦截、`--color-border`、未保存守卫） | `CertContentPage.tsx`、`cert-content.ts`、`cert/app.js`、`index.css` + 1 个单测 | ~1.5 天 | **低**（不动布局） | ✅ |
| **B · 交互闭环** | P1-1…P1-6（批量重试、toast/confirm 收敛、表格 `data-label`、导航 `title`、44px、空状态） | `ReportsPage`、`Layout`、`ui.tsx`、`index.css` + 全站 `<td>` 补标签 | ~2 天 | 低-中（触表多） | ✅ |
| **C · 设计系统收敛** | P2-1…P2-6（`StatCard` 组件、圆角令牌、图标统一、标题层级、表单尺寸、深色阴影） | `index.css` + 全部 `routes/*.tsx` 的类名替换 | ~2.5 天 | **中**（视觉全站变化，且**仓库目前没有视觉快照基线**，只能手测） | ✅ 但建议配合 D0 |
| **D0 · 视觉回归基线** | 用 `qa/*-check.mjs` 的既有模式，给 3 个断点 × 3 个页面做截图基线 | `qa/` 新增 1 个脚本 | ~0.5 天 | 无 | ✅ |
| **D · 增强** | P3-1 实时预览、P3-2 主题复制、P3-3 趋势 | 认证卡页大改 + 后端无改动 | ~3 天 | 中 | ✅ |

**建议顺序：A → D0 → B → C → D。** A 先把会出错的修掉（不影响任何视觉），D0 在动视觉之前建立基线，之后再改 C 才有"改坏了能看见"的能力。

> ▎ 颗**粒度**在这：A 和 B 加起来 3.5 天，能消掉 11 条问题里的全部 P0 和 P1。C 才是"审美"，但它必须排在 D0 后面——没有基线的视觉重构不叫重构，叫赌。

---

## 7. 核心样式示例（统一卡片 / 指标卡 / 表格 / 图标轨）

与现有栈对齐：Tailwind v4 `@theme` + CSS 变量 + `color-mix`，不引入新依赖。

### 7.1 令牌层

```css
@theme {
  /* 圆角只留 4 档，卡片与控件不再各自硬编码 */
  --radius-card: 16px;
  --radius-control: 10px;
  --radius-sm: 8px;
  --radius-pill: 999px;

  /* 高度：桌面 36，粗指针 44（统一在这里，别散落各处） */
  --control-h: 36px;
  --tap-min: 44px;
}

:root {
  --shadow-card: 0 1px 2px rgb(16 24 40 / 0.04), 0 14px 32px -20px rgb(16 24 40 / 0.18);
  --shadow-card-hover: 0 16px 34px -25px rgb(15 23 42 / 0.42);
  --stat-decor: color-mix(in srgb, var(--color-primary) 5%, transparent); /* 原 7% → 5% */
}

/* 深色：内高光代替看不见的外阴影 */
html[data-theme="dark"], html[data-theme="night"], html[data-theme="luxury"] {
  --shadow-card: inset 0 1px 0 rgb(255 255 255 / 0.045), 0 18px 40px -24px #000;
  --color-edge: color-mix(in srgb, var(--color-base-content) 16%, var(--color-base-100));
  --stat-decor: color-mix(in srgb, var(--color-primary) 9%, transparent);
}
```

### 7.2 组件层：卡片 + 指标卡（一份实现，两个页面共用）

```css
@layer components {
  .card {
    background: var(--surface);
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-card);
    box-shadow: var(--shadow-card);
    padding: 16px;
  }
  @media (min-width: 640px) { .card { padding: 20px; } }

  /* 指标卡：总览与报告页共用 */
  .stat-card {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-height: 104px;
    padding: 14px 16px;
    text-align: left;
    background: var(--surface);
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-card);
    box-shadow: var(--shadow-card);
    transition: transform .16s ease, box-shadow .16s ease, border-color .16s ease;
  }
  /* 装饰圆：开关式，不再无法关闭 */
  .stat-card[data-decor="on"]::after {
    content: "";
    position: absolute;
    right: -28px; bottom: -40px;
    width: 110px; height: 110px;
    border-radius: 50%;
    background: var(--stat-decor);
    pointer-events: none;
  }
  .stat-card[data-interactive="true"]:hover {
    transform: translateY(-2px);
    box-shadow: var(--shadow-card-hover);
    border-color: color-mix(in srgb, var(--color-primary) 22%, var(--color-edge));
  }
  .stat-card[data-tone="danger"] {
    border-color: color-mix(in srgb, var(--app-danger) 35%, var(--surface));
    background: color-mix(in srgb, var(--app-danger) 8%, var(--surface));
  }
  .stat-card__label { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 600; color: var(--color-muted); }
  .stat-card__value { font-size: clamp(24px, 3vw, 32px); font-weight: 750; letter-spacing: -.035em; font-variant-numeric: tabular-nums; }
  .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
}
```

### 7.3 表格：一处改完，全站移动端都有标签

```css
@media (max-width: 639px) {
  .tbl { display: block; }
  .tbl thead { display: none; }
  .tbl tbody, .tbl tr, .tbl td { display: block; width: 100%; }
  .tbl tr { padding: 12px 0; border-bottom: 1px solid var(--color-edge-soft); }
  .tbl td { padding: 4px 0; display: grid; grid-template-columns: 76px minmax(0, 1fr); gap: 8px; }
  .tbl td::before { content: attr(data-label); font-size: 12px; font-weight: 600; color: var(--color-muted); }
  .tbl td[data-label=""] { display: block; font-weight: 600; }
  .tbl td[data-label=""]::before { display: none; }
  .tbl td .btn-sm { width: 100%; justify-content: center; }
}

@media (pointer: coarse) {
  .btn, .btn-sm, .input, .select { min-height: var(--tap-min); }
  .btn-icon { min-width: var(--tap-min); }
}
```

### 7.4 图标轨：给每个链接一个名字

```tsx
<Link
  to={item.to}
  aria-label={item.label}
  title={item.label}                     // 640–999px 图标轨的唯一提示
  className="group relative flex items-center gap-3 rounded-control px-3 py-2.5
             text-sm font-medium sm:justify-center lg:justify-start"
>
```

### 7.5 页面骨架（总览页套用后的结构）

```tsx
<div className="space-y-5">
  <div className="admin-page-intro">…</div>

  <section className="card">
    <div className="card-title">
      <div><h2>数据总览</h2><p className="card-sub">…</p></div>
      <button className="btn btn-sm">刷新</button>
    </div>
    <div className="stat-grid mt-5">
      {METRICS.map((m) => (
        <div key={m.key} className="stat-card" data-decor="on">
          <span className="stat-card__label"><m.icon className="h-4 w-4" />{m.label}</span>
          <span className="stat-card__value">{value}</span>
        </div>
      ))}
    </div>
  </section>
</div>
```

---

## 8. 我不建议做的三件事

1. **不建议重写表格组件**。现状（`.tbl` + 移动端堆叠）方向正确，缺的只是 `data-label` 和 sticky 首列，改 20 行比换一套 `@tanstack/table` 划算。
2. **不建议把 19 个菜单重排成新 IA**。折叠 + 按角色收敛就够；重排会让已有肌肉记忆全部失效，收益不成比例。
3. **不建议给认证卡页做"独立预览组件的自研渲染"**。必须复用 `cert/render.js`，否则两周后预览和真实卡片必然不一致——这类漂移没人会主动发现。

---

## 9. 待你决策

| # | 决策点 | 选项 |
| --- | --- | --- |
| 1 | 先做哪批 | **A**（正确性）/ A+D0 / A+D0+B / 全做 |
| 2 | 指标卡装饰圆 | 保留（降到 5%）/ 关闭 / 默认关、后台可开 |
| 3 | 主题 ID | 「创建后只读 + 复制」/ 保持可编辑但加强校验 |
| 4 | 平板侧栏 | 只加 tooltip（1 小时）/ 加 hover 展开（半天） |
| 5 | 颜色选择 | 保留原生取色器 / 换成 HEX 输入 + 色块（支持 alpha） |
| 6 | 是否要我同时补视觉回归基线（D0） | 要 / 不要 |

> ▎ 我的建议是 **A + D0 先落地**（2 天，零视觉风险，把 5 个会出错的洞堵掉），你过一眼再决定 B/C。**因为信任所以简单**——但信任换不来"我知道那 40 套主题里哪一套的 id 写错了"，那要靠校验。

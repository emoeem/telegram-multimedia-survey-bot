# Showcase（展示区）前端技术选型调研报告

> 目标：为 `/home/emo/code/telegram-bot` 新增「展示区 / Showcase」——移动端优先的沉浸式人物立绘画廊，左右滑动切换人物、背景联动过渡、点击人物从底部弹出 Bottom Sheet 展示资料与精选作品。
>
> **调研方法说明（重要）**：本次会话中 shell 直连 `registry.npmjs.org` / `bundlephobia.com` 被本地策略代理拒绝（CONNECT 403），`web_fetch` 亦不可用，因此**数据不是直接从 npm registry 抓的**，而是通过可用搜索引擎（exa / tavily / keenable / anysearch 等）索引到的第三方聚合页（npmx.dev、devpick.co、depscope.dev、codingdunia.com、pkgpulse、snyk、unpkg 文件列表、GitHub release / PR / changelog）读取的。每个数字都标注了来源，未能核实的项已显式标注「未公布 / 未验证」，不做推测填充。

---

## 0. 结论速览（TL;DR）

| 需求 | 结论 | 增量体积 |
|---|---|---|
| 左右滑动切人物 | **不引入库**：CSS scroll-snap + `scrollend` + Pointer Events | 0 KB |
| 背景联动过渡 | **不引入库**：`animation-timeline: view()` 渐进增强 + IntersectionObserver 兜底 | 0 KB |
| 点击弹 Bottom Sheet | **不引入库**：daisyUI 5 `modal modal-bottom`（原生 `<dialog>`）+ 约 60 行 Pointer 手势 | 0 KB |
| 进场/退场/共享元素过渡 | **不引入库**：CSS transition + 原生 View Transitions | 0 KB |
| 图片放大灯箱 | **条件引入** `yet-another-react-lightbox`（11.7 KB gz，React 19 官方支持，仍在维护） | +11.7 KB |
| 瀑布流 | **不引入库**：CSS `columns` / 多列 grid | 0 KB |
| 仅当需要「无限循环 / 多点吸附 / 自由拖拽惯性」 | 可选引入 `embla-carousel-react` | +7.1 KB |

**一句话结论**：本项目已有 daisyUI 5 + Tailwind 4 + 原生 `<dialog>` + scroll-snap，Showcase 的三大交互（横滑、背景联动、底部抽屉）**可以 0 依赖实现**；唯一值得引入外部依赖的是「完整图片灯箱」。理由见第 8 节。

---

## 1. 项目现状与硬约束（已核实）

### 1.1 依赖现状

来源：本机 `admin/package.json`、`package.json`

| 项 | 值 |
|---|---|
| react / react-dom | `^19.2.8` |
| react-router | `^8.3.0` |
| vite | `^8.2.2`（`@vitejs/plugin-react` `^6.1.0`） |
| tailwindcss / @tailwindcss/vite | `^4.3.3` |
| daisyui | `^5.7.20`（主题：light/dark/night/luxury/retro/cupcake/synthwave/black） |
| lucide-react | `^1.33.0` |
| 其它 | echarts 6、echarts-for-react、@dnd-kit/*、@telegram-apps/sdk、qrcode.react、@fingerprintjs/fingerprintjs |
| **未安装** | framer-motion、motion、任何轮播/手势/Drawer/灯箱库 |

`admin/src/components/Dialogs.tsx` 显示：项目**已经自己手写了 confirm/toast 栈**（`DialogsProvider` + `useDialogs`，纯 React state + `lucide-react` 图标），没有任何 portal 库。这意味着「底部抽屉自己实现」与本仓库既有风格一致，不引入新范式。

### 1.2 Cloudflare Workers 静态资源约束

来源：本机 `wrangler.toml`

```toml
main = "src/index.ts"
assets = { directory = "admin/dist", binding = "ASSETS", run_worker_first = true, not_found_handling = "none", html_handling = "none" }
minify = true
```

* `run_worker_first = true`：**每个静态资源请求（含每个 JS chunk、每张立绘）都先经过 Worker**，再由 assets 绑定返回。新增依赖 = 新增同源 chunk = 更多经过 Worker 的请求。趋势上应当**控制 chunk 数量与体积**，而不是无脑堆库。
* Vite 目前是双入口（`main` + `survey`），`rollupOptions.input` 没有 `manualChunks`。建议 Showcase 用 `React.lazy(() => import(...))` 切成**独立懒加载 chunk**，不污染主包首屏。

### 1.3 Service Worker / 离线策略（决定性约束）

来源：本机 `admin/public/sw.js`、`admin/src/pwa.ts`

```js
const CACHE = "survey-platform-v2";
const PRECACHE = ["/", "/survey.html", "/manifest.webmanifest"];
const NEVER_CACHE_PREFIXES = ["/api/", "/telegram/", "/health"];
// fetch handler:
if (url.origin !== self.location.origin) return;            // 跨域请求直接放行，不缓存
// 命中 caches.match 即返回；未命中则 fetch 后 cache.put（仅同源 200 basic）
```

由此得到三条硬结论：

1. **绝对不能用 CDN 引入任何库**（jsDelivr / unpkg / cdnjs）。跨域资源不进 SW 缓存，离线直接白屏。所有依赖必须走 `pnpm add` 本地打包（现有依赖也全是这种方式）。
2. **新依赖会永久驻留用户离线缓存**。分发后想清理，必须显式把 `CACHE` 从 `survey-platform-v2` 升到 `v3`（`pwa.ts` 的 `CURRENT_CACHE` 与 `sw.js` 的 `CACHE` 需同步改）。因此「引入 20 KB 只为做一个小抽屉」的代价**不只是首屏，还有长期的离线缓存体积与升级噪音**。
3. SW 是 cache-first 懒写入，没有版本化 hash 探测；新 chunk 上线后老用户第一次访问需要在线一次才能缓存——划分「首屏必需 vs 懒加载」要在意这个。

### 1.4 CSP 现状

来源：全仓 `grep Content-Security-Policy`

* 全站**没有页面级 CSP**；唯一的 CSP 在媒体响应上：`src/services/media/media-serve.service.ts` → `default-src 'none'; sandbox`（用于把用户上传的媒体当不可信资源隔离）。
* 因此当前引入依赖**不存在 CSP 阻塞风险**。但若未来给管理端加页面级 CSP，应避免依赖「运行时注入 `<style>` 标签」的库（本报告推荐的 0 依赖方案天然无此问题；纯 CSS 文件方案也安全）。

---

## 2. 移动端手势 / 滑动库

| 包名 | 最新版 (发布时间) | 周下载量 | gzip 体积 | React 19 | License | 可直接用？ | 结论 |
|---|---|---|---|---|---|---|---|
| **embla-carousel-react** | 8.6.0（2025-04-04；v9.0.0-rc03 仍在 RC） | 百万级（pkgpulse 2026 指南 ~2M/周；stackmatch 汇总口径 35.5M） | **7.1 KB**（17.6 KB min） | 是——8.3.1 的 PR #1041 加入 react 19 peer | MIT | 是 | **条件引入**（需要 loop / 多点吸附时） |
| **swiper** | 14.3.0（2026-10 前后；v14 起 react peer ^19.2.6） | ~435 万/周 | 核心 **~30 KB**（模块化 + tree-shaking 可降；全量约 25–45 KB） | 是——v14 显式 bump react 19 | MIT（部分历史代码 GPL/MIT 双许可） | 是 | **不推荐**（体积/收益比差） |
| **react-swipeable** | 7.0.2（2024-11-04） | 约 36 万–85 万/周（socket.dev 356K；registry 853K） | **1.5 KB**（3.8 KB min；size-limit 1.7 KB） | 是——peer `^16.8.3 – ^19` | MIT | 是 | **不需要**：自研 Pointer 逻辑与其等价 |
| **@use-gesture/react** | 10.3.1（**2024-03-21，停更约 2.5 年**） | ~360 万/周 | **8.7 KB**（27.9 KB min） | 未声明 19（peer `>=16.8`，实际可用，属未验证） | MIT | 是 | **不推荐**（停更 + 体积） |
| **keen-slider** | 6.8.6（**2023-07-05，停更 3 年**） | ~22–25 万/周 | ~5.5 KB（作者自称） | 未验证 | MIT | 是 | **不推荐**（停更） |
| **CSS scroll-snap + Pointer Events** | 平台能力 | — | **0 KB** | — | — | 是 | **首选** |

关键判据：

* 这些库里**没有一个是 React 19 的阻塞项**（最差只是 peer 警告）。真正的问题是体积、维护状态，以及本项目并不需要它们的大部分功能（分页器、虚拟化、loop、整套 a11y）。
* Swiper 官方 issue #8000 曾明确「文档未声明 React 19 支持」，直到 v14 才由 commit `49d2329` 把 React bump 到 19.2.6——说明大而全的库在 React 19 迁移上反而比 headless 小库慢。
* Embla 是唯一「值得留后手」的合理选项：shadcn/ui 的 Carousel 就是 embla 封装（可直接抄其 ARIA / 键盘 / 交互约定），7.1 KB 体量可接受，且 **8.3.1 起就声明了 React 19**。

---

## 3. Bottom Sheet / Drawer

| 方案 | 版本 (发布) | 周下载 | gzip / 依赖成本 | React 19 | License | 与 Tailwind/daisyUI 配合 | 结论 |
|---|---|---|---|---|---|---|---|
| **daisyUI 5 `modal modal-bottom`** | 已装 5.7.20 | — | **0**（现有依赖） | — | MIT | 原生同族，类名即用；v5 用 `<dialog>` + 新定位工具类 | **首选** |
| **原生 `<dialog>` + `::backdrop`** | Baseline | — | 0 | — | — | 与 Tailwind 4 的 `@starting-style` / `transition-behavior: allow-discrete` 完美配合 | **首选**（免费焦点陷阱 / Esc / inert） |
| **vaul** | 1.1.2（**2024-12-14；npm 页显示 last publish 2 years ago**） | ~3300–4000 万/周 | **21.4 KB min+gzip**；依赖 `@radix-ui/react-dialog ^1.1.1`（再 +12.3 KB gz） | 是——PR #498「feat: add React 19 to peer deps」进 1.1.1 | MIT | 无样式，需自己写 Tailwind；会引入 radix 依赖链 | **条件引入**（要 snapPoints / 物理拖拽手感时） |
| **react-modal-sheet** | 5.6.0（2026-03-27） | ~16 万/周 | 官方未公布 min+gzip（unpkg `dist/` 366 KB 未压缩）；**peer 依赖 `motion >= 11`**，等于同时引入 motion | 是——peer `react >= 16` | MIT | 无样式 | **不推荐**（隐性成本 = motion 全家桶） |
| **@radix-ui/react-dialog** | 1.1.23（2026-07-24） | 7100 万/周（聚合口径） | 12.3 KB gz（devpick 口径 15.6 KB），15 个运行时依赖 | 是 | MIT | 无样式，与 Tailwind 搭配良好 | **不必要**：原生 `<dialog>` 已覆盖同等能力 |
| **@headlessui/react (Dialog)** | 2.2.10（2026-04-07） | ~720–840 万/周 | 整包 **61.5 KB gz**（可 tree-shake，单用 Dialog 远小于此但依然显著） | 是——2.2.0 PR #3543「Add React 19 support」 | MIT | 官方定位就是「Tailwind 的无样式组件」 | **不推荐**：为一个抽屉引入 Headless UI 生态 |
| **@gorhom/bottom-sheet** | — | — | — | — | MIT | — | **不适用**（React Native 专用，Web 无法复用） |

取舍要点：

* 需求是「点击人物 → 底部弹出资料卡」，**这就是 daisyUI 的 `modal-bottom`**：`<dialog class="modal modal-bottom sm:modal-middle">`（daisyUI 官方文档示例正是这个响应式写法）。原生 `<dialog>.showModal()` 免费提供焦点陷阱、Esc 关闭、背景 inert、`::backdrop`。
* 三件事 daisyUI / 原生**不免费提供**，需要自己写（合计约 60–100 行）：① 下拉手势关闭（Pointer Events + `translateY` + 速度阈值）；② 打开时 body 滚动锁（iOS 上要用 `position: fixed` + 记录 scrollY 的经典技巧）；③ 多档 snapPoints（若要做「半开 / 全开 / 全关」三档，才考虑 vaul 或 react-modal-sheet）。
* vaul 的真实代价要按「21.4 KB + radix dialog 12.3 KB ≈ 30 KB+」估算，且**两年未发新版**（164 个 open issues）。它值得引入的唯一场景是「需要多档吸附 + 与原生一致的物理拖拽手感 + 不想自己调手势」。

---

## 4. 动画库

| 包名 | 版本 (发布) | 周下载 | gzip | React 19 | License | 结论 |
|---|---|---|---|---|---|---|
| **motion**（framer-motion 新包名） | 14.0.0（2026-10 前后，非常活跃） | ~2800 万/周 | 完整 `motion` 组件 **~34 KB gz**；`LazyMotion` + `m` 起步 **4.6 KB** | 是（motion.dev 自身已在跑 React 19.3） | MIT | **条件引入**：只在要做共享元素 / 弹簧 / 编排动画时，且必须用 LazyMotion |
| **@react-spring/web** | 10.1.2（2026 年中） | ~540 万/周 | **20.5 KB min+gzip** | 是——v10.0.0 = 「feat!: react 19 support」PR #2368 | MIT | **不推荐**（体积 / 场景不匹配） |
| **@formkit/auto-animate** | 0.10.0（2026-07-10） | ~114 万/周 | **3.2–3.3 KB gz** | 是——已移除 react peer（框架无关） | MIT | **可选小工具**：列表增删 FLIP |
| **CSS transition / View Transitions / WAAPI** | 平台能力 | — | **0** | — | — | **首选** |

要点：

* Showcase 的动画需求是：① 滑动时背景 / 立绘的联动过渡；② 抽屉进出；③ 人物切换的淡入淡出。**①②③ 全是「两态之间过渡」，CSS transition + scroll-driven animations 完全够用**，不需要 JS 动画引擎。
* motion 是这里面维护最好、React 19 最积极的（changelog 里还有「Update Studio panel to React 19.3.0」），但它官方文档自己也承认 Bundlephobia 上 50 KB+ 的数字有误导性——**要用对方式引入**（`LazyMotion` + `m`）。本项目 `framer-motion 未安装`，说明团队此前已刻意回避它，不建议为 Showcase 破例。
* auto-animate 只做「增删元素的 FLIP」，对横向画廊没有帮助（画廊是滚动，不是 DOM 重排），可以不用。

---

## 5. 图片查看器 / 画廊 / Masonry

| 包名 | 版本 (发布) | 周下载 | gzip | React 19 | License | 维护状态 | 结论 |
|---|---|---|---|---|---|---|---|
| **yet-another-react-lightbox** | 3.32.2（**2026-07-30**，活跃） | ~55.4 万/周 | 核心 **11.7 KB gz**（31.2 KB min）；插件各自 size-limit 1.6–1.75 KB，按需引入 | 是——官网明示「works with React 19, 18, 17, and 16.8.0+」 | MIT | 活跃（GitHub 1.27k stars；Snyk 显示 2026 年多次发版、0 已知漏洞） | **若要完整灯箱，首选** |
| **photoswipe** | 5.4.4（2024-05-24） | ~50 万/周 | **16.6 KB gz**（57.7 KB min） | 框架无关（原生 DOM，需自己写 React 包装） | MIT | 低活跃但稳定 | 备选（体积大 + 非 React 原生） |
| **react-photo-view** | 1.2.7（**2025-01-05，停维护约 1.5 年**） | ~7.2–8.1 万/周 | 7 KB gz | 未声明 React 19（未验证） | Apache-2.0 | 停滞（Snyk：last updated 1 year ago） | **不推荐** |
| **react-masonry-css** | 1.0.16（**2021-04-04，5 年未更新**） | ~23–25 万/周 | 极小 | 未验证 | MIT | 停滞（Snyk：last updated 5 years ago；depscope health 57/100） | **不推荐**（CSS `columns` 即可替代） |

备注：`yarl` 的插件架构（core + 按需 `dist/plugins/*` 动态 import）本身值得抄——即使不引入它，Showcase 的「资料卡里的作品灯箱」也应做成懒加载 chunk。

---

## 6. 可参考的开源实现（借鉴交互，不必依赖）

| 参考 | 值得抄的东西 | 链接 |
|---|---|---|
| shadcn/ui Carousel（embla 封装） | 横滑组件的 ARIA 约定（`role="region"`、`aria-roledescription="carousel"`、键盘左右键）、focus 管理 | https://ui.shadcn.com/docs/components/carousel |
| Chrome 官方《Carousels with CSS》 | 纯 CSS 轮播：scroll-snap + `::scroll-button()` / `::scroll-marker()` / `:target-current` / `scroll-state` | https://developer.chrome.com/blog/carousels-with-css |
| Chrome I/O 2025 `web-at-io25` | 「首帧即可交互的 CSS 轮播」的定位与降级策略 | https://developer.chrome.com/blog/web-at-io25 |
| 原生 Popover Bottom Sheet（零 JS + swipe 关闭） | 用 `popover` + `@starting-style` 做抽屉，手势关闭只写约 20 行 | https://viliket.github.io/posts/native-like-bottom-sheets-on-the-web |
| Nolan Lawson《Modern carousel with scroll-snap》 | scroll-snap + `scrollTo({behavior:'smooth'})` + 捏合缩放 + IntersectionObserver 同步 a11y 状态 | https://nolanlawson.com/2019/02/10/building-a-modern-carousel-with-css-scroll-snap-smooth-scrolling-and-pinch-zoom |
| SitePoint《Scroll-driven CSS in 2026》 | 用 `animation-timeline` + `::scroll-marker` 做「零 JS 轮播」的完整配方 | https://www.sitepoint.com/scrolldriven-css-in-2026-building-carousels-without-javascript |
| react-swipeable API 设计 | `onSwipedLeft/Right` + 可配置 threshold（默认 50px）的判定心智模型，可直接移植成自己的 hook | https://commerce.nearform.com/open-source/react-swipeable/docs/api |
| react-modal-sheet demo | Bottom Sheet 的 snapPoints / 拖拽把手的视觉语言 | https://temzasse.github.io/react-modal-sheet |
| Josh Comeau《Scroll-Driven Animations》 | `animation-timeline` 渐进增强与 fallback 的具体写法 | https://www.joshwcomeau.com/animation/scroll-driven-animations |
| fngr（PointerEvent 手势库，设计参考） | 「每个识别器独立 import」的 tree-shaking 设计哲学（若将来真要手势库，优先这类） | https://github.com/akoreh/fngr |

---

## 7. 能用 CSS / 原生 API 直接实现的能力（0 依赖清单）

| 能力 | 现状 | 浏览器支持（2026-10 口径） | Showcase 用法 |
|---|---|---|---|
| **CSS scroll-snap**（`scroll-snap-type: x mandatory` / `scroll-snap-align` / `scroll-snap-stop`） | Widely available，可作主方案 | 全现代浏览器 | 人物横向轨道；`scroll-snap-stop: always` 保证一滑一个 |
| **Pointer Events**（`pointerdown/move/up` + `setPointerCapture`） | Baseline | 全现代浏览器 | 抽屉下拉关闭；判定「点 vs 滑」用 movement < 10px 阈值 |
| **原生 `<dialog>` + `::backdrop` + `showModal()`** | Baseline | 全现代浏览器 | Bottom Sheet 本体（焦点陷阱 / Esc / inert 全免费） |
| **`@starting-style` + `transition-behavior: allow-discrete`** | Baseline Newly Available | Chrome 117+ / Safari 17.4+ / Firefox 129+ | `<dialog>` 的进出场过渡（`display` / `overlay` 离散属性过渡） |
| **View Transitions API（同文档）** | Baseline Newly Available（2025-10 官方宣布）；caniuse 2026-06 全局 **94.2%** | Chrome/Edge 111+、Safari 18+、Firefox 133+ | 人物切换的共享元素过渡（`view-transition-name` 打在同一个人物立绘上） |
| **View Transitions（跨文档 MPA）** | 部分支持 | Chrome 126+、Safari 18.2+；**Firefox 仍在 flag** | 本 Showcase 用不到，纯渐进增强 |
| **scroll-driven animations**（`animation-timeline: view()` / `scroll()`） | 90%+ 支持，**Firefox 仍需 flag** | Chrome/Edge 115+、Safari 26+；Firefox 需 `layout.css.scroll-driven-animations.enabled` | 背景联动过渡的首选实现；**必须写降级**（IntersectionObserver 或 `scrollend`） |
| **`::scroll-button()` / `::scroll-marker()` / `:target-current`** | Chrome 135+ 新原语，其它引擎尚未跟进 | 仅 Chromium | 导航点 / 箭头「锦上添花」，**必须有自绘 dot 降级** |
| **`interpolate-size: allow-keywords` / `calc-size()`** | 有限可用；**WebKit 立场仍 open**（standards-positions #348），Firefox 无 | Chrome 129+ | **不要用于关键路径**；抽屉高度动画改用 `grid-template-rows: 0fr → 1fr` 或 `max-height` |
| **`:has()` / `content-visibility: auto`** | Baseline | 全现代浏览器 | 父级按激活态改样式；长列表 / 多人物卡片的渲染跳过 |
| **`overscroll-behavior` / `touch-action`** | Baseline | 全现代浏览器 | 防止横滑时触发浏览器回退 / 纵向串扰 |

**React 19.3 的 `<ViewTransition>` 组件注意点**：React Router 8 已把 `viewTransition` prop / `useViewTransitionState` 标记为 deprecated，转向 React 的 `<ViewTransition>`（**要求 react & react-dom ≥ 19.3**）。本项目当前是 `19.2.8`，**暂时用不了这个组件**，只能直接用 `document.startViewTransition()` 命令式 API（或升级到 19.3 后再迁移）。
来源：https://reactrouter.com/main/how-to/view-transitions 、 https://react.dev/reference/react/ViewTransition

---

## 8. 推荐结论与取舍

### 8.1 推荐方案：**0 依赖自研（CSS scroll-snap + Pointer Events + daisyUI modal-bottom + View Transitions）**

理由：

1. **功能覆盖度已经足够**。三大交互（横滑切换 / 背景联动 / 底部抽屉）分别对应 scroll-snap、scroll-driven animations、原生 `<dialog>`，都是平台一级能力。
2. **体积预算为 0**，且不触碰第 1.3 节的 SW 离线缓存与 `run_worker_first` 约束——这是本项目相对普通 Web 项目**最该省的地方**。
3. **不新增供应链与升级负担**。候选里维护最差的几个（vaul 2 年未发版、@use-gesture 停更 2.5 年、react-photo-view 停更 1.5 年、react-masonry-css 停更 5 年、keen-slider 停更 3 年）引入后都会变成长期负债；React 19 → 20 的迁移又会重演一遍（Swiper 到 v14 才补 React 19 支持就是例子）。
4. **样式天然统一**。daisyUI 主题（8 套主题 + 项目自定义 `--radius-*` / `--accent-*`）能直接作用于抽屉与导航点，不用像 vaul / radix 那样重写一遍皮肤。
5. **与既有代码风格一致**。项目已手写 `Dialogs.tsx`，没有 portal / headless 依赖，自研抽屉是延续而非背离。

### 8.2 唯一建议引入的依赖：`yet-another-react-lightbox`

只有在「资料卡里的精选作品需要全屏查看，且要缩放 / 滑动切换 / 缩略图 / 键盘」时才引入：

* 11.7 KB gz（核心），插件按需动态 import（每个 1.6–1.75 KB）；
* 官网明确声明支持 React 19，2026 年仍在发版，0 已知漏洞；
* **必须 `React.lazy` 懒加载**，只有用户点开作品时才下载，不进入展示区首屏 chunk。

对比：photoswipe（16.6 KB，非 React 原生，需要包装）更重；react-photo-view（7 KB 更小）但已停维护、未声明 React 19，不建议在 2026 年新代码里上。

### 8.3 「降级到引入依赖」的触发条件（建议写进 ADR，避免反复争论）

| 触发条件 | 才考虑引入 |
|---|---|
| 要做「无限循环 + 多点吸附 + 自由拖拽惯性」的滑块 | `embla-carousel-react`（7.1 KB gz，React 19 已支持） |
| 抽屉需要「半开 / 全开 / 全关」多档 snapPoints 且要求原生级物理手感 | `vaul`（但要接受约 30 KB（含 radix）+ 2 年未发版的现状） |
| 要做共享元素 + 弹簧 + 编排（时间轴、stagger、scroll-linked 复杂编排） | `motion` + `LazyMotion` / `m`（起步 4.6 KB，别用 34 KB 全量） |
| 需要虚拟滚动的超长列表（> 500 人物） | 先考虑 `content-visibility: auto`；确有必要再上虚拟列表库 |

### 8.4 自研 vs 引入 的取舍（诚实版）

| 维度 | 自研（推荐） | 引入库 |
|---|---|---|
| 体积 | 0 KB | 7–30 KB+（且进离线缓存） |
| 手感（惯性 / 回弹 / 多档吸附） | 「够用」：scroll-snap 的浏览器原生惯性其实很顺；但**做不到**自定义回弹曲线、跨容器同步、dragFree 自由滚动 | 明显更好（embla / vaul 的手感是其核心价值） |
| 开发量 | 约 200–250 行（轨道 80 + 手势 60 + 背景联动 50 + 抽屉 60） | 约 40–80 行胶水代码 + 学 API |
| a11y | 需自己补 ARIA 与键盘（可照抄 shadcn / embla 的约定） | 原生 `<dialog>` 免费给焦点陷阱 / Esc；库各有强弱（vaul 基于 radix 较好） |
| 维护风险 | 自己维护，但无上游停更风险 | 上游停更 / React 大版本迁移风险（本报告已列出 5 个停更候选） |
| iOS 兼容坑 | 需正确设 `touch-action` / `overscroll-behavior` / 滚动锁 | 库已处理大部分坑（这也是它们的价值） |

---

## 9. 落地蓝图（0 依赖方案）

```
admin/src/showcase/
├── ShowcasePage.tsx      // 路由页：React.lazy 独立 chunk，建立「人物数据 → 上下文体」的 Provider
├── CharacterRail.tsx     // scroll-snap 横向轨道（overflow-x:auto + scroll-snap-type: x mandatory）
├── CharacterStage.tsx    // 背景层：每层立绘用 animation-timeline: view() 联动透明度 / 位移
├── CharacterSheet.tsx    // <dialog class="modal modal-bottom">：showModal() + 进出场过渡
├── useActiveSnap.ts      // ~40 行：IntersectionObserver + scrollend → activeIndex
├── useSwipeDismiss.ts    // ~60 行：Pointer Events + translateY + 速度阈值关闭
└── useScrollLock.ts      // ~30 行：iOS 安全的 body 滚动锁（position:fixed + scrollY 还原）
```

关键骨架（示意）：

```css
/* 横向轨道：0 依赖滑动 */
.rail { display: flex; overflow-x: auto; scroll-snap-type: x mandatory;
        overscroll-behavior-x: contain; touch-action: pan-x;
        scrollbar-width: none; }
.rail > * { flex: 0 0 100%; scroll-snap-align: center; scroll-snap-stop: always; }

/* 背景联动（渐进增强；不支持则保持静态可见） */
@supports (animation-timeline: view()) {
  @keyframes bg-reveal { from { opacity: .15; transform: scale(1.06) } to { opacity: 1; transform: scale(1) } }
  .stage-layer { animation: bg-reveal linear both; animation-timeline: view(x); animation-range: cover 20% cover 80%; }
}

/* 底部抽屉：daisyUI modal-bottom + 原生 dialog */
.sheet-dialog { transition: translate .32s cubic-bezier(.32,.72,0,1), overlay .32s allow-discrete, display .32s allow-discrete; translate: 0 100%; }
.sheet-dialog[open] { translate: 0 0; }
@starting-style { .sheet-dialog[open] { translate: 0 100%; } }
```

```tsx
// 抽屉：daisyUI + 原生 dialog，手势关闭用 Pointer Events
<dialog ref={ref} className="modal modal-bottom sheet-dialog" onClose={onClose}>
  <div className="modal-box rounded-t-2xl bg-base-100/95 backdrop-blur">
    <div {...dismissHandlers} className="mx-auto h-1.5 w-10 rounded-full bg-base-300 touch-none" />
    {/* 资料 + 精选作品（灯箱按需 React.lazy） */}
  </div>
  <form method="dialog" className="modal-backdrop"><button>关闭</button></form>
</dialog>
```

```ts
// 约 60 行：下拉关闭（速度 > 0.5px/ms 或位移 > 1/3 高度则关闭）
function useSwipeDismiss(el: RefObject<HTMLElement>, onDismiss: () => void) {
  // pointerdown: setPointerCapture + 记录 y / 时间
  // pointermove: 只写 CSS 变量（不 setState，避免掉帧）
  // pointerup:   用位移与速度决定回弹或关闭；关闭后调用 dialog.close()
}
```

**给实现者的三条硬提醒**：

1. 图片全部同源（走本站媒体路由）。**禁止 CDN**，否则 SW 不缓存、离线失效（`sw.js` 对跨域直接 return）。
2. Showcase chunk 必须懒加载，并在发版时把 `CACHE` 从 `survey-platform-v2` 升到 `v3`（`sw.js` + `pwa.ts` 同步），否则旧 chunk 永久滞留用户缓存。
3. 背景联动的 scroll-driven 动画要包在 `@supports` 里做渐进增强；Firefox 未开启该特性时不能出现空白或不可见（默认态必须是「已完成 / 可见」，而不是「未动画的初始态」）。

---

## 10. 风险清单

| 风险 | 影响 | 缓解 |
|---|---|---|
| iOS Safari 上 scroll-snap 与抽屉手势互相抢事件 | 滑动时误开 / 误关 | 轨道用 `touch-action: pan-x`、把手用 `touch-none`；抽屉打开时锁 body 滚动 |
| 「点击人物」与「滑动结束」误触 | 意外弹窗 | pointerup 时判定 movement < 10px 且 duration < 300ms 才算点击 |
| 抽屉打开时 body 滚动穿透 | 背景跟着滚 | `position: fixed` + 记录 `scrollY` 的滚动锁（iOS 唯一可靠做法）；`overscroll-behavior: contain` 用于 `modal-box` |
| scroll-driven animations 在 Firefox 无效 | 背景不联动 | `@supports` 渐进增强 + IntersectionObserver / scrollend 降级；默认态即可见 |
| 新 chunk 进离线缓存后无法回收 | 用户设备缓存膨胀 | 发版升 `CACHE` 版本号；Showcase 走懒加载 |
| 未来加页面级 CSP | 依赖注入 inline style 的库可能受影响 | 0 依赖方案天然安全；若引入灯箱，它是 CSS 文件 + CSSOM 赋值，同样安全 |
| React 19.3 的 `<ViewTransition>` 尚不可用（当前 19.2.8） | 只能用命令式 `document.startViewTransition()` | 封装一个薄 hook，等升级 19.3 后再切组件式 API |

---

## 11. 参考来源

**包数据 / 版本 / 体积 / 许可**

* https://www.npmjs.com/package/embla-carousel-react 、 https://depscope.dev/pkg/npm/embla-carousel-react 、 https://bundlephobia.com/package/embla-carousel-react
* https://github.com/davidjerleke/embla-carousel/releases/tag/v8.3.1 （React 19 peer，PR #1041）、 https://github.com/davidjerleke/embla-carousel/discussions/1325 （v9 时间线）
* https://www.npmjs.com/package/swiper 、 https://github.com/nolimits4web/swiper/commit/49d232937def64852495027ea89dd135d2702ec8 （v14 bump react 19）、 https://github.com/nolimits4web/swiper/issues/8000 、 https://swiperjs.com/blog/swiper-v14
* https://depscope.dev/pkg/npm/react-swipeable 、 https://registry.npmjs.org/react-swipeable （7.0.2 / 2024-11-04）、 https://github.com/FormidableLabs/react-swipeable/pull/358 （size-limit）
* https://depscope.dev/pkg/npm/@use-gesture/react 、 https://npmx.dev/package-changelog/@use-gesture/react/v/10.3.1 （2024-03-21）
* https://registry.npmjs.org/keen-slider （6.8.6 / 2023-07-05）、 https://keen-slider.io
* https://www.npmjs.com/package/vaul 、 https://codingdunia.com/ui-components/vaul/ （21.4 kB min+gzip、40.7M 周下载）、 https://github.com/emilkowalski/vaul/compare/v1.1.0...v1.1.2 （React 19 peer）、 https://github.com/emilkowalski/vaul/issues/591
* https://www.npmjs.com/package/react-modal-sheet 、 https://github.com/Temzasse/react-modal-sheet （peer `motion >= 11`）、 https://app.unpkg.com/react-modal-sheet@5.6.0
* https://github.com/tailwindlabs/headlessui/releases/tag/%40headlessui%2Freact%40v2.2.0 （React 19 支持）、 https://depscope.dev/pkg/npm/@headlessui/react （61.5 KB gz）
* https://depscope.dev/pkg/npm/@radix-ui/react-dialog 、 https://codingdunia.com/ui-components/radix-ui
* https://motion.dev/docs/react-reduce-bundle-size （34 KB / 4.6 KB）、 https://security.snyk.io/package/npm/motion
* https://github.com/pmndrs/react-spring/pull/2368 （v10 = React 19）、 https://codingdunia.com/ui-components/react-spring 、 https://www.react-spring.dev/docs
* https://depscope.dev/pkg/npm/@formkit/auto-animate 、 https://registry.npmjs.org/@formkit/auto-animate （0.10.0 / 2026-07-10）
* https://depscope.dev/pkg/npm/yet-another-react-lightbox 、 https://yet-another-react-lightbox.com （React 19 支持）、 https://security.snyk.io/package/npm/yet-another-react-lightbox （3.32.2 / 2026-07-30）
* https://depscope.dev/pkg/npm/photoswipe 、 https://registry.npmjs.org/photoswipe （5.4.4 / 2024-05-24）
* https://registry.npmjs.org/react-photo-view 、 https://npmx.dev/package/react-photo-view （1.2.7 / 2025-01-05）
* https://security.snyk.io/package/npm/react-masonry-css 、 https://registry.npmjs.org/react-masonry-css （1.0.16 / 2021-04-04）、 https://depscope.dev/pkg/npm/react-masonry-css
* https://www.pkgpulse.com/guides/embla-carousel-vs-swiper-vs-splide-2026 、 https://pistack.xyz/posts/2026-08-19-swiper-vs-embla-vs-splide-javascript-carousel-libraries-comparison

**CSS / 平台能力**

* https://developer.chrome.com/blog/carousels-with-css 、 https://developer.chrome.com/blog/web-at-io25
* https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Selectors/::scroll-marker 、 https://www.sitepoint.com/scrolldriven-css-in-2026-building-carousels-without-javascript
* https://dev.to/linou518/view-transitions-api-native-browser-page-transitions-no-more-framer-motion-3g7d （Baseline Newly Available）
* https://www.pravinkumar.co/blog/view-transitions-api-webflow-designers-2026 （caniuse 2026-06：94.2%）、 https://trade-assistance.com/blog/cross-document-view-transitions-mpa-2026
* https://rebeccamdeprey.com/blog/scroll-driven-animations-css 、 https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/animation-timeline
* https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/interpolate-size 、 https://github.com/WebKit/standards-positions/issues/348 、 https://developer.chrome.com/docs/css-ui/animate-to-height-auto
* https://viliket.github.io/posts/native-like-bottom-sheets-on-the-web 、 https://css-tricks.com/using-and-styling-the-dialog-element 、 https://web.dev/learn/css/popover-and-dialog
* https://nolanlawson.com/2019/02/10/building-a-modern-carousel-with-css-scroll-snap-smooth-scrolling-and-pinch-zoom
* https://daisyui.com/components/modal?lang=en 、 https://daisyui.com/docs/v5?lang=en 、 https://daisyui.com/components/drawer?lang=en
* https://reactrouter.com/main/how-to/view-transitions 、 https://react.dev/reference/react/ViewTransition

**本仓库证据**

* `admin/package.json`、`package.json`、`wrangler.toml`、`admin/vite.config.ts`、`admin/public/sw.js`、`admin/src/pwa.ts`、`admin/src/components/Dialogs.tsx`、`src/services/media/media-serve.service.ts`

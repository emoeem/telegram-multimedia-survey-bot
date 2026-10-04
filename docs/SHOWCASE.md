# 展示区（Showcase）

> 一个面向手机端的沉浸式人物 / 作品展示空间，位于 `/showcase`，管理入口在后台「社区 → 展示区」。

## 1. 它是什么

展示区不是信息流，而是一个「人物立绘 + 氛围背景 + 作品展台」的浏览空间：

- 全屏舞台，一位创作者一屏；
- 左右滑动切换人物（原生滚动吸附，跟手、不卡顿）；
- 背景、主题色、装饰随人物联动过渡；
- 点击立绘从底部弹出资料面板：简介、标签、社交链接、精选作品、关联问卷；
- 每张人物页都有独立链接（`/showcase?p=<id>`），可直接分享。

## 2. 技术选型：零依赖

调查结论见 [SHOWCASE_FRONTEND_RESEARCH_2026-10.md](./SHOWCASE_FRONTEND_RESEARCH_2026-10.md)。核心判断：

| 需求 | 方案 | 增量体积 |
| --- | --- | --- |
| 左右滑动切换 | CSS `scroll-snap-type: x mandatory` + `scroll-snap-stop: always`，JS 只跟踪当前页 | 0 KB |
| 背景联动 | 每人物一层背景，透明度 + 缓慢缩放交叉淡入 | 0 KB |
| 立绘出入场 | 立绘随滚动容器移动，附加 `data-active` 驱动的缩放/淡出 | 0 KB |
| Bottom Sheet | 手写 Pointer Events 拖拽关闭（沿用仓库既有的 Dialogs 手写风格） | 0 KB |
| 无障碍 | Esc 关闭、body 滚动锁、`role="dialog"`、`aria-selected` 圆点 | 0 KB |

不引入 embla/swiper/vaul/motion 的原因：它们能解决的（循环、多档 snapPoints、物理弹簧）当前需求都不需要，而每个都会永久进入 Service Worker 的离线缓存（`admin/public/sw.js` 是 cache-first），并且会让 Telegram WebView 的首屏变慢。

何时才引入：见调研报告 8.3 —— 需要 loop + 多点吸附 → embla；多档 snapPoints → vaul；共享元素弹簧 → motion + LazyMotion；单页 >500 项 → 先试 `content-visibility`。

## 3. 页面结构

```
/showcase  (admin/src/survey/ShowcaseScreen.tsx)
├─ .showcase-root            主题变量容器（--sc-accent 由当前人物决定）
│  ├─ .showcase-stage
│  │  ├─ .showcase-backdrop  每个人物一层背景，仅渲染 ±1 层（避免一次性解码所有大图）
│  │  ├─ .showcase-veil      渐变遮罩 + 主题色光晕
│  │  ├─ .showcase-scroller  原生横向滚动容器
│  │  │  └─ .showcase-slide  一屏一个人物：立绘 + 昵称 + 副标题 + 标签 + 点按提示
│  │  ├─ .showcase-arrow     桌面端左右箭头（≥640px）
│  │  └─ .showcase-controls  圆点/计数 + 「查看 xx 的资料」
│  └─ BottomNav              与问卷/挑战/广场统一的底部导航（新增「展示」页签）
└─ ShowcaseSheet             底部资料面板（ShowcaseSheet.tsx）
```

移动端适配要点：

- 根容器 `position: fixed; inset: 0`，用 `100dvh` 语义避免地址栏抖动；
- `padding-bottom: env(safe-area-inset-bottom) + 150px`，保证立绘与控件不被底部导航和 Home 条压住；
- 滚动容器 `overscroll-behavior-x: contain`，避免 iOS 边缘返回手势与画廊抢手势；
- 触控目标 ≥ 40px；没有 hover-only 的操作；
- 面板在手机上贴底弹出，在桌面端居中成卡片（`@media (min-width: 640px)`）。

## 4. 数据结构

```
showcase_persons                       -- 一个人物 = 一张展示页
├─ name / subtitle / description
├─ accent_color                        -- 主题色：光晕、标签、圆点、按钮
├─ background_from / background_to     -- 无背景图时的渐变色
├─ background_media_id / illustration_media_id / avatar_media_id
├─ background_url / illustration_url   -- 也可直接填外链（自建 CDN）
├─ tags_json                           -- string[]
├─ links_json                          -- { type, label, url }[]
├─ survey_id                           -- 「查看我的问卷」
├─ response_id                         -- 预留：关联个人画廊答卷
├─ owner_user_id                       -- 预留：参与者自助维护
├─ feature_rank / sort_order / published
└─ created_by / created_at / updated_at

showcase_items                         -- FeaturedItem：一个人物的作品
├─ person_id → showcase_persons(id) ON DELETE CASCADE
├─ title / description
├─ kind   image | article | video | project | github | website | social | survey | other
├─ cover_media_id / cover_url
├─ url
├─ featured                           -- 精选：在资料面板里单独成组
└─ sort_order / created_at
```

设计取舍：

- **与个人画廊解耦**：展示区自己存字段，不要求参与者先发布一份答卷。两者通过 `survey_id` / `response_id` 建立软连接，将来可以「以画廊答卷生成展示页」。
- **媒体复用现有管线**：上传走 `storeSurveyAdminMedia`（`asset_scope='survey'`、KV 存储、不过期），因此不需要新的 scope、不会被 7 天临时媒体清理扫掉。
- **图片可来自外链**：`illustration_url` / `background_url` 只接受 http(s)，避免有人往 `<a href>` / `<img src>` 里塞 `javascript:`。

## 5. 接口

公开（无需登录，`ReadOnly`）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/showcase?limit&offset` | 仅返回 `published=1` 的人物及其作品；不含 owner / 审计字段 |
| GET | `/api/showcase/media/:assetId` | 立绘/背景/头像/封面。**只有被已发布人物引用时才可读**，下架即失效（授权边界是一次 JOIN） |

后台（仅管理员）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/showcase` | 列出全部人物（含草稿）与作品，带媒体 id 供表单回填 |
| POST | `/api/admin/showcase/persons` | 新建 |
| PATCH | `/api/admin/showcase/persons/:id` | 局部更新（只写传入字段，`null` 表示清空） |
| DELETE | `/api/admin/showcase/persons/:id` | 删除人物（作品级联删除，图片保留在媒体库） |
| POST | `/api/admin/showcase/persons/reorder` | `{ ids: [...] }` 拖拽/上下移动排序 |
| POST | `/api/admin/showcase/persons/:id/items` | 新增作品 |
| PATCH/DELETE | `/api/admin/showcase/items/:id` | 修改 / 删除作品 |
| POST | `/api/admin/showcase/media` | 上传图片（multipart，≤8MB，仅 image/*），返回 `mediaAssetId` |

所有写操作都写审计日志（`showcase.person.create/update/delete/reorder`、`showcase.item.create/update/delete`）。

> 排序语义：列表按 `feature_rank DESC, sort_order ASC, id` 展示。后台「上移/下移」只置换
> `sort_order`，所以当某个人物通过 API 设置了更高的 `feature_rank`（精选权重）时，手动排序
> 无法把它移到权重更高的人物之后——这是为「精选轮播」预留的优先级，属预期行为。UI 创建的
> 人物 `feature_rank` 恒为 0，常规排序不受影响。

## 6. 后台操作路径

1. 后台左侧「社区 → 展示区」；
2. 「新建人物」→ 填昵称/副标题/简介/标签 → 上传立绘、背景、头像（或填外链）→ 选主题色与背景渐变 → 填关联问卷编号；
3. 保存后在同一弹窗里「添加作品」，勾选「设为精选」；
4. 列表页可「公开/下架」「上移/下移」「编辑」「删除」；
5. 点「打开展示区」直接看前台效果（`/showcase`）。

## 7. 后续可扩展方向

- **参与者自助维护**：`owner_user_id` 已预留；加一个 `/api/showcase/me`（`resolveParticipant` 鉴权）即可让每个人编辑自己的那一条。
- **从画像生成展示页**：把指定的个人画廊答卷一键转成 `showcase_persons`（字段映射 + 图片复制，可直接复用 `profile-gallery.service` 的复制逻辑）。
- **团队 / 项目维度**：`showcase_persons` 增加 `kind`（person | team | project）即可，前台只需换一套立绘占位。
- **精选轮播 / 首页推荐**：`feature_rank > 0` 已经在排序里优先。
- **图片灯箱**：调研建议唯一值得引入的依赖是 `yet-another-react-lightbox`（MIT，核心 11.7KB gz，支持 React 19），且必须 `React.lazy` 懒加载。

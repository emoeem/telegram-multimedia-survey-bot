# 三区界面优化 + 新功能 · 进度交接文档

> 创建于 2026-10-03。配套会话完成的部分详见本文各节；**每完成一个批次更新一次本文件**。
> 范围来源：2026-10-03 的三区深审（问卷 / 广场 / 挑战）+ 用户确认"全部完成"。
> 最近更新：2026-10-03（第三批：成就 / 展示页 / 树洞图片帖 全部落地）。

## 状态总览

| 批次 | 状态 | 备注 |
|---|---|---|
| P0 修复包（FAB/死页/上一题/评论×2/挑战死锁×5） | ✅ 完成 | tsc 双 0、trial 相关 343 测试绿 |
| 界面-问卷（报告入口/卡片增强/排序/星级/退出确认等） | ✅ 完成 | 列表缓存版本已升 v2 |
| 界面-挑战（并入 P0：进度条/道具名/排行榜/价格下发/重摇限次/bot名） | ✅ 完成 | |
| 界面-广场（详情页+深链/autofocus/按tab拉取/空态/破图/重试） | ✅ 完成 | 双 tsc 0 错误 |
| 功能-图片灯箱（0依赖） | ✅ 完成 | 广场图片卡与资料详情页内使用 |
| 功能-「我的」个人中心 v1 | ✅ 完成 | /me + /api/me/overview；成就与展示页已接入 |
| 功能-成就/徽章系统 | ✅ 完成（2026-10-03） | 迁移 0067；13 枚徽章；bot 文案的"解锁成就"已名副其实 |
| 功能-画廊转展示页 | ✅ 完成（2026-10-03） | 迁移 0069；参与者只生成草稿，公开由管理员决定 |
| 功能-树洞图片帖 + #话题# | ✅ 完成（2026-10-03） | 迁移 0068；含图片上传/读图授权/话题筛选 |
| 功能-问卷列表 最新/热门 排序 | ✅ 完成（客户端排序） | |
| 收尾（全量 tsc/vitest/build + 重启 dev + 浏览器回归） | 🔶 代码面完成 | 双 tsc 0 + vitest 全绿 + build:admin 通过；浏览器回归待人工 |

## 已完成改动摘要

详细逐条说明见会话交接记录，此处只列关键位置：

- **P0**：PlazaScreen.tsx:529（FAB bottom 18→84px）；SurveyApp.tsx（retryKey 错误重试、accessCodeRef 再填一次、goBack 先落库）；src/http/plaza-api.ts（评论 POST 返回真实 owner）；admin/src/survey/plaza-api.ts（评论 offset 分页）；src/trial/engine.ts（advance 无任务→优雅结算、coinRerolls、rerollCap=3）；src/http/trial-api.ts（coverageTop 钳制、abandon 任意阶段、/runs/active 停用包恢复+孤儿局结算、reroll 409、/packs 下发 shop 经济配置）；task-run.repository.ts（排行榜昵称）。
- **问卷**：src/http/survey/catalog.ts（closed_at/anonymous/responseCount，**缓存版本 v1→v2**）；admin/src/survey/api.ts（reportUrl、列表字段）；SurveyApp.tsx（done 屏报告入口+已答标记、列表排序/徽章/破图/空态、rating 星级、matrix 300px、min/max/maxLength、媒体缩略图、退出确认 exitFillingWithConfirm——⚠️ 必须留在条件 return 之前）。
- **广场（2026-10-03）**：服务端 profile-gallery.service.ts 新增 getPublishedGalleryProfile（注意 listGalleryMediaByResponseIds 返回 Map，需 .get(id) ?? []）；src/http/plaza-api.ts 新增 GET /api/plaza/profiles/:id；客户端 fetchPlazaProfile + botHandleFromUrl（plaza-api.ts 导出版）；feed hooks 加 active 参数按 tab 拉取；空态去运营话术；错误加重试；ProfileCard 破图兜底 + 图片点击 ImageLightbox（0 依赖，Esc/点击关闭）+「查看资料卡」链接；新增 ProfileDetailScreen + 路由 /plaza/profile/:id（SurveyApp 的 /plaza 分发放宽为 startsWith("/plaza/")；worker 的 survey.html 路由本来就放行 /plaza/*）；composer autoFocus；done 屏资料卡深链 /plaza/profile/<responseId>。

## 第三批（2026-10-03）：成就 / 展示页 / 树洞图片帖

### 1. 成就 / 徽章系统（迁移 0067）

- **数据**：participant_achievements(participant_hash, code, unlocked_at, seen, meta_json)，UNIQUE(participant_hash, code)。**目录只在代码里**（src/services/achievement.service.ts 的 ACHIEVEMENTS，13 枚 = 问卷 4 / 挑战 4 / 广场 2 / 彩蛋 3），加徽章不需要迁移。
- **服务**：evaluateAchievements（按 hash + userId 统计问卷/资料卡/挑战/树洞，写入新解锁项并只返回"本次新解锁"）、evaluateTimeOfDayAchievements（深夜 0-5 点 / 早起 5-8 点，只能在完成那一刻判定）、loadAchievementOverview、markAchievementsSeen。全部 try/catch：徽章是装饰，统计失败不能拖垮提交。
- **打点位置**：src/http/survey/handler.ts 提交成功后；src/http/trial-api.ts action 后 status 为 completed 时；src/http/plaza-api.ts 发帖/评论后。响应里带 newAchievements。
- **接口**：GET /api/me/overview 增加 achievements{unlocked,total,unseen,items}；POST /api/me/achievements/seen 清小红点。
- **客户端**：admin/src/survey/AchievementWall.tsx（按分组徽章墙，未解锁显示锁、隐藏成就显示 ???）；MyScreen.tsx 挂载后自动清小红点；SurveyApp.tsx 提交成功屏与 TrialScreen.tsx 结算屏展示"解锁新成就"；src/bot/survey-handler.ts 主菜单新增「我的 · 成就」（带参与者 token 的 /me 深链）。

### 2. 画廊转展示页（迁移 0069）

- **软连接**：showcase_persons.response_id（0065 预留）加部分唯一索引，一个人一份答卷最多一条展示页。
- **映射**：src/services/showcase-profile.service.ts 的 mapProfileToShowcasePerson（纯函数，可测）：题目标题启发式取名（姓名/昵称/name）、副标题（签名/一句话/职业）、简介（简介类题目，否则按长度取前 3 条回答）、标签（标签/兴趣题，按 逗号/顿号/分号/# 切分，最多 8 个）、图片前两张分别作为立绘/背景；名字兜底 @username → 资料卡 #id。
- **接口**：POST /api/me/showcase（需要 Telegram 身份 + 已发布资料卡）→ 只创建**草稿**（published=0）；已存在的展示页**绝不覆盖**（管理员改过的名字/精选不会被一次点击冲掉），返回 {personId, created, published, url}。
- **入口**：/me 资料卡区块 →「把我的资料卡生成展示页」/「已生成，等待审核」/「查看我的展示页」；后台展示区卡片新增「来自画廊 #id」徽章，提示公开前先核对。

### 3. 树洞图片帖 + #话题#（迁移 0068）

- **迁移**：plaza_posts 加 image_asset_id 与 topic，建 idx_plaza_posts_topic 与 idx_plaza_posts_image_asset。**不重建 media_assets**（第一版那样做在生产 D1 上直接报 SQLITE_CONSTRAINT_TRIGGER 7500 —— D1 把一个迁移文件当一次原子批处理，事务内的 PRAGMA foreign_keys=OFF 是 no-op，DROP TABLE 会触发 RESTRICT 子表拒绝 / CASCADE 子表被清空；详见下方坑）。
- **上传**：POST /api/plaza/posts/media（仅 Telegram 身份，15 次/小时，≤5MB，JPG/PNG/WebP/GIF，verifyUploadContent 校验字节签名）→ durable KV media:plaza:<uuid>，expires_at 为空（不会被 7 天临时媒体清理扫到）。scope 复用 CHECK 允许的 **response**，身份判据是 KV 前缀 media:plaza:（isPlazaImageAsset）；/api/survey/media 与 /api/report 对 response 资产都要求「答卷 + 本人」，所以树洞图不会被别的路由旁路读出。
- **读图**：GET /api/plaza/media/:id 只在图片挂在一张 published 帖子上的时候可读；后台下架会 purgePlazaPostImage（删 KV 字节 + 过期 asset + 摘引用），**恢复帖子不会带回图片**（有意为之）。
- **发帖**：POST /api/plaza/posts 接受 imageAssetId / topic；带图时正文可为 0 字（仍 ≤500 字），不带图仍要求 5-500 字；配图必须是"树洞 scope 且还没被任何帖子用过"的 asset（防止拿已知 id 挂别人的图）。
- **话题**：src/services/plaza-topic.service.ts —— 显式 topic 优先，否则取正文第一个 #话题#；规范化后为空/含空格/超 20 字一律视为无话题。GET /api/plaza/posts?topic= 筛选，GET /api/plaza/topics 返回热度榜。
- **客户端**：广场投稿弹层支持配图（本地预览 + 上传 + 换一张/移除）与 #话题# 输入；树洞流渲染配图（点击进灯箱）与可点击的话题 chip；顶部话题筛选条（全部 / 各话题计数）；后台「树洞」页显示配图（/api/admin/media/:id/image）与话题标签。

### 4. 展示区「文字作品」阅读（2026-10-03 修，用户实测反馈）

现象：展示区里写文章 / 小说的作品，点立绘只能看到两行灰字，看不到正文。

根因（本地 Playwright 复现，非点击失效）：
- 面板本身能正常打开，作品也在——但 `.showcase-work-desc` 有 `-webkit-line-clamp: 2`，正文只剩两行预览（实测 scrollHeight 707px 被压成 clientHeight 35px），**没有展开入口**；
- 作品简介上限只有 400 字，长文根本存不进去，"写文章"这件事在数据层就被卡住了。

修复：
- 服务端：`SHOWCASE_LIMITS.itemDescription` 400 → **20000**；公开 feed 只发 `SHOWCASE_ITEM_PREVIEW_CHARS`（280 字）预览并带 `descriptionTruncated`，全文走新接口 **GET /api/showcase/items/:id**（`getPublishedShowcaseItemById`，只认已公开人物，下架即 404），避免几十篇长文把首屏撑大。
- 客户端：作品卡片在有正文时变成按钮（保留两行预览 + 「阅读全文」），点击打开全屏**查看层**（`admin/src/survey/ShowcaseViewer.tsx` 的 `.showcase-viewer`：标题 + 完整正文 + 原文链接 + 返回/关闭），Esc 先退查看层再关面板；无正文的卡片行为不变。
- 后台：作品简介输入框改成正文提示（"文章 / 小说可以直接把正文写在这里，最多 20000 字"）。
- 回归脚本：`qa/make-showcase-media-fixtures.mjs` 生成的样本 + `qa/showcase-viewer-check.mjs`（Playwright，非 CI）：断言每种作品的查看层形态、授权路由、无横向溢出、Esc 层级正确。

### 5. 展示区媒体作品（图片 / 音频 / 视频，2026-10-03 追加）

现象：作品只有 56px 缩略图和一个外链，图片点不出大图，音频类型根本不存在，"点击欣赏作品"不成立。

改动：
- **迁移 0070**：`showcase_items` 加 `media_asset_id`（作品**内容文件**，与卡片缩略图 `cover_media_id` 分开）+ `idx_showcase_items_media_asset`。纯 ADD COLUMN（0068 的教训）。
- **类型**：新增 `audio`（schema union / 服务端 kind 白名单 / 两端 label / 后台下拉）。
- **服务端**：`normalizeShowcaseItemInput` 接受 `mediaAssetId`；公开 feed 的 item 增加 `mediaUrl`（管理端走 `/api/admin/media/:id/image`，公开走 `/api/showcase/media/:id`）；`getPublishedShowcasePersonIdForAsset` 把 item 的内容文件也纳入授权（否则图片/视频一上传就 404）；上传接口从"只允许图片 8MB"放宽到"图片/音频/视频 20MB"。
- **清理保护**：孤儿媒体扫描的反连接与索引清单补上 `showcase_items.media_asset_id`（漏了会在 7 天后把作品文件删掉）。
- **客户端**：新增 `admin/src/survey/ShowcaseViewer.tsx` —— 一个查看层按类型切换：图片→大图（深色舞台、contain）、视频→16:9 原生播放器（playsinline、只预载元数据）、音频→封面+标题+整行铺满的播放器（浅色卡片）、文章→阅读层；Esc 先退查看层再关资料面板。卡片按类型显示「查看大图 / 播放音频 / 播放视频 / 阅读全文」。
- **后台**：作品编辑弹层可上传/替换/移除作品文件，并按类型预览。
- **回归**：`qa/make-showcase-media-fixtures.mjs`（ffmpeg 生成 png/wav/mp4 → data: URL seed）+ `qa/showcase-viewer-check.mjs`（Playwright，四种类型逐个点开，断言节点类型、授权路由、图片真实加载、无横向溢出）。

## 数据库迁移（本批新增，务必先应用）

| 迁移 | 内容 |
|---|---|
| 0067_participant_achievements.sql | 成就解锁表 |
| 0068_plaza_post_images_and_topics.sql | 树洞配图/话题列（**不重建 media_assets**，见坑） |
| 0069_showcase_person_response.sql | showcase_persons(response_id) 部分唯一索引 |
| 0070_showcase_item_media.sql | showcase_items.media_asset_id（作品内容文件）+ 索引 |

本地：pnpm migrate:local；线上：pnpm migrate:remote。**未应用迁移时新功能会直接 500/404**（表/列不存在）。

## 接手须知（坑）

- 问卷列表是 stamp 缓存：**改 payload 必须升 SURVEY_LIST_CACHE_VERSION**。
- 重建 admin dist 后 **必须重启 wrangler dev**，否则资源 404（清单过期）。
- trial 引擎状态存 task_runs.state_json：新增字段必须走 normalizeState 兜底（参考 coinRerolls）。
- trial action 处理里 **abandon 分支必须保持在 phase 检查与包查询之前**。
- 退出确认 useCallback 必须在组件所有条件 return 之前（hooks 规则）。
- botHandleFromUrl 现有三份（SurveyApp 本地 / plaza-api 导出 / TrialScreen useMemo），广场批收尾时统一到 plaza-api.ts。
- 后台本地登录：密码 showcase-test-2026（.dev.vars 的 ADMIN_IDS=123456789 对应种子用户）。
- **成就**：新增徽章只改 ACHIEVEMENTS 数组即可；已解锁用户不会补发历史徽章，评估只在"下一次有动作"时补齐；newAchievements 只表示"本次真的新解锁"，用 meta.changes 判定。深夜/早起彩蛋按 **Asia/Shanghai** 换算（Worker 运行时是 UTC，报告/周报也用这个时区），别再退回 getHours()/getUTCHours()。
- **展示页**：syncShowcasePersonFromProfile 对已存在的页面是 no-op（保护管理员编辑）；想刷新映射只能在后台删掉那条展示页再让用户点一次。草稿必须在后台点「公开」才出现在 /showcase。
- **树洞图片**：admin/src/survey/plaza-api.ts 的 plazaRequest 只有**非 FormData** 请求体才写 Content-Type——改回无条件 JSON 会让上传 400。新增帖子字段记得同步后台 PlazaPostSummary（admin/src/api.ts）。
- **D1 迁移不能重建被外键引用的父表**（2026-10-03 生产实测踩坑）：`wrangler d1 migrations apply` 把一个迁移文件当成**一次原子批处理**，事务内的 `PRAGMA foreign_keys=OFF` 是 no-op；于是 `DROP TABLE media_assets` 会触发外键动作 —— 有 ON DELETE RESTRICT 的子表（`visual_template_assets`、`image_generator_backgrounds`）直接报 `FOREIGN KEY constraint failed: SQLITE_CONSTRAINT_TRIGGER [code: 7500]`，就算没有 RESTRICT，CASCADE 子表的数据也会被静默清掉。`PRAGMA defer_foreign_keys` 只推迟检查、不阻止级联，同样不可用。
- **media_assets.asset_scope 有 CHECK 约束且无法安全放宽**：所以树洞配图复用 `response` scope + `media:plaza:` KV 前缀（判定用 `isPlazaImageAsset`）。以后要加新 scope，先想清楚要不要走「新表」或多值编码，别再写重建迁移。
- **孤儿媒体清理会删图**：`database-maintenance.service.ts` 每天按 7 天cutoff 删除「没人引用」的 media_assets 行 + KV 字节。引用探针漏了谁，谁的图就会消失——树洞配图与展示区图片（showcase_persons/items）就踩过这个坑，已补进反连接与 `ORPHAN_SWEEP_INDEXES`。加新的图片引用表时**必须同步这三处**：反连接探针、索引清单、（可选的）清理逻辑。新表/新列还会让索引创建失败从而自动停用清理，属于安全降级。
- **迁移与代码的先后**：0068 加列之前部署新代码，/api/plaza/posts 会因为 SELECT 不存在的列而 500。发布顺序固定为 **先 apply 迁移，再 wrangler deploy**。

## 体验创作者：登录入口与邀请码（2026-10-04）

**背景**：给外部的人开了体验创作者（`creator_trial_grants`，按 Telegram 用户、有到期时间），对方却卡在登录页。根因是登录页第一屏写着「输入管理员密码即可登录，**无需 Telegram 验证或 OAuth**」——那句话只对管理员成立，体验创作者真正的入口是下面那行「使用 Telegram 登录」（`canUseAdminPanel` 放行 admin 或有效体验创作者）。

三处改动：

1. **登录页文案**（`admin/src/routes/LoginPage.tsx`）：改成「管理员用密码登录；体验创作者用下面的『使用 Telegram 登录』」，并读取 `?reason=` 把一次性链接的失败原因显示成人话（link_invalid / no_access）。
2. **一次性免密登录链接**（新 `src/services/admin-magic-link.service.ts` + `GET /api/admin/auth/link?t=<token>`）：机器人主菜单的「🌐 网页管理后台」按钮直接带上票据，点开即登录 —— 不再需要「开网页 → 点按钮 → 跳 app → 点确认 → 切回浏览器」那套流程。
   - 30 分钟 TTL、**用掉即废**（唯一性由 `admin_login_consumptions` 主键裁决，KV 没有 CAS）；兑换时**重新**校验后台权限，授权到期/撤销后链接立刻失效；IP 限流 20 次/5 分钟。
   - 纯 GET + 302 + Set-Cookie，Telegram 内置浏览器里也能用；拿不到 CACHE 时自动退回普通 `/admin`。
3. **邀请码**（迁移 **0072** `creator_invites` + 机器人 `/invite CR-XXXX-XXXX` + 后台「体验创作者试用」卡片里生成/作废）：管理员发一个码，对方自己在机器人里兑换开通。好处是不用先问出对方的 Telegram 数字 ID、也不用共享密码，而授权仍然落在对方自己的账号上（复用 `grantCreatorTrial`）。码去掉了 0/O/1/I 等易混字符；核销是单条 `UPDATE … WHERE used_count < max_uses AND expires_at > ?`，并发只会有一个拿走名额；生成/作废走 vendor-only 闸门（顾客实例不能自己发体验权限）。

**上线验证（2026-10-04 18:15，生产实测）**：

```
curl -s -i "$BASE/api/admin/auth/link?t=probe" | head -6
HTTP/2 302
location: /admin/login?reason=link_invalid
cache-control: no-store
referrer-policy: no-referrer
```

- `cache-control: no-store` + `referrer-policy: no-referrer` 正是 `bounce()` 设的两条头 → 确认由**新代码**应答（网关的 401 不带这两条）。
- 同时新资源 `/assets/LoginPage-TBThid8H.js` = 200，说明这次构建的资源已生效。
- 部署后**第一秒**那次探针曾返回 401（部署传播窗口里仍由旧版本应答，body 为 `{"code":"unauthorized"}`）；一分钟后再打即 302。以后遇到「刚 deploy 完探针不对」，先等一分钟再判定。
- 线上版本 `7acf4a35-9c44-40f1-b8b2-3c9d6e5abc81`，迁移 0072 ✅。

**尚未跑过的**：成功路径的生产端到端（有效票据 → Set-Cookie → 进后台），需要真人从机器人里点「🌐 网页管理后台」；代码层由 `tests/unit/http/admin-magic-link.test.ts` 的第一条用例覆盖（断言 location=/admin 且 set-cookie 含 admin_session）。

验证：`tests/unit/services/creator-invite.service.test.ts`（生成/规范化/一次性/多用/过期/未知）、`tests/unit/http/admin-magic-link.test.ts`（兑换成功、无权限、已用/过期三种 302）、`tests/unit/services/admin-magic-link.service.test.ts`（一次性与并发只赢一个）、`tests/unit/bot/survey-handler-routing.test.ts`（首页按钮带票据、`/invite` 成功与失败文案）、`tests/unit/services/deployment-role.service.test.ts`（邀请码接口属 vendor-only）。
## 生产部署记录（2026-10-03）

- `wrangler login` 重新登录（旧 OAuth 已过期）；生产账号 / D1 `159e8169-a233-4bd7-b3e9-723586f850c2`。
- 远端迁移：**0065–0069 全部 ✅**（`wrangler d1 migrations list DB --remote` → "No migrations to apply!"）。0068 第一次失败于父表重建（见坑），改写后 5 条命令通过。
- Worker 版本：**`35dcb91f-a3cb-4d5b-a622-1cdac6ffce7e`**（首次部署 `e5d57987-4659-4f3a-840a-c7e9997ae9bd` 时 0068 尚未落地，中间短暂出现过 `/api/plaza/posts` 500）。
- 冒烟通过：`/health` → `{"ok":true,"environment":"production","version":"0.3.0","licenseEnforcement":"disabled"}`；`GET /api/plaza/posts?limit=1` → 200 且返回 items（树洞流恢复）。
- 仍需人工：浏览器回归（/plaza 配图投稿 + 话题筛选、/me 徽章墙 + 生成展示页、/trial 结算页新成就）；bot 主菜单的新按钮要用户重新 /start 才出现。
- **踩坑（2026-10-03 第二轮）**：0070 迁移第一次 apply 报 `The given account is not valid or is not authorized to access this service [code: 7403]`，但同一轮 `wrangler deploy` 成功了 —— 命令是分行的，于是「旧库 + 新代码」上线，`/api/showcase`/`/showcase`/后台展示区全部 500（代码 SELECT 了还不存在的列）。处置：`npx wrangler rollback` 回 35dcb91f 止血 → 排查发现同账号同 token（`d1 (write)` 权限在）、`d1 execute SELECT 1` 正常 → 直接重试 `migrations apply` 就 ✅ 了，说明 7403 是 Cloudflare 侧的瞬时授权错误，**先重试再怀疑配置**。
- 发布命令务必用 `&&` 串成一条链（`migrations apply && build && deploy`），迁移失败就不该继续部署；更稳的是走 `.github/workflows/deploy.yml`（迁移在部署之前，失败即中断）。
- 当前线上版本：**8d146fa5-7bc7-4426-9004-e4a3c229e4ef**（含展示区媒体作品 + 阅读层）；被回滚掉的坏版本是 c50b83e9-0518-49ef-a9f9-4e0aff8e4628。

## 收尾清单

1. ✅ pnpm --dir admin exec tsc --noEmit / pnpm typecheck（双 0 错误）
2. ✅ pnpm test（vitest 全量 659 用例，含本批新增 7 个测试文件）
3. ✅ pnpm build:admin
4. 🔶 重启 wrangler dev（:8787）——未在本轮执行，需要部署环境
5. 🔶 浏览器回归：/s（排序/徽章/空态）、/s/:id（rating、退出确认、报告入口）、/plaza（FAB、按 tab 拉取、评论分页、资料详情深链、灯箱、**配图投稿 + 话题筛选**）、/trial（重摇上限、进度条、排行榜层数、**结算页新成就**）、**/me（徽章墙、生成展示页）**
6. ✅ 新服务端行为补 vitest：
   - tests/unit/db/migrations-plaza-images.test.ts（0068 按 D1 语义跑：整文件一次批处理 + FK 开启；并锁住「重建父表必炸」这条结论）
   - tests/unit/repositories/plaza-post.repository.test.ts（配图/话题/话题榜/读图授权）
   - tests/unit/repositories/achievement.repository.test.ts（幂等解锁、已读）
   - tests/unit/services/achievement.service.test.ts（指标聚合、时间彩蛋、进度）
   - tests/unit/services/plaza-topic.service.test.ts（话题解析规则）
   - tests/unit/services/showcase-profile.service.test.ts（映射 + 不覆盖已有展示页）
   - tests/unit/http/me-api.test.ts、tests/unit/http/plaza-posts.test.ts（接口规则）

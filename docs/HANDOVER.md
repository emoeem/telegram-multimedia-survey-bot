# 项目交接文档（给下一位开发者 / AI）

> 更新日期：2026-08-23。本文档说明**当前完成了什么、还缺什么、下一步做什么**，
> 以及接手时最容易踩的坑。不含任何密钥/Token 明文——凭据一律走 Cloudflare
> Secrets 或本地 `.dev.vars`。

## 1. 项目定位（架构决策，已定死）

**Web-first 问卷平台 + Telegram 作为入口/通知/归档渠道**：

> **正式方向（2026-08-23 确认）**：Telegram 不再负责问卷 UI，也不限制问卷、
> 编辑器、报告展示能力。完整第二阶段计划见 `docs/PHASE2_PLAN.md`。

- 普通用户：Web 问卷列表（`/s`）→ Web Survey（`/s/:id`）→ 提交 → Web Report（`/report/:id`，手机浏览器阅读）
- 后台：Admin Web（`/admin`，Telegram WebApp）是核心控制台
- 归档：答卷完成后异步生成 PDF → 发送到管理员私人 Telegram 频道（带 hashtag）
- 用户上传图片是**临时数据**：报告归档成功后删除；答案数据永久保存在 D1
- R2 不可用（账号支付受限）→ 临时媒体用 KV（`MEDIA_KV`）
- 不引入 MTProto / MinIO / 新框架；单 Cloudflare Worker + D1 + KV + Queue + DO + Browser Rendering

## 2. 已完成功能清单

### 数据层（稳定，勿动）
- D1 全套：users / surveys / survey_questions / question_options / media_assets(scope+storage_kind) / survey_responses / answers / answer_options / answer_media / survey_versions / result_profiles / report_deliveries / user_tags / audit_logs / system_settings
- 迁移 0000–0030 全部可增量应用（0026 分页+版本快照；0027 临时媒体+报告交付；0028 用户标签；0029 报告模板列；0030 系统设置）
- `survey_versions` 快照 + `survey_responses.version` 关联：历史答卷绑定提交时版本
- `report_deliveries`：UNIQUE(response_id) + delivery_id 幂等键 + 状态机（pending/delivering/delivered/failed）+ 指数退避 + cron 重试驱动

### Web Survey
- `/s` 问卷列表（题数后端计算、密码标识）；`/s/:id` 移动端优先填写：全题型、进度、分页、校验、跳题、断点续填、访问码、图片上传（仅 JPEG/PNG/WebP，单张 ≤10MB、答卷 ≤50MB）

### Web Report + 报告模板
- `/report/:id?t=<签名token>` 响应式单页；`?template=` 可切换模板
- Report Template System：`ReportTemplateSpec`（sections/theme/css）+ 注册表（classic、magazine-dark）+ 校验
- PDF 与 Web 共用同一模板与 ReportViewModel；PDF 图片压缩至 ≤1200px，目标 ≤15MB
- 问卷可绑定 `report_template_id`（Admin 问卷详情选择）

### 报告归档（Telegram 频道）
- 完成即入队；Worker 生成 PDF + 必要图片 → `sendDocument`（带"📋 新答卷"摘要 + `#答卷X #问卷Y #用户Z`）→ 成功后才删临时媒体
- 失败退避重试（1m/5m/15m/1h，最多 5 次）+ 管理员通知 + Admin 重试/重新生成
- 频道识别：`/detect_channel` + `channel_post` 自动识别（验证 Bot 是频道管理员）；也可在设置页配 `report_channel_id`

### Admin Web（当前控制台）
- Dashboard：计数/今日答卷/报告交付状态/最近操作
- 问卷：列表/搜索/筛选/详情/关闭/重新发布/归档/删除（带答卷保护）/复制/导入导出/预览
- 编辑器：题目与选项 CRUD、拖拽排序、改题型、校验、跳题规则、分页管理、题目/选项复制、保存队列、409 并发、发布、版本恢复
- 版本管理：列表/对比（增删改 diff）/恢复为新草稿
- 答卷：列表（状态+日期筛选）/详情/媒体预览/归档/删除（已完成禁止）/打开 Web 报告/重新生成报告
- 报告管理：deliveries 状态/错误/重试
- 用户目录：搜索/标签/`tg://openmessage` 深链
- 系统设置：归档频道/默认模板/媒体 TTL/上传与 PDF 限制
- 审计：问卷创建/发布/关闭/归档/删除/导入/复制/恢复、报告重试/重新生成、设置变更

### Telegram Bot（保留职责）
- /start 入口、Web 问卷列表入口、完成通知（含网页版报告链接）、身份绑定、报告重发、频道识别、大文件人工渠道（后续）
- **旧 Bot 答题 UI 已下线（P10 第一块完成，2026-08-23）**：survey-handler 删除了内联答题渲染/消息答题路由/q:* 回调/继续填写入口及 `src/survey/renderer.ts`；问卷列表行改为 Web 链接（`/s/:id`），`/start survey_<id>` 深链打开 Web 问卷。**仍在代码中**：Builder（builder-handler 49KB）、QuestionEditor、导入 UI、owner:* 管理流程（P10 后续块，待 Bot 回归确认后继续）

## 3. 环境与部署现状

### 生产（唯一在跑的环境）
- Cloudflare 账号：`pd2335346@gmail.com`（Account ID `ed1957935f0efde06a68432e5fc48d97`）
- Worker：`telegram-multimedia-survey-bot` → `https://telegram-multimedia-survey-bot.pd2335346.workers.dev`
- D1：`telegram-survey-db`（id `159e8169-a233-4bd7-b3e9-723586f850c2`，有真实数据）
- KV：`CACHE`（`0e659a11…`）、`MEDIA_KV`（`1761c298…`）
- Queue：`telegram-survey-export`
- Secrets：`BOT_TOKEN` / `WEBHOOK_SECRET` / `ADMIN_IDS`（=8407924229）
- Vars：`REPORT_CHANNEL_ID=-1004489719605`
- Webhook：生产 URL + allowed_updates=[message, callback_query, channel_post]
- 已应用迁移：0000–0030
- 最近部署版本：`7a041cbc`（2026-08-23，对应 git `9417dd5`；注：形如 `xxxxxxxx` 的 8 位短串是 wrangler 部署 ID 前缀，不是 git commit）

### Staging（备用）
- 账号：`3353745917@gmail.com`（Account ID `fb8f4c599afffea6f419532f2d95ab54`）
- Worker：`telegram-multimedia-survey-bot-staging`
- 注：**本机 wrangler OAuth 目前是生产账号**；部署 staging 前需 `wrangler login` 切回 staging 账号

## 4. 已知限制与决策（接手前必读）

1. **R2 未启用** → 临时媒体走 KV；问卷静态媒体仍是 Telegram file_id（Web 编辑器暂不能上传静态媒体，只能 Bot/导入）
2. **无规则集的 fallback 报告**：~~单选显示原始选项 ID（如"10"而非"蓝色"）~~ 已修复——`result-visual.service.ts` 的 fallback 展示会把单选/多选选项 ID 映射为标签（未知 ID 回退原始值）；标签来自当前 `question_options`，历史答卷按 DB 选项 ID 尽力映射（快照中选项为位置 ID，无可靠对应关系）。配置 ResultRule 后按规则显示文案
3. **Bot 旧答题 UI 第一块已下线**：内联答题/消息路由/q:* 回调/继续填写入口/`renderer.ts` 已删；Builder、QuestionEditor、owner:* 管理流程仍在代码中（P10 后续块，等 Web 流程人工确认后继续删）
4. **`assets` 配置三件套（2026-08-23）**：`run_worker_first=true` + `html_handling="none"` + `not_found_handling="none"`。Worker 先于静态资产执行，`/s`、`/admin`、`/api/*` 由 Worker 显式路由，JS/CSS 由 ASSETS 兜底，未知路径返回真 404。**不要把 `not_found_handling` 改回 `single-page-application`**：那会让带 `Sec-Fetch-Dest: document` 的真实浏览器导航请求被 SPA fallback 拦截并直接返回 admin index.html（Worker 不执行），导致 `/s`、`/s/:id` 黑屏——这是此前 curl 正常但浏览器黑屏的根因。`/admin` 入口在 Worker 里显式取 `/index.html`（`html_handling="none"` 下无目录索引）；`/s` 显式取 `/survey.html`，勿改回默认否则路径被重定向丢失
5. **前端页面不再阻塞加载 telegram.org 脚本（2026-08-23）**：survey/admin 均改为挂载前带超时动态加载（`waitForTelegramWebApp`）+ initData 惰性读取；`/s`、`/admin` 的 HTML 响应 `Cache-Control: no-store`，防止 WebView 缓存旧页面。普通浏览器（含国内）不再黑屏；Telegram WebView 内由客户端本地提供该脚本，鉴权不受影响
6. 系统设置页里的 TTL/上传/PDF 限制目前是**存储+展示**，运行时媒体限制仍用代码常量（`temporary-media.service.ts`）；接入设置值属后续项
6. `.dev.vars` 的 BOT_TOKEN 是占位符，别当真；真实 token 只在 Cloudflare Secrets
7. **Bot token 曾在对话中暴露过**，建议在 BotFather 轮换一次并更新 Secrets
8. 本机 `~/.config/.wrangler` 的 OAuth 会随 `wrangler login` 切换账号，注意当前指向哪个账号

## 5. 待办（下一步）

### 近期（建议优先级）
- [x] **提升批 1-7 + GitHub CI（2026-08-23）**：系统设置生效、问卷列表搜索/封面、审计日志页、编辑器撤销重做+自动保存、PWA、模板编辑器拖拽+字体配色可视化、批量导出进度；GitHub Actions CI（typecheck/单测/lint/构建/PDF 回归/视觉回归）。详见 `docs/PHASE2_PLAN.md` §14
- [x] **答卷批量导出/内嵌预览/分享链接（2026-08-23）**：答卷列表勾选批量导出到私人频道、桌面双栏内嵌报告预览（可切模板）、一键复制分享链接（30 天 token）。详见 `docs/PHASE2_PLAN.md` §14
- [x] **报告打包直发频道 + 后台响应式（2026-08-23）**：有用户图片的答卷归档改为 PDF+图片打包单个 zip 发私人频道（>45MB 降级分开发）；答卷详情「导出到私人频道」；草稿编辑器桌面分栏 + 粘性实时预览。详见 `docs/PHASE2_PLAN.md` §14
- [x] **BGM 图形化配置 + 用户自选主题（2026-08-23）**：后台问卷详情可直接上传 BGM 或填直链（带预览/清除）；填写页头部 🎨 弹层让用户选主题（默认 + 8 套 DaisyUI 预设，按问卷记忆），覆盖问卷默认主题；视觉回归 48 用例。详见 `docs/PHASE2_PLAN.md` §14
- [x] **体验修复批（2026-08-23）**：管理员可重复填写已发布问卷（每次新答卷）；已发布问卷可直接改主题/报告模板等元数据（去掉 draft-only 锁）；答卷详情支持任选模板预览 Web 报告；修复 PDF 下载 404（前端误用 GET）；新增 BGM（主题 `audio` 字段 + 问卷页浮动播放器）；浏览器登录（Telegram `/admin_login` 发一次性链接 → HMAC 会话 cookie 7 天 + `/admin/login` 页 + 浏览器模式横幅）。详见 `docs/PHASE2_PLAN.md` §14
- [x] **Phase 6：Template Editor（2026-08-23）**：迁移 0032 自定义模板表 + 解析服务全链路接入（Web/PDF/下载）+ `/admin/templates` 编辑器（块编排/主题/实时预览/手机桌面切换）+ 问卷绑定自定义模板。详见 `docs/PHASE2_PLAN.md` §9
- [x] **Phase 5：Responsive Report（2026-08-23）**：桌面 12 栏分栏网格、平板双列、PDF 打印强制单栏独立布局；报告视觉回归 21 用例 + 打印 7 用例（总计 47）。详见 `docs/PHASE2_PLAN.md` §8
- [x] **Phase 4 第一块：Report Engine 2.0（2026-08-23）**：报告主题复用 DaisyUI 8 套、新增环形分/清单/档案头/分隔线块、模板库扩至 7 套（数据分析/身份档案/杂志/极简/影集等）、报告视觉回归 14 用例。详见 `docs/PHASE2_PLAN.md` §7/§8
- [x] **Phase 3 完成（2026-08-23）**：SurveyTheme 渲染 + DaisyUI 预设库/后台选择 + 题号进度/分页指示/长文本折叠 + Option 卡片化 + 键盘适配；视觉回归 19 用例覆盖。详见 `docs/PHASE2_PLAN.md` §5/§6
- [x] **Phase 3 第三块：Option Media 卡片化（2026-08-23）**：带媒体选项整题切换 2 列卡片（4:3 封面 object-cover + 选中徽标 + 底部指示器），无媒体选项纯标签卡片；视觉基线已随布局更新。详见 `docs/PHASE2_PLAN.md` §5
- [x] **Phase 7 第一块：Playwright 视觉回归（2026-08-23）**：`qa/visual/survey.spec.ts` 18 用例（6 fixture × 3 视口），离线自包含，硬断言溢出/报错/主题 + 截图基线对比；`npm run test:visual` / `test:visual:update`。详见 `docs/PHASE2_PLAN.md` §10
- [x] **Phase 3 第二块：主题预设库 + 后台选择界面（2026-08-23）**：预设直接复用 DaisyUI 主题库（8 套，纯 CSS 变量，无组件冲突）；问卷页 `data-theme` 激活；后台详情页预设选择器（实时色板）+ 自定义 JSON 叠加 + 清除。详见 `docs/PHASE2_PLAN.md` §6
- [x] **Phase 3 第一块：SurveyTheme 渲染 + 移动端增强（2026-08-23）**：主题令牌规范化/下发/渲染（背景图+遮罩+主色+卡片+文字+按钮）、题号进度加完成百分比与分页指示、长文本折叠；修复 `.btn` 白底白字旧隐患。详见 `docs/PHASE2_PLAN.md` §5/§6
- [x] **Phase 2 完成（2026-08-23）**：Web JSON 导入页 + 高保真预览（题型/媒体/低置信度）、分页保真、置信度透传、Media Resolver（data URL → MEDIA_KV）、导入错误逐字段定位、导入时绑定报告模板/主题（迁移 0031 `surveys.settings_json`）。详见 `docs/PHASE2_PLAN.md` §3
- [x] **Phase 2 第三块：导入错误逐字段定位（2026-08-23）**：`ImportValidationError` + 结构化 issues（题号/标题/字段/路径），导入页逐条展示；Bot 导入路径兼容。详见 `docs/PHASE2_PLAN.md` §3
- [x] **Phase 2 第二块：Media Resolver（2026-08-23）**：PDF 内嵌 data URL 媒体导入时解码存入 MEDIA_KV（D1 只存引用）、导入上限提至 40MB、媒体代理支持 data URL 直出；实测堕落游戏.pdf 58 个媒体无损入库。详见 `docs/PHASE2_PLAN.md` §3/§4
- [x] **Phase 2 第一块：Web JSON 导入 + 高保真预览（2026-08-23）**：`/admin/imports` 导入页（粘贴/上传 → 预览 → 创建草稿）、预览含题型分布/媒体/低置信度清单、分页保真、置信度透传；PDF 转换器（`scripts/forms_pdf_to_survey.py`）对非 Forms 版式自动关联 PDF 分页。详见 `docs/PHASE2_PLAN.md` §3
- [x] **Phase 1 答卷查看核心（第一块，2026-08-23）**：答卷详情补问卷版本号 + 版本页链接、每题原始数据查看、PDF 下载（同步 Browser 渲染）、重新发送 Telegram（force 重入队）；详见 `docs/PHASE2_PLAN.md`
- [ ] **按 `docs/PHASE2_PLAN.md` 继续第二阶段**：Phase 2 JSON 高保真导入 → Phase 3 Web Survey UI 2.0 → Phase 4 Report Engine 2.0 → Phase 5 Responsive Report → Phase 6 Template Editor → Phase 7 Playwright Visual QA
- [x] **WebView 黑屏根因修复并上线（2026-08-23）**：`run_worker_first=true` + 显式静态兜底 + 入口 HTML `Cache-Control: no-store` + 非阻塞 telegram.org bridge + data-URI favicon；生产 Version `7a041cbc`，Chromium 实测 `/s`、`/s/18`、`/admin`、`/admin/surveys` 全部 200 且控制台无 404/加载失败。**人工验证时先发 `/start` 拿新按钮**（旧消息里的旧按钮可能仍带旧行为）
- [x] **生产冒烟验证（大部分完成）**：2026-08-23 通过公开 API 提交答卷 167/168（问卷 18）→ `report_deliveries` 均 `delivered`（1 次尝试）、Web 报告页 200 且单选显示选项标签、临时媒体上传 → KV+D1 正常。**仍需人工确认**：Telegram 频道收到 PDF+hashtag（`#答卷167` 等）；带图片题的真实答卷（发布问卷中暂无图片题）验证"归档后删临时媒体"
- [ ] **P10：旧 Bot UI 下线**（答题渲染/Builder/QuestionEditor/导入 UI 入口）——验证稳定后逐块删，每块先单测+回归；配合 Telegram 职责收缩（见 `docs/PHASE2_PLAN.md` §0）
  - [x] 答题渲染（内联答题/消息路由/q:* 回调/renderer 模块）已删并部署（`0e577f7b`）
  - [x] 问卷入口改为 Telegram WebView（`web_app` 按钮打开 `/s` 与 `/s/:id`，`54005b63`）
  - [ ] Builder / owner:* 管理流程（待 Bot 回归确认后继续）
  - [ ] QuestionEditor（question-editor.ts）
  - [ ] 导入 UI 入口（home:import_json / home:copy_list）
- [ ] Admin「结果模板」页（visual templates 目前只在 Bot 管理）
- [x] 单选 fallback 显示选项标签（`result-visual.service.ts` + 单测覆盖）

### 中期（C1–C5）
- [ ] 编辑器自动保存 + 撤销/重做
- [ ] PWA（manifest + service worker）
- [ ] Web 媒体库：Survey 静态媒体上传（走频道 file_id 或临时→长期）
- [ ] 报告模板 DB 化 + Admin 自定义模板编辑器（当前注册表硬编码）
- [ ] 大文件/视频 Telegram 人工提交入口
- [ ] 系统设置中的媒体 TTL/上传/PDF 限制真正接入运行时
- [ ] 问卷预计耗时展示

### 持续
- [ ] 每次改动跑 `npm run typecheck && npm test && npm run lint && npm --prefix admin run build`
- [ ] 前端 UI 改动后跑 `npm run test:visual`（视觉回归；`test:visual:update` 仅在有意变更时重生成基线）
- [ ] PDF 转换器改动后跑 `.venv/bin/python scripts/test_forms_pdf_to_survey.py`
- [ ] 迁移流程：备份 D1（`wrangler d1 export`）→ 应用 → staging 验证 → 生产
- [x] 已应用迁移 0000–0031（0031 为 `surveys.settings_json`，2026-08-23）

## 6. 常用命令

```bash
npm run typecheck
npm test
npm run lint
npm --prefix admin run build        # 前端构建（含 survey.html 列表页）
npm run migrate:local               # 本地 D1
npx wrangler d1 migrations apply DB --remote   # 生产迁移
npx wrangler deploy                 # 生产部署（当前 OAuth 指向生产时）
```

## 7. 关键文件地图

| 区域 | 文件 |
| -- | -- |
| Worker 入口/路由 | `src/index.ts` |
| 公开 Survey API | `src/http/survey-api.ts` |
| 公开 Report 页 | `src/http/report-api.ts` |
| Admin API | `src/http/admin-api.ts` |
| 报告模板系统 | `src/services/report/template.ts` + `web.ts` + `pdf.ts` |
| 报告归档 Worker | `src/services/report-delivery-worker.service.ts` |
| 临时媒体 | `src/services/media/temporary-media.service.ts` |
| 版本快照 | `src/services/survey-version.service.ts` |
| 系统设置 | `src/services/system-settings.service.ts` |
| Bot 主处理器（旧 UI） | `src/bot/survey-handler.ts` |
| 频道识别 | `src/bot/channel-detection.ts` |
| 前端 Admin | `admin/src/`（EditorPage/UsersPage/ReportsPage/VersionsPage/SettingsPage…） |
| 前端 Web Survey | `admin/src/survey/SurveyApp.tsx` |
| 迁移 | `db/migrations/`（当前到 0030） |

## 8. 接手第一步

1. `npx wrangler whoami` 确认当前账号（生产 pd2335346 / staging 3353745917）
2. `npm install && npm test` 确认基线
3. 打开生产 `/admin`（Telegram 内）核对 Dashboard/报告/设置
4. 在频道发一条消息看 Bot 是否正常回（新代码应回复"✅ 已自动识别报告归档频道"只触发一次；已配置则无回复）
5. 按 §5 待办继续

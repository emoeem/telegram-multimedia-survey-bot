# 项目交接文档（给下一位开发者 / AI）

> 更新日期：2026-08-23。本文档说明**当前完成了什么、还缺什么、下一步做什么**，
> 以及接手时最容易踩的坑。不含任何密钥/Token 明文——凭据一律走 Cloudflare
> Secrets 或本地 `.dev.vars`。

## 1. 项目定位（架构决策，已定死）

**Web-first 问卷平台 + Telegram 作为入口/通知/归档渠道**：

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
- **旧 Bot 答题 UI 仍在代码中**（survey-handler 5235 行），入口未删（P10 待做）

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
- 最近部署版本：`7c49ca05`（2026-08-23）

### Staging（备用）
- 账号：`3353745917@gmail.com`（Account ID `fb8f4c599afffea6f419532f2d95ab54`）
- Worker：`telegram-multimedia-survey-bot-staging`
- 注：**本机 wrangler OAuth 目前是生产账号**；部署 staging 前需 `wrangler login` 切回 staging 账号

## 4. 已知限制与决策（接手前必读）

1. **R2 未启用** → 临时媒体走 KV；问卷静态媒体仍是 Telegram file_id（Web 编辑器暂不能上传静态媒体，只能 Bot/导入）
2. **无规则集的 fallback 报告**：单选显示原始选项 ID（如"10"而非"蓝色"）；配置 ResultRule 后正常显示文案。可后续加选项标签映射
3. **Bot 旧答题 UI 未删除**：删除前必须 Web 流程在真实环境验证稳定（P10）
4. **`html_handling="none"` 已配置**：不要改回默认，否则 `/s/:id` 会被 ASSETS 重定向到 `/survey` 丢失路径
5. 系统设置页里的 TTL/上传/PDF 限制目前是**存储+展示**，运行时媒体限制仍用代码常量（`temporary-media.service.ts`）；接入设置值属后续项
6. `.dev.vars` 的 BOT_TOKEN 是占位符，别当真；真实 token 只在 Cloudflare Secrets
7. **Bot token 曾在对话中暴露过**，建议在 BotFather 轮换一次并更新 Secrets
8. 本机 `~/.config/.wrangler` 的 OAuth 会随 `wrangler login` 切换账号，注意当前指向哪个账号

## 5. 待办（下一步）

### 近期（建议优先级）
- [ ] **生产冒烟验证**：填一份真实答卷 → 检查频道收到 PDF+附件+hashtag、临时媒体被删、Admin 报告页状态
- [ ] **P10：旧 Bot UI 下线**（答题渲染/Builder/QuestionEditor/导入 UI 入口）——验证稳定后逐块删，每块先单测+回归
- [ ] Admin「结果模板」页（visual templates 目前只在 Bot 管理）
- [ ] 单选 fallback 显示选项标签

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
- [ ] 迁移流程：备份 D1（`wrangler d1 export`）→ 应用 → staging 验证 → 生产

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

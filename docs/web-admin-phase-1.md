# Web Admin Phase 1

复用现有 Cloudflare Worker、D1 `users/surveys/survey_questions/survey_responses` 表及权限角色。新增只读 API：`GET /api/admin/dashboard`、`GET /api/admin/surveys`、`GET /api/admin/surveys/:id`。

认证采用 Telegram 身份：从 Telegram 打开页面时验证 `x-telegram-init-data`（HMAC-SHA256 签名校验 + 24 小时新鲜度，页面端 percent-encode 传输）；Staging/本地（`ENVIRONMENT=development`）可通过 `x-telegram-user-id` 旁路模拟身份。管理员复用 `ADMIN_IDS` 与 `users.system_role=admin`；通过身份认证且存在于 `users` 表的用户均可登录，非 admin 的问卷 owner 只能看到自己的问卷（列表/总览按 `owner_id` 过滤），访问他人问卷详情返回 403。未新增 Cloudflare 资源、迁移、R2 或 Queue。静态 SPA 位于 `admin/dist`（无构建步骤，直接入库），由同一 Worker Assets 提供。

本阶段暂不实现题目、答卷编辑、统计、Telegraph、模板与发布操作。

## 已完成（Phase 1 收尾批，2026-08-22）

- 后端 API 抽到 `src/http/admin-api.ts`（与 `license-api.ts` 同模式），owner 只读视图放开、403 可真实触发
- initData 验证加固：percent-decode、auth_date 24h 新鲜度校验；单测覆盖（`tests/unit/http/admin-api.test.ts`）
- 响应式：平板侧栏图标栏（保留 emoji）、移动端抽屉 + 遮罩 + Escape 关闭 + 背景滚动锁定、卡片视图、内容居中、表格横向滚动、状态 badge 分色、骨架屏
- 完整状态：401（引导 Telegram 登录）/403/404/网络错误区分文案，重试为重新请求（不整页刷新），空态区分「还没有问卷」与「没有符合条件的问卷 + 清除筛选」
- Survey List：搜索防抖 300ms、状态筛选（草稿/已发布/已关闭/已归档）
- Staging Test Banner：`/health` 返回 `development` 且不在 Telegram 内时显示，可输入测试身份并应用/清除；生产永不渲染
- Bot 登录交接：`/admin` 管理员中心新增「🌐 网页管理后台」web_app 按钮（`ctx.origin + '/admin'`）
- `.gitignore` 改为只忽略根目录 `/dist/`，`admin/dist` 入库（CI 部署依赖 assets 目录）
- 前端脚本路径修正为 `/app.js`（assets 以 `admin/dist` 为根）

分页 UI（后端已支持 `page/pageSize/totalPages`）留到后续批次。

## Deployment

Production remains the existing single Worker. Create a separate Wrangler environment/account for staging with independent D1/R2/Queue bindings; do not copy production data into a browser or expose Cloudflare tokens. Validate `/admin`, dashboard, survey filtering/detail, responsive layouts, loading/empty/error/403 states in staging before production deployment.

## Staging 验证手册

Staging 配置见 `wrangler.staging.toml`（独立 D1/KV/Queue，`ENVIRONMENT=development` 启用测试身份旁路）。首次部署：

```sh
# 1. secrets（BOT_TOKEN 可复用生产 bot token：initData 签名验证与 webhook 接收方无关）
npx wrangler secret put BOT_TOKEN -c wrangler.staging.toml
npx wrangler secret put WEBHOOK_SECRET -c wrangler.staging.toml
npx wrangler secret put ADMIN_IDS -c wrangler.staging.toml   # 逗号分隔的测试管理员 Telegram ID

# 2. staging D1 建表（新库）
npx wrangler d1 migrations apply telegram-survey-staging-db --remote

# 3. 部署
npx wrangler deploy -c wrangler.staging.toml
```

浏览器验证（不需要 Telegram）：

1. `GET /health` 返回 `environment: "development"`。
2. 打开 `/admin`，顶部出现黄色 STAGING 测试条；输入 `users` 表中存在的 Telegram ID 并应用。
3. 依次验证：总览卡片与最近问卷/答卷、问卷列表 → 详情跳转、搜索（防抖）、状态筛选、空态文案与清除筛选、401（未设身份）/403（普通用户访问他人问卷）/404（不存在的问卷 ID）。
4. DevTools 三档视口（>1000px / 641–1000px / ≤640px）+ 手机真机检查侧栏收缩、抽屉、卡片视图。

Telegram 真机验证（initData 身份，验证完务必切回）：

```sh
# 临时把 webhook 指向 staging Worker
curl "https://api.telegram.org/bot$BOT_TOKEN/setWebhook" \
  -d "url=https://telegram-multimedia-survey-bot-staging.<account>.workers.dev/telegram/webhook" \
  -d "secret_token=$WEBHOOK_SECRET"
# 验证完成后切回生产 webhook（生产 URL 同上格式）
```

在 Telegram 中发送 `/admin` → 点击「🌐 网页管理后台」按钮 → 页面以真实 initData 打开并自动通过身份验证（测试条应消失）。

验收要点：Test Header 不出现在生产；staging 与生产 D1/KV/Queue 绑定 ID 不同，验证过程不执行 `npm run deploy`、不读写生产绑定。

## Staging 验证记录（2026-08-22）

部署至 `telegram-multimedia-survey-bot-staging.3353745917.workers.dev`，已验证：

- `/health` 返回 `development`；`/admin`、`/admin/surveys/:id` 深链接、`/app.js` 均正常（旧 `/admin/app.js` 路径会命中 SPA 回退返回 HTML，即白屏 bug，已修复为 `/app.js`）
- 权限链：无身份 401；`users` 表外身份 401；production 模式忽略 dev header（单测覆盖）；owner（测试身份 222）列表/dashboard 仅见自己的问卷；admin 全量；他人问卷详情 403；不存在 404；非 GET 405
- initData：真实 BOT_TOKEN 签名（含中文 first_name）→ 200 且 owner 过滤生效；过期（25h）→ 401；篡改 hash → 401
- 浏览器 UI：Test Banner 显示/应用/清除；Dashboard 指标与最近问卷/答卷；列表搜索（防抖）、状态筛选、空态（区分「还没有问卷」/「没有符合条件的问卷 + 清除筛选」）；详情 8 字段 + 本地化时间；403/404 面板文案与重试按钮
- 响应式：390px 汉堡菜单 + 抽屉 + 卡片视图（表格 CSS 隐藏）；820px 图标侧栏；桌面全展开
- staging 测试数据：users 222（owner_test）/333（other_owner）及 3 份问卷，供人工复验
- 注意：浏览器自动化面板偶发输入事件投递不稳（同按钮时灵时不灵），已用 Node 端 React 桩模拟证明「清除筛选」等事件接线与状态更新逻辑正确

**剩余人工步骤**：Telegram 真机 initData 端到端验证——按上文临时切换 webhook 到 staging，在 Telegram 内 `/admin` → 「🌐 网页管理后台」按钮打开页面（Test Banner 应消失、以真实身份载入数据），验证后把 webhook 切回生产。

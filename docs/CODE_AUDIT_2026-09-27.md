# 代码审计报告 · telegram-multimedia-survey-bot

日期：2026-09-27
范围：`src/`（Worker/D1/KV/Queue/DO）、`admin/`（React 管理端 + 问卷/广场/任务 SPA）、`db/migrations/`
方法：`tsc --noEmit` + `vitest run` + `eslint` + `pnpm --dir admin build` 全绿；随后按 5 个子系统做只读审计，对每条高危结论回到源码与 SQL 复核，关键项做了实测复现。

> 基线：typecheck 通过、99 个测试文件 559 个用例全通过、lint 通过、admin 构建通过。
> 结论：代码质量整体高于同类项目（错误语义化、限流、幂等、索引、读预算都考虑到了），
> 下面按“会造成数据/安全损失 → 功能静默失效 → 性能与额度 → 可维护性”排序。

---

## P0 · 需要尽快修

### P0-1 上传 MIME 由客户端声明 → 同源存储型 XSS（可跨用户投递）

- `src/http/survey/media.ts:169-190`：`const mimeType = (file.type || ...).toLowerCase()`，而 `questionType === "file"` 时
  `typeAllowlist = null`（第 173-181 行），即**任意声明的 MIME 都通过**（`text/html`、`image/svg+xml`）。
- `src/services/media/media-serve.service.ts:59-61`：原样回写 `Content-Type: asset.mimeType`。
- 仓库里**没有任何 `Content-Security-Policy`**（`grep -rn "Content-Security-Policy" src/` 无结果）；
  `nosniff` 拦不住一个被显式声明成 `text/html` 的响应。
- 真正做魔术字节校验的 `verifyUploadContent()`（`src/services/media/upload-validation.service.ts:168`）
  **从未被 import**，是死代码。
- 跨用户路径：`/api/report/media/:id?t=<token>&rid=<rid>`（`src/http/report-api.ts:128-153`）对同一答卷的任意资产放行，
  而提交者自己就持有该 token（`src/http/survey/handler.ts:366-372`，30 天有效），且提交时 blob 已转为长效存储
  （`media:report:*`，`expires_at = NULL`），链接长期有效。
- 组合利用：匿名开一份答卷 → 对 `file` 题上传一个声明为 `text/html` 的 HTML → 保存答案 → 提交 → 把
  `/api/report/media/<assetId>?t=...&rid=...` 发给管理员。脚本运行在**与 `/admin` 同源**的页面上，
  而 admin 会话是 `HttpOnly; Path=/` 的 Cookie（`src/http/admin/index.ts:71`），因此可以代管理员调用
  `/api/admin/*`、读取同源 `localStorage`。

修复：
1. `buildMediaResponse` 对 `file` 类资产强制 `application/octet-stream` + `Content-Disposition: attachment`；
   或在存储时用 `detectContent(bytes)` 的检测结果覆盖声明值。
2. 接入 `verifyUploadContent(bytes, mimeType)`（代码已存在，只是没被调用）。
3. 媒体响应加 `Content-Security-Policy: default-src 'none'; sandbox`。

### P0-2 「强制重新归档/重发报告」全部是静默空操作

- `src/services/report-delivery.service.ts:68`：
  `const shouldQueue = input.force === true || delivery.status === "pending" || delivery.status === "failed";`
  → `force` 只决定**要不要发队列消息**，**从不重置已有行**（不新建 `delivery_id`、不升 `report_version`）。
- `src/services/report-delivery-worker.service.ts:75`：`if (delivery.status === "delivered") return;`
- `src/db/repositories/report-delivery.repository.ts:110`：`claimReportDelivery` 只接受 `status IN ('pending','failed')`。
- 全仓库没有任何 UPDATE 把 `delivered` 改回 `pending`（只有 claim / complete / fail 与两处 cron UPDATE，
  其中 `report-delivery.service.ts:122` 只处理 `delivering`）。
- 传 `force: true` 的调用点：`src/http/admin/reports.ts:30`（报告中心「重试」）、
  `src/http/admin/surveys.ts:58`（批量导出）、`:229`（重新生成报告）、`:278`（导出到私人频道）。
- 后果：答卷 #N 提交后已 `delivered`，管理员点「重试/重发/重新生成报告」→ API 返回 `ok: true`
  （批量导出还会返回 `queued: 100`）→ 队列消息被 worker 直接 return → **频道里什么都不会出现**。
  用户和操作员都以为成功。

修复：`force` 时在同一操作里重置行，例如
`UPDATE report_deliveries SET status='pending', attempts=0, next_retry_at=NULL, last_error=NULL WHERE id=?`
（或按 `report_version + 1` 建新行）；补一个 `force + delivered` 的单测——
现有测试只覆盖 `force + failed`（`tests/unit/services/report-delivery.service.test.ts:66`）。

### P0-3 迁移 0048 在全新数据库上必然失败 → 新客户部署卡在 0047

- `db/migrations/0045_trial_tasks.sql:10-11` 已在 `CREATE TABLE task_packs` 里声明 `prep_items` / `prep_text`；
- `db/migrations/0048_trial_pack_prep_columns.sql:3-4` 又对同两列执行 `ALTER TABLE ... ADD COLUMN`。

实测复现（本次审计亲自跑过）：

```
$ sqlite3 fresh.db < db/migrations/0045_trial_tasks.sql   # 0045 OK
$ sqlite3 fresh.db < db/migrations/0048_trial_pack_prep_columns.sql
Parse error near line 3: duplicate column name: prep_items
Parse error near line 4: duplicate column name: prep_text   # exit 1
```

- 生产库不受影响（0048 早已应用），但 `scripts/deploy-customer.mjs:645,747` 会
  `wrangler d1 migrations apply DB --remote` 到一个**全新客户 D1**，`pnpm migrate:local` 同理。
  → 迁移链在 0047 中断，**0049–0054 全部不会执行**：没有 `task_items`/`task_runs`、没有 `email_accounts`、
  也没有 0051/0052 那批关键性能索引。

修复：删掉 0048 里那两条 `ALTER TABLE`，只保留回填 `UPDATE`（列已由 0045 建好）。

### P0-4 管理员密码 fallback 是硬编码哈希，且未配置时 fail-open

- `src/services/admin-password.service.ts:5`：`DEFAULT_ADMIN_PASSWORD_HASH = "pbkdf2$100000$81UZ..."`（已随公开仓库
  `github.com/emoeem/telegram-multimedia-survey-bot` 提交）。
- `src/http/admin/index.ts:65`：`const valid = await verifyAdminPassword(password, configuredHash ?? DEFAULT_ADMIN_PASSWORD_HASH);`
- 没有任何迁移或脚本写入 `admin_password_hash`；唯一的写入方是**已登录**后的系统设置页（`src/http/admin/write.ts:95-97`）。
  → 没有配过密码的部署，永远接受这把“厂商内置钥匙”；操作员也无从得知初始密码。
  （本次用 cracklib 词表 + 常见变形约 23 万候选做字典攻击未命中，说明明文不是常见弱口令，但哈希公开
  意味着可离线爆破，且 fail-open 的设计本身不可接受。）

修复：未配置时 fail-closed（返回 503 + 引导），并提供 `scripts/set-admin-password.mjs`
用 `wrangler d1 execute` 写入初始哈希；永远不要内置可用凭据。

### P0-5 问卷访问密码不保护内容，且可无限流暴力破解

- `src/http/survey/handler.ts:102-110`：`GET /api/survey/:id` 在**校验密码之前**直接返回
  `loadSurveyDefinition(...)`；`src/http/survey/definition.ts:103-120` 里带上了全部 `questions`（题干/选项/媒体 id）。
  客户端（`admin/src/survey/SurveyApp.tsx:1099-1108`）是先拿到完整定义、再显示密码框的——**门禁只在前端**。
  → `curl https://<host>/api/survey/<id>` 即可拿到受保护问卷的全部题目与选项。
- `src/http/survey/handler.ts:112-123` 的 `POST /access` **没有任何限流**（限流只加在 `/responses`、`/media`、`/answers`），
  是一个干净的 200/403 预言机；密码最短长度仅 4（`src/bot/builder-handler.ts:936`：`length < 4`）。

修复：未验证密码时只返回元数据（`questions: []`、不下发媒体 URL）；`POST /access` 通过后签发短时
access-grant token 并在 `loadSurveyDefinition` 内校验；给 `/access` 加按 IP + 按问卷的失败锁定；最短长度提到 ≥ 8。

---

## P1 · 高

### P1-1 render_jobs 回收无租约 → 报告可能重复发给用户

`src/services/result-visual-job-recovery.service.ts:10` `staleProcessingMs = 2 * 60_000`，`:21-37` 把
`processing` 超 2 分钟的行改回 `queued` 并 `:60` 重新入队；**没有 owner/heartbeat**，无法区分“worker 死了”和“还在渲染”。
而单次渲染很容易超过 2 分钟：最多 20 页 × 每页最多 3 次尝试（`src/services/report/size-policy.ts:34`、
`src/services/html-report-renderer.service.ts:683`），加上顺序下载 Telegram 图片（每张 20s 超时）。
`claimRenderJob` 只认 `status='queued'`（`src/db/repositories/result-visual.repository.ts:99-110`），
`completeRenderJob` 无状态守卫（`:112-121`）→ 第二个消费者可以并行渲染，两份都发给用户。

修复：加 `lease_owner` + `heartbeat_at`（渲染每页续约），回收阈值设到最坏渲染时长之上
（report_deliveries 那条更便宜的链路用的是 10 分钟，见 `src/services/report-delivery.service.ts:128`）；
或回收时不改状态、只按同一 jobId 补发消息，让 `claimRenderJob` 负责串行化。

### P1-2 image_generator_jobs 无租约 → 永久卡死、无重试无通知无清理

`src/services/image-generator-worker.service.ts:208-213` 的认领要求 `status='queued'`，认领失败时
**正常 return**（不抛错）→ `src/services/export-worker.service.ts:178-181` 立刻 `message.ack()`。
于是：worker 在渲染中途被 CPU/内存/驱逐杀掉 → 行停在 `processing` → 队列重投 → 认领失败 → ack →
**该任务永远不会再被处理**；用户收不到图；`runDatabaseMaintenance` 只删 `completed|failed`
（`src/services/database-maintenance.service.ts:380-389`），行永久残留。
（`recoverStale*` 只对 `render_jobs` 存在，`image_generator_jobs` 没有对应回收。）

修复：照抄 render_jobs 的回收（cron 把超时的 `processing` 重置为 `queued` 并重新入队，或到次数上限标 terminal + 通知）。

### P1-3 媒体保留(25/天) 追不上清理(500/天) → 已完成答卷的图永久丢失

- 保留批大小 `src/services/media/temporary-media.service.ts:177` `MEDIA_RETENTION_SWEEP_BATCH_SIZE = 25`；
- 清理 `:233` `LIMIT 500`，且**不区分答卷状态**；
- 二者都在每日 cron 里跑，保留在前、清理在后（`src/index.ts:526-543`），比例 1:20。
- `KVMediaStore.put` **没有 `expirationTtl`**（`src/services/media/temporary-media-store.ts:25-27`）。

后果：提交时转存失败（或转存上线前的历史行）超过 25 条/天时，7 天后清理会删掉 blob 并把
`storage_key` 置 NULL，后续 sweep 只能记为 `discarded`；报告与后台预览**静默丢图且不可恢复**。
同时漏掉的 KV blob 因为没设 TTL 会永久占用存储。

修复：清理查询排除 `completed/archived` 答卷中尚未转存的媒体（或让保留先无条件排空）；
`KVMediaStore.put` 带上 `{ expirationTtl: TEMP_MEDIA_TTL_SECONDS }` 作为兜底。

### P1-4 每答卷媒体上限可绕过

`src/http/survey/media.ts:195-199` 用 `countTemporaryMediaBytesForResponse` 做上限判断，而
`src/db/repositories/media.repository.ts:457-471` 的求和要求 `JOIN answer_media`——
**上传但还没保存成答案的 blob 计 0**，`media_assets` 也没有 `response_id` 列。
→ 循环 `POST /api/survey/:id/media` 且不保存答案，`maxResponseMediaMb`(默认 50MB) 永远不触发；
只有 20 次/分钟/IP 的上传限流，约 200MB/分钟/IP，约 1000 次请求即可打满免费版单日 KV 写额度
（与 2026-09-14 事故同类）。

修复：按 `storage_key LIKE 'media:temp:' || ? || ':%' AND expires_at IS NOT NULL` 求和（或给
`media_assets` 加 `response_id` + 索引），并在 `store.put` 之前计入本次待写入字节。

### P1-5 `GET /api/surveys?q=` 不缓存、不限流，且带每行相关子查询

- `src/http/survey/handler.ts:42-58`：只有 `!q` 才走 KV 缓存；搜索分支直接查库，且**全程没有限流**
  （`src/index.ts:291-309` 的分发里也没有全局限流）。
- `src/http/survey/catalog.ts:74-86`：`(SELECT COUNT(*) FROM survey_questions q WHERE q.survey_id = s.id) questionCount`
  是每返回行一次子查询，`LIMIT 200`；文件自己的注释（`catalog.ts:10-13`）就写了这大约 15000 行读/次，
  而免费额度是 5,000,000 行/天。
- 匿名 `?q=<随机>` 循环约 330 次即可打满当天 D1 行读额度，整个产品停摆到次日 UTC。
  `q` 长度也没有上限。

修复：搜索分支加按 IP 限流、`q` 截断到约 64 字符、缓存到同一 list stamp 下。

### P1-6 周报 digest 两次全表扫描 survey_responses

`src/services/weekly-digest.service.ts:20-28` 与 `:30-41` 都按 `started_at` 过滤，而
`survey_responses` 上没有任何含 `started_at` 的索引（`EXPLAIN` → `SCAN survey_responses`）。
每周两次扫全表，随答卷无限增长。

修复：`CREATE INDEX idx_responses_started_at ON survey_responses(started_at);`
以及 `CREATE INDEX idx_responses_status_started ON survey_responses(status, started_at);`

### P1-7 每日维护仍在做几处全表扫描

- `src/services/database-maintenance.service.ts:341-343` `DELETE ... WHERE status IN (...) AND updated_at < ?`
  → `SCAN survey_responses`（最大表，且每删一行还会级联 answers/answer_media/report_deliveries）。
  修复：`CREATE INDEX idx_responses_status_updated ON survey_responses(status, updated_at);`
- `:350` `DELETE FROM audit_logs WHERE created_at < ?` → `SCAN audit_logs`。
  修复：`CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at);`
- `:372-397` 三处 `COALESCE(completed_at, created_at) < ?` 让索引失去 range 条件。
  修复：表达式索引 `(status, COALESCE(completed_at, created_at))` 或拆成两个谓词。
- `:212-216` `loadAnswerJsonMediaIds` 是无 `LIMIT` 的 `SELECT json_value FROM answers ... LIKE`
  → 单条语句就能扫穿最大表；`MAINTENANCE_ROWS_READ_BUDGET`(500k) 只在**步骤之间**检查
  （`:473-476`），拦不住一条正在执行的语句。这正是 2026-09-14 那类事故的残余入口。
  修复：按 `id > ?` 游标分页扫描，或把 `mediaAssetId` 落到可索引的列。

---

## P2 · 中

| # | 问题 | 证据 / 修复 |
|---|---|---|
| P2-1 | 限流器是 KV 非原子 read-modify-write，并发可绕过 | `src/services/rate-limit.service.ts:29-38` `get` 与 `put` 之间无 CAS；N 个并发请求读到同一个计数全部放行。作用于 admin 密码登录（5 次/300s，`src/http/admin/index.ts:60`）与邮箱认证。修复：改 D1 原子计数（`ON CONFLICT ... count=count+1 RETURNING`）或 DO |
| P2-2 | 报告模板 CSS 可注入脚本 + 预览 iframe 无 sandbox | `src/services/report/web.ts:384` 原样插入 `${template.css}`；`admin/src/routes/TemplatesPage.tsx:584` `<iframe srcDoc={previewHtml}>` 无 `sandbox`（srcdoc 继承父源）。模板作者可执行同源脚本，`/report/:id?template=<id>` 的查看者同样受影响。修复：`<iframe sandbox="">`、拒绝/转义 `</style`、报告响应加 CSP |
| P2-3 | 一批热点查询缺索引 | 排行榜相关子查询 O(N²)（`src/db/repositories/task-run.repository.ts:178-195` → `idx_task_runs_user_pack_mode`）；`answer_media.answer_id` 无索引导致每次图片答案保存全表扫（`idx_answer_media_answer_id`）；`survey_responses(participant_hash)` 单独无索引（`idx_responses_participant_hash`）；维护里 4 处 `NOT EXISTS` 打在无索引外键上；后台用户搜索对全表做函数 + 前导通配 LIKE |
| P2-4 | `/submit` 非幂等 | `src/http/survey/handler.ts:308-315` 是先 SELECT 判断，`src/db/repositories/response.repository.ts:274-284` 的 UPDATE 无 `AND status='in_progress'` 且不检查返回值。两个并发提交都会继续跑 `publishProfileResponse`/`promoteResponseMediaToDurable`/`enqueueReportDelivery`：`gallery_profile_media` 无 `(response_id, source_asset_id)` 唯一约束 → 画廊里每张图重复；转存生成两个 durable key，其中一个成为无主 blob。修复：把状态判断合并进 UPDATE 并检查 `meta.changes`，补唯一索引 |
| P2-5 | 公开广场「个人画廊」N+1 | `src/services/profile-gallery.service.ts:424-429` 串行 `await responseToProfileItem`（每个 2 条查询），单页最多 30 条 = 约 60 次串行 D1 往返、约 2000-2500 行读/次，且该接口无需鉴权、无缓存、无限流。修复：按页 id 批量 `IN (...)` 后内存组装（`media.repository.ts:284-312` 已有现成模式） |
| P2-6 | 数字统计子查询漏了 survey_id | `src/services/statistics.service.ts:267` `SELECT id FROM survey_responses WHERE status='completed'` 未按问卷过滤，外层虽按 `q.survey_id` 限定，子查询仍会materialize 全库已完成答卷。修复：子查询补 `AND survey_id = ?` 或改 `EXISTS(... r.survey_id = q.survey_id)` |
| P2-7 | 导出任务会永久卡 `running`，瞬时失败不重试 | `src/services/export-worker.service.ts:116-119` 认领后无租约，进程中断则重投时 `status !== 'pending'` 直接 return 并 ack；`:127-139` 任何错误都直接标 failed 不入队重试。修复：`status='pending' OR (status='running' AND created_at < cutoff)`，瞬时错误走 `message.retry()` |
| P2-8 | 会话无法撤销 | admin 会话是 7 天无状态 HMAC、**没有 logout**，改密码不使已签发 token 失效（`src/services/admin-session.service.ts:10,109-115`）；邮箱会话 30 天、`hashSessionToken` 定义了但从未被调用（`src/services/email-auth.service.ts:9,172-174`），重置密码后旧 token 仍有效。修复：把 `jti`/会话哈希落库并在校验时比对，改密时轮换；补 `POST /api/admin/auth/logout` |
| P2-9 | 报告标题超长 → Telegram caption 1024 超限 → 被误判为可重试 | `src/services/report-delivery-worker.service.ts:163-175` 原样插入 `survey.title`；`:64-69` 的白名单不包含 `caption is too long`，于是 5 次尝试全废、报告进不了归档频道。bot 建卷路径标题无长度上限（`src/bot/builder-handler.ts:968-969`）。修复：入口处截断标题、caption 截到 1024、把该错误加入不可重试 |
| P2-10 | Puppeteer 页面从不关闭 | `src/services/html-report-renderer.service.ts:663,689,809` 只有 `browser.close()`，没有 `page.close()`；20 页 × 最多 3 次尝试 = 60+ 个存活页面，`newPage()` 可能开始失败导致整个渲染抛错。修复：每页 `try/finally { await page.close(); }` |
| P2-11 | 结果报告单页失败被吞掉后仍标 `completed` | `src/services/result-visual-worker.service.ts:74-85` 收集 `pageFailures`，`:116-130` 只 warn，`:178-181` 照常 `completeRenderJob`；第 3 页的 429/5xx 会让那一页永久缺失且队列不再重试。修复：`pageFailures.length > 0` 时抛错走队列重试，或记录已送达页做续传 |
| P2-12 | 编辑器撤销被 `defaultValue` 覆盖 | `admin/src/components/editor/QuestionCard.tsx:297-310,315-328,534-545` 用 `defaultValue` + `onBlur` 提交；Ctrl+Z 后 DOM 输入框仍是新文本（key 未变、`defaultValue` 不更新活动输入），失焦又把旧文本写回，静默抵消撤销。修复：改成受控输入，或把值并入 key |
| P2-13 | PDF 下载过早 `revokeObjectURL` | `admin/src/routes/ResponseDetailPage.tsx:189-195` `anchor.click()` 后立刻 revoke，且 anchor 未入 DOM；Firefox/Safari 上静默失败或得到 0 字节文件。修复：延迟 revoke 并 append/remove anchor |
| P2-14 | Dashboard 卡片链接的 `?status=` 被忽略 | `admin/src/routes/DashboardPage.tsx:120` 生成 `/reports?status=...`，而 `admin/src/routes/ReportsPage.tsx:37-41` 从不读 `useSearchParams` → 点「失败 N」打开的是未过滤列表。修复：用 query 初始化状态 |
| P2-15 | 后台用户搜索每敲一键发一次请求 | `admin/src/routes/UsersPage.tsx:136-144` 立即 setState，每次响应还把列表重置为骨架；`SurveysPage.tsx:30-33` 已有 300ms 防抖模式可复用 |
| P2-16 | 管理端可能白屏 2.5 秒 | `admin/src/main.tsx:11-16` 先 `await waitForTelegramWebApp()` 再 render，而该函数会注入 `telegram.org` 脚本并轮询至 2500ms（`admin/src/telegram.ts:28-41`）；密码登录根本不需要这个 bridge，且第三方脚本无 SRI。修复：先 render，再 `void waitForTelegramWebApp()` |
| P2-17 | 排行榜请求竞态 | `admin/src/survey/TrialScreen.tsx:456-467,481-491` 切换任务包/模式时不取消在途请求，后到的旧响应会覆盖新标签页内容。修复：请求序号或 AbortController |
| P2-18 | `window.open` 在 `await` 之后被拦截且不检查返回值 | `admin/src/routes/ResponsesPage.tsx:93-100`、`ResponseDetailPage.tsx:171-173,208-217`；Firefox/iOS Safari 上点击无任何反应。修复：点击时同步开窗口句柄，再赋 `location.href` |
| P2-19 | 服务端仍把系统设置里的 TTL/上传/PDF 限制当摆设 | 项目自己已记录（`docs/HANDOVER.md` 第 6 条）：运行时限流仍用代码常量 `temporary-media.service.ts`。建议把 `mediaTtlSeconds`/`maxUploadMb`/`maxResponseMediaMb` 真正接入上传与清理路径 |
| P2-20 | Bot token 曾泄露且未轮换 | 项目自己已记录（`docs/HANDOVER.md` 第 8 条）。建议在 BotFather 轮换并更新 Secrets——这属于必须处理的凭据卫生问题 |

---

## P3 · 低 / 健壮性

- `src/db/errors.ts:14` 用 `/D1_ERROR/i` 判定配额耗尽：任何 UNIQUE/NOT NULL/CHECK/FK 违反都会被当成
  「数据库今日查询额度已用尽」展示给用户，并影响重试分支。建议只匹配真实配额码（`exceeded D1`、
  `daily row read limit`、`code: 7500`）。
- `src/db/repositories/user.repository.ts:131-152` `upsertUser` 是 SELECT-then-INSERT，并发首次接触同一
  telegram id 时第二个 INSERT 会撞 UNIQUE 报 500。建议改 `INSERT ... ON CONFLICT(telegram_user_id) DO UPDATE`。
- `src/services/email-auth.service.ts:104` 邮箱验证码摘要用 `!==` 比较（非常量时间）；空间只有 10^6，
  但仍建议与 `verifyPassword` 保持一致。
- `src/http/email-auth-api.ts:51-55` 邮箱认证限流键是 `ip:email`，轮换 email 即可重置预算 → 无上限发信。
  建议补一个只按 IP 的限流；`:91` 的 `409 email_taken` 与 `:68` 的防枚举注释自相矛盾。
- `admin/src/survey/deviceInfo.ts:88-90` 会把当前 URL/query 记入 `browserInfo`，而问卷 URL 带 `?pt=<签名 token>`
  （`admin/src/survey/api.ts:132-136`），该 token 随后在答卷详情页作为「当前 URL」渲染出来。建议上报前剔除
  `pt`/`t`/`token`。
- `admin/src/survey/deviceInfo.ts:44-60,94-99` 每个问卷请求都重建浏览器信息并新建 WebGL 上下文
  （浏览器上限约 16 个，最旧的会被丢弃，导致记录到的 `webgl` 静默变 null）。建议模块级 memo。
- `admin/src/survey/SurveyApp.tsx:541` 向 `theme.audio.url`（管理员可填任意外链）发送 `identityHeaders()`
  请求，若对方 CORS 宽松，受访者的 `x-telegram-init-data`/`x-email-session` 会外泄。建议只对同源 URL 附带身份头。
- `admin/src/routes/SurveyDetailPage.tsx:67-86` 的 `[data]` 依赖 effect 会在任意 `retry()` 后把用户正在编辑的
  自定义主题 JSON/BGM/完成文案覆盖掉，无提示。建议仅在 survey id 变化时初始化，或加 dirty 守卫。
- `admin/src/components/editor/StructureTree.tsx:102` 折叠页面的行是可点击 `div`，无 `role`/`tabIndex`/键盘处理。
- `admin/src/charts.ts:5-20` `useMemo(..., [])` 只读一次 CSS 变量，OS 主题切换后（`admin/src/theme.ts:60-63`）
  已挂载的图表配色不更新。
- 数字输入框清空会跳成 0：`admin/src/survey/SurveyApp.tsx:854-857`、`admin/src/routes/TaskPacksPage.tsx:353,364`、
  `admin/src/components/editor/ResultRulesPanel.tsx:109`（`Number("") → 0`）。
- `src/db/repositories/task-run.repository.ts:202` 无昵称时用 `玩家 ${hash.slice(-4)}`，而 `participant_hash`
  形如 `user_<dbUserId>`，等于公开泄露内部用户 id 尾号。
- `src/db/repositories/task-pack.repository.ts:277-278` 保存任务包时 `DELETE` + 重新 INSERT，会换掉
  `task_items.id`，而 `task_runs.state_json` 存的是 `currentTaskId`/`usedTaskIds`
  （`src/trial/engine.ts:48,52`、`src/http/trial-api.ts:217-218`）→ 管理员一保存，进行中的局会拿到 `task: null`
  或对着已不存在的 id 提交。建议按 id upsert，或存在进行中的 run 时拒绝替换。
- `src/http/plaza-api.ts:27-32` `offset` 未做 `Number.isFinite` 校验，`?offset=Infinity` 会直接进
  `LIMIT ? OFFSET ?`。建议 `Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0` 并设上限。
- `src/http/report-api.ts:24-26` 本地 `fail` 缺少 `api-response.ts` 约定的 `Cache-Control: no-store`。
- `src/http/survey/media.ts:43-46` 任何 `scope="survey"` 的临时资产都跳过归属校验（草稿封面/BGM 也是这么建的），
  且 id 自增可枚举。建议只对已发布或本人拥有的问卷放行。
- `src/http/survey/handler.ts:343` 把内部 `error.message`（例如「…当前环境未配置」）直接回给客户端。
- `src/services/export.repository.ts:89-105` 仅更新状态时会把 `r2_key`/`error_message` 置 NULL。
- `src/db/schema.ts:176-185` 声明了 `card_template`/`gallery_profile` 两个 scope，但 `media_assets` 的 CHECK
  （`db/migrations/0018_identity_card_scope.sql:5`）不允许，而本该放开它的
  `db/migrations/0042_allow_gallery_profile_media_scope.sql` 内容就是一句 `SELECT 1;`（空迁移）。
  目前所有写入方都传合法值所以只是潜在问题，但 `src/http/report-api.ts:173` 的 `asset.scope === "gallery_profile"`
  分支永远不可能命中。
- 缺外键：`db/migrations/0037_plaza_posts.sql:5`（`user_id`）、`0018_identity_card_scope.sql:30`、
  `0023_identity_card_jobs.sql:5`，删除用户会留下无主行（当前无删用户入口，属潜在问题）。
- `src/db/repositories/image-generator.repository.ts:180-198` `MAX(sort_order)+1` 后 INSERT，并发编辑会产生重复
  `sort_order`（仅排序，无数据损坏）。
- `src/durable-objects/ui-session.ts:43-46`、`survey-session.ts:179-180` 的 `storage.put` 与 `setAlarm` 不是原子操作，
  中途驱逐会留下永远不被回收的 DO 状态。

---

## 优化机会（非缺陷）

1. **echarts 全量打包 1.13 MB（gzip 376 KB）**。`admin/src/components/EChart.tsx:15` 动态 import
   `echarts-for-react`，但拉进的是 echarts 完整构建（构建产物里 `esm-*.js` 1,133.79 kB）。
   改用 `echarts/core` + 按需 `use([...])` 注册实际用到的图表/组件，通常可减 70-80%。
   对后台可接受，但这块目前也走 `/admin` 首屏附近的网络。
2. **图表相关**：`admin/src/charts.ts` 的配色读取与主题系统脱节（见 P3）。
3. **`export_jobs`/`render_jobs`/`image_generator_jobs` 的清理策略不统一**（有的有回收有清理，有的只有清理），
   建议抽一个统一的「任务租约 + 回收 + 保留期」小服务，避免每类任务各写一遍再各漏一处。
4. **一次 cron 可能串行 1200+ 个子请求**（维护约 130 条语句 + 最多 100 次 orphan DELETE + 两次全表 JSON 扫描，
   再加保留 25×4 与清理 500×2，`src/index.ts:517-543`），中途触顶会连带干掉当天的试用提醒。
   建议按有界并发分块，并降低单次上限。
5. **媒体键空间语义**：转存后 `storage_kind` 仍是 `'temporary'`，只靠 `expires_at IS NULL` 区分
   （`markMediaAssetDurable`，`src/db/repositories/media.repository.ts:436-450`）。虽然当前查询都成对使用这两个条件，
   但语义已经名不副实，建议补一个 `'durable'` 值或 `retained` 布尔列，降低后续误用风险。
6. **`system_settings` 里的运行时限流参数仍未生效**——见 P2-19，是最容易兑现的「配置即生效」优化。

---

## 复核过的、确认无问题的部分

- 常量时间比较与会话签名：`src/core/security.ts:1-37`、`src/services/admin-password.service.ts:34-39`、
  `src/services/license-api.ts:20-31`、`src/services/report-access-token.service.ts:37-42`；
  HMAC 校验一律走 WebCrypto `verify`。
- 开发后门正确失效：`src/http/admin/index.ts:134-138` 要求 `ENVIRONMENT === "development"` **且**配置了
  `ADMIN_DEV_AUTH_SECRET`；三个部署配置都是 production/staging。
- CSRF/开放重定向：Cookie 为 `HttpOnly; SameSite=Lax`（https 下带 Secure），无状态变更型 GET，重定向目标全部为固定值。
- SQL 注入：未发现任何把用户输入拼进 SQL 的地方，动态片段只有 `?` 占位符列表或常量。
- 幂等与 CAS 写得对的部分：telegram update 去重（单条 `INSERT ... ON CONFLICT ... WHERE`）、
  `report_deliveries` 认领、`render_jobs` 认领、`answers` 的 `ON CONFLICT(response_id, question_id)`、
  部分唯一索引 `idx_responses_active_participant` / `idx_render_jobs_active`；全仓库没有 `INSERT OR REPLACE`。
- 队列 ack/retry 语义正确（每个分支处理完才 ack，`max_batch_size = 1` 使顺序循环安全）。
- DO 的读-改-写都在存储操作之间同步完成，无需 `blockConcurrencyWhile`；alarm 幂等。
- 公共 API 的错误不会泄露堆栈（`guardApiResponse` + `describePublicDatabaseError`），没有 CORS 头，
  `limit` 已夹紧，状态码使用合理。
- 管理端 XSS 面很窄：`admin/src` 无 `dangerouslySetInnerHTML`/`innerHTML`/`eval`；
  `completion.redirectUrl` 的 `javascript:` 已被 `src/survey/theme.ts:210-213` 过滤掉。
- 前端 `useApi` 会取消过期请求，ECharts 实例与 object URL 都被正确释放，`sw.js` 已不缓存 `/api/`。
- `report-images.service.ts` 的老 N+1 确实已修（批量取资产、12MB 上限、并发 4）。

---

## 建议的修复顺序

1. P0-3（迁移 0048）—— 一行删除，直接决定新客户能不能部署。
2. P0-2（force 重发）与 P1-1/P1-2（任务租约）—— 管理者与用户直接感知的功能正确性。
3. P0-1（上传 XSS）+ P0-5（问卷密码）—— 安全边界。
4. P0-4（默认密码 fallback）—— 改成 fail-closed，很小的工作量换掉一个高风险默认值。
5. P1-3/P1-4/P1-5 + P1-6/P1-7 —— 数据保全与 D1 额度，都是历史上出过事的方向。
6. P2 批次按模块合并提交，每项补一个单测（本仓库测试基建很完善，成本低）。

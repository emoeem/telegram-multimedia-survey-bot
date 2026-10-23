# 报告归档管线（Phase 4-6）

> 状态：**已实现并已部署（2026-09-18）**。Web-first Phase 4 / 5 / 6 已进入生产运行。

## 数据流

```text
用户提交（/api/survey/:id/responses/:rid/submit）
  ├── 答案落 D1（永久）
  ├── 返回 reportUrl（30 天签名链接，HMAC(secret, responseId, expiresAt)）
  └── enqueue report_delivery（EXPORT_QUEUE，幂等键 response_{id}_v{version}）
        ↓
ReportDeliveryWorker
  ├── claim（原子，防重复消费）
  ├── ResultProfile → ReportViewModel（复用 result-engine + html-report-renderer）
  ├── 解析图片（temporary KV / Telegram / R2 / URL → data URL，缺失跳过）
  ├── renderReportPdf（响应式模板 + @media print，图片压缩至 1200px，目标 ≤15MB）
  ├── sendDocument(PDF, caption=新答卷摘要) → 私人频道
  ├── sendPhoto 用户附件（≤6 张，失败降级 sendDocument）
  ├── completeReportDelivery（chat_id + pdf message_id + image message_ids）
  └── 长效保留：提交答卷时 `promoteResponseMediaToDurable` 已把附件从 `media:temp:*`
      转存到 `media:report:*`（asset id 不变、`expires_at` 置空），预览与归档都能继续读
```

cron（`*/30 * * * *`）里，`retainFinishedResponseMedia` 会先于
`cleanupExpiredTemporaryMedia` 跑一批（默认 25 条，按 `expires_at` 升序、走
`idx_media_assets_temp_expiry`）：历史上在“保留”上线前提交、或提交时转存失败的
已完成答卷，其附件也会被搬到长效键，抢在过期清理删除 blob 之前救回来。

## 重试与幂等

- `report_deliveries.delivery_id` UNIQUE：同一答卷只归档一次；worker 已
  delivered 直接跳过
- 失败：`failReportDelivery(retryable, nextRetryAt)`，退避 1m/5m/15m/1h，
  最多 5 次；cron（`*/30 * * * *`）驱动到点重入队，超限转 failed 并通知管理员
- 配置错误（`REPORT_CHANNEL_ID` / `BROWSER` 缺失）直接 failed，不重试

## Web Report

- `GET /report/:id?t=<token>`：响应式单页（移动端优先，深色模式，图片懒加载，
  长文本/得分/雷达/回答明细），服务端渲染，无需额外前端包
- `GET /report/:id.pdf?t=<token>`：**参与者自助下载 PDF**（2026-10-15 新增）。
  优先复用归档队列写入 KV 的 `public-report-pdf:<id>`（7 天）——绝大多数下载零
  浏览器开销；缓存过期/缺失时按需 `renderReportPdf` 一次并写回同一个键（同一份
  报告 7 天内最多渲染一次）。无 `BROWSER` 绑定的部署形态或渲染失败时 302 回退到
  HTML 报告页。响应为 `Content-Disposition: attachment`。生产实测：KV 中已有 35
  份归档 PDF，即"提交后一段时间内下载"几乎全部命中缓存。
  每日限额：**每身份 3 次 + 每 IP 12 次**（后备闸门防轮换密钥绕过；两道闸门在同一次
  `db.batch` 计数，1 往返 2 行写）。超限返回 429 落地页（说明限额 + 在线查看入口）。
  额度只在令牌与归属校验之后消耗；D1 不可用回落 KV 限流器，KV 也失败则放行（限流器
  故障不该拦住用户下载自己的报告）。生产已验证 D1 原子限流端到端生效（探针并发打点，
  计数到 120 后返回 429）。
- **网页报告内的下载按钮**：由 `injectReportDownloadAction` 在 report-api 层注入，
  不进入 `buildResponsiveReportHtml` —— 同一个 builder 还产出 PDF、归档副本、
  模板预览与视觉回归快照，交互控件绝不能混入；打印样式里再隐藏一次作为保险。
- `GET /api/me/reports`：**「我的报告」列表**（2026-10-15 新增）。按服务端解析的
  参与者身份（`participantHash`）列出 `completed`/`archived` 答卷，为每条现铸
  30 天 token（HMAC 无状态，无存储成本）；被作者删除的问卷连同报告一并下架。
  「我的」页面 (`/me`) 与完成页据此提供持久入口——此前报告链接只在完成页出现
  一次，离开即遗失（用户反馈"填完之后无法查看自己的报告"）。
- **归档消息里的「用户：」按 Telegram 用户 ID 生成 mention**（`tg://user?id=`），
  不再拼 `https://t.me/<username>`：用户改名或放弃用户名后旧链接就是 404（运营实际
  观察到"点了完全找不到人"）；用户名仅作展示文本，改名不影响点击。
- `GET /api/report/media/:id?t=<token>&rid=<id>`：报告媒体代理（按答卷归属鉴权）
- PDF 与 Web Report 共用同一份 `ReportViewModel` 与同一套 HTML 模板
- 图片解析同源：Web 报告与 PDF/归档都从 `collectReportImageEntries`
  （命名图片 + `metadata.gallery`）出发；存量 asset 渲染成 `/api/report/media/:id` 链接，
  data URL / 编辑器图片 URL / 旧 Telegram file_id 由服务端解析，避免"PDF 有图、网页无图"

## 配置

- `REPORT_CHANNEL_ID`：管理员私人频道 ID（负数），Bot 需为频道管理员；
  已加入 `.dev.vars.example` 与两个 wrangler 配置（默认空）
- 临时媒体存储 `MEDIA_KV`（生产/ staging 已建）；R2 启用后可加回 `MEDIA`
  binding，`storage_kind='r2'` 分支自动生效

## 迁移

- `0027_temporary_media_and_report_delivery.sql`

## 验证

```bash
pnpm typecheck && pnpm test && pnpm lint
```

自助报告入口的回归测试在 `tests/unit/http/report-flow.integration.test.ts`（真实
SQLite + 全量 migration 建库，跑真实处理器）：完成答卷 + 提交时铸的 token 能打开
报告页；`/api/me/reports` 只列出本人答卷、返回的 token 可直接打开报告、他人 key 看
不到、无身份 401；PDF 走 KV 缓存返回 `application/pdf`；无缓存且无 BROWSER 时 302
回退 HTML；下载按钮只注入网页报告（含打印隐藏样式）。

> 相关结构重构（admin API 与 bot survey handler 拆分）见
> [`docs/MODULARIZATION.md`](./MODULARIZATION.md)。

Staging 手工验证：上传图片 → 提交 → 检查频道收到 PDF + 附件 → KV 中
`media:temp:*` 键消失 → 重复触发不重发 → 断网模拟失败后 cron 重试。

## Telegram 归档包 v2

完成答卷的私人频道归档现在统一生成结构化 ZIP（只要 ZIP 不超过发送上限，即使没有图片也会生成），而不是只把 PDF 和附件平铺在频道中。

包内目录：

- `00-index.json`：归档索引、问卷/答卷/用户信息及文件清单；
- `01-report/report.pdf`：最终报告；
- `01-report/result.json`：Participant Report 结果快照；
- `02-answers/answers.json`：答卷答案原始结构；
- `03-attachments/`：gallery / 用户附件；
- `04-profile/`：头像、肖像等个人资料图片；
- `05-result-assets/`：结果类型或其他报告图片。

文件名带序号与来源 key，便于在频道中下载后直接浏览和归档。ZIP 超过 Telegram 发送安全阈值时，系统仍回退为 PDF + 图片逐项发送。

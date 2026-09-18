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
  └── deleteTemporaryMediaForResponse（原始图片删除，D1 引用保留）
```

## 重试与幂等

- `report_deliveries.delivery_id` UNIQUE：同一答卷只归档一次；worker 已
  delivered 直接跳过
- 失败：`failReportDelivery(retryable, nextRetryAt)`，退避 1m/5m/15m/1h，
  最多 5 次；cron（`*/30 * * * *`）驱动到点重入队，超限转 failed 并通知管理员
- 配置错误（`REPORT_CHANNEL_ID` / `BROWSER` 缺失）直接 failed，不重试

## Web Report

- `GET /report/:id?t=<token>`：响应式单页（移动端优先，深色模式，图片懒加载，
  长文本/得分/雷达/回答明细），服务端渲染，无需额外前端包
- `GET /api/report/media/:id?t=<token>&rid=<id>`：报告媒体代理（按答卷归属鉴权）
- PDF 与 Web Report 共用同一份 `ReportViewModel` 与同一套 HTML 模板

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

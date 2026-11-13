# 可观测性基线 · 2026-11-14

> 版本：2026-11-14 · 范围：审计 [COMPREHENSIVE_OPTIMIZATION_AUDIT_2026-11-06.md](COMPREHENSIVE_OPTIMIZATION_AUDIT_2026-11-06.md) §3A 的可观测性部分，最小落地，**不引入任何新平台依赖**（仍是 `console.log/error/warn` 结构化行 + Cloudflare 原生日志）。
> 方法：先盘点 `src/observability/` 全部文件与全部使用点（`src/index.ts` → `src/http/router.ts` / `src/cron.ts` / `src/http/guard.ts`），以「运维能在 Cloudflare dashboard / 日志里回答的问题」为标准挑缺口；每条补齐带复现用例，已有覆盖的候选如实标「无缺口」并给出查询方式，不硬造工作。

---

## 0. 结论摘要

**已有基线**（此前已上线，本次盘点确认）：每个 fetch 请求一条 `request_metrics` 行、每个队列批一条 `queue_metrics` 行、单请求预算异常一条 `budget_anomaly` ERROR 行（`src/observability/metrics.ts`），绑定 D1/KV/Queue 的代理计数器在 `instrumentEnv` 装配（`metrics.ts:348-357`，使用点 `router.ts:106` 与 `index.ts:32`）。

**本次补齐 4 个缺口**（判定标准：运维提的问题，现有日志回答不了）：

| #   | 缺口                                     | 运维问题                            | 修复                                                                                                      |
| --- | ---------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1   | 公共 API 限流命中无维度归因              | 「今天的 429 是哪道限制挡的？」     | `rate_limit_hit` 结构化行（`src/http/guard.ts`）                                                          |
| 2   | 报告归档终态失败在 cron 侧静默           | 「报告归档今天死了几单？」          | `report_delivery_terminal` ERROR 行（`src/cron.ts` + `src/services/report-delivery.service.ts`）          |
| 3   | 报告归档 worker 失败行缺 `terminal` 字段 | 「这条失败还会重试吗？」            | 失败行补 `terminal` 字段，与其余五类队列 handler 对齐（`src/services/report-delivery-worker.service.ts`） |
| 4   | `botUpdates` 混入伪造 webhook 流量       | 「bot 今天处理了多少合法 update？」 | 记录点移到 secret 校验之后（`src/http/router.ts` + `src/observability/metrics.ts`）                       |

**判定为已有覆盖、本次不动的候选**：D1 预算告警触发、webhook 校验失败计数、队列重试/死信——查询方式见 §2，均有可检索的日志行，不为它们重复造指标。

---

## 1. 已有指标盘点（本次未改动部分）

### 1.1 请求级：`request_metrics`

- **触发点**：`withRequestMetrics`（`src/observability/metrics.ts:396-443`），fetch 入口唯一装配点 `src/http/router.ts:106`。静态资源成功请求跳过日志（`metrics.ts:417-419`），失败仍输出。
- **字段**：`requestId`、`route`（数字/UUID 段折叠为 `:id`/`:token`，`normalizeRoute`）、`method`、`status`、`durationMs`、`ok`、`d1Queries`、`d1RowsRead`、`d1RowsWritten`、`d1DurationMs`、`kvOps`、`kvHits`、`kvMisses`、`queueSends`、`queueMessages`、`botUpdates`、`duplicateUpdates`。
- **审计 3A 的对应关系**：p50/p95 用 `durationMs` 按天聚合；SQL 次数=`d1Queries`；rows_read/written 直接落行——即 3A 要求的「请求级 p50/p95、SQL 次数、rows_read、rows_written、KV hit/miss」全部已有，缺的只是下面 §3 的归因维度。

### 1.2 队列级：`queue_metrics`

- **触发点**：`withQueueMetrics`（`metrics.ts:463-502`），装配点 `src/index.ts:31-35`。
- **字段**：`queue`、`messages`、`durationMs`、`ok` + 同一套 D1/KV/queue 计数。导出/渲染这类重活烧 D1 预算的第二现场由此可见。

### 1.3 预算异常：`budget_anomaly`（ERROR 行）

- **触发点**：`findBudgetAnomaly` 阈值 `d1RowsRead>=50_000`、`d1RowsWritten>=5_000`、`kvOps>=5_000`（`metrics.ts:283-329`），请求侧 `metrics.ts:436-437`、队列侧 `metrics.ts:493-500` 各自输出 `console.error("budget_anomaly", JSON…)`。
- 注意 cron 维护任务不经过这两个 wrapper，但它有自己的预算护栏（见 §2.1）。

### 1.4 Telegram 侧计数

- `botUpdates` / `duplicateUpdates`：`MetricsCollector.recordBotUpdate` / `recordDuplicateUpdate`（`metrics.ts:85-92`），使用点在 `src/http/router.ts`（幂等跳过时 `router.ts:425`）。Telegram API 调用计数**有意不做**（`metrics.ts:14-20` 的注释：bot 从深层 handler 直接调全局 `fetch`，计数需要改每个调用点，不值）。

---

## 2. 判定为「已有覆盖」的候选（不重复造指标）

### 2.1 D1 预算告警触发 —— 无缺口

- 单请求/单批烧穿预算：`budget_anomaly` ERROR 行（§1.3），即「告警已触发」的可检索证据。
- 维护任务提前止读（`truncated`）：`src/cron.ts:98-100` 调 `notifyMaintenanceBudgetExhausted` 给管理员发 bot 告警（`src/http/guard.ts:15-24`），且 `maintenanceSummary`（含 `truncated`/`rowsRead`）整体落在 `console.info("Database maintenance complete", …)`（`cron.ts:114-118`）。查「今天预算告警触发过吗」→ 过滤 `Database maintenance complete` 行看 `truncated:true`，或直接过滤 `budget_anomaly`。

### 2.2 webhook 校验失败 —— 无缺口（本次只修指标失真，见 §3.4）

- 校验失败返回 403（`router.ts:382-384`），`withRequestMetrics` 对 `status>=400` 恒输出行 → 查 `route="/telegram/webhook" AND status=403` 即伪造流量计数；`status=400` 是解析失败。
- 修复前的一个失真：`withRequestMetrics` 曾按路由名无条件给 webhook 记 `botUpdates=1`，403 探测也被算成「bot 处理过的 update」。已修（§3.4）。

### 2.3 队列重试与死信 —— 无缺口（除 §3.2/§3.3 的报告归档部分）

- 六类队列消息（public report / report delivery / response report / image generator / result visual / survey export）的失败路径都在 `handleExportQueue` 的 `console.error` 行里带 `attempts` 和 `terminal` 字段（`src/services/export-worker.service.ts:268-275、330-331、348-364、372-377、416`）。查「昨天队列死了几个任务」→ 过滤 `"terminal": true`；查重试 → `"terminal": false`。
- Cloudflare Queues 层面没有配置 DLQ：终态全部由 handler 显式 `message.ack()` + 业务行打 `failed`，没有「静默丢弃」的暗道。

---

## 3. 本次补齐的缺口

### 3.1 `rate_limit_hit` —— 公共 API 限流命中的维度归因

**缺口**：`applyPublicApiRateLimit` 的邮件登录三道限制里，per-domain 命中只有一条中文纯文本 warn、**per-email 与 per-ip 命中完全没有日志**（原 `src/http/guard.ts:65-76`）。运维能从 `request_metrics` 看到 429 的条数，回答不了「是哪个维度挡的」——per-domain 突增意味着新的一次性邮箱域在批量注册，per-email/per-ip 突增是撞库/刷码，三种攻击形态的处置不同。

**修复**（`src/http/guard.ts:35-45`）：新增 `logRateLimitHit`，429 前输出结构化行：

```
rate_limit_hit {"type":"rate_limit_hit","surface":"email-auth","dimension":"per-email","scope":"login","path":"/api/auth/email/login"}
```

- `dimension` ∈ `per-email` / `per-ip` / `per-domain`；`scope` ∈ `register` / `login` / `reset`；per-domain 行额外带 `domain`（域名不是 PII）。
- 日志纪律：**不落邮箱/IP 原文**（与 `request_metrics`「不复制请求体」同一红线，单测有断言）。

**复现用例**：`tests/unit/http/guard-rate-limit-metrics.test.ts`

- KV 计数器已到上限（`get` 返回 `"5"`）→ `guardApiResponse` 返回 429，断言 `rate_limit_hit` 行的 `dimension`/`scope`，且全文不含邮箱与 IP。
- register 命中时 `per-domain` 与 `per-email` 两行都在（`example.com` 不在主流域名单，两道同烧）。

```bash
pnpm vitest run tests/unit/http/guard-rate-limit-metrics.test.ts
```

**查询方式**：Cloudflare 日志过滤 `rate_limit_hit`，按 `dimension` 分组计数；或 `wrangler tail --format json | jq 'select(.message[0]=="rate_limit_hit")'`。

### 3.2 `report_delivery_terminal` —— 报告归档终态失败计数（cron 侧）

**缺口**：报告归档的重试终态发生在 30 分钟一次的 cron（`retryPendingReportDeliveries`，`src/services/report-delivery.service.ts`），两条把行打成 `failed` 的 UPDATE **changes 数被直接丢弃**，cron 日志只有 `requeued`——「今天死了几单归档」无处可查，终态失败意味着那份答卷的归档重试已烧完 5 次（`REPORT_DELIVERY_MAX_ATTEMPTS`），管理端手动重投是唯一出路。

**修复**：

- `retryPendingReportDeliveries` 返回 `{ requeued, terminalFailed }`（`report-delivery.service.ts:144-214`）。原来的 stale-delivering 单条 `CASE` UPDATE 拆成两条（先超限打 `failed` 计数、其余回 `pending` 计数）——CASE 的一个 `meta.changes` 拆不开两种结局；每 30 分钟多一条小 UPDATE，代价可忽略。
- `src/cron.ts` 在 `terminalFailed > 0` 时输出 `console.error("report_delivery_terminal", {"type":"report_delivery_terminal","count":N})`。**零值不输出**：全零字段会让真实回归看起来像坏掉的仪表（`metrics.ts` 文件头注释同一条原则）。

**复现用例**：

- `tests/unit/services/report-delivery-retry.test.ts`：两条终态 UPDATE 的 changes（2+1）→ `terminalFailed=3`；正常重排队 → `{ requeued: 2, terminalFailed: 0 }`。
- `tests/unit/index-webhook.test.ts`：cron mock 返回 `terminalFailed: 2` → 断言 `report_delivery_terminal` ERROR 行 `count=2`；返回 0 时断言无该行。

```bash
pnpm vitest run tests/unit/services/report-delivery-retry.test.ts tests/unit/index-webhook.test.ts
```

**查询方式**：过滤 `report_delivery_terminal`，`count` 字段按天求和；也可按 ERROR 级别直接挂告警。

### 3.3 报告归档 worker 失败行补 `terminal` 字段

**缺口**：`processReportDeliveryMessage` 的失败行里 `retryable` 是**原始错误的可重试性**，不是终态判定——`attempts` 烧到 5 次时即使错误本身可重试也已进终态（`failReportDelivery` 的实参 `retryable: retryable && attempts < MAX`，`src/services/report-delivery-worker.service.ts:174-179`），看日志会把终态误读成「还会重试」。其余五类队列 handler 的失败行都有 `terminal` 字段，唯独这一类没有。

**修复**（`report-delivery-worker.service.ts:181-190`）：失败行补 `terminal: !retryable || attempts >= REPORT_DELIVERY_MAX_ATTEMPTS`，判定与落库参数完全一致。

**复现用例**：`tests/unit/services/report-delivery-worker.service.test.ts`

- 可重试失败（attempts=1）→ `{ attempts: 1, retryable: true, terminal: false }`；
- 终态失败（attempts=5，错误不可重试）→ `{ attempts: 5, retryable: false, terminal: true }`。

```bash
pnpm vitest run tests/unit/services/report-delivery-worker.service.test.ts
```

### 3.4 `botUpdates` 语义修正 —— 伪造 webhook 不再计入

**缺口**：`withRequestMetrics` 的 `finally` 里按路由名给 `/telegram/webhook` 无条件 `recordBotUpdate()`（原 `metrics.ts:415`），403（secret 错误）、400（JSON 解析失败）、license 503 全被算成「bot 处理过的 update」——`botUpdates` 无法回答「bot 今天处理了多少合法调用」，探测流量上涨时指标虚高。

**修复**：

- 删除 `metrics.ts` `finally` 中的自动记录（`metrics.ts:414-415` 现为解释性注释）；
- 记录点移到 `src/http/router.ts` 的 `isWebhookSecretValid` 通过之后（`router.ts:388-390`）：`botUpdates` = **通过 secret 校验的 Telegram 调用数**。403 的伪造流量本身仍由 `request_metrics` 的 `status=403` 行回答（§2.2），两条指标各司其职。

**复现用例**：

- `tests/unit/observability/metrics.test.ts`：显式 `recordBotUpdate()` → 行内 `botUpdates=1`；403 响应且未调用 → `botUpdates=0`（回归护栏：wrapper 不得再按路由名自动记录）。
- `tests/unit/index-webhook.test.ts`：合法 update 的 `request_metrics` 行 `botUpdates=1`；错误 secret 的行 `route=/telegram/webhook, status=403, botUpdates=0`。

```bash
pnpm vitest run tests/unit/observability tests/unit/index-webhook.test.ts
```

---

## 4. 运维速查（Cloudflare dashboard / `wrangler tail`）

| 运维问题                 | 过滤方式                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| 某接口今天慢不慢 / p95   | `request_metrics` 按 `route`+`durationMs` 聚合                                               |
| 谁把 D1 日报表烧了       | `budget_anomaly`（ERROR）看 `route` 与 `reasons`；`request_metrics` 按 `d1RowsRead` 排序     |
| 维护任务有没有提前止读   | `Database maintenance complete` 行的 `truncated:true` + bot 告警                             |
| 今天有多少限流、什么形态 | `rate_limit_hit` 按 `dimension`/`scope` 分组                                                 |
| 报告归档死了几单         | `report_delivery_terminal` 的 `count`；明细看 `Report delivery failed` 行（`terminal:true`） |
| 队列任务死了几个         | 六类 `console.error` 行的 `"terminal":true`                                                  |
| bot 处理量 / 重复投递量  | `request_metrics`（route=/telegram/webhook）的 `botUpdates` / `duplicateUpdates`             |
| 有没有人在伪造 webhook   | `request_metrics`：`route=/telegram/webhook AND status=403`                                  |
| KV 命中率                | `request_metrics` 的 `kvHits`/`kvMisses`                                                     |

---

## 5. 自验记录

```bash
pnpm vitest run tests/unit/observability tests/unit/services/report-delivery-retry.test.ts \
  tests/unit/services/report-delivery-worker.service.test.ts \
  tests/unit/http/guard-rate-limit-metrics.test.ts tests/unit/index-webhook.test.ts \
  tests/unit/router.test.ts
# → Test Files 6 passed (6) / Tests 55 passed (55)

pnpm vitest run tests/unit/router.test.ts tests/unit/security.test.ts tests/unit/services/report-delivery-retry.test.ts
# → Test Files 3 passed (3) / Tests 14 passed (14)

pnpm typecheck
# → 退出码 0（会话期间工作区有一批并行未提交改动曾报 5 个 TS 错误，均位于
#   非本任务的 DedupSim/router 测试 hunk；随后被并行会话修复，最终全绿。
#   本任务改动的文件自始至终无类型报错。）
```

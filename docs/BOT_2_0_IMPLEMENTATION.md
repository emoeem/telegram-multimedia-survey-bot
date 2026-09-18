# Telegram Bot 2.0 收尾实现（可观测性 / 幂等 / 批量查询 / 前端拆分）

> 状态：已完成并通过 `typecheck` / `lint` / `test` / `build:admin`。
> 结构重构（admin-api / survey-handler 拆分）见
> [MODULARIZATION.md](./MODULARIZATION.md)。

本文只记录**已经落地**的改动；未完成或明确推迟的内容见文末“未完成/推迟”。

## 1. 可观测性接入

`src/index.ts` 的 `fetch` 整体包在 `withRequestMetrics` 中，`queue` 整体包在
`withQueueMetrics` 中。每次请求/队列批次输出**恰好一行**结构化日志：

```
request_metrics {"type":"request_metrics","requestId":"…","route":"/api/admin/surveys/:id",
  "method":"GET","status":200,"durationMs":12,"ok":true,
  "d1Queries":3,"d1RowsRead":412,"d1RowsWritten":0,"d1DurationMs":…,
  "kvOps":1,"kvHits":1,"kvMisses":0,"queueSends":0,"queueMessages":0,
  "botUpdates":0,"duplicateUpdates":0}
queue_metrics   {"type":"queue_metrics","queue":"telegram-survey-export","messages":1,
  "durationMs":…,"ok":true,"d1Queries":…,"d1RowsRead":…,"d1RowsWritten":…,
  "kvOps":…,"queueSends":…,"queueMessages":…}
```

要点：

- **D1/KV/Queue 通过代理计数**：`instrumentEnv` 包装 `DB`/`CACHE`/`MEDIA_KV`/
  `EXPORT_QUEUE`，`bind()` 链与 `db.batch()` 都会累计行读写；包装失败时透传原
  binding，绝不让“统计失败”变成“请求失败”。
- **队列也计 D1 成本**：队列批次同样使用 instrumented env，导出/可视化任务读到
  的行数会出现在 `queue_metrics` 里（以前完全不可见）。
- **计数真实**：`queueSends`=API 调用次数，`queueMessages`=消息条数；
  `duplicateUpdates`=被幂等跳过的重复投递次数。没有保留“永远是 0”的假字段。
- **不记录密钥/答卷**：指标行只包含 route/method/status/耗时/计数。`normalizeRoute`
  把数字 id、UUID/长 hex 折叠为 `:id`/`:token`；测试断言请求体里的答案与密码
  不会出现在日志中。
- **静态资源降噪**：成功返回的静态资源（js/css/png/…）不再输出指标行，失败
  （4xx/5xx）仍然输出，避免每个 JS/CSS 文件都写一行日志。
- **Webhook 不泄露更新内容**：日志只记录 `updateId` 与 kind，不含消息文本/答案。

## 2. Telegram update_id 幂等

Webhook 在真正处理之前先 claim，成功 `complete`，失败 `release`：

```text
POST /telegram/webhook
  → verify secret → license → parse update
  → dedup.claim(update_id)   // 单条 INSERT … ON CONFLICT DO UPDATE … WHERE
      ├── 未抢到 → 200 {"ok":true,"duplicate":true}（不重复执行副作用）
      └── 抢到 → handleTelegramUpdate → dedup.complete()
                    └── 抛错 → dedup.release()，保留重试机会
```

- **迁移**：`0052_telegram_idempotency_and_query_indexes.sql` 建
  `telegram_update_dedup(update_id PRIMARY KEY, received_at)`；
  `0053_telegram_update_dedup_status.sql` 增加 `status`（`processing`/`done`）与
  索引，用于区分“进行中”和“已完成”。
- **并发重复投递**：claim 是单条 `INSERT … ON CONFLICT DO UPDATE … WHERE`，
  SQLite 串行化写入，只有第一个能 `changes=1`；第二个拿不到，直接跳过。
- **永不永久吞掉失败**：进程在 claim 之后被驱逐时，行停在 `processing`；
  超过 `STALE_CLAIM_MS`（5 分钟）的重复投递可以原子接管重跑。`done` 的行永远不会
  被接管或被 `release` 删除。
- **失败即释放**：`src/bot/router.ts` 之前会吞掉 handler 异常（于是失败也会被
  当成完成）。现在失败会以 `TelegramUpdateHandledError` 重新抛出，`index.ts`
  释放 claim 让 Telegram 重投；同时避免给用户重复发两条失败提示。
- **迁移缺失时降级**：`status` 列不存在时自动回退到 0052 的 claim；表整体不存在时
  fail-open 继续处理（宁可重复一次，也不丢用户操作）。
- 覆盖范围是整个 webhook（message / callback_query / channel_post），
  即所有会产生副作用的变更。

## 3. 媒体 N+1 批量查询

新增/使用批量仓储 API（`src/db/repositories/media.repository.ts`）：

- `getMediaAssetsByIds(db, ids)`：按 90 个 id 一批 `IN (…)`，返回 `Map<id, asset>`
- `getQuestionMediaByQuestionIds(db, ids)`
- `getAnswerMediaByAnswerIds(db, ids)`
- `listOptionMediaByOptionIds(db, ids)`（已有，接入更多调用方）

接入点：

- 答卷报告生成（`src/bot/survey-report.ts`，原 `survey-handler.ts` 的报告块）：
  原来每题/每选项/每答案各一次关系查询 + 每个素材一次 `SELECT`。现在固定为
  **3 次关系批量查询 + 1 次素材批量查询**，与题目/选项/素材数量无关。
- 问卷 builder 草稿恢复（`src/services/survey-builder.service.ts`）：原来每题一次
  `question_media`、每选项一次 `option_media`（2N+1），现在固定 2 次批量查询。
- 报告图片解析（`src/services/report/report-images.service.ts`）已使用
  `getMediaAssetsByIds`。

单条 `getMediaAssetById` 仍保留给“确实只查一个”的场景（封面、单张媒体代理等）。

## 4. 管理端前端代码拆分

- 路由级 `React.lazy`：`admin/src/App.tsx` 中每个页面都是动态 `import()`，
  `Suspense` 显示骨架屏。
- ECharts 动态加载：`admin/src/components/EChart.tsx` 用
  `lazy(() => import("echarts-for-react"))`，图表首次挂载时才拉取；管理端源码中
  没有任何 `echarts` 静态 import（有测试守卫）。
- 回归测试：`tests/unit/admin/lazy-routes.test.ts` 断言所有路由都走 `lazy(`、
  ECharts 只在动态 import 中出现。

构建产物（`npm run build:admin`，vite 8）：

| chunk | raw | gzip | 说明 |
| --- | --- | --- | --- |
| `main-*.js` | 110.96 kB | **36.41 kB** | 初始 JS（管理端） |
| `esm-*.js`（ECharts） | 1,133.79 kB | 376.49 kB | 懒加载，初始请求不包含 |
| `survey-*.js` | 145.39 kB | 42.64 kB | 问卷/试用/广场入口 |
| `pwa-*.js`（共享运行时/react-dom） | 194.01 kB | 61.89 kB | 两个入口共享 |

初始管理端加载为 `main + react + pwa`（≈313 kB raw / ≈101 kB gzip），
相比拆分前单包 ≈1.54 MB / 490 KB gzip 明显下降。

## 5. 测试

新增/加强：

- `tests/unit/services/update-dedup.service.test.ts`：并发重复、done 跳过、
  release 重试、崩溃后的过期接管、0052 回退、表缺失 fail-open。
- `tests/unit/index-webhook.test.ts`：真实 webhook 路径的 claim/complete/release、
  重复投递跳过、失败释放、错误 secret 拒绝。
- `tests/unit/bot/router-failure.test.ts`：handler 失败会抛
  `TelegramUpdateHandledError`（保证 claim 会被释放），且只提示用户一次。
- `tests/unit/observability/metrics.test.ts`：D1/KV/queue 计数、batch 计数、
  队列 D1 成本、静态资源降噪、请求体/答案/密钥不入日志。
- `tests/unit/repositories/media.repository.test.ts`：批量 `IN` 查询、去重、
  分片（>90）与空输入不查询。
- `tests/unit/admin/lazy-routes.test.ts`：前端拆分守卫。

## 6. 验证

```bash
npm run typecheck   # 通过
npm test            # 最终 97 个文件 / 548+ 个测试全部通过
npm run lint        # 通过
npm run build:admin # 通过（体积见上表）
```

## 未完成 / 推迟

- **Telegram API 调用次数**未计入指标：bot 代码直接调用全局 `fetch`，要在不修改
  每一处调用点的前提下按请求归因需要请求级作用域（如 AsyncLocalStorage），当前
  未接入；指标不再保留这个永远为 0 的字段。
- 幂等只保证“同一 update 不重复执行”，不保证副作用本身事务化：如果 handler 在
  完成副作用之后、`complete` 之前抛错，Telegram 重投仍可能重复该副作用。需要
  强一致的写路径应自行加唯一键（例如 `report_deliveries` 的 `delivery_id`）。
- 结构重构的后续清理（例如 `survey-handler.ts` 仍剩约 2878 行渲染状态机）见
  [MODULARIZATION.md](./MODULARIZATION.md)。

# 免费版 D1 预算纪律

## 约束

Cloudflare D1 免费版按**账号**计量，所有库共享：

- 读取 5,000,000 行/天，写入 100,000 行/天，存储 5 GB
- 每日 00:00 UTC（北京时间 08:00）重置
- 一旦超限，**该账号下所有 D1 查询都会失败**，直到次日重置

官方原文（D1 Pricing FAQ）："When your account hits the daily read and/or write
limits, you will not be able to run queries against D1."、"
Free limits reset daily at 00:00 UTC."

所以任何一条失控查询都不是"慢一点"，而是全站（机器人 + 后台 + 问卷）停摆一整天。
2026-09-14 就是这么发生的一次：一次维护清扫读了约 530 万行，当天额度当场用尽。

## 现有护栏（改动前请先读）

1. **维护任务有硬预算** — `MAINTENANCE_ROWS_READ_BUDGET`（50 万行/次）。逐步执行，
   累计 `meta.rows_read` 超预算就在步骤之间停下，记 `truncated: true` 并私聊管理员。
   每步幂等，所以"停下"只是暂停，次日继续。
2. **清理查询必须走索引** — 孤儿媒体清扫需要的 11 个读路径索引由任务自己保证：
   缺失时按 migration 0051 的 SQL 自建，建不出来就停手不扫。
3. **公开只读接口走 KV 缓存**（键里带"戳"，数据一改键就变，不靠 TTL 保新鲜）：
   - `survey-list:v1:<已发布数量>:<max(updated_at)>` — 列表接口每次约 1.5 万行
   - `survey-definition:v1:<id>:<version>:<updated_at>` — 详情每次约 500 行
   - `admin-dashboard:v1:<admin|owner-id>` — 仪表盘是整表 COUNT/GROUP BY
4. **KV 免费额度**：10 万读 / 1,000 写 / 天。缓存 TTL 故意设长（列表 6 小时、详情 1 小时），
   因为新鲜度由键里的戳保证，TTL 只影响写入次数——短 TTL 会把 KV 写额度也打满。
5. **cron 节奏**：重试驱动 `*/30 * * * *`（最坏报表投递延迟 30 分钟）、每日维护
   `15 1 * * *`（北京 09:15）、周报 `30 9 * * 1`。加频次要按行数算账。
6. **额度耗尽时的降级**：机器人、后台、问卷/试用/广场/报告 API 都返回结构化 JSON
   和明确文案（`describePublicDatabaseError`），不再让用户看到"请求失败"。

## 实测数据

| 场景                                    | 维护任务单次读取              |
| --------------------------------------- | ----------------------------- |
| 2026-09-14（修复前，无索引 + 无边界）   | ~5,300,000 行（额度当场耗尽） |
| 2026-09-15 09:15（自愈建索引 + 有边界） | 21,720 行（额度的 0.43%）     |

这次运行同时删除了 24 条过期答卷、3 个孤儿媒体、10 个过期临时媒体，
`truncated: false`。

## 怎么监控

每日维护日志（`wrangler tail` 或 Workers Logs）里的
`Database maintenance complete` 会带 `rowsRead` 和 `truncated`。
`truncated: true` 表示触到了 50 万行预算——先查是不是有新加的清理查询缺索引，
再考虑放宽预算。

每个请求和每个队列批次还会输出一行可观测性日志，用来看“**是哪次请求读多了**”：

- `request_metrics {...}`：`route`（数字 id 已折叠成 `:id`）、`status`、
  `durationMs`，以及该请求累计的 `d1Queries`/`d1RowsRead`/`d1RowsWritten`、
  `kvOps`/`kvHits`/`kvMisses`、`botUpdates`/`duplicateUpdates`。
- `queue_metrics {...}`：队列名、消息数与同一个批次的 D1/KV 计数（导出/可视化
  任务也会吃额度）。

成功的静态资源请求不输出指标行；4xx/5xx 仍然输出。日志只含计数，不含请求体、
密钥或问卷答案。详见 [BOT_2_0_IMPLEMENTATION.md](./BOT_2_0_IMPLEMENTATION.md)。

## 改动新查询时

- 清理/统计类 SQL 必须能走索引；`LIMIT` 不是边界（带 `ORDER BY` 时排序仍然要读完）。
- 新增公开只读接口时，优先复用 `src/services/kv-cache.service.ts` 的戳式缓存。
- 加 cron 前先估算：单次行数 × 每天次数。

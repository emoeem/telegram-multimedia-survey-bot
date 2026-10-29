# 运维告警接入:预算异常与告警过滤

## 背景

`src/observability/metrics.ts` 给每个请求发一行 `request_metrics`(D1 行数 / KV / 队列计数),但日志只进 Cloudflare 的 worker tail——**没有任何东西在看它**。这个产品最怕的故障是"一个失控请求把共享 D1 免费档的行数预算读干",等发现的信号却是几天后账号被限流。

现在当单个请求(或队列批)的计数突破硬阈值时,会额外发一行 **ERROR 级**的 `budget_anomaly` 日志。阈值是数量级判断,不是调参旋钮:正常的重端点(报告生成、编辑器保存)离它们还有三倍以上距离。

## 阈值

| 计数            | 阈值            | 依据                                       |
| --------------- | --------------- | ------------------------------------------ |
| `d1RowsRead`    | ≥ 50,000 / 请求 | 最重的合法路径(整卷报告导出)约 15,000 行   |
| `d1RowsWritten` | ≥ 5,000 / 请求  | 最重的合法写入(批量答案 upsert)约 1,500 行 |
| `kvOps`         | ≥ 5,000 / 请求  | KV 使用集中在限流/会话,单请求正常 < 100    |

队列批同样覆盖:`requestId` 形如 `queue:<queue>:<messages>`。

## 告警怎么接(一次性的仪表盘操作,代码不用再动)

`budget_anomaly` 是 ERROR 级 console.error,Cloudflare 两条现成管道都能抓:

1. **Workers Logs(推荐,零配置起步)**:Dashboard → Workers & Pages → 该 Worker → Logs → Logs Engine。在"过滤"里存一个查询:`error.message = "budget_anomaly"` 或直接搜字段 `kind = "budget_anomaly"`。付费计划可在同一页面给保存的查询配 **Alert**(邮件/webhook)。
2. **Logpush → 外部告警**(`Workers Observability` → Logpush):把 `logs` dataset 推到 R2 / Datadog / Axiom 等,在对面按 `kind: "budget_anomaly"` 建告警规则。免费档 Logpush 不可用时,方案 1 或 `wrangler tail --format pretty | grep budget_anomaly` 的外部看门脚本兜底。

## 需要一起看的相邻信号

- **每日配额水位**:Dashboard → Workers & Pages → D1 → 数据库 → Metrics 里看每天 rows read/written 总量。 budget_anomaly 是"单请求异常";如果每天总量平滑地逼近免费档上限(如新问卷爆量),那是容量问题,不是异常请求,告警抓不到——需要在 Dashboard 层面盯总量。
- **`queue_metrics`** 行:导出队列积压(ok=false 连续出现)是另一个独立的故障模式,同样没有告警,接入时可以顺手在对面加一条。

## 改阈值

`BUDGET_ANOMALY_THRESHOLDS` 常量在 `src/observability/metrics.ts`,改完跑 `tests/unit/observability/metrics.test.ts`——里面的用例钉着"正常重路径(3 倍以下)不告警"的边界。

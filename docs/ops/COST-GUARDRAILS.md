# 计费护栏：哪些花费是被结构挡住的，哪些得你亲手关

> 这份文档回答一个问题：**这个部署在什么情况下会开始多花钱，以及每一道防线在哪一层。**
>
> 写它是为了对齐一个容易被忽略的事实——**大多数"防刷"代码都发生在计费之后**。
> Cloudflare 按到达边缘的请求收费，你的 Worker 返回 429 也照样计费。所以
> 「在 Worker 里加限流」保护的是下游（D1 / R2 / DO），不是账单。真正保护账单
> 的规则必须在边缘、在 Worker 之前。

## 1. 三个计费项，三套护法

账号 `ed1957935…`（本站，区别于投稿机器人的 `fb8f4c…`）：

| 订阅                | 计费方式    | 单价                                | 谁在花钱                 |
| ------------------- | ----------- | ----------------------------------- | ------------------------ |
| Workers Paid        | 请求数      | $5/月含 1000 万，超出 $0.30/百万    | 每个到达 Worker 的请求   |
| R2 Paid             | 存储 + 操作 | $0.015/GB/月；Class A $4.50/百万    | 媒体上传后留在桶里的字节 |
| Images Stream Basic | **按分钟**  | $5/月含 1000 分钟，超出 $0.005/分钟 | 视频答卷的时长           |
| emoe.eu.cc          | Free Plan   | —                                   | —                        |

**Stream 是唯一的线性计费项**，这也是它被停用的原因（见第 2 节）。

## 2. Stream 已停用：硬开关与它的理由

`wrangler.toml`：

```toml
STREAM_DISABLED = "true"
```

行为：

- `streamConfigured()` 第一行就返回 `false`，**即使 `STREAM_ACCOUNT_ID` /
  `STREAM_API_TOKEN` 两个 secret 都在**
- `POST /api/survey/:id/media/stream-ticket` → `404 stream_unavailable`
- 能力面板 `streamVideo: false`（`src/services/plan.service.ts`）

**为什么用显式变量而不是删 secret**：删 secret 是隐式的。下一次有人为了别的
目的补回 token，视频通道会无声重开，而任何人都不会在 diff 里看到这个变化。
一个写在配置里的 `"true"` 是可审计的停用声明——要开就得改这行，改这行必然进 diff。

**档位不受影响**：`deriveTier()` 只看 `r2Media / browserRender / asyncQueue`
三项，Stream 不参与。关掉视频不会把部署从 `pro` 降成 `paid`，导出队列等
与 Stream 无关的功能照常。

**还没做的**：Stream 订阅本身仍在（$5/月）。停用代码只保证**不产生按分钟的
费用**，那 $5 基础费还在收。要彻底停：Dashboard → Billing → Images →
取消 Stream。这一项我没有 API 权限（`/accounts/…/subscriptions` 回 403）。

## 3. 已有防线，按「花不花钱之前」排序

| #   | 层     | 机制                                                   | 在计费前吗 | 挡什么                                |
| --- | ------ | ------------------------------------------------------ | ---------- | ------------------------------------- |
| 1   | 边缘   | Managed Challenge（现状已开）                          | ✅         | 非浏览器 UA、脚本，实测 curl 直接 403 |
| 2   | 边缘   | Rate limiting（`scripts/cf-edge-guard.mjs`，**待配**） | ✅         | 单 IP 瞬时洪泛                        |
| 3   | Worker | `MEDIA_DAILY_UPLOAD_LIMIT=300` 全局日上限              | ❌         | 多 IP 轮换刷存储                      |
| 4   | Worker | `20 次/分钟/IP`（`checkRateLimit "upload"`）           | ❌         | 单 IP 刷上传                          |
| 5   | Worker | `Content-Length > 61MB → 413`（不读 body）             | ❌         | 超大请求体烧内存                      |
| 6   | Worker | 单文件 10MB / 单答卷 50MB                              | ❌         | 单次上传体积                          |
| 7   | R2     | lifecycle `media:temp/` 7 天过期                       | —          | 孤儿对象永久计费                      |
| 8   | R2     | 公有访问**已关闭**（`enabled: false`）                 | —          | 媒体被公网直连刷 Class B              |

第 3 条是上一轮加的，第 7、8 条是核实过的现状，第 2 条卡在权限上。

## 4. 全局日上限的取舍（明写）

`STREAM_DAILY_TICKET_LIMIT=30` / `MEDIA_DAILY_UPLOAD_LIMIT=300` 都是**全局**的，
不是按 IP 的。代价：

> 打满 300 次后，**当天所有用户都不能再上传**，包括真实用户。

这是有意的：宁可少收一天附件，也不让存储与请求额度被无声刷穿。数字的依据是
正常业务量（历史 19 条投稿、单份答卷 ≤10 个附件）离上限有两个数量级的距离。
觉得太紧就改 `src/http/survey/media.ts` 里的常量，两处都有注释说明代价。

## 5. 边缘规则：脚本已就绪，权限未到

```bash
CF_API_TOKEN=<带 Zone WAF:Edit 的 token> \
CF_ALERT_EMAIL=pd2335346@gmail.com \
node scripts/cf-edge-guard.mjs --dry-run    # 先看 body
node scripts/cf-edge-guard.mjs --apply      # 再写入
```

规则内容：`20 次 / 60 秒 / IP`，命中即封 10 分钟（`mitigation_timeout=600`），
作用于 `/api/survey/<id>/media*`、`/api/submit*`、`/api/auth/*`。

刻意**不**包含只读问卷页 `/api/survey/<id>`——它有边缘缓存且是正常浏览路径，
限流会把真实用户挡在外面。

当前 token 只有 `zone (read)`，`GET /zones/{id}/rulesets/phases/http_ratelimit/entrypoint`
回 `403 Authentication error`。缺的权限：

```
Zone    · Zone WAF        : Edit
Account · Notifications   : Edit   （告警策略）
Account · Account Settings: Read
```

**没有这个 token 也能手点，两分钟**：

1. dash.cloudflare.com → emoe.eu.cc → Security → WAF → **Rate limiting rules**
2. Create rule：
   - 名称：`billing guard: upload/auth/submit flood`
   - 路径：`/api/survey/*/media*` 与 `/api/submit*` 与 `/api/auth/*`（三个条件 OR）
   - Rate：**20 requests / 1 minute**，Based on **IP**
   - Action：**Block**，Duration **10 minutes**
3. Deploy

## 6. 告警（免费，但必须手点）

Dashboard → **Notifications** → Add：

| 策略             | 阈值               |
| ---------------- | ------------------ |
| Workers Requests | 50% of daily limit |
| R2 Storage       | 50% of 10 GB       |
| D1 Rows Written  | 50% of daily limit |

额度是静默烧掉的。50% 是留出反应时间的位置。

## 7. 已清理的历史遗留

`media_assets` 里 52 条 `storage_kind='temporary' AND storage_key IS NULL` 的
孤儿行（2026-09-03 ~ 2026-10-06，元数据在、字节早已不存在）已删除。

- 备份：`.backup/d1/orphan-temp-media-20261023.json`（52 行完整快照）
- 复核：`temporary` 513 → 461，`orphan` 52 → 0
- 无引用：`question_media` 引用数为 0
- 不影响成本（字节本来就不在），但让「临时媒体总量」统计虚高 60 MB

> 注：`wrangler d1 execute` 的 `meta.changes` 报 137，是索引条目的计数，不是
> 行数。实际行差 52（513−461），与备份一致。

## 8. 最坏情况估算

假设攻击者用 IP 池把日上限全部打满（边缘规则未配的情况下）：

| 资源        | 最坏用量                                       | 超免费量           | 月成本影响  |
| ----------- | ---------------------------------------------- | ------------------ | ----------- |
| R2 存储     | 300 次/天 × 10MB = 3GB/天，7 天过期稳态 ≈ 21GB | 11GB               | **≈ $0.17** |
| Worker 请求 | 正常业务离 1000 万/月极远（实测 7 天 66 次）   | 0                  | $0          |
| Stream 分钟 | **0**（已停用）                                | 0                  | $0          |
| D1 写       | 300 次 × 4 行 = 1200 行/天                     | 0（免费 10 万/天） | $0          |

**结论：即使被完整刷穿，直接成本在「几毛钱」量级。** 真正会痛的不是钱，是
「额度被打满后正常用户当天传不了文件」——那是可用性问题，不是账单问题。
这也是为什么边缘规则值得配：它把损失从「可用性」压回到「几个 429」。

# Cloudflare 套餐分层：Pro 增强 + Free 兜底双轨方案

> 前置阅读：[FREE_TIER_BUDGET.md](./FREE_TIER_BUDGET.md)（D1/KV 预算纪律与既有护栏）。
> 本文不重复那份文档的额度核算，只回答一个新增问题：**买了 Pro 之后，哪些能用、
> 哪些仍然卡在原来的天花板、以及怎么让非 Pro 部署跑得一样完整。**

---

## 0. 结论先行（四句，含一次自我纠正）

1. **实测确认：账户订阅的是 `Workers Paid` + `Images Stream Basic`，域名 `emoe.eu.cc`
   仍是 `Free Plan`。** 依据是 2026-10-23 的管理账户 → 账单 → 订阅页截图（产品列
   三行：`Workers Paid` / `Images Stream Basic` / `emoe.eu.cc Free Plan`，前两者
   `Renews on Nov 22, 2026`）。**这一条推翻了本文件 0.x 版的第一句**——那份草稿假设
   「Pro = 域名套餐」，于是把「KV 1,000 写/天没变」写成了结论。错的是那个假设。
2. **Workers Paid 是把「硬额度」换成「按量计费」，这才是真正的变化。** 官方
   [KV limits](https://developers.cloudflare.com/kv/platform/limits/) 表明 Paid 档
   `Reads: Unlimited` / `Writes to different keys: Unlimited`；
   [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) 表明 Paid 档
   不再有「行/天」硬限，只有 10 GB 单库与 1 TB 账户存储上限。所以 Free 下那种
   **「额度一超，全站所有 D1 查询当场失败」**的悬崖消失了。
3. **但有一条硬限 Paid 也没解开：KV 同一个 key 每秒只能写 1 次。** 这一条在 Free 与
   Paid 两档完全相同。而当前的限流实现正是「同 key 读-改-写」
   （`src/services/rate-limit.service.ts:55`），所以它的问题不是额度，是**正确性**。
   这决定了 §4.2 的存废：迁 DO 的理由从「省额度」变成「修并发」。
4. 方案仍然是双轨的：**Paid 提供增强路径，Free 保持功能等价**。任何新能力上线必须同时
   回答「Free 下它退化成什么」，否则不允许合入。这条不因为买了 Paid 而放松——你还有
   `DEPLOYMENT_ROLE = "customer"` 的客户部署在用同一份代码。

---

## 1. 事实基线：现在到底跑在哪一档

判断依据不靠记忆，靠三条命令（在仓库根目录执行）：

```bash
# 1) 账户计划与当前用量（需要已登录 wrangler）
npx wrangler whoami

# 2) 这个 Worker 实际绑定了哪些按量资源（DO / Queues / Browser 都是付费面）
grep -nE "^\[\[(durable_objects|queues|browser)" wrangler.toml

# 3) 线上是否已经在吐配额错误
npx wrangler tail --format json | grep -E "capacity|kv_capacity|exceeded"
```

当前 `wrangler.toml` 已绑定 **Durable Objects（3 个类）+ Queues（1 生产者 1 消费者）
+ Browser Rendering**。这三项在纯 Free 计划下要么不可用、要么额度极低，所以
**这个项目事实上已经不是"免费部署"了**——它至少需要 Workers Paid。

这一点很关键：如果升级 Pro 后你感觉「没什么变化」，那是因为瓶颈从来不在 Zone 层。

---

## 2. 升到 Workers Paid 之后，到底变了什么

数据全部取自 2026-10-23 的官方 limits 页面（Workers / KV / D1），不是记忆。

| 资源 | Workers Free | **Workers Paid（当前）** | 倍率 | 对本站的意义 |
| --- | --- | --- | --- | --- |
| Worker 请求 | 100,000 / 天 | **无限制** | ∞ | 活动期不怕被打满 |
| CPU 时间 | 10 ms | **30 秒**（可调至 5 分钟） | 3,000× | Browser 渲染不再有 CPU 悬崖 |
| Subrequests / 请求 | 50 | **10,000** | 200× | 队列任务里的多步 fetch 不被截断 |
| KV 读 | 100,000 / 天 | **无限制** | ∞ | 列表缓存可以放心读 |
| KV 写（不同 key） | 1,000 / 天 | **无限制** | ∞ | **验证码存储不再会「写不进去」** |
| KV 写（同一 key） | 1 / 秒 | **1 / 秒** | **1×** | ⚠️ **唯一没变的硬限**，见 §4.2 |
| KV 存储 | 1 GB | 无限制 | ∞ | 媒体临时文件可以放更久 |
| D1 读行数 | 5,000,000 / 天 | **无硬限**（按量计费） | 硬→软 | 「超了全站 500」变成账单 |
| D1 写行数 | 100,000 / 天 | **无硬限**（按量计费） | 硬→软 | 同上 |
| D1 单库大小 | 500 MB | **10 GB** | 20× | 短期内不用分库 |
| D1 账户存储 | 5 GB | **1 TB** | 200× | — |
| **D1 Time Travel** | 7 天 | **30 天** | 4.3× | **免费的多了一层可回滚备份，见 §3.4** |
| D1 每请求查询数 | 50 | **1,000** | 20× | 后台聚合页可以合并查询 |
| Cron Triggers | 5 / 账户 | **250 / 账户** | 50× | 可加独立的对账/清理触发器 |
| 环境变量 | 64 / Worker | **128 / Worker** | 2× | 还有余量 |

### 2.1 一句话概括这次升级的性质

**它不是「额度变大」，是「故障模式从 500 变成账单」。**

Free 档最狠的地方不是数字小，是**超限即全站失败**：
`docs/FREE_TIER_BUDGET.md` 记录过 2026-09-14 那次——一次维护清扫读了约 530 万行，
超过 D1 免费的 500 万行/天，**当天该账号下所有 D1 查询全部失败**，站点直接躺下。

Paid 档把这条悬崖填平了。现在的代价是「超了要付钱」，而不是「超了用户看到 500」。
这个区别比任何一项数字都重要：**它把可用性风险转成了成本风险**，而成本风险可以
限额、可以告警、可以事后算账，可用性事故不能。

### 2.2 Zone 层仍停在 Free，这仍然限制三件事

`emoe.eu.cc` 是 `Free Plan`（截图第三行）。域名套餐没升级，所以下面这些**依然拿不到**：

| 能力 | Free 现状 | 对本项目的实际影响 |
| --- | --- | --- |
| WAF 托管规则 / 高级速率限制 | 只有基础 5 条速率规则 | 抗刷靠应用层（已实现），不靠边缘 |
| 缓存规则精细化（Cache Rules） | 只有 Page Rules 的 3 条 | 静态资源缓存靠 `ASSETS` 与 Worker 头，影响很小 |
| 图片 Resize / Polish | 无 | 认证卡与报告图都是 Worker 自己渲染，**不受影响** |
| Argo Smart Routing | 无 | 中国大陆访问靠 `emoemok.top` 中继，不靠这个 |
| 日志保留 | 取决于账户套餐 | Workers Logs 的 3 天保留不变 |

**结论：Zone 层不升级，对本项目的功能完整性没有影响。** 要花的钱应该花在
Workers Paid 上（已花），而不是 Pro 域名套餐。

> 顺带纠正一个容易误判的点：`Images Stream Basic` 是 **Cloudflare Images**（图片存储 +
> 变换），**不是** Worker 的 Image Resizing。本站的认证卡走 `cert/render.js` 在浏览器里
> 画、报告图走 Worker 内渲染，两者都不经过 Images。
>
> 核实方式（避免被 `maxImages` 这类同名字段误导）：
>
> ```bash
> $ grep -rn "env\.IMAGES\|IMAGES:" src/ wrangler.toml | wc -l
> 0
> $ grep -c -i images wrangler.toml
> 0
> ```
>
> 即**没有任何 Images 绑定**。这项订阅目前没有被代码引用，属于可评估是否退订的项。
> （注：`grep -rn "IMAGES"` 会命中 `image-generator-handler.ts` 里的 `maxImages` /
> `minImages` —— 那是问卷题目的图片张数设置，与 Cloudflare Images 无关。）

---

## 3. 双轨设计的四条原则

### 原则一：能力必须可探测，不能靠"我记得我是 Pro"

不把方案建立在"现在有额度"这个假设上。每个依赖按量资源的功能，读取一个统一的
能力描述：

```ts
// src/services/plan.service.ts（待新增）
export type PlanTier = "free" | "paid" | "pro";

export interface PlanCapabilities {
  tier: PlanTier;
  /** KV 精确限流（Free 只有 1,000 写/天，撑不住） */
  kvRateLimit: boolean;
  /** 异步队列处理重活；关闭时走同步降级 */
  asyncQueue: boolean;
  /** 浏览器渲染报表图；关闭时退化为纯字符串模板 */
  browserRender: boolean;
  /** 公开只读接口的长 TTL 缓存 */
  longLivedCache: boolean;
}
```

来源优先级：`env.PLAN_TIER`（显式声明）> 运行时探测到的配额错误（自适应降级）> 默认 `"free"`。

**默认必须是最保守的那一档。** 未声明 = 按 Free 处理，宁可少用能力，不可假设有额度。

### 原则二：降级是"换实现"，不是"关功能"

用户不应该因为部署方省钱就少一个按钮。每一项都要有功能等价的降级路径：

| 能力 | Paid/Pro 实现 | Free 降级实现 | 用户感知 |
| --- | --- | --- | --- |
| API 限流 | KV 计数器（`rate-limit.service.ts:25`） | 内存 Map（`createMemoryRateLimiter`，同文件已存在） + 仅对写接口生效 | 无（多实例下略宽松） |
| 报表图渲染 | Browser Rendering（`[browser]` binding） | 服务端 SVG/字符串模板 | 图片略朴素 |
| 导出/可视化 | Queues 异步 | 同步处理 + 明确的"生成中"轮询 | 慢几秒 |
| 公开列表缓存 | 戳式 KV 缓存（已有） | TTL 拉长到 12h + 只缓存 top-N 热键 | 无 |
| 验证码存储 | KV | **无降级**（必须有地方存码）→ 见 §4.3 |

### 原则三：配额耗尽必须是"可解释失败"，不是 500

已有 `describePublicDatabaseError`（`src/db/errors.ts:28`）只是第一层。本次已补
**KV 容量错误识别**（`isKeyValueCapacityError`）。

为什么 Paid 之后这条仍然要留：**客户部署跑的是 Free**（`DEPLOYMENT_ROLE = "customer"`），
而 Free 档 KV 写 1,000/天、D1 写 100,000 行/天依然是硬限。而这些错误串此前既不含
`exceeded d1` 也不含 `code: 7500`，于是被兜底成「服务暂时不可用，请稍后重试」——
用户以为站点挂了，实际换个 Telegram 入口立刻能用。

**这条不变式是：任何配额错误都必须翻译成「说清发生了什么 + 说清现在能做什么」，
而不是一句通用文案。** 自用部署有额度不代表客户部署有。

### 原则四：备份要落在平台层，不要只写在代码里

买到 Paid 之后白拿了一项能力：**D1 Time Travel 从 7 天变成 30 天**
（官方 [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)）。

这一项值得单独写成原则，因为它改变了「备份」这件事的成本结构：

| 层次 | 手段 | RPO | 成本 | 谁维护 |
| --- | --- | --- | --- | --- |
| **平台层（新获得）** | Time Travel 时间点恢复 | 分钟级 | **0**（已含在 Paid） | Cloudflare |
| 应用层 | `scripts/backup-d1.mjs` 定期导出 | 天级 | 存储成本 | 自己 |
| 人工 | `wrangler d1 export` 手动 | 不定 | 0 | 自己 |

**推荐做法**：Time Travel 兜「刚手滑删了数据」这类分钟级事故，应用层导出兜
「要跨账号迁移/离线归档」这类需求，两者不互相替代。

验收命令（确认 30 天真的生效）：

```bash
# 列出可回滚的时间点；Paid 档应能取到 30 天前
npx wrangler d1 time-travel info telegram-survey-db

# 演练恢复到昨天的某个时刻（--dry-run 语义见 wrangler 文档）
npx wrangler d1 time-travel restore telegram-survey-db --timestamp <ISO8601>
```

⚠️ **恢复是写操作，会覆盖当前数据。** 演练前先跑一次 `scripts/backup-d1.mjs` 留底，
不要在生产流量高峰做。

---

## 4. 分档落地：从 Free 到 Pro 的每一步

### 4.1 第一步（P0，与套餐无关，现在就该做）

| # | 做什么 | 状态 |
| --- | --- | --- |
| 1 | `wrangler.toml` 加 `[observability]`，让 `request_metrics` / `queue_metrics` / `Resend email failed` 有留存 | ✅ 已加 |
| 2 | 错误分类认识 KV 配额，返回 `kv_capacity` + 可执行建议 | ✅ 已改 `src/db/errors.ts` |
| 3 | 验证码存储失败与「码不对」分流，返回 `email_code_store_unavailable` | ✅ 已改 `src/http/email-auth-api.ts` |
| 4 | **部署**（以上三项不部署就全部不生效） | ⬜ `npx wrangler deploy` |
| 5 | 成本/用量仪表盘：把 `request_metrics` 的 `d1RowsRead` / `d1RowsWritten` 做日聚合 | ⬜ |

**第 4 项是关键**：`[observability]` 只有部署后才开始收集；`CERT_SHARE_DISABLED = "true"`
也只有部署后才在线上生效。

**第 5 项取代了旧版的「KV 写次数汇总」**：Paid 档 KV 写无上限，盯它没有意义；
现在该盯的是**按量计费的三项**（D1 行读写、KV 操作、CPU 时间），因为它们直接等于账单。

### 4.2 第二步（P1，理由已从「省额度」改为「修并发」）

> ⚠️ **本节在买到 Workers Paid 之后被重写了。** 旧版理由是「KV 1,000 写/天撑不住」，
> 那个前提已经不成立——Paid 档 KV 写是 `Unlimited`。但**问题没消失，只是换了性质**。

现状：`src/services/rate-limit.service.ts:33-55` 的 `allow()` 是「读计数器 → 比较 →
写回 `current + 1`」。这条路径在三种情况下会算错：

| 情况 | 后果 | Paid 是否解决 |
| --- | --- | --- |
| 同一 key 并发请求 | 两个请求都读到 `n`，都写 `n+1`，**少算一次** | ❌ 不解决 |
| 同一 key 每秒 > 1 次写 | KV 明确限制 `Writes to same key: 1 per second`，**超出的写被拒或覆盖** | ❌ **不解决，这是 Paid 也不放开的硬限** |
| 额度耗尽 | 整条链路写入失败 | ✅ 解决了 |

真正被 Paid 解决的只有第三行。前两行是**语义问题**，不是额度问题：

- 公开 API 每个请求至少 1 次写；登录接口 2 次（`src/index.ts:397-398` 的
  `Promise.all` 双维度：邮箱 5 次/小时 + IP 20 次/小时）。
- 一个 IP 后面的多个用户共用同一个 `email-auth-ip|<ip>` 键 → 该键每秒写多次 →
  **一旦超过 1 次/秒，限流计数就不再准确**，而 `rate-limit.service.ts:24` 的注释
  自己已经承认「concurrency does not justify a more expensive atomic backend」。

**所以改造仍然要做，但 KPI 变了**：不是「把写入压到 1,000 以下」（已无意义），
而是「让计数在并发与高频写下仍然正确」。

改造方案（按推荐度排序）：

1. **限流迁到 Durable Object（推荐）。** 加一个 `RateLimitDO`，用
   `ctx.storage.transaction()` 做原子读-改-写。DO 天然单线程串行，既解掉
   「每秒 1 写」的硬限，也解掉并发少算。项目已有 3 个 DO 类
   （`SurveySessionDO` / `SurveyBuilderDO` / `UiSessionDO`），加第 4 个的边际成本很低。
2. **Cloudflare 原生 Rate Limiting binding（可选，Beta）。** `wrangler.toml` 加
   `[[unsafe.bindings]]` 或 `[[ratelimits]]` 声明，由边缘直接计数，零存储。
   优点是零成本零延迟，缺点是**只按时间窗简单计数，不支持「5 次/小时」这类
   业务化窗口语义**——本站登录限流正是后者，所以只能覆盖一部分接口。
3. **什么都不做，接受不准。** 只有在「公开接口并发极低」这个前提持续成立时才可接受。
   一旦办活动、被转发、被爬，这个前提就没了。

**Free 档怎么办**：`createMemoryRateLimiter`（同文件 :59）已经存在，是单 isolate 内的
Map 实现。它在 Free 下可用，代价是多 isolate 时各算各的（限流会偏松）。这个降级
**现在就已经在仓库里**，不需要新写。

### 4.3 第三步（P1，Paid 才打开的能力）

买到 Paid 之后**解锁的、值得用上的**四件事，按收益排序：

| # | 能力 | 现在为什么做不了 | Paid 后怎么做 | Free 降级 |
| --- | --- | --- | --- | --- |
| 1 | **报告图/证书图 CPU 放宽** | Free 10 ms 下复杂渲染极易 1102 | `[limits] cpu_ms = 300000`（见 §4.3.1） | 保持 10 ms，退到简化模板 |
| 2 | **队列重活扩容** | Free 下 Queues 额度极低 | `max_concurrency` 从 3 提到 10 | 保持 3 |
| 3 | **D1 30 天 Time Travel** | Free 只有 7 天 | 无需配置，`wrangler d1 time-travel` 直接可用 | 7 天 |
| 4 | **Cron 从 5 条扩到 250 条** | 已被 3 条占满，加不了 | 可加独立的对账/清理/成本巡检触发器 | 不加 |

#### 4.3.1 CPU 上限要不要调

**建议先不调，先量。** 当前默认是 Paid 的 30 秒，已经从 10 ms 提到 30 秒（3,000×），
绝大多数请求根本用不完。调 `cpu_ms = 300000` 的唯一理由是「单次请求需要跑几分钟」，
而本站没有那种负载——Browser 渲染是**独立进程**，CPU 时间不计入 Worker。

**先做的事**：`[observability]` 已经打开（本次改动），去 Workers Logs 看
`cpuTimeMs` 的 P99。如果 P99 远低于 30 秒，这一项**不需要动**，写在这里是为了
说明「有这个旋钮，但别为了调而调」。

### 4.3 第三步（P1，可选增强）

按 `PLAN_TIER` 开启：

| 开关 | free | paid | pro |
| --- | --- | --- | --- |
| `kvRateLimit` | ❌（走 DO） | ✅ | ✅ |
| `browserRender` | ❌（SVG 降级） | ✅ | ✅ |
| `asyncQueue` | ⚠️ 仅重活 | ✅ | ✅ |
| `longLivedCache` | ❌（短 TTL） | ✅ | ✅ |
| 日志保留 | 3 天 | 3 天 | 7 天+ |

`pro` 与 `paid` 在 Worker 运行时额度上**没有区别**——Pro 的增量在 Zone 层
（WAF/缓存/图片）。所以代码里 `pro` 档的价值只有一项：
**可以放心把静态资源与图片交给 Cloudflare 边缘处理**，例如启用 Image Resizing
代替 Worker 内解码，省 CPU 与内存。

### 4.4 第四步（P2）

- 按量成本告警：`wrangler tail` 里 `request_metrics.d1RowsRead` 做日聚合，
  超日预算 70% 时私聊管理员（复用现有 `MAINTENANCE_ROWS_READ_BUDGET` 的通知通道）。
- 多环境：`wrangler.staging.toml` 固定 `PLAN_TIER = "free"`，**让 CI 永远在
  最保守的档位下跑测试**，防止只在有额度的环境里验证过。

---

## 5. 验收：怎么证明"非 Pro 也能正常用"

不能靠"我试了一下没问题"。三条硬验收：

### 5.1 注入式降级测试（必须自动化）

```bash
# 让所有 KV 写失败，全站仍应能走完「注册 → 答题 → 出报告」
PLAN_TIER=free KV_FAIL=1 npx vitest run tests/unit/http
```

断言：注册接口返回 `503 kv_capacity` 且**文案里出现「可以直接用 Telegram 打开」**，
而不是 500 或空白；答题与报告链路不受影响（它们不依赖 KV 写）。

### 5.2 额度沙盘（双列：自用 Paid / 客户 Free）

同一份代码要跑在两种账户下，所以预算表必须两列都填。

| 资源 | 单次成本 | **自用（Paid）** | **客户（Free）** |
| --- | --- | --- | --- |
| KV 写 | 限流 1 次/公开请求，登录 2 次 | 无硬限，按量计费 | **1,000/天 → 最紧** |
| KV 同 key 写 | 限流计数器 | **1/秒（不变）** | **1/秒（不变）** |
| D1 行读 | 见 `FREE_TIER_BUDGET.md` | 无硬限，按量计费 | 5,000,000/天（硬限，超了全挂） |
| D1 行写 | 同上 | 无硬限，按量计费 | 100,000/天 |
| Worker CPU | 报表渲染最重 | 30 秒 | **10 ms → 次紧** |
| 请求数 | 每页一次 | 无限制 | 100,000/天 |

**两列的最紧项不同，这就是双轨的必要性**：
- Paid 下最紧的是「KV 同 key 1 次/秒」——**不是额度，是协议限速**，只能靠换存储（§4.2）。
- Free 下最紧的是「KV 写 1,000/天」和「CPU 10 ms」——前者靠 DO 迁移缓解，
  后者靠关掉 Browser 渲染、退到字符串模板。

### 5.3 三档回归

同一套 E2E（`qa/visual/*.spec.ts`）在 `PLAN_TIER=free` / `paid` / `pro` 下各跑一遍，
**界面差异必须只出现在"性能相关"的地方**（加载时间、图片质量），
不能出现"Free 下少了某个按钮"。

---

## 6. 注册失败的真实归因（已查清，与本方案的优先级直接相关）

用户截图（2026-10-23 **07:33 CST** = 23:33 UTC）显示「服务暂时不可用，请稍后重试。」，
出现在「注册并登录」按钮下方。

### 6.1 那句话是谁写的

全站只有一个产出点：`src/db/errors.ts` 的 `describePublicDatabaseError` **兜底分支**。
它属于**存储层异常**，不是邮件异常。链路是：

| 步骤 | 代码 | 缺陷 |
| --- | --- | --- |
| 发码写 KV | `src/services/email-auth.service.ts:82` `await store.put(...)` | **零 try/catch** |
| 异常冒泡 | 穿过 `email-auth-api.ts` | 无人接住 |
| 全局兜底 | `src/index.ts` `guardApiResponse` | 返回通用文案 ✅/❌ |

对照：限流那边**做了**保护（`rate-limit.service.ts:56` catch 后 fail open）。
同一类风险，一个堵了、一个漏了。

### 6.2 决定性证据：时间跨过了额度重置点

| 时刻 | 实测 | 换算 UTC |
| --- | --- | --- |
| 截图 07:33 CST | 失败 | 23:33（额度耗尽） |
| 复测 08:06 CST | `200 {"ok":true,"sender":"no-reply@emoemok.top"}` | 00:06（额度重置） |

**中间跨过 UTC 00:00 —— KV 免费额度的每日重置点。** 这是 Free 档的典型症状。

### 6.3 顺带纠正一处上一轮的错判

上一轮本文件曾把「发信 502」列为主因。**那个判断是错的**：复测 `request-code` 返回
200，发信链路本身是通的；502 只是同一时段的一次瞬时抖动，被误当成了病根。

### 6.4 已修什么、没修什么

| 项 | 状态 |
| --- | --- |
| 用户看到误导性通用文案 | ✅ 已修：`safeVerifyEmailCode` 区分「存储挂了」与「码不对」，返回 `email_code_store_unavailable`（503）+ 指向 Telegram 免注册入口 |
| 根因（Free 档 KV 写 1,000/天） | ❌ **未修，也不需要修** —— 账户已是 Payed，KV 写 `Unlimited` |
| 线上生效 | ⬜ **待部署** |

**结论：这条在买到 Workers Paid 之后已经不是活跃故障。** 但代码层的错误分流仍要保留，
因为客户部署跑 Free（见原则三）。

---

## 7. 待决问题

**已由截图确认，不再是问题**：账户订阅为 `Workers Paid` + `Images Stream Basic`，
域名 `emoe.eu.cc` 停在 `Free Plan`。所以「§4.2 是可选还是必须」有答案了——
**必须做，但理由从「省额度」变成「修并发准确性」**（见 §4.2）。

剩下的三个需要你拍板：

1. **限流迁 `RateLimitDO`，做不做？** 收益：修掉「同 key 1 写/秒」导致的计数丢失，
   并让 `rate-limit.service.ts:24` 那句「并发下不精确」的自述失效。成本：一个新 DO 类
   + 一次 config 迁移 + 单测。**我倾向做**，因为这是唯一一条「买了 Paid 也没解决」的缺陷。
2. **`Images Stream Basic` 要不要留？** 代码里没有任何一处引用 Images
   （认证卡在浏览器画、报告图在 Worker 内渲染）。如果只是为了「以后可能用」，
   它现在是纯支出；如果打算把认证卡成品图迁到 Images 做变换，那就留着。
3. **Free 档要不要保留 Browser 渲染？** Free 的 CPU 是 10 ms，Browser 渲染虽然不计入
   Worker CPU，但**启动与回传的编排代码**在 10 ms 内很紧张。建议 Free 档直接关掉，
   退到 SVG 模板。

## 8. 变更记录

| 日期 | 改动 | 文件 |
| --- | --- | --- |
| 2026-10-23 | **Stream 视频托管上线**（Pro）：答卷视频/音频走 Stream 浏览器直传（`/media/stream-ticket` 铸凭证 + `storage_kind='stream'` 占位行 + 媒体端点按状态分流 302 HLS / 202 / 410），突破经 Worker 上传的 20MB 天花板；每日 cron 对账清理未完成凭证。**Images 图片管线上线**（Pro）：认证卡成品图旁路上传 Images（`images.service.ts`，响应带 `imageUrl`），TG 发送不变 | `src/services/media/stream.service.ts`、`src/services/media/images.service.ts` 等 |
| 2026-10-23 | **能力探测层落地**：`plan.service.ts`（tier + 六项能力探测，PLAN_TIER 显式声明只收紧不解锁）；后台「部署能力」面板（`/api/admin/deployment` 返回 `plan`）；无队列部署的导出/归档走 SELF 内部端点同步执行（`export-job-dispatch.service.ts`，`/internal/dispatch-export-job` + waitUntil），免费客户部署可用 `--plan free` 部署（`deploy-customer.mjs`）；**R2 媒体分层存储上线**（`TieredMediaStore`：R2 主、KV 读回落，行保持 `storage_kind='temporary'` 以兼容既有 retention SQL；答卷单文件 20→100MB、总量 50→200MB，仅 R2 部署生效） | `src/services/plan.service.ts` 等 |
| 2026-10-23 | 新增 `[observability]`，让指标日志有留存 | `wrangler.toml` |
| 2026-10-23 | 新增 `isKeyValueCapacityError`，KV 配额不再被兜底成通用 500 | `src/db/errors.ts` |
| 2026-10-23 | `guardApiResponse` 区分 `kv_capacity`，按可重试返回 503 | `src/index.ts` |
| 2026-10-23 | 验证码存储失败与「码不对」分流（`safeVerifyEmailCode`） | `src/http/email-auth-api.ts` |
| 2026-10-23 | **本文件按账单截图重写 §0/§2/§4.2/§5.2/§6**：确认订阅是 Workers Paid，纠正「Pro = 域名套餐」的错判，补 §3.4 Time Travel 原则 | 本文件 |

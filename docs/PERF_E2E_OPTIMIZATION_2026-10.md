# 端到端性能优化记录（2026-10-15）

上一轮（版本 37217063）把「下一题」从 10 次 D1 + 2 次 KV 压到 2 次往返、打开问卷压到 3 次往返之后，本轮针对剩余的延迟来源做了系统性的第二轮优化。本文记录实际改动、缓存策略的安全边界、测试结果与测量数据。**未包含的数字一律标注「未测」。**

## 一、本轮处理的瓶颈与成因

| 瓶颈 | 成因 | 位置 |
| --- | --- | --- |
| 翻题感知延迟 ≈ 一个保存往返 | `goNext` 同步 `await saveAnswer` 后才切题 | `admin/src/survey/SurveyApp.tsx` |
| 题面媒体慢、无法预热 | `fetch→blob→objectURL` 绕开浏览器 HTTP 缓存/渐进解码，且把 Telegram initData 发给不需要身份的公开端点 | 同上 `AuthenticatedMedia`/`MediaBlock` |
| survey 范围媒体仍 5 分钟过期 | `buildMediaResponse` 只有 KV 分支用了 `mediaCacheControl`，data-URL / R2 / Telegram 三个分支硬编码 `max-age=300` | `src/services/media/media-serve.service.ts` |
| 每个媒体请求 2–3 个串行 D1 往返 | 资产行 → 关联 UNION → 封面兜底，三个查询顺序执行；Telegram file_id 每次过期都回 Telegram Bot API 现拉 | `src/http/survey/media.ts` |
| `/answers` 实际 3 个往返、每击键重读整卷 | `resolveParticipant` 的 `participant_links` 查询在主 batch 之外；questions+options 每次 batch 全量拉取 | `src/http/survey/handler.ts` |
| 打开问卷 3 个串行往返 | survey 行 → `isCoinAccessEnabled` 探针 → `loadSystemSettings` 顺序执行；KV miss 冷路径 4 个串行读 | 同上 + `definition.ts` |
| 开卷串行链 | `fetchSurvey` → `startResponse` → `fetchAnswers` 三个串行 API | 前端 + `POST /responses` |
| 提交前 5 个串行读 | survey → participant → 归属检查 → 答案 → 设置 | `/submit` |
| 首屏关键 JS ~203KB gzip、首请求被指纹阻塞 | 金币/广场/挑战/展示等非答题界面静态 import 进入口；`request()` 每次 `await FingerprintJS.get()` | `admin/src/survey/*` |

## 二、实际改动

### P0 缓存策略统一（`media-serve.service.ts`）
- `mediaCacheControl()` 成为唯一策略函数；data-URL / R2 / Telegram / KV 四个存储分支全部走它。
- 安全边界：只有 `survey` 作用域（asset id 寻址、永不原地覆盖、替换上传得新 id）拿到 `public, max-age=31536000, immutable`；`response` 作用域 temporary 保持 `private, no-store`、durable 保持 `public, max-age=300`；其余内部作用域（模板/生成结果/证件等）维持 300s 公开。测试：`tests/unit/services/media-serve-cache.test.ts`（10 项，覆盖 4 分支 × 2 范围 + active-content 降级）。

### P1 乐观翻题 + 保存队列（`save-queue.ts` + `SurveyApp.tsx` + `api.ts`）
- 新模块 `admin/src/survey/save-queue.ts`：串行泵（一次一个在途请求、保持作答顺序）、只合并同题可替代更新、失败保留 + 界面横幅重试、`flushSaves()` 供提交前冲队列、`reset()` 供新会话。
- `goNext`/`goBack` 校验通过后立即切题，答案入队后台落库；`submit` 先 `flushSaves()`（失败重发一遍，仍失败则拦截提交）。
- `pagehide`/退出确认时尽力冲队列；`saveAnswer` 加 `keepalive: true`，关页后在途请求仍送达。
- 「保存中…」按钮文案只在提交时出现；底栏下方新增「正在同步答案…」轻提示与失败横幅（第 N 题，可重试）。
- 测试：`tests/unit/survey/save-queue.test.ts`（6 项：串行顺序、同题合并/异题不吞、失败保留与清除、flush 重发成功/失败、reset）。

### P2 媒体原生加载 + 下一题预加载（`SurveyApp.tsx` + `media-preload.ts` + `SpriteLayer.tsx`）
- 定义媒体（题面/选项/封面）改 `PublicImage`/原生 `<img src>`、`<video preload="metadata">`、`<audio preload="none">`；不再发送 `identityHeaders()`。
- `AuthenticatedMedia` 只保留给 response 范围私有媒体；**顺带修复既有 bug**：上传预览的裸 `<img>` 无身份头必 403（缩略图一直被 onError 静默藏掉），现改走带身份头的 blob 通道。
- 新增 `media-preload.ts`：`shouldSkipPreload()`（saveData/2G/3G 跳过，SpriteLayer 复用同一判定）+ `preloadImages()`（≤8 张上限）+ `collectQuestionImageUrls()`；SurveyApp 在当前题渲染 400ms 后按跳题规则预热真实后继题的公开图片。

### P3 媒体端点（`src/http/survey/media.ts` + `media.repository.ts`）
- 资产行 + 关联/封面检查合并进**一个** `db.batch()`（关联 UNION 与封面兜底合并为一条三 UNION 语句）——survey 范围媒体从 2–3 个串行往返降到 1 个。
- `caches.default` 边缘缓存：命中先于鉴权与数据库（缓存键为 URL，只可能存有身份无关的 survey 范围响应）；未命中走完整鉴权后 `cache.put`。
- **安全边界**：只有 `asset.scope === "survey"` 且 200 的 GET 响应进边缘缓存（边缘副本 `max-age=86400`，客户端仍收 immutable）；response/内部范围绝不入缓存。已知取舍：问卷关闭/归档后其媒体可能在边缘残留 ≤24h——严格小于任何已加载过它的浏览器手里的一年副本；未实现主动 purge（Cache API 无按前缀失效，需逐 URL 删除，收益/复杂度不划算，记录为已知限制）。
- Telegram file_id 资产因此只在边缘未命中时回 Telegram Bot API 一次；同一 colo 的后续请求全部由边缘副本承接。未做 KV 持久化（写预算 1000 次/天，边缘缓存已消除重复回源）。
- 测试：`tests/unit/http/survey-api.test.ts` 新增 3 项（首填+命中后零 D1、私有媒体不入缓存、失败不入缓存）。

### P4 `/answers` 折批 + flow KV 缓存（`handler.ts` + `catalog.ts`）
- 匿名 Web 参与者的 hash 是纯拼接（`web_<key>`）：身份判定改为 header-only，`participant_links`+封禁检查（LEFT JOIN users 一条语句）折进主 batch。Telegram/邮箱身份 hash 依赖 DB 用户号，保持原路径；折批后 `participantHash` 与折批前逐字相同（由浏览器 key 派生，与 link 行无关），因此只有封禁一条执法语义依赖这行——`survey-api.test.ts` 分别覆盖「已封禁的关联账号 403 account_banned」与「未封禁的关联账号正常保存」。
- 每次翻题：**3 个 D1 往返 → 2 个**；batch 不再拉 questions/options，改读边缘 KV 的 flow 缓存，每击键少读数百行。
- **flow 缓存 v2（并行读 + payload 内嵌版本戳）**：最初实现（v1）把 `version`/`updatedAt` 编进 KV 键——键必须先读到 survey 行才能算出，于是 KV 读只能排在 batch 之后，给热路径加了一跳**串行**（生产实测 `/answers` 394ms）。v2 的键只含问卷 id，版本戳放进 payload：请求在发 batch 之前就 fire KV 读（与 batch 并行），拿到新鲜 survey 行后比对 payload 戳（行永远是刚读的，比对权威）；一致 → 用缓存，不一致/未命中 → 回源数据库并写回新戳。实测回落至 182–194ms，同时保留行数削减。戳一致性依赖与 definition 缓存相同的既有假设（每条变更路径都 touch `version`/`updated_at`），TTL 1h 只兜底存储。测试：`tests/unit/services/survey-flow-cache.test.ts`（5 项：命中零 D1、陈旧戳回源并改写、冷未命中、损坏 payload 回退、键形状）。
- `POST /responses`（开卷）同样并行使用 flow 缓存；`/submit`、媒体上传同构（媒体上传只需"已发布"判定，已改为只读 survey 行，不再读 flow）。

### P5 定义加载合批（`handler.ts` GET + `definition.ts` + `system-settings.service.ts`）
- survey 行 + 金币开关 + 系统设置 → **一个 batch**（原 3 个串行往返）；设置行由新的 `settingsFromRows()` 在批后组装。
- KV miss 冷路径：questions/options/pages 一趟 batch（原 4 个串行读）+ 既有媒体两语句 batch。

### P6 开卷并行 + 续答内联（`SurveyApp.tsx` + `POST /responses` + `response.repository.ts`）
- 前端 `fetchSurvey` 与 `startResponse` 并行发射（服务端 /responses 自带密码、金币、次数校验，并行不绕过任何门；门禁问卷的预检 403/402 就地作废，验证后带凭据重开）。
- 服务端续答命中时在响应里直接带回 `answers`（`listAnswersForInProgressResponseStatement` 搭 resume batch，零额外往返）；客户端优先消费，旧部署无该字段时回退 GET /responses。
- 金币开关折进开卷的首个 batch（原为独立往返，且排在参与者解析之后）；仅启用时才走完整解锁判定。
- 测试：`survey-api.test.ts` 覆盖「续答响应内联答案」（`answers: {"10":[101]}`）与开卷非续答路径不变。

### P7 提交路径读侧合批（`/submit`）
- 归属检查 + 全量答案读取 +（发布时）系统设置 → **一个 batch**（原 2–3 个串行读）。`completeResponse` 保持独立（并发提交的网关语义）；媒体提升/入队保持既有 try/catch 非致命边界。成就评估上一轮已批处理（11–13 次往返 → 常数级），幂等性由 schema 唯一约束 + `INSERT OR IGNORE` 保证（见第四节），本轮未再动。

### P8 FingerprintJS 解耦 + 首屏拆分（`deviceInfo.ts` + `main.tsx` + `SurveyApp.tsx`）
- FingerprintJS 改**动态 import**（vendor chunk 移出关键图）+ localStorage 缓存 visitorId（设备维度稳定，仅首次探测付费）+ 模块初始化即后台预热；请求路径最多等 **150ms**，超时先发请求（指纹是风控元数据，不是参与者等待的东西；后续保存都带得上）。
- PlazaScreen / MyScreen / CoinsScreen / GachaScreen / SubmissionsScreen / CoinGateScreen / ShowcaseScreen / TrialScreen / EmailAuthScreen 全部 `React.lazy` + `LazyScreen`（Suspense 整屏占位）。
- CSS（daisyUI 全主题 188KB / 30KB gzip）**未拆分**——问卷与主题选择器依赖全主题变量，拆分收益/闪烁风险比不划算，记录为后续可选项。

### P9 D1 区域评估（仅评估，未动生产）
实测证据：
- `wrangler d1 info --json`（4.151.0）：**`running_in_region: "APAC"`** —— D1 主区域已经在亚太（也就是本项目受众与 Worker 所在的宏区域），`read_replication.mode: "disabled"`，17.7MB。
- 24h 读查询 23,704 次 / 读行数 1,570,793；写查询 8,142 次 / 写行数 31,591（对免费额度 5,000,000 行读/天仍有余量，本轮的 flow/definition KV 缓存进一步压低热路径读行数）。
- 单次 D1 往返成本来自两处证据的交叉：Worker 内部 duration 与 SQL 时间（d1DurationMs 常年 1–7ms）的差值；以及「零存储请求」（边缘缓存命中）的 34ms 基线。

结论：**不迁移**。D1 的 location hint 只到宏区域粒度（`wnam/enam/weur/eeur/apac/oc`），没有城市级控制；既然已经在 APAC，重建数据库大概率落在同一位置，却要付出导出/导入 + 写冻结 + 绑定切换的停机与数据风险——收益面接近于零。此前文档里"迁移到 apac 可把每往返 90ms 降到 20–40ms"的预期**已被这条证据推翻**，特此更正。
后续若要继续压 RTT，只剩两条更小的路（均未实施，收益为数十毫秒级）：
1. **read replication 试点**：当前 disabled；能本地化"纯读批次"（定义 GET、首页列表的 stamp 探针），但 `/answers` 与 `/responses` 的读批次里含限流 UPSERT（写），仍会打到主库——对最热的翻题路径帮助有限。需先在 staging 验证 read-your-writes 语义（答卷写入后立刻读报告的场景）。
2. **减少往返次数**（而不是缩短单次往返）：见第六节第 2、4 项。

## 三、缓存与失效策略汇总

| 缓存 | 键 | 失效 | 边界 |
| --- | --- | --- | --- |
| 浏览器（survey 媒体） | URL（asset id） | 不需要（id 即内容） | 仅 survey 范围；response 保持 no-store/300s |
| 边缘 `caches.default`（survey 媒体） | URL | 24h TTL 自然过期 | 仅 survey 范围 200；关闭/归档后 ≤24h 残留（已记录取舍） |
| KV flow（`published-flow:v1:...`） | id+version+updatedAt | 任何编辑 bump 版本；TTL 1h 兜底 | 未命中安全回退 DB；只读已发布问卷 |
| KV definition（既有） | id+version+updatedAt | 同上 | 投影变更需手工 bump 版本号（既有约定） |

## 四、测试与验证结果

| 项 | 结果 |
| --- | --- |
| 单元/集成测试 | **938/938 全绿**（基线 914，净增 24：媒体缓存测试 3→10；保存队列新增 6；survey-api 12→18；flow 缓存新增 5） |
| Worker typecheck（`pnpm typecheck`） | 通过 |
| 前端 typecheck（admin `tsc --noEmit`） | 通过 |
| Lint（`pnpm lint`） | 通过 |
| 前端生产构建（`vite build`） | 通过 |
| Worker 构建（`wrangler deploy --dry-run`） | 通过；生产部署 3 次（见第七节） |
| 视觉回归 · 非 admin 全部 spec | **111/111 全绿**：survey 38（两轮独立运行）、galgame-playthrough 8（含完整通关/跳章/BGM 开关/立绘切换，直接覆盖本轮乐观翻题与媒体改动）、survey-exit 4、trial+report 51、showcase-pagination + editor-layout + admin-telegram-login 10 |
| 视觉回归 · admin（`qa/visual/admin.spec.ts`） | 本机 **40 failed / 40 passed**，全部为字体 AA 与 ECharts 动画帧的亚像素差异（diff ratio ≈0.01）。**已在未改动的 HEAD 上用 `git worktree` 独立构建复现完全相同的 40 failed / 40 passed**，确认与本轮改动无关（本机环境差异，如 Chromium 字体栈；CI 为准）。 |
| 成就幂等性 | schema `UNIQUE (participant_hash, code)`（migration 0067）+ 仓储 `INSERT OR IGNORE` + 既有测试「only reports the first unlock」三重保障；本轮未改动成就逻辑，未新增测试（覆盖已存在）。 |

## 五、性能对比

### 5.1 生产实测（`wrangler tail` 的 request_metrics，同套方法对比）

上线后对 survey 118（58 题剧本卷）做真实请求探测（探针答卷/答案/限流行已全部从生产 D1 删除并核对为 0）：

| 指标（Worker 内部） | 原始基线（用户报告） | 本轮之前（上轮修复后） | 本轮部署后实测 | 说明 |
| --- | --- | --- | --- | --- |
| `POST .../answers`（下一题） | 879–924ms，10 D1 + 2 KV | 155–253ms | **182–194ms**（两次命中），d1q=8（2 批）、d1rows=63、KV=1（flow，与 batch 并行） | v1 串行 KV 版实测 394ms，改为并行后回落；读行数从整卷（58 题+选项 ≈150+ 行）降到 63 |
| `POST /responses`（开卷，flow 热） | 1035ms，8 D1 + 2 KV | 317ms | **461ms**，d1q=9、d1rows=31、KV=1 命中 | 冷 flow（首次/编辑后）一次 1206ms 含 395 行整卷读 + KV 写，之后走热路径 |
| `POST /responses`（续答） | — | — | 110ms（真实用户流量中捕获） | 答案内联返回，客户端不再补 GET |
| `GET /api/survey/:id`（定义，热） | — | 317ms（同接口口径） | **56–61ms** Worker 内部；端到端 0.45s | 3 语句 1 batch（survey+coin+settings）+ definition KV 命中 |
| 媒体端点 `GET /api/survey/media/:id` | — | 2–3 串行 D1 | 未命中 322ms/2 语句 1 批；**命中 34ms、d1q=0、KV=0** | 响应头实测：首次 `max-age=31536000, immutable`、命中返回边缘副本 `max-age=86400` |
| 首页列表 `GET /api/surveys` | — | — | 206–274ms、d1q=1（stamp 探针）、KV 命中 | 未改动 |

**测量条件**：`wrangler tail --format json` 捕获项目自带 `request_metrics`（durationMs/d1Queries/d1RowsRead/kvOps），请求经 `emoe.eu.cc` 直连（非中继），探测用真实匿名参与者 key；d1q 计的是**语句数**，往返数按代码结构计（`/answers` = 2 批）。

### 5.2 构建产物与路径计数（本地实测）

| 指标 | 优化前 | 优化后 | 测量方法 |
| --- | --- | --- | --- |
| 点击下一题到题目切换（前端） | ≈ 一个端到端保存往返（上轮实测 0.57–0.68s） | **≈ 0ms**（校验后立即切题，保存后台化） | 代码路径；**未做新一轮真实浏览器计时** |
| 答案保存完成时间 | 不变 | 不变（同一 API，串行队列） | — |
| `/answers` 的 D1 往返 | 3（participant 独立 + 读 batch + 写 batch） | **2**（匿名参与者折入读 batch；flow KV 读与 batch 并行） | 代码路径计数 + 生产 d1q |
| 打开问卷 Worker 内 D1 往返 | 3 串行（survey→coin→settings） | **1 batch**（coin 已折入） | 代码路径计数 |
| 打开问卷前端串行 API | 2–3（定义→开卷→续答取答案） | **2 并行 1**（定义 ∥ 开卷；续答答案内联） | 代码路径计数 |
| 媒体端点 D1 往返（未命中） | 2–3 串行 | **1 batch**；命中 **0** | 生产 d1q + 端点测试 |
| Telegram 媒体重复回源 | 每次浏览器缓存过期都现拉 | 每边缘 colo 24h 一次 | 设计保证；生产命中率**未测** |
| 首屏 JS 关键路径（survey.html 引用，gzip 实测） | ~203KB（survey 48.5 + react 97.4 + fingerprint 16.2 + icon 10.1 + css 30.5 + runtime） | **~160KB**（survey 20.0 + react 98.7 + icon 10.1 + css 30.5 + runtime）；fingerprint 与全部非答题屏移出关键图 | `gzip -9` 逐 chunk 实测 + `dist/survey.html` 引用清单 |
| 首个问卷请求是否等 FingerprintJS | 是（完整探测，低端机数百 ms CPU） | **否**（最多等 150ms，localStorage 命中时 0 等待） | 代码路径 + 设计保证 |
| 提交问卷端到端 | 读侧 5 个串行往返 | 读侧 **2 往返**（survey+KV、归属+答案+设置 batch）；写侧不变 | 代码路径计数 |

**诚实声明**：5.1 的毫秒数为单次探测（每路径 1–2 个样本，未做统计分布）；「未测」项保持标注，不做推断。探针请求路径与真实用户一致（同一 API、同一题库），但并发/网络环境与真实流量不完全相同。

## 六、未完成与后续建议

1. **端到端浏览器复测**：生产已验证 Worker 内部指标；建议再用真实浏览器经中继复测「点击→切题」的用户可见延迟（本轮的乐观导航使前端不再等待保存，理论点击延迟≈0ms + 渲染）。
2. **`POST /responses` 仍可再折一轮**：匿名参与者的 `participant_links` 解析（1 往返）与 create 前的 resume/policy 批次可与首 batch 进一步合并（与 `/answers` 同构），预估再省 ~90ms；本轮因该处理器涉及 Telegram/邮箱/关联三种身份语义而保守未动。**评估结论：收益/风险不成比例，不建议做**——省的是「每会话一次 × 仅匿名浏览器用户」的 90ms，而失误代价是答卷归属错误；Telegram/邮箱身份本来就需要查用户表，折不掉。
3. **CSS 拆分**（188KB/30KB gz 共享样式）未做：daisyUI 全主题被主题选择器依赖，需要按入口拆 theme layer。
4. **survey-list 缓存键仍需一次 stamp 探针**（每次首页加载 1 个 D1 往返）：可改为「变更时删键」的失效反转，涉及全部 mutation 路径审计，本轮未动。
5. **关闭/归档时的边缘缓存主动 purge** 未实现（Cache API 需逐 URL 删除）；当前以 24h TTL 封顶并在上文记录取舍。
6. ~~**D1 区域迁移**~~：已证伪——D1 当前已在 APAC（见 P9），location hint 无城市级粒度，迁移没有目标可迁。若仍要压 RTT，只能走 read replication 试点（未实施）。
7. admin 暗色视觉快照建议在 CI 上重新基线化（本机字体 AA 与 ECharts 动画帧不稳定，证据见第四节）。

## 七、部署记录

| 时间 | 版本 ID | 内容 |
| --- | --- | --- |
| 2026-10-15 | `8af9ca1c` | 本轮全部优化首次上线（P0–P8；flow 缓存为 v1 串行版） |
| 2026-10-15 | `fabbb932` | flow 缓存 v2：KV 读与 batch 并行（修复 v1 的 394ms 串行开销） |
| 2026-10-15 | `248bf708` | 开卷路径金币开关折入首 batch |

部署前检查：`wrangler d1 migrations list --remote` 无待应用迁移（本轮无 schema 变更）。数据边界：所有性能探测产生的答卷（3417/3418/3420）、答案与限流行已删除并核对为 0；未产生任何其他生产数据变更。回滚方式：`wrangler rollback`（云侧保留历史版本）。

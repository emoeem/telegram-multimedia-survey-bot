# Telegram Multimedia Survey Bot

> **生产状态：已上线（2026-09-18）**
>
> 一个运行在 Cloudflare Workers 上的 Telegram 多媒体问卷平台。用户可以直接在 Telegram 中创建、发布和填写问卷，也可以通过 Web 完成填写、查看个人报告、参与任务与社区功能。创建者拥有完整的问卷编辑、导入、结果规则、报告模板、答卷管理和导出能力。

## 目录

- [项目定位](#项目定位)
- [核心能力](#核心能力)
- [产品架构](#产品架构)
- [数据与存储](#数据与存储)
- [问卷生命周期](#问卷生命周期)
- [Result Engine 2.0](#result-engine-20)
- [Participant Report 2.0](#participant-report-20)
- [报告模板系统](#报告模板系统)
- [Telegram 归档](#telegram-归档)
- [编辑器与导入器](#编辑器与导入器)
- [管理端](#管理端)
- [D1 免费额度与数据库安全](#d1-免费额度与数据库安全)
- [可靠性与幂等](#可靠性与幂等)
- [性能与前端拆分](#性能与前端拆分)
- [测试与质量门禁](#测试与质量门禁)
- [生产部署](#生产部署)
- [Telegram Webhook](#telegram-webhook)
- [本地开发](#本地开发)
- [Migration](#migration)
- [项目结构](#项目结构)
- [安全与隐私](#安全与隐私)
- [商业授权](#商业授权)
- [文档索引](#文档索引)

## 项目定位

本项目不是一个单纯的 Telegram Bot，而是一套 **Telegram + Web 的问卷与个人报告平台**。核心原则是：

1. 问卷数据、答案和结果计算与展示层分离；
2. Participant Report 面向填写者本人，Creator Analytics 面向创建者；
3. Result Rules 必须由创建者显式定义，不能把普通数字或长文本猜成“人格分析”；
4. 报告 Web、PDF、图片和 Telegram 归档共享同一份 ReportViewModel；
5. 数据库查询必须可观测、可解释，并对 Cloudflare D1 免费额度设置硬护栏；
6. 不依赖常驻 VPS、Docker 进程或自建 PostgreSQL。

生产 Worker：`telegram-multimedia-survey-bot`

生产地址：`https://telegram-multimedia-survey-bot.pd2335346.workers.dev`

健康检查：`GET /health`

## 核心能力

### 问卷

- 多问卷、多创建者、多权限模型；
- 创建、编辑、保存、发布、关闭、重新开放、归档、复制、删除；
- 单选、多选、文本、长文本、数字、评分、日期、时间、是非及媒体题；
- 题目、选项、回答均可关联图片、视频、音频和文件；
- 分页、题目排序、选项排序、上一题、恢复填写、修改答案；
- 访问密码、公开/受限访问和完成状态管理；
- 已存在答卷的问卷进入结构保护流程，避免修改历史数据语义。

### Telegram

- `/start`、`/surveys`、`/create`、`/continue`、`/import` 等核心流程；
- Telegram 内创建和填写问卷；
- 管理员问卷、用户、授权和导出管理；
- Webhook update 幂等与失败重试；
- 报告 PDF、图片和结构化 ZIP 归档到私人 Telegram 频道。

### Web

- 管理后台；
- 响应式问卷填写；
- Participant Report；
- 报告模板选择与预览；
- 任务系统、排行榜、个人画廊、广场/树洞；
- 邮箱 + 密码身份系统；
- Telegram WebApp/身份接入；
- Open Graph 分享预览卡。

### 创建者工具

- 可视化问卷编辑器；
- 结构树搜索与批量设置必答/选填；
- undo/redo、autosave、stale detection；
- JSON 导入、格式化、复制、重复问卷检测；
- PDF / Microsoft Forms / Office 文档 / URL 导入链路；
- Result Rules 结果设计器；
- 实时“测试答案 / 结果预览”；
- 报告模板绑定、可视化模板预览；
- CSV / XLSX / JSON / ZIP / PDF 导出。

## 产品架构

```text
                           ┌─────────────────────┐
                           │      Telegram       │
                           │ Bot / WebApp / 用户 │
                           └──────────┬──────────┘
                                      │ Webhook / HTTPS
                                      ▼
┌──────────────────────────────────────────────────────────────────────┐
│                         Cloudflare Worker                             │
│                                                                      │
│  Telegram Router   Admin API   Survey API   Report API   Auth API    │
│        │               │           │            │           │         │
│        └───────────────┴───────────┴────────────┴───────────┘         │
│                              │                                       │
│                    Domain / Service Layer                            │
│                              │                                       │
│       Result Engine ─ Participant Report ─ Report Renderer          │
│             │                  │                  │                  │
│       Survey Builder      Media Pipeline      Export Worker         │
└───────────────┬──────────────────┬──────────────────┬───────────────┘
                │                  │                  │
                ▼                  ▼                  ▼
        ┌────────────┐      ┌──────────────┐    ┌──────────────┐
        │ D1 SQLite  │      │ KV / Media   │    │ Queues       │
        │ source data│      │ cache/assets │    │ async jobs   │
        └────────────┘      └──────────────┘    └──────────────┘
                │
                ▼
        Durable Objects
   session / builder / UI state
```

### Cloudflare 组件

| 组件              | 用途                                                   |
| ----------------- | ------------------------------------------------------ |
| Workers           | HTTP、Telegram Webhook、业务路由与任务入口             |
| D1                | 问卷、题目、选项、答案、用户、报告投递、审计等持久数据 |
| KV                | 公开接口缓存、临时媒体等低延迟数据                     |
| Durable Objects   | 填写会话、Builder 状态、UI Session                     |
| Queues            | 导出、报告投递及异步任务                               |
| Browser Rendering | HTML → PDF/图片报告渲染                                |
| Workers Assets    | Admin 与 Web 静态资源                                  |

## 数据与存储

核心关系包括：

- `surveys` / `survey_questions` / `question_options`；
- `survey_responses` / `answers`；
- `media_assets` 及 question/option/answer media 关系；
- `survey_result_rule_sets`；
- `report_deliveries`；
- Telegram update dedup；
- 用户、身份、任务、社区和审计数据。

历史 migration 保持不重写原则。新结构通过递增 migration 添加，当前生产已完成至 `0053`。

## 问卷生命周期

```text
创建 / 导入
    ↓
草稿编辑
    ↓
结构校验 + 结果规则 + 报告模板
    ↓
发布前检查
    ↓
发布
    ↓
Telegram / Web 填写
    ↓
答案持久化
    ↓
Result Engine
    ↓
Participant Report
    ├── Web Report
    ├── PDF
    ├── 分享图片
    └── Telegram 私人频道归档
```

## Result Engine 2.0

Result Engine 的职责是**计算事实和确定性结果**，而不是生成无法解释的心理推断。

创建者可以在编辑器的“结果规则”中定义：

- 评分维度；
- 维度最小/最大值和单位；
- 哪些题目参与某个维度；
- 每个选项对应的分值；
- 多选答案的逐项计分；
- 最终结果类型；
- 结果类型的总分区间；
- 结果标题、副标题、描述、标签和图片。

计算链路：

```text
Answers
  ↓
Dimension Scoring
  ↓
Dimension Stats
  ↓
Total Score
  ↓
Result Type Matching
  ↓
Participant Report
```

### 实时结果设计器

编辑器可以直接模拟测试答案，不写入真实答卷：

```text
Q1 = A ──→ 独立性 +5
Q2 = C ──→ 独立性 +3
Q3 = B ──→ 社交性 +5

独立性   8 / 10
社交性   5 / 10
总分    13 / 20

最终结果：探索型
为什么：总分 13 落在「探索型」区间
```

预览会即时显示每个维度得分、总分、命中结果、结果区间、标题/标签以及匹配原因。没有结果命中时，会直接提示覆盖范围不足。

详细设计见 [`docs/RESULT_ENGINE_2_0.md`](docs/RESULT_ENGINE_2_0.md)。

## Participant Report 2.0

Participant Report 是**填写者自己的报告**，与创建者统计报告明确分离。

系统会先判断问卷语义：

- 个人档案；
- 测评；
- 偏好画像；
- 普通问卷；
- 普通表单。

个人档案中的姓名、年龄、身高、体重、城市、职业、照片、语音等属于资料事实，不会被错误计算成“人格分数”。普通长文本也不会仅因为文本很长就自动变成“人格/行为/关系模式”。

有显式 Result Rules 的测评则使用规则计算维度和最终结果。

默认报告模板映射：

| 问卷类型 | 默认模板 |
| -------- | -------- |
| 个人档案 | 身份档案 |
| 测评     | 数据分析 |
| 偏好画像 | 杂志     |
| 普通问卷 | 经典     |
| 普通表单 | 完整问答 |

问卷显式绑定的模板优先级最高。

## 报告模板系统

报告不是“PDF 专用代码”，而是：

```text
ReportViewModel
       ↓
ReportTemplateSpec
       ↓
 ┌─────┼─────┐
 ▼     ▼     ▼
 Web   PDF  Image
```

同一份报告数据可以输出 Web、PDF、图片分享卡和 Telegram 归档。

当前后台模板库提供不同用途的模板预览，例如：

- 经典报告；
- 完整问答；
- 杂志暗色；
- 数据分析；
- 身份档案；
- 艺术档案；
- 杂志；
- 极简；
- 影集。

模板只改变报告的结构、布局和视觉主题，不改变答案计算与 Result Engine 结果。

管理端模板页已经加入可视化 schematic preview；实际 HTML/PDF 预览仍由报告渲染管线负责。

详细说明见 [`docs/REPORT_TEMPLATE_SYSTEM.md`](docs/REPORT_TEMPLATE_SYSTEM.md)。

## Telegram 归档

完成答卷的归档会尽量生成结构化 ZIP，而不是把 PDF 和图片无序地平铺在频道里：

```text
report-42.zip
├── 00-index.json
├── 01-report/
│   ├── report.pdf
│   └── result.json
├── 02-answers/
│   └── answers.json
├── 03-attachments/
│   ├── 01-gallery.1.jpg
│   └── 02-gallery.2.jpg
├── 04-profile/
│   ├── 01-avatar.jpg
│   └── 02-portrait.jpg
└── 05-result-assets/
    └── ...
```

`00-index.json` 保存问卷、答卷、完成时间、用户信息和文件清单；目录按照报告、答案、附件、资料和结果素材分类。超过 Telegram 发送安全阈值时，系统降级为 PDF + 图片逐项发送。

报告投递使用 `report_deliveries.delivery_id` 幂等键，并支持失败重试与管理员通知。

详细说明见 [`docs/REPORT_ARCHIVE.md`](docs/REPORT_ARCHIVE.md)。

## 编辑器与导入器

### 编辑器

当前编辑器保留并强化已有的核心状态模型：

- draft lock；
- autosave；
- stale detection；
- undo/redo；
- structure tree；
- pagination；
- question/option duplication；
- media management；
- live preview。

新增能力包括题目搜索和搜索结果批量设置必答/选填，以及 Result Rules 实时测试答案。

### 导入

统一导入链路支持：

- survey JSON；
- PDF；
- Microsoft Forms；
- OneDrive / SharePoint / Word Online；
- 直接 PDF/JSON URL；
- 图片与媒体；
- 分页、置信度、结构化 issue；
- 自动修复与导入前后校验；
- 同名问卷重复检测；
- JSON 格式化与复制。

推荐先把导入结果作为草稿检查，再发布。

## 管理端

Admin 是完整的 Web 管理控制台，主要区域包括：

- Dashboard；
- Surveys；
- Survey Editor；
- Responses / Response Detail；
- Analytics；
- Versions；
- Reports；
- Report Templates；
- Import；
- Task Packs；
- Plaza；
- Profile Gallery；
- Users；
- Audit；
- Settings；
- Licenses。

### 全局 UI

本轮完成了全局 UI 统一，而不是只美化编辑器：

- 统一卡片、输入框、按钮、表格、Badge、空状态；
- 统一圆角、间距、边框和 hover/focus 状态；
- 浅色/深色主题一致性；
- 移动端布局；
- 登录页独立于后台导航壳；
- 顶层页面避免错误显示“返回上一页”；
- 模板、Result Rules 和报告区域采用更明确的信息层级。

视觉回归覆盖 **20 个路由 × 2 主题 × 2 viewport = 80 组组合**。

## D1 免费额度与数据库安全

这是本项目上线阶段最重要的基础设施护栏之一。

Cloudflare D1 Free 的每日额度按账号计算，当前项目重点关注：

- Rows Read：5,000,000 / day；
- Rows Written：100,000 / day；
- Storage：5 GB。

D1 的 Rows Read 是**扫描行数**，不是最终返回行数。因此一个返回 10 行但扫描百万行的查询依然可能快速耗尽免费额度。

### 本次线上事故与修复

2026-09-14 曾出现约 **5,341,161 rows read** 的异常日级峰值，根因是维护清理路径中的媒体孤儿扫描没有可靠使用完整索引路径，导致大范围扫描。

本轮修复包括：

1. 为媒体引用关系补齐索引；
2. orphan-media 查询在执行前检查必要索引；
3. 维护任务增加 `MAINTENANCE_ROWS_READ_BUDGET = 500,000` 硬预算；
4. 每个维护步骤读取 `meta.rows_read`，超预算立即停止后续步骤；
5. 新增请求级 D1 行读/写指标；
6. 队列任务同样纳入 D1 成本统计；
7. 公开只读接口使用带版本/更新时间戳的 KV cache；
8. cron 从过密的重试节奏调整为 `*/30 * * * *`。

### 线上验证

修复后的 D1 日级数据明显下降：

| 日期                 | Rows Read |
| -------------------- | --------: |
| 2026-09-14           | 5,341,161 |
| 2026-09-15           |   580,553 |
| 2026-09-16           |   721,819 |
| 2026-09-17           |   374,591 |
| 2026-09-18（验收时） |   102,712 |

这些是 D1 日 bucket 聚合数据，最后一天是验收时的部分数据，不应解读为精确滚动 24 小时统计。

生产 EXPLAIN 已确认 orphan-media 核心查询使用 `SEARCH ... USING INDEX` / covering index，没有发现之前的全表 `SCAN` 路径。

最近生产 1d insights 中，最高的单条查询累计读取约 72k 行，远低于此前百万级异常查询。

详细规则见 [`docs/FREE_TIER_BUDGET.md`](docs/FREE_TIER_BUDGET.md)。

## 可靠性与幂等

### Telegram update dedup

Webhook 在真正处理前执行：

```text
verify secret
    ↓
parse update
    ↓
dedup.claim(update_id)
    ├── duplicate → 直接 200
    └── claimed → handle update
                    ├── success → complete
                    └── failure → release
```

`telegram_update_dedup` 防止 Telegram 重复投递导致副作用重复执行。`processing` 状态支持超时接管，避免进程崩溃后永久吞掉操作。

### 报告投递

报告投递使用唯一 `delivery_id`，失败根据错误类型区分 retryable / terminal，并采用退避：

```text
1m → 5m → 15m → 1h
```

最多 5 次；配置错误不会无意义地无限重试。

### 观测

请求和队列批次会输出结构化指标：

- route；
- method；
- status；
- duration；
- D1 query / rows read / rows written；
- KV hits / misses；
- queue sends / messages；
- Telegram update / duplicate update。

日志不记录密码、token、完整答案或请求体。

## 性能与前端拆分

Admin 已采用 route-level `React.lazy`，ECharts 也采用动态 import。

最近生产构建中的主要 chunk：

| Chunk              |      Raw |     Gzip |
| ------------------ | -------: | -------: |
| main               |  ~111 kB | ~36.6 kB |
| survey             |  ~145 kB | ~42.5 kB |
| pwa/shared         |  ~194 kB | ~61.9 kB |
| ECharts lazy chunk | ~1.13 MB |  ~376 kB |

ECharts 大 chunk 保持懒加载，因此不会进入普通后台首页初始下载。

## 测试与质量门禁

生产发布前已经完成：

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build:admin
git diff --check
pnpm exec playwright test qa/visual/admin.spec.ts --project=chromium
```

结果：

- TypeScript typecheck：通过；
- ESLint：通过；
- Vitest：全部通过，最终超过 548 个测试；
- Admin production build：通过；
- Git diff check：通过；
- Admin visual regression：80/80 通过；
- 生产 `/health`：HTTP 200；
- 生产 Admin shell：HTTP 200；
- 公开 Survey API：HTTP 200；
- D1 migration：生产无待应用 migration；
- D1 EXPLAIN：关键清理查询确认走索引；
- D1 Row Metrics：修复后无百万级异常查询。

## 管理后台登录

浏览器管理后台使用 **Telegram Bot Deep Link + 确认** 登录，不依赖 BotFather Login/OIDC 配置。

`/admin/login` → 创建 5 分钟 KV 登录请求 → 打开 Telegram Bot Deep Link → 管理员点击「确认登录」 → 浏览器轮询状态 → 签发现有 7 天 `admin_session`。登录请求使用随机 ID + HMAC 绑定 Cookie，不写 D1。

旧的 `/api/admin/auth/browser?t=...` bearer 登录入口仅保留兼容重定向，不再直接建立会话。

## 生产部署

生产配置位于 `wrangler.toml`，当前 Worker 使用：

```toml
name = "telegram-multimedia-survey-bot"
main = "src/index.ts"
```

生产资源包括：

- D1：`telegram-survey-db`；
- `MEDIA_KV`；
- `CACHE`；
- `EXPORT_QUEUE`；
- Durable Objects：`SurveySessionDO`、`SurveyBuilderDO`、`UiSessionDO`；
- Browser Rendering；
- Workers Assets。

标准部署：

```bash
pnpm install
pnpm build:admin
pnpm exec wrangler d1 migrations apply DB --remote
pnpm exec wrangler deploy
```

生产部署前必须先确认：

1. `wrangler whoami` 指向正确 Cloudflare 账号；
2. D1 migration 状态；
3. secrets 存在且没有进入 Git；
4. `pnpm typecheck && pnpm lint && pnpm test` 全部通过；
5. Admin build 通过；
6. `/health` smoke test；
7. D1 Row Metrics / Insights；
8. 关键查询 `EXPLAIN QUERY PLAN`。

### GitHub Actions

仓库可以通过 GitHub Actions 执行质量检查和部署。生产凭据应使用：

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

不要把 token、Bot Secret、数据库密码或客户授权密钥写入 workflow。

## Telegram Webhook

创建 Bot 后通过 BotFather 获取 Token。部署完成后设置 Webhook：

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://<worker>.workers.dev/telegram/webhook","secret_token":"<WEBHOOK_SECRET>","allowed_updates":["message","callback_query","channel_post"]}'
```

`allowed_updates` 必须包含 `channel_post`，否则私人报告归档频道的相关事件无法完整接收。

敏感配置：

- `BOT_TOKEN`；
- `WEBHOOK_SECRET`；
- `ADMIN_IDS`；
- `LICENSE_KEY`；
- 其他第三方凭据。

应使用 Cloudflare Secrets 或未跟踪的 `.dev.vars` 保存。

## 本地开发

```bash
cp .dev.vars.example .dev.vars
pnpm install
pnpm typecheck
pnpm test
pnpm dev
```

健康检查：

```text
GET http://127.0.0.1:8787/health
```

Admin 默认由 Worker Assets 提供，开发时根据 Wrangler 输出访问本地地址。

## Migration

本地：

```bash
pnpm migrate:local
```

远程：

```bash
pnpm migrate:remote
```

查看生产状态：

```bash
pnpm exec wrangler d1 migrations list telegram-survey-db --remote
```

历史 migration 不应修改、删除或重用 tag。新增结构必须增加新的 migration。

## 项目结构

```text
telegram-bot/
├── src/
│   ├── bot/                  Telegram Bot / update router
│   ├── db/                   D1 schema / repositories
│   ├── http/                 Admin / Survey / Report / Auth APIs
│   ├── observability/        request / queue metrics
│   ├── result/               Result Engine schema
│   └── services/             report / import / media / task / auth 等领域服务
├── admin/
│   ├── src/components/       通用 UI 与编辑器组件
│   ├── src/routes/           Admin 页面
│   └── src/survey/            Web Survey / Plaza / Trial
├── db/migrations/             D1 migrations
├── tests/unit/                单元测试
├── qa/visual/                 Playwright 视觉回归
├── scripts/                   导入、授权、发布辅助脚本
├── docs/                      架构、部署、产品和运维文档
├── delivery/                  客户交付包
├── tg-archive/                Telegram 归档相关工具/说明
└── wrangler.toml              生产 Cloudflare 配置
```

## 安全与隐私

- 不提交 `.dev.vars`、Bot Token、Webhook Secret、API key；
- 生产 secrets 通过 Cloudflare Secret 管理；
- 不把用户完整答案写入结构化日志；
- 匿名问卷的原始身份不应出现在不必要的结果或导出中；
- 报告媒体代理必须验证 response 所有权；
- 导出、删除、发布等高影响操作必须经过权限检查；
- 结果规则由后端 schema 校验，禁止可执行表达式；
- ZIP 归档中的 `answers.json` 只应发送到配置好的私人归档频道。

## 商业授权

项目包含厂商控制的 License Server 能力。

支持：

- timed；
- perpetual；
- updates_until；
- max_activations；
- suspend / resume / revoke；
- 客户 Worker 定期在线校验与有限离线宽限。

许可证明文只在创建时显示一次，服务端持久化 SHA-256 hash。

厂商自己的 Worker 保持：

```toml
LICENSE_ENFORCEMENT = "disabled"
```

客户部署使用 `LICENSE_ENFORCEMENT = "required"`，并通过 Secret 注入 `LICENSE_KEY`。

## 文档索引

### 核心架构

- [`docs/PLATFORM_2_0_AUDIT.md`](docs/PLATFORM_2_0_AUDIT.md) — 平台 2.0 产品审计与优化记录
- [`docs/MODULARIZATION.md`](docs/MODULARIZATION.md) — HTTP / Bot 模块化拆分
- [`docs/BOT_2_0_IMPLEMENTATION.md`](docs/BOT_2_0_IMPLEMENTATION.md) — 可观测性、幂等、批量查询、前端拆分

### Result / Report

- [`docs/RESULT_ENGINE_2_0.md`](docs/RESULT_ENGINE_2_0.md) — Result Rules 与实时结果设计器
- [`docs/REPORT_TEMPLATE_SYSTEM.md`](docs/REPORT_TEMPLATE_SYSTEM.md) — 报告模板与 Renderer 架构
- [`docs/REPORT_ARCHIVE.md`](docs/REPORT_ARCHIVE.md) — Telegram 报告归档管线与 ZIP v2

### 数据库 / 运维

- [`docs/FREE_TIER_BUDGET.md`](docs/FREE_TIER_BUDGET.md) — D1 免费额度纪律与线上事故复盘
- [`docs/HANDOVER.md`](docs/HANDOVER.md) — 项目交接信息
- [`docs/PROJECT_REPORT.md`](docs/PROJECT_REPORT.md) — 项目状态与生产资源

### 导入 / 部署

- [`docs/WINDOWS_CUSTOMER_DEPLOYMENT.md`](docs/WINDOWS_CUSTOMER_DEPLOYMENT.md) — Windows 客户部署与交付
- [`docs/TELEGRAM_ARCHIVE_RESEARCH.md`](docs/TELEGRAM_ARCHIVE_RESEARCH.md) — Telegram 归档研究
- [`docs/WEB_ADMIN_EDITOR_API.md`](docs/WEB_ADMIN_EDITOR_API.md) — Admin Editor API
- [`docs/WEB_ADMIN_MIGRATION_PLAN.md`](docs/WEB_ADMIN_MIGRATION_PLAN.md) — Admin 迁移规划

## 版本与发布原则

当前线上 Worker 版本为 `0.3.0`。生产发布必须同时考虑：

1. 源码变更；
2. Admin 静态资源；
3. D1 migration；
4. Telegram Webhook；
5. Queue / Durable Object 配置；
6. secrets；
7. D1 Row Metrics；
8. 回归测试。

发布不是“代码能编译”就算完成。对于本项目，**数据库迁移 + Worker 部署 + smoke test + D1 线上指标**共同构成生产验收闭环。

---

**当前状态：生产运行中。**

本仓库的后续开发应优先保持数据库成本、数据一致性、幂等和报告结果正确性，再继续增加产品功能。

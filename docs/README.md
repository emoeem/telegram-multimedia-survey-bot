# 文档索引

> 这个目录 70+ 份文档，按「现在还要不要看」分成三层：
> **① 根目录 = 还活着的权威文档**（会更新，先看这里）；**② 子目录 = 分类手册与记录**；
> **③ `archive/` = 历史留档**（只读，结论可能已被后续迭代推翻，不要照着做）。

## 一、从这里开始（3 份）

| 文档                                                             | 什么时候看                                                                                |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [`HANDOVER.md`](HANDOVER.md)                                     | **接手项目第一步。** 现状、已完成的里程碑、最容易踩的坑、接手检查清单                     |
| [`UPGRADE_ROADMAP_2026-10-28.md`](UPGRADE_ROADMAP_2026-10-28.md) | **后面还要做什么。** 唯一执行计划（阶段 A–F，带 ✅/☐ 勾选状态）——想知道"还欠什么"只看这份 |
| [`FEATURE-OVERVIEW.md`](FEATURE-OVERVIEW.md)                     | 产品有什么功能、每个功能对应哪些文档与代码                                                |

## 二、分类目录

### `ops/` — 运维、成本、部署（10 份）

线上出问题、要配额度、要交付客户时看这里。

| 文档                                                                       | 内容                                               |
| -------------------------------------------------------------------------- | -------------------------------------------------- |
| [`ops-runbook.md`](ops/ops-runbook.md)                                     | 故障预案：D1 备份恢复、预算告警、国内中继故障      |
| [`ops-alerting.md`](ops/ops-alerting.md)                                   | 告警接入（预算异常日志 → 通知）                    |
| [`COST-GUARDRAILS.md`](ops/COST-GUARDRAILS.md)                             | 成本红线与降级策略，含"还没做的"人工项             |
| [`FREE_TIER_BUDGET.md`](ops/FREE_TIER_BUDGET.md)                           | D1 免费额度纪律、线上事故复盘、反刷边界            |
| [`CLOUDFLARE_PLAN_TIERS.md`](ops/CLOUDFLARE_PLAN_TIERS.md)                 | 付费能力探测与降级原则（Stream/Images/R2/队列）    |
| [`CN_ACCESS_VERCEL_RELAY.md`](ops/CN_ACCESS_VERCEL_RELAY.md)               | 国内可达性：Vercel 中继（emoemok.top）的部署与排障 |
| [`CUSTOMER_DEPLOY.md`](ops/CUSTOMER_DEPLOY.md)                             | 客户部署（vendor/customer 角色、授权）             |
| [`WINDOWS_CUSTOMER_DEPLOYMENT.md`](ops/WINDOWS_CUSTOMER_DEPLOYMENT.md)     | Windows 环境客户部署与交付                         |
| [`WEB_SUBMISSIONS_MERGE.md`](ops/WEB_SUBMISSIONS_MERGE.md)                 | 免登录投稿并轨的上线切换与旧 Worker 退役（含回滚） |
| [`STAGING_D3_WRITE_SIDE_RUNBOOK.md`](ops/STAGING_D3_WRITE_SIDE_RUNBOOK.md) | staging 实测手册（§5b 有 2026-10-29 的实测记录）   |

### `guides/` — 功能与操作手册（14 份）

改某个功能之前先读对应手册。

| 文档                                                                    | 内容                                  |
| ----------------------------------------------------------------------- | ------------------------------------- |
| [`EDITOR_GUIDE.md`](guides/EDITOR_GUIDE.md)                             | 问卷编辑器使用与设计说明              |
| [`HANDOVER_EDITOR_P2_PLAN.md`](guides/HANDOVER_EDITOR_P2_PLAN.md)       | 编辑器 P2 三栏壳的交接与验收清单      |
| [`HOTSPOT_EDITOR_HANDOVER.md`](guides/HOTSPOT_EDITOR_HANDOVER.md)       | 互动场景编辑器的交接                  |
| [`EDITOR_PLUGIN_ARCHITECTURE.md`](guides/EDITOR_PLUGIN_ARCHITECTURE.md) | 编辑器插件架构（玩法 draw 等）        |
| [`QUESTION_TYPES.md`](guides/QUESTION_TYPES.md)                         | 题型与数据模型                        |
| [`HOTSPOT_SCENES.md`](guides/HOTSPOT_SCENES.md)                         | 互动场景（scene）配置格式             |
| [`RESULT_ENGINE_2_0.md`](guides/RESULT_ENGINE_2_0.md)                   | Result Rules 与实时结果设计器         |
| [`REPORT_TEMPLATE_SYSTEM.md`](guides/REPORT_TEMPLATE_SYSTEM.md)         | 报告模板与 renderer 架构              |
| [`REPORT_ARCHIVE.md`](guides/REPORT_ARCHIVE.md)                         | Telegram 报告归档管线与 ZIP v2        |
| [`COIN_ECONOMY.md`](guides/COIN_ECONOMY.md)                             | 金币经济、抽卡、挑战                  |
| [`CERT_CARDS.md`](guides/CERT_CARDS.md)                                 | 认证卡生成器（版式/评分/18+ 门禁）    |
| [`SHOWCASE.md`](guides/SHOWCASE.md)                                     | 展示区（`/showcase`）                 |
| [`EMAIL_DELIVERABILITY.md`](guides/EMAIL_DELIVERABILITY.md)             | 邮件送达率（发信域、SPF/DKIM）        |
| [`WEB_VIEW_ARCHIVE_MVP.md`](guides/WEB_VIEW_ARCHIVE_MVP.md)             | `tg-archive` 网页版归档的最小实现设计 |

### `releases/` — 更新记录（12 份）

每次上线的对外说明，命名 `RELEASE_YYYY-MM-DD[_主题].md`。格式固定：元信息表
（部署版本 ID / 线上入口 / 迁移 / 测试数）+ 分章正文。**新的一份按最近一份的骨架写。**
最新：`RELEASE_2026-10-29_SUBMISSIONS_UI.md`。

### `reports/` — 报告（3 份）

| 文档                                                             | 内容                                                           |
| ---------------------------------------------------------------- | -------------------------------------------------------------- |
| [`WORK_REPORT_2026-10-29.md`](reports/WORK_REPORT_2026-10-29.md) | 发布链路加固的交付报告：结论表、门禁实测、已知限制、下一步建议 |
| [`PROJECT_REPORT.md`](reports/PROJECT_REPORT.md)                 | 项目完成情况报告（2026-08-23，历史基线）                       |
| [`round-p1.md`](reports/round-p1.md)                             | P1 功能增强的一轮交付报告                                      |

### `audits/` — 审计与专项记录（7 份 + 截图目录）

| 文档                                                                          | 内容                                                     |
| ----------------------------------------------------------------------------- | -------------------------------------------------------- |
| [`CODE_AUDIT_2026-09-27.md`](audits/CODE_AUDIT_2026-09-27.md)                 | 全量代码审计（P0–P2；多数已修复，未修项见路线图）        |
| [`PLATFORM_2_0_AUDIT.md`](audits/PLATFORM_2_0_AUDIT.md)                       | 平台 2.0 产品审计                                        |
| [`ADMIN_UI_2_AUDIT.md`](audits/ADMIN_UI_2_AUDIT.md)                           | Admin UI 2.0 现状审计                                    |
| [`UIUX-AUDIT-2026-10-22.md`](audits/UIUX-AUDIT-2026-10-22.md)                 | UI/UX 审计（分批评方案，B 批已实施）                     |
| [`ui-audit-2026-10.md`](audits/ui-audit-2026-10.md)                           | 首页/认证页视觉审计（截图在 `ui-audit-2026-10-assets/`） |
| [`PERF_E2E_OPTIMIZATION_2026-10.md`](audits/PERF_E2E_OPTIMIZATION_2026-10.md) | 性能与 E2E 优化记录                                      |
| [`UI_REWORK_PROGRESS_2026-10.md`](audits/UI_REWORK_PROGRESS_2026-10.md)       | 界面改造进度台账                                         |

### `archive/` — 历史留档（20 份，只读）

已完成的一次性计划、被取代的架构方案、调研报告、提案。**不要照做**——结论可能已经
变了，只在追溯"当初为什么这么设计"时查。

- 已完成计划：`PHASE2_PLAN`、`MODULARIZATION`、`BOT_2_0_IMPLEMENTATION`、
  `P0_TIERING_SHARE_IDENTITY_DESIGN`（已实施）、`REPORT-IMAGE-DELIVERY-PLAN`（已实施）
- 已被取代：`WEB_ADMIN_*`（5 份 + `web-admin-phase-1`）、`WEB_SURVEY_PHASE_3`、
  `UI_PLATFORM_2_0_PLAN`、`THREE_TIER_ARCHITECTURE`
- 调研：`TELEGRAM_ARCHIVE_RESEARCH`、`SHOWCASE_FRONTEND_RESEARCH_2026-10`、`RECOMMENDED_STACK`
- 提案/对外材料：`BOT_GOVERNANCE_PROPOSAL`、`FRANCHISE_PROPOSAL`

## 三、约定

1. **新增文档放哪**：还活着的（会被更新、要经常查）→ 对应子目录；一次性的（审计、
   报告、已完成计划）→ `audits/`、`reports/`、`archive/`。
2. **更新记录**：`docs/releases/RELEASE_YYYY-MM-DD[_主题].md`，同一天多批就用主题后缀。
3. **路径写法**：代码注释与跨文档引用一律写**完整相对仓库根的路径**
   （`docs/guides/QUESTION_TYPES.md`），避免移动目录后大面积断链。改目录后跑一遍
   链接检查（见下）。
4. **`archive/` 不加新内容**，也不在里面续写；要复活某份计划，先移到对应子目录再改。
5. 被代码注释引用的 5 份文档（`CN_ACCESS_VERCEL_RELAY`、`CLOUDFLARE_PLAN_TIERS`、
   `HOTSPOT_SCENES`、`COST-GUARDRAILS`、`WEB_VIEW_ARCHIVE_MVP`）已分别归入 `ops/`、
   `guides/`，代码里同步了路径——再移动它们需要一起改代码注释。

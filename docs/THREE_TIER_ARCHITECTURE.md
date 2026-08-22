# 三端架构方案：Telegram / Web Admin / Telegraph

> 2026-08-22。定位：**目标架构与实施路线，关键产品决策已确认**。
> 目标架构（用户定义）：
> **Telegram = 用户端 + 快捷管理；Web Admin = 完整后台；Telegraph = 对外问卷目录。**
> 与既有文档的关系：本文档是 `docs/WEB_ADMIN_MIGRATION_PLAN.md`（阶段路线）+ `docs/WEB_ADMIN_EDITOR_RESEARCH.md`（Phase 2.0 编辑器方案）的**上层架构整合**，不推翻已批的 Phase 2 计划。

## 1. 三端职责边界（目标态）

| 端 | 职责 | 明确不做 |
| -- | -- | -- |
| **Telegram Bot** | ① 答题全流程（唯一答题入口，保留）；② 快捷管理：问卷暂停/续填/查状态/发布确认/导出触发等**单步轻操作**；③ 通知通道（导出完成、渲染完成、Telegraph 发布结果）；④ 管理入口：`/admin` → 「🌐 网页管理后台」按钮 | 多步管理向导（迁 Web）、统计浏览、模板编辑、用户管理、媒体管理 |
| **Web Admin**（Mini App，`/admin`） | 全部管理 CRUD：问卷编辑器（Phase 2 方案）、答卷浏览/统计、结果模板编辑、媒体库（按 scope 分区）、用户管理、导入/导出、Telegraph 目录管理、访问密码 | 答题（用户在 bot 答题）、对外公开页 |
| **Telegraph**（telegra.ph） | 对外问卷目录：自动生成的目录页（在填问卷列表）+ 可选的单问卷落地页（标题/描述/进入按钮）；由发布/关闭事件驱动自动维护 | 手工维护（现状）、答卷数据、管理操作 |

架构图：

```
用户（Telegram 客户端）
 ├── Bot 对话：答题 / 快捷命令 / 通知
 └── Mini App 按钮 ──→ Web Admin（同一 Worker，/admin SPA + /api/admin/*）
                         │
Cloudflare Worker（单 Worker 不变）
 ├── D1（唯一数据源） / KV（缓存+流程状态） / DO（答题/向导/UI 会话） / Queue（异步任务）
 └── Telegraph 管线：publish/close 事件 → Queue → Telegraph API → 目录页/落地页
                          ↑ token 存 Worker secrets，浏览器永不接触
```

不变量（沿用 MIGRATION_PLAN）：单 Worker；浏览器不接触 D1/KV/DO 绑定与任何 token；staging 独立资源先行验证；不引入第二身份/数据库/媒体库/队列/服务。

## 2. 十一个痛点 → 方案映射

| # | 痛点 | 方案 | 落点阶段 |
| -- | -- | -- | -- |
| 1 | Telegram 后台操作复杂 | 管理操作整体迁 Web Admin；bot 管理菜单瘦身为"Web 入口 + 单步快捷项" | Phase 2.7 |
| 2 | 管理需连续点击很多消息 | 同上——多步向导（题目编辑/模板编辑/用户管理）只在 Web 存在 | Phase 2.x |
| 3 | 返回/分页/编辑/统计/发布逻辑混乱 | Web 端用真实路由（React Router）+ 面包屑恢复位置感；bot 端仅保留线性快捷命令 | Phase 2.1/2.7 |
| 4 | 大量重复 UI 消息 | 统一走 `renderUiScreen`（UiSessionDO 删旧发新机制已存在但未全覆盖）——治理项：把 admin-handler/result-visual 等仍"连发新消息"的路径收敛到 UI 会话 | Phase 3（bot 治理） |
| 5 | Survey/Template/Response/Identity/Import 流程互相污染 | **流程状态命名空间**：所有 KV 流程键强制 `flow:{name}:{userId}` 前缀 + 注册表（§4.1）；进入某流程时按注册表清互斥键 | Phase 3 |
| 6 | 模板变量手工填路径类型不匹配 | **类型化变量注册表**：从数据模型自动生成变量树（zod schema），模板编辑改为**选择器**而非手填字符串；bot 端模板输入同步改造 | Phase 3 |
| 7 | Survey Media 与 Template Asset 混淆 | `media_assets.asset_scope` 枚举已存在（0007/0017 迁移）；治理：查询/删除/预览一律按 scope 过滤 + Web 媒体库按 scope 分区展示 + 孤儿清理已有（`database-maintenance`） | Phase 3（媒体库） |
| 8 | /start /cancel 历史状态污染 | 作用域重置语义（§4.2）：`/cancel` 只清当前 flow（按注册表）；`/start` 做注册表全量清理；所有流程 KV 键加 TTL 兜底 | Phase 3 |
| 9 | 管理员缺完整 Web Admin | 正在建设：Phase 1 已交付（Shell+只读 API+权限），Phase 2 编辑器方案已批（`WEB_ADMIN_EDITOR_*.md`） | Phase 2 |
| 10 | Telegraph 目录无系统化自动生成 | **Telegraph 管线**（§5）：代码现状为**零集成**（src/ 无 telegraph 引用，目录页系手工维护）——新建事件驱动自动生成 | Phase 4 |
| 11 | 复杂管理堆在 Telegram 效率低 | 同 1-3：迁移 + bot 菜单重设计（`/admin` 首屏改为 Web 入口大按钮 + 3-4 个快捷项） | Phase 2.7 |

## 3. GitHub 调研结论（license 已核实）

### 3.1 可直接采用

| 项目 | License | 热度 | 用途 | 结论 |
| -- | -- | -- | -- | -- |
| [Telegram-Mini-Apps/reactjs-template](https://github.com/Telegram-Mini-Apps/reactjs-template) | MIT | 425★ | 官方 Mini App React 模板：Vite + TS + 开发环境模拟（mockTelegramEnv）+ HTTPS dev | **采用为 Phase 2.1 工具链脚手架**（去掉 TON Connect；路由/Tailwind 自加，模板本身不含） |
| [@telegram-apps/sdk](https://github.com/Telegram-Mini-Apps/telegram-apps)（原 tma.js）+ sdk-react | MIT | ~1.2k★ | Mini App 客户端 SDK：主题/viewport/initData/返回键 | **采用**，替代手写 `window.Telegram.WebApp` 调用 |
| [dnd-kit](https://github.com/clauderic/dnd-kit) | MIT | 既有结论（Phase 0.5 已推荐） | 题目/选项/图层拖拽排序 | 采用（Phase 2.3） |
| React Router + Tailwind + shadcn/ui | MIT | 既有结论（RECOMMENDED_STACK） | Web Admin 框架与 UI | 采用 |

### 3.2 参考实现（不直接引入）

| 项目 | License | 说明 |
| -- | -- | -- |
| [dcdunkan/telegraph](https://github.com/dcdunkan/telegraph) | MIT，24★，16 commits，Deno 向 | Telegra.ph API 封装参考（createAccount/create/parse/upload 未公开端点）。**Telegraph API 本身是极简 REST（4-5 个端点 + access_token），建议按现有 `telegram.ts` fetch 模式自实现 ~100 行**，避免引入低活跃依赖；此库作协议参考 |
| [@grammyjs/conversations](https://grammy.dev/plugins/conversations) | MIT | 会话式状态机模式参考（imperative wait + 状态持久化 + 自动清理）。**bot 框架整体迁移被红线禁止（不重写 Bot）**，仅借鉴其"会话作用域 + 显式等待 + 退出即清"模式改造现有 handler |
| [TelegramUI](https://github.com/telegram-mini-apps-dev/TelegramUI) | MIT | Telegram 风格 UI 组件库，作视觉参考（我们既定 Tailwind + shadcn/ui） |
| Python 系 admin 面板（[RakinSV](https://github.com/RakinSV/Telegram-admin-app-project)/[HumoFX](https://github.com/HumoFX/telegram_admin)/[donBarbos](https://github.com/donBarbos/telegram-bot-template) 等） | 各异 | 栈不符（FastAPI/Flask/Django，需常驻服务器，违反单 Worker 不变量），仅 UX 参考 |
| SurveyJS Form Library | MIT（Phase 0.5 结论 B） | 仅渲染/schema 概念参考；Creator 商业条款排除（既定） |

### 3.3 拒绝

| 项目 | License | 拒绝原因 |
| -- | -- | -- |
| [Formbricks](https://github.com/formbricks/formbricks) | **AGPL-3.0** | AGPL 在项目红线清单（另需独立服务器栈，违反不变量） |
| LimeSurvey 等经典调查系统 | GPL 系 | 同上 |

## 4. Bot 端治理设计（痛点 4/5/8）

### 4.1 流程状态注册表（flow registry）

现状证据：`admin-handler.ts:80-98`、`result-visual-admin-handler.ts:85-89`、`survey-handler.ts` 内散布至少 8 类 per-user KV 状态键（license-issue / creator-trial / admin-survey-search / admin-user-search / identity-card-password / template-import / template-editor / public-survey-search…），无统一命名、无 TTL、互不知晓——这是流程污染与状态残留的直接原因。

设计：

```
src/bot/flow-state.ts（新增，纯代码无迁移）
  FLOWS = { survey: [...keys], template: [...], identity: [...], admin: [...], import: [...] }
  enterFlow(ctx, 'template')   → 按注册表清理互斥 flow 的键（写 flow:{userId}=当前流程名）
  setFlowState / getFlowState  → 键统一 flow:{name}:{userId}:{slot}，默认 TTL（如 24h）
  resetFlow(name?) / resetAll  → /cancel 调前者，/start 调后者
```

- 每条消息进入 router 时先读 `flow:{userId}` 做路由守卫：非本 flow 的文本输入不再误触输入态（例如停在"模板导入"状态时发 `/surveys` 不应被当成模板内容）。
- 存量键保留兼容读取、写入即迁移到新命名（一次性小步改造，不迁移数据）。

### 4.2 /start /cancel 语义

- `/cancel`：清当前 flow 状态 → 回该 flow 首屏（不清答题会话——答题有自己的退出键）。
- `/start`：注册表全量清理 + 首页（现行为只重置部分状态，是痛点 8 的实体）。
- UI 消息治理：管理类多步流程统一 `renderUiScreen`（删旧发新），杜绝消息堆积（痛点 4）。

### 4.3 模板变量类型化（痛点 6）

- 定义变量注册表：每类模板（结果报告/身份卡/视觉模板）声明可用变量树（zod schema：`survey.title`、`response.completedAt`、`answer[qid].text`…）。
- 渲染前用 schema 校验 + 缺失变量报具体路径；**模板编辑改为树形选择器**（Web）/ 序号选择（bot），消灭手填路径。
- 与 Phase 3 的"结果模板 Web 化"合并实施。

## 5. Telegraph 管线设计（痛点 10）

现状：`src/` 零 Telegraph 集成；目录页手工维护。

```
事件源：updateSurveyStatus('published' | 'closed')（编辑器/bot 两端点都经过此处）
   ↓ 发 Queue 消息 {kind:'telegraph_sync', surveyId}（复用 EXPORT_QUEUE 的多路复用模式）
telegraph-sync service（新增）
   1. 读问卷 + 题目摘要 → 生成目录条目（标题/描述/题数/状态/开始命令）
   2. Telegraph API：首次 createAccount（token 存 secrets/KV，绝不进浏览器）→ createPage/editPage
   3. 目录页（单页、64KB 内分页追加）+ 可选单问卷落地页（deep link /start survey_{id}）
   4. 页面 URL 回写 D1（surveys 侧 KV 映射，无需迁移）→ Web Admin 列表/详情展示外链
失败重试沿用 Queue 3 次退避；关闭/归档的问卷从目录移除或标记
```

- 依赖决策：**自实现** Telegraph REST 封装（参照 `telegram.ts` 模式 + dcdunkan/telegraph 的 parse 参考）；不引入该包（24★/低活跃）。
- 目录结构决策点：A. 仅单目录页（最小）；B. 目录页 + 每问卷落地页（推荐，落地页可带封面与说明，转化更好）。

## 6. 实施路线图（整合既有计划）

| 阶段 | 内容 | 对应痛点 |
| -- | -- | -- |
| **Phase 2.1-2.6（已完成）** | 编辑器工具链（改用 reactjs-template + @telegram-apps/sdk 脚手架）→ 题目编辑 → 排序 → 保存/并发 → 预览 → 发布 | 9 |
| **Phase 2.7（已完成）** | Bot 管理菜单瘦身：`/admin` 首屏 = Web 入口大按钮 + 快捷项（发布确认/关闭/导出）；删除 bot 内多步管理向导入口（代码保留回调兼容，入口隐藏） | 1/2/3/11 |
| **Phase 3a（进行中）** | Web：答卷浏览/统计（第一批已完成，见 `WEB_ADMIN_PHASE_3.md`）/媒体库（scope 分区）/导入导出 UI/用户管理 | 1/7/9/11 |
| **Phase 3b** | 模板变量类型化（结果报告 + 身份卡 + 视觉模板）；Bot 治理按 `BOT_GOVERNANCE_PROPOSAL.md` 单独审批后实施 | 4/5/6/8 |
| **Phase 4** | Telegraph 管线（§5）+ Web 端目录管理/开关 | 10 |
| 验收 | 每阶段 staging 全量验证（沿用 Phase 1 手册），生产晋级需评审 | — |

顺序理由：先 Web 后瘦身 bot——先把承接面（Web Admin）建全，再拆 bot 的管理负担，避免中间态两边都不完整；Telegraph 独立无依赖，排最后但可在 3a/3b 期间穿插。

## 7. 决策记录（2026-08-22 用户已确认）

1. bot 快捷命令：只保留必要项（执行清单见 2.7：发布确认、关闭、导出、暂停/续填、查我的问卷 + Web 入口），其余移除。
2. Telegraph 目录结构：**目录页 + 单问卷落地页**。
3. Telegraph 账号：以 bot 名义建独立 Telegraph 账号，token 入 Worker secrets。
4. 模板类型化：**全范围**（结果报告 + 身份卡 + 视觉模板，同一注册表机制）。
5. `@telegram-apps/sdk`：保留版本、许可和运行时兼容性审计；许可信息用于风险判断，但不作为脱离实用性、安全性和维护性的唯一阻塞条件。
6. bot 治理（flow registry / start-cancel 语义 / renderUiScreen 全覆盖）：已形成独立的 `BOT_GOVERNANCE_PROPOSAL.md`，再次批准后再实施，不与 Phase 2 混批。

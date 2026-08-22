# Web Admin Editor 迁移方案（Phase 2.0 提案）

> 结论先行：**Phase 2 v1（编辑器完整能力：创建/编辑/排序/保存/预览/发布）在现有 D1 schema 上零迁移即可实现**。本文档论证该结论，并列出未来可选项（默认不做）。
> 依据：`docs/WEB_ADMIN_EDITOR_RESEARCH.md` 的现状分析。

## 1. 为什么零迁移可行（逐项对照）

| 编辑器需要 | 现有支撑 | 结论 |
| -- | -- | -- |
| 问卷基本信息（标题/描述/策略） | `surveys` 既有列 + `updateDraftSurvey` / `updateSurveyResponsePolicy` | ✅ 无需变更 |
| 题目 CRUD 与排序 | `survey_questions` 全套 repository 原子方法（`question.repository.ts`）；排序 = `"order"` 连续整数不变量，新增一个批量 normalize 函数即可 | ✅ 新增代码，不动表 |
| 选项编辑（保 ID） | `updateQuestionOptionLabel` / `createQuestionOption` / `deleteQuestionOption` | ✅ |
| Matrix 列 | `settings_json`（`{columns:[…]}` 既有约定，bot 向导已用） | ✅ |
| 题目描述 | `description` 列已存在（0002），仅 bot 向导未暴露 | ✅ 写既有列 |
| 校验参数（长度/范围/多选数等） | **`validation_json` 列已存在且未使用**；领域模型 `SurveyValidation`（`src/survey/schema.ts:55-66`）已定义完整结构 | ✅ 启用预留列 |
| 乐观并发 | `surveys.updated_at` 既有（每次写更新）→ baseUpdatedAt + 409 | ✅ 无需 version 改造 |
| 防并发破坏历史答卷 | `assertSurveyQuestionsEditable`（有任何答卷即锁）+ draft-only 编辑 + CASCADE 外键现状 | ✅ 沿用不变量 |
| 发布/关闭 | `updateSurveyStatus` + `assertSurveyCanPublish` | ✅ |
| 复制再改 | `duplicateSurvey` 已存在 | ✅ |
| 媒体只读展示 | `question_media`/`option_media`/`media_assets` 读路径 | ✅（上传属后续，见 §3） |

## 2. 需要的代码级变更（非迁移）

1. `handleAdminApi` 解除全局 GET-only，逐端点方法校验（RESEARCH §API）。
2. `question.repository` 新增：`updateQuestionDescription`、`updateQuestionSettings`、`updateQuestionValidation`、`normalizeQuestionOrder`（batch）。
3. 题型/选项数量校验统一常量模块，修复 `SurveyQuestionType` 幽灵 `boolean` 与三处规则漂移。
4. （顺带修复项，bot 侧缺陷）`saveDraftSurvey` 全删重插丢跳题规则——`DraftQuestion` 增加 condition 携带，或 bot 保存时保留原题目 condition；独立小改动，不阻塞 Web 编辑器。
5. 前端引入 Vite 工具链（产物仍 `admin/dist`）+ CI build 步骤——部署面不变，`.gitignore`/入库策略调整属工程配置。

## 3. 未来可选项（明确不在 Phase 2 v1，需单独立项评审）

### 3.1 编辑锁（防双开互踩的强方案）
现状用 updated_at 409 软保护即可。若未来要硬锁：KV `editor-lock:{surveyId}`（TTL 心跳）即可，**仍无需迁移**。

### 3.2 Survey 历史版本 / 发布快照（revision 表）
- 问题：Published Survey 与 Question 无版本关系，历史答卷的语义依赖"有答卷即锁"这一运行时防线，而非数据快照。
- 方案：`survey_versions`（survey_id, version, snapshot_json, created_at），发布时写快照；答卷绑定 version。
- 代价：新表 + 发布链路改造 + 答卷读取联查 + 导出/统计适配。风险：中。
- 建议：**Phase 3+ 视"答卷结构审计/回滚"真实需求再立项**。v1 的 draft-only + 锁 + 复制再改已满足"不破坏历史答卷"目标。

### 3.3 浏览器媒体上传（multipart → Bot API 中继换 file_id）
无 R2 现状下的可行通路（复用 `uploadMediaForReuse` 模式），涉及 Worker 请求体大小限制与 Bot API 20MB getFile 上限的权衡。Phase 2 后期或 Phase 3。

### 3.4 archived_at 写入 / 状态机校验
`updateSurveyStatus` 目前任意状态可跳、`archived_at` 从不写入。属 bot 既有行为，编辑器 v1 只使用 draft→published（+可选 close）路径，不扩大状态面；收紧状态机属全局行为变更，单独评审。

## 4. 若未来必须迁移的流程约束（预留）

任何 D1 migration：单独迁移文件 + 文档说明（为什么/新增什么/旧数据兼容性/可回滚性/对历史答卷的影响）→ 本地 → staging → 测试 → 评审 → 生产；禁止直接对生产执行 `wrangler d1 migrations apply --remote`。生产晋级前 staging 全量验证（沿用 Phase 1 手册）。

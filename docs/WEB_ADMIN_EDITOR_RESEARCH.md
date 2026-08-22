# Web Admin 问卷编辑器研究（Phase 2.0）

> 纯调研产物，2026-08-22。本阶段**未修改任何生产代码、未新增迁移**。Phase 1（Web Admin Shell + 只读 API）为稳定基线。
> 配套文档：`docs/QUESTION_TYPES.md`（题型清单）、`docs/WEB_ADMIN_EDITOR_API.md`（API 设计）、`docs/WEB_ADMIN_EDITOR_MIGRATION.md`（迁移结论：第一版零迁移）。

## 1. 当前架构总览

```
Cloudflare Worker（单 Worker，生产 wrangler.toml）
├── POST /telegram/webhook ──→ bot router ──→ survey-handler / builder-handler / question-editor / admin-handler
│                                            （答题、创建向导、编辑、管理）
├── GET /api/admin/* ─────────→ http/admin-api.ts（Phase 1 只读：dashboard / surveys 列表 / 详情）
├── /api/v1/licenses/* ───────→ http/license-api.ts（授权，与编辑器无交集）
├── /admin/* ─────────────────→ Static Assets（admin/dist，无构建 React UMD SPA）
├── Durable Objects：SurveySessionDO（答题会话）/ SurveyBuilderDO（创建向导）/ UiSessionDO
├── D1：surveys / survey_questions / question_options / media_assets / survey_responses / answers …
├── KV CACHE、Queue（导出/渲染任务，编辑器不需要）
└── 无 R2 绑定（媒体 = Telegram file_id 存 D1，media_assets.r2_key 恒 null）
```

关键事实：

- **答题没有 public HTTP 面**——100% 走 bot webhook。编辑器改动数据只影响 bot 答题流，不存在 Web 答题页兼容问题。
- 答题端**每次交互从 D1 重载题目**（`question.service.ts:4-13`，`ORDER BY "order", id`）——编辑保存对答题端即时生效。
- admin API 认证基建（`verifyTelegramWebAppUser` HMAC + 24h 新鲜度 + dev 旁路 + owner/admin 权限语义）已在 Phase 1 验证，可整体复用；**写操作端点目前不存在**（`admin-api.ts:21` 对非 GET 一律 405）。

## 2. Survey 数据结构（现状）

`surveys` 表（`db/migrations/0001_users_surveys.sql` + 0007）：

| 字段 | 说明 |
| -- | -- |
| `id`, `owner_id` | 数值主键；归属 users.id |
| `title`, `description`, `cover_media_id` | 基本信息；封面指向 media_assets |
| `status` | `draft / published / closed / archived`，DEFAULT draft |
| `anonymous`, `allow_multiple_responses`, `max_responses_per_user` | 响应策略 |
| `version` | INTEGER DEFAULT 1——**只是状态/策略变更计数器**：仅在 `updateSurveyStatus`（publish/close 等）与 `updateSurveyResponsePolicy` 时 +1；题目增删改不递增；**不是乐观锁、无历史版本表**（`survey_publications` 表建了但从未写入） |
| `published_at / closed_at`（`archived_at` 列存在但从不写入） | 状态时间戳 |
| `access_code(+encrypted)` | 访问密码（bot 侧管理） |

Repository 写方法（`src/db/repositories/survey.repository.ts`）：`createSurvey`（version=1）、`updateSurveyResponsePolicy`（version+1）、`updateDraftSurvey`（**仅 draft 且 owner 匹配**，改 title/description）、`updateSurveyStatus`、`deleteSurvey`、`duplicateSurvey`（`survey.service.ts:124-207`，深拷贝题目/选项/媒体）、`getLatestDraftSurveyByOwner`（草稿恢复）。

### Draft / Publish 现状（§5 详述规则）

- `updateSurveyStatus`（`survey.repository.ts:162-193`）**没有状态机校验**，任意状态可跳；publish/close 写时间戳并 version+1；closed/archived 会把进行中答卷置 abandoned。
- 发布前置校验 `assertSurveyCanPublish`（`survey.service.ts:60-99`）：标题非空、≥1 题、每题标题非空、single/multiple/yes_no/rating ≥2 选项。
- **已发布问卷的编辑规则**：`assertSurveyQuestionsEditable`（`survey.service.ts:101-122`）——**只要有任何 survey_responses 记录（不限 completed），题目/选项/附件全部锁定**，提示"复制问卷后再修改"；0 份答卷的 published 问卷在 bot 侧仍可编辑（走增量方法）。标题/描述不受此锁限制（但 `updateDraftSurvey` 仅限 draft）。

## 3. Question / Option 数据结构（现状）

`survey_questions`（0002）：`type TEXT`（**无 CHECK 约束**，14 种题型见 QUESTION_TYPES.md）、`title`、`description`、`required`、`"order"`（**0..n-1 连续整数**：删除后批量前移补位，上移/下移=相邻 swap，复制=让位插入）、`validation_json`（**列已存在、全代码未使用**）、`settings_json`（matrix 列 `{columns:[…]}`）、`condition_json + skip_to_question_id`（跳题，`{"kind":"option_equals","rules":[{optionId,targetQuestionId}]}`，**只向前跳**）、`parent_question_id`（预留未用）。

`question_options`（独立表，非 JSON）：`label`、`value`（恒等于 label，同步写）、`order`、`is_other`（未用）。

媒体：`question_media` / `option_media` 关系表 → `media_assets`（Telegram file_id + asset_scope 所有权）。

**Repository 原子操作面**（`src/db/repositories/question.repository.ts`，Web API 可直接复用）：`createQuestion`、`createQuestionOption`、`updateQuestionTitle`、`updateQuestionOptionLabel`（**保 option.id**）、`updateQuestionRequired`、`deleteQuestion`（batch 内含 order 补位）、`deleteQuestionOption`、`swapQuestionOrder` / `swapQuestionOptionOrder`（相邻交换，保 ID）、`duplicateQuestion`（深拷贝）、`setQuestionSkipRule`。**没有任意重排 API**——拖拽排序需要新增一个批量 normalize 端点。

统一 JSON 模型 `UnifiedSurvey`（`src/survey/schema.ts`）已存在且双向可用：导出 `survey-json.service.ts`、导入 `import.service.ts` + `validator.ts`。注意：**导出是lossy的**（media: []、不含跳题规则）；字符串 ID（q1/q1_o1）仅是序列化格式，**不是** D1 里的 ID。

## 4. Creator Wizard 分析（Bot 创建向导）

**结构**：`SurveyBuilderDO`（每用户一个实例，`idFromName("user:"+userId)`，单 key 存 `SurveyBuilderState`）+ `survey-builder.service.ts`（唯一访问层）+ `builder-handler.ts`（用户交互）。

**状态机**（`survey-builder.ts:20-38`）：

```
idle → survey_title → survey_description → [每道题循环:]
  question_type → question_title → question_required → question_media
  → question_options（matrix 再进 matrix_columns）→ append → question_type …
→ finish_questions → ready
辅助挂起步骤（suspendedStep 保存现场）：add_question_option / option_media /
  question_media_existing / edit_option_label / edit_question_title /
  survey_access_code / set_survey_access_code
另有：start_import（JSON 导入）、start_append_questions（往已有问卷追加题）
```

**DraftQuestion 结构**（DO 内）：`{type, title, required?, options:[{label, mediaAssetId}], matrixColumns?, mediaAssetId}`——**不含 condition/跳题规则、不含 description/validation**。

**落库**（`saveDraftSurvey`，`survey-builder.service.ts:359-404`）：
- 仅 draft 且 owner 匹配才可覆盖（`updateDraftSurvey` 约束）；
- 已有草稿：更新 title/description 后 **`DELETE FROM survey_questions WHERE survey_id=?` 全删 → `insertDraftQuestions` 整批重建**（含选项与媒体关联）；
- ⚠️ **发现现存缺陷：全删重插会丢跳题规则与 validation/settings（DraftQuestion 不携带 condition_json）**——bot 侧"保存草稿"后，此前在题目编辑器里配好的跳题会被静默清除。Web 编辑器设计必须避免沿用此模式（见 §7）。

**Web 能否复用向导？** 不建议。向导状态机为聊天流设计（一步一问），Web 表单是自由编辑模型；且 DO 状态与 D1 双源。**应复用的是向导之下的 repository 原子操作与校验规则**，而不是 DO 状态机本身。

**已存在的共享域**：`src/survey/`（schema/validator/engine/renderer）+ 上述 repository——bot 与 Web 天然共享同一 D1 模型，无需新建平行 schema。

## 5. Draft / Publish 分析

| 操作 | Bot 现状 | Web 编辑器建议 |
| -- | -- | -- |
| 创建 | `/create` 进向导，保存时 createSurvey（draft） | `POST /api/admin/surveys`（需 `canCreateSurvey`） |
| 编辑 draft | 向导恢复 + 全删重插 | **增量操作**（保 ID、保跳题），见 §7 |
| 编辑 published | `assertSurveyQuestionsEditable`：0 答卷可增量编辑；有答卷锁结构（标题/响应策略另有通道） | **v1 只允许编辑 draft**；published 提供只读视图 + "复制为新草稿"（duplicateSurvey 已存在）。避免"编辑 published 期间有人开始答题"的竞态 |
| 发布 | `owner:publish_ask/confirm` → `assertCanManageSurvey` + `assertSurveyCanPublish` → `updateSurveyStatus` | 同一校验链搬到 API（见 API 文档） |
| 关闭 | `owner:close` | v1 可选（低风险，复用同一链路） |
| 删除 | `deleteSurvey`（裸删） | v1 不做（不可逆；后续若做需连带清理策略讨论） |

**版本化问题**（规范文档 §七）：当前无 Survey↔Question 版本关系、无发布快照。**v1 不引入版本化**——通过"draft-only 编辑 + 有答卷即锁 + 复制再改"达成"已发布问卷不破坏历史数据"的目标，这正是现有 bot 的既定语义（既有不变量），零迁移。快照/revision 方案作为未来选项写入 MIGRATION 文档，不在本阶段做。

## 6. 历史答卷兼容性分析（最重要）

答卷与题目/选项的耦合点：

1. **选项 ID 是答案外键**：选择题答案 = `answers.json_value=[optionId,…]` + `answer_options(option_id)` 外键 `ON DELETE CASCADE`。删除或重建选项会**静默删除历史答案关联**。→ 编辑器必须用 `updateQuestionOptionLabel`（保 ID）改文案；删选项仅对无答卷问卷安全。
2. **题目删除 CASCADE 掉 answers**（`ON DELETE CASCADE`）。
3. **矩阵答案按列索引存**：`{"kind":"matrix","selections":{rowId: columnIndex}}`——调整列顺序会改变历史答案语义（存索引不存 ID）。
4. **进行中会话断点**：`survey_responses.current_question_id`（D1）与 `SurveySessionState.currentQuestionId`（DO，优先）双写；删题/换 ID 会触发"题目不存在，请重新开始问卷"（`survey-handler.ts:990-1010`）。
5. **跳题规则在提交时镜像重放**：`findMissingRequiredQuestion` 沿同一跳题路径检查必答——编辑条件会改变校验语义。

**结论（编辑器安全边界）**：
- **draft 问卷**：无答卷、无答题会话 → 任何编辑安全（含全删重插，但会丢跳题规则——见 §4 缺陷，仍建议增量）。
- **published + 0 答卷**：编辑安全但存在竞态窗口（保存时校验 responseCount 后、提交前有人开始答题）——缓解：保存事务内复查；v1 干脆不开放（§5）。
- **有任何答卷**：结构锁定（沿用 `assertSurveyQuestionsEditable`），仅允许复制后编辑。

## 7. 推荐编辑器架构

### 7.1 编辑模型：客户端全量状态 + 服务端增量持久化

```
浏览器编辑器（本地 state，题目数组 + dirty 标记）
   │  保存 = 一组增量操作（或逐题 PATCH）
   ▼
POST/PATCH /api/admin/surveys…（见 API 文档）
   │  verifyTelegramWebAppUser → canCreateSurvey/canManageSurvey
   │  → assertSurveyQuestionsEditable（写路径每次复查）
   │  → 复用 question.repository 原子方法 / db.batch
   ▼
D1（现有 schema，零迁移）
```

- **不复用** SurveyBuilderDO（聊天向导状态机）；**复用** 其下层 repository 原子操作与校验规则。
- **创建流程**：`POST /surveys`（title 必填，创建 draft）→ 逐题添加（每题一次 API 或一次批量）→ `POST /surveys/:id/publish`。
- **编辑流程**：`GET /surveys/:id/editor`（问卷 + 全部题目/选项/媒体引用，按 `"order"` 排序）→ 本地编辑 → 增量保存（每操作保 ID）。
- **保存策略**：v1 = 明确的手动保存 + Dirty 状态（Saved/Unsaved/Saving/Save failed）+ 离开提醒；自动防抖保存后置（规范文档 §十二同此要求）。
- **并发保护**：轻量乐观锁——PATCH/POST 携带 `baseUpdatedAt`（读时返回），服务端不匹配返回 **409**。用现有 `updated_at` 列，零迁移。
- **排序**：拖拽后提交完整 ID 顺序数组 → 服务端 `db.batch` 批量 `UPDATE "order"`（新增 normalize 函数，保持 0..n-1 不变量）。

### 7.2 题型支持范围（v1）

- **完整编辑**：single / multiple / text / long_text / number / yes_no / rating / matrix（行+列）/ date / time；`description`（既有列）；`required`；`validation_json` 启用文本长度/数字范围/多选数量等既有领域模型 `SurveyValidation`。
- **只读展示**：image / video / audio / file 的已有附件；上传/更换提示走 Bot（媒体通路缺口见 §9）。
- **不做**（保留数据不破坏即可）：跳题规则 UI（condition_json 原样带回）、选项媒体上传、placeholder。

### 7.3 前端结构

Phase 1 无构建 UMD SPA 在编辑器规模下会失控。**建议 Phase 2.1 引入 Vite + React Router + Tailwind**（RECOMMENDED_STACK 既定方向），产物仍输出 `admin/dist`、仍由同一 Worker Assets 提供（部署面不变）。两个必须同步的决策点：(a) CI deploy.yml 增加 build 步骤；(b) 构建产物是否继续入库（建议：改为 CI 构建，`.gitignore` 回收 dist）。

页面结构（对齐规范文档 §八）：

```
/admin/surveys/:id/editor
├── Editor Header：返回 / 标题 / 状态 badge / Save（dirty）/ Preview / Publish
├── Survey Settings：标题、描述、匿名、多次填写、次数上限
├── Question List：卡片 + 拖拽把手 + 题型 badge + 复制 / 删除
└── Question Editor（桌面右侧栏 / 移动端全屏推入）：内容、选项、校验、高级
```

移动端一等公民：题目列表纵向卡片流，点击进入全屏题目编辑（返回保留 state），拖拽用长按把手（dnd-kit，既定选型），删除需确认，输入区处理键盘遮挡（规范 §九逐项落实）。

### 7.4 Preview

Bot `/preview` = `getSurveyFlow` → 纯文本编号列表（`survey-handler.ts:2075-2100`）。Web 预览复用**同一 view model**（`SurveyQuestionView`，engine.ts 构建）渲染结构化只读预览——题目文案、选项、必答标记、矩阵表格一致；Telegram 键盘交互形态（按钮布局/媒体呈现）在 Web 预览中以近似样式呈现并明确标注。不新写一套题目语义解析。后续增强可加"发送到 Telegram 真预览"（复用 bot 的 sendSurveyPreview 通路）。

## 8. 权限边界（复用 Phase 1 + 补齐）

- 认证：`verifyTelegramWebAppUser`（initData HMAC + 24h）+ dev 旁路（staging）。
- 授权：写路径必须叠加 bot 同款检查——`canCreateSurvey`（admin 或 active creator trial）、`canManageSurvey`（**admin 或 owner 且 owner 有 active creator trial**，`permission.service.ts:47-59`）+ `assertSurveyQuestionsEditable`（结构锁）。Phase 1 admin-api 只做了 owner/admin 读过滤，**未接 trial 检查**——写 API 必须接（读沿用现状）。后端永远是最终权限边界，前端只做 UI 预判。
- 权限矩阵与测试用例见 API 文档 §6。

## 9. 媒体系统（现状与缺口）

现状：媒体 = Telegram `file_id` 存 D1（无 R2）；上传只能经 bot 消息（`registerMediaAsset`）；外部 URL 媒体靠 `uploadMediaForReuse` 转发换 file_id。**浏览器直传是缺口**。可行未来通路：浏览器 multipart → Worker → Bot API multipart（attach://）转发到用户 chat → 换 file_id → 删临时消息（复用 uploadMediaForReuse 模式）。**v1 不做**，媒体题只读展示（见 QUESTION_TYPES.md §4）。不创建第二套媒体体系。

## 10. 风险列表

| # | 问题 | 影响 | 建议 | 代价/风险 | 阶段 |
| -- | -- | -- | -- | -- | -- |
| R1 | bot"保存草稿"全删重插会**丢跳题规则**（DraftQuestion 不携带 condition_json） | 现存数据破坏路径；Web 若沿用同模式会复现 | Web 用增量操作；bot 侧缺陷单列修复项（DraftQuestion 增加 condition 携带） | 小/低 | 2.2 |
| R2 | 选项/题目 ID 是答卷外键（CASCADE） | 重建式保存会静默删历史答案 | 保 ID 增量编辑 + 保存时复查 responseCount | —/低 | 全程 |
| R3 | published+0 答卷编辑存在答题竞态窗口 | 保存瞬间新答卷引用被改结构 | v1 仅 draft 可编辑；published 走复制再改 | 体验取舍/低 | 2.x |
| R4 | 题型集合与选项数量规则三处不一致（含幽灵 `boolean`） | 编辑器校验与 bot/导入行为漂移 | Phase 2.1 前置：统一常量模块 + 修 validator | 小/低 | 2.1 |
| R5 | 无乐观锁/version 语义弱 | 双开浏览器互相覆盖 | baseUpdatedAt 轻量 409 方案（零迁移） | 小/低 | 2.4 |
| R6 | 媒体上传无浏览器通路 | 媒体题 Web 不可编辑附件 | v1 只读 + 后置 multipart→Bot API 中继方案 | 中/中 | 后置 |
| R7 | admin-api 写面缺失 + 未接 trial 检查 | 权限边界不完整 | 新写端点统一接 canCreate/canManage/assertEditable | 小/低 | 2.1-2.2 |
| R8 | 前端无构建，CI 无 build 步骤 | 编辑器代码规模失控 / 部署断裂 | 引入 Vite + CI build + dist 入库策略变更 | 中/中 | 2.1 |
| R9 | `scripts/research-web-admin.sh` 不存在 | dnd-kit 等依赖 license 审计前置缺失 | 引入任何 npm 依赖前补审计（含精确版本+license） | 小/低 | 2.1 |
| R10 | matrix 列顺序 = 历史答案语义（索引存储） | 重排列改变历史含义 | 有答卷本就锁结构（R2 防线覆盖）；draft 内自由 | —/低 | 已覆盖 |
| R11 | 删除问卷为裸 DELETE 无清理策略 | 不可逆+孤儿数据 | v1 不提供删除 UI | —/低 | 后置 |

## 11. Phase 2 实施计划（对齐总规范 §二十三）

| 阶段 | 内容 | 关键点 |
| -- | -- | -- |
| **2.0（本文档）** | 调研 + 架构/API/迁移提案 | **已完成，等待确认后进入 2.1** |
| 2.1 Editor Shell | Vite 工具链接入（产物仍 admin/dist）+ CI build；题型/校验统一（R4）；编辑器路由/头/设置/题目列表（只读渲染）+ 桌面/移动布局；依赖审计（R9） | 不接写 API |
| 2.2 Question Editing | 写 API 第一批（创建问卷/增删改题目/选项，见 API 文档）+ 编辑 UI（10 种题型完整、4 种媒体题只读）；修复 R1 顺带验证 | 增量操作、保 ID |
| 2.3 Ordering | 拖拽排序（dnd-kit）+ 批量 normalize API + 校验 | 0..n-1 不变量 |
| 2.4 Draft/Save | Dirty/Saving/Saved/Failed 状态机 + baseUpdatedAt 409 + 离开提醒 | 自动保存后置 |
| 2.5 Preview | 基于 SurveyQuestionView 的 Web 预览 | 复用 engine |
| 2.6 Publish | 发布确认 + assertSurveyCanPublish 链 + 状态展示 + published 只读视图/复制再改 | 复用 bot 校验链 |
| 验收 | Staging 全量验证（权限矩阵/并发/兼容性/三端响应式）后评伋生产 | 沿用 Phase 1 手册流程 |

每阶段完成按总规范 §二十六格式汇报；任何 schema/迁移/domain 重大修改先提案再动（本文档即 2.0 提案）。

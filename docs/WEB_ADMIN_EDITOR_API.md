# Web Admin Editor API 设计（Phase 2.0 提案）

> 状态：**提案，未实现**。基于 `docs/WEB_ADMIN_EDITOR_RESEARCH.md` 的结论设计。挂载在现有 `handleAdminApi`（`src/http/admin-api.ts`）之下，与 Phase 1 只读端点共存（需解除全局 GET-only 405，改为逐端点校验方法）。

## 0. 通用约定

- 认证：沿用 `verifyTelegramWebAppUser`（initData HMAC + 24h 新鲜度）；staging dev 旁路不变。
- 授权（写路径逐端点叠加）：
  1. `canCreateSurvey`（admin 或 active creator trial）——创建类；
  2. `canManageSurvey`（admin，或 owner 且有 active creator trial）——修改类；
  3. `assertSurveyQuestionsEditable`（问卷无任何答卷）——改题目/选项/附件结构类。
- 错误格式：`{ code, message, requestId }`（与 Phase 1 一致）；成功一律 `Cache-Control: no-store`。
- 乐观并发：所有写请求可带 `baseUpdatedAt`（ISO 字符串，来自上次读取）；服务端比对 `surveys.updated_at`，不匹配返回 **409 `stale_write`**（正文带当前 updated_at 供前端刷新）。
- 可编辑范围（v1）：`status === "draft"` 的问卷；非 draft 的结构编辑端点一律 **403 `survey_locked`**（published 复制再改）。
- 输入验证：API 层重验（题型 ∈ 14 种白名单、标题长度、选项数量规则——统一常量模块，见 RESEARCH §10 R4）。

## 1. 端点总表

| 方法 | 路径 | 权限 | 说明 |
| -- | -- | -- | -- |
| GET | `/api/admin/surveys/:id/editor` | owner/admin（Phase 1 语义） | 编辑器装配文档（§2） |
| POST | `/api/admin/surveys` | canCreateSurvey | 创建 draft 问卷（可带初始题目，§3） |
| PATCH | `/api/admin/surveys/:id` | canManageSurvey | 改 title/description/响应策略（draft） |
| POST | `/api/admin/surveys/:id/questions` | +assertEditable | 新增题目（含选项） |
| PATCH | `/api/admin/surveys/:id/questions/:qid` | +assertEditable | 改题目字段（保 ID） |
| DELETE | `/api/admin/surveys/:id/questions/:qid` | +assertEditable | 删题（order 补位） |
| POST | `/api/admin/surveys/:id/questions/reorder` | +assertEditable | 批量重排（§4.4） |
| PATCH | `/api/admin/surveys/:id/options/:optionId` | +assertEditable | 改选项 label（保 ID） |
| DELETE | `/api/admin/surveys/:id/options/:optionId` | +assertEditable | 删选项（order 补位） |
| POST | `/api/admin/surveys/:id/duplicate` | canManageSurvey | 复制为新 draft（复用 duplicateSurvey） |
| POST | `/api/admin/surveys/:id/publish` | canManageSurvey | 发布（§4.6） |
| POST | `/api/admin/surveys/:id/close` | canManageSurvey | 关闭（可选，低优先） |

选项的新增挂在题目端点内（创建题目带 options；PATCH 题目可追加选项）——避免碎片化；独立的选项端点只做改文案/删除。

## 2. GET /api/admin/surveys/:id/editor

响应（单请求装配，避免前端 N+1）：

```jsonc
{
  "survey": { "id": 1, "title": "…", "description": null, "status": "draft",
              "anonymous": false, "allowMultipleResponses": false,
              "maxResponsesPerUser": 1, "version": 3,
              "createdAt": "…", "updatedAt": "…",         // updatedAt 即 baseUpdatedAt
              "responseCount": 0,                           // >0 → 前端直接锁 UI
              "editable": true },                           // status==='draft' && responseCount===0
  "questions": [{
    "id": 11, "type": "single", "title": "…", "description": null,
    "required": true, "order": 0,
    "settings": { "columns": ["…"] },                       // matrix 才有
    "validation": { "max_length": 200 },                    // validation_json 解析，可 null
    "condition": { "kind": "option_equals", "rules": [] },  // 原样带回，v1 不编辑
    "media": [{ "mediaAssetId": 7, "mediaType": "photo" }], // 只读引用
    "options": [{ "id": 21, "label": "是", "order": 0,
                  "media": [{ "mediaAssetId": 8, "mediaType": "photo" }] }]
  }]
}
```

服务端实现：`listQuestionsBySurvey` + `listOptionsForQuestions`（既有 90/批 IN 查询）+ 媒体关系表各一次，D1 batch 合并。

## 3. POST /api/admin/surveys

```jsonc
// 请求（questions 可省略；结构同 editor 响应的 questions 元素，不传 id）
{ "title": "新问卷", "description": null,
  "anonymous": false, "allowMultipleResponses": false, "maxResponsesPerUser": 1,
  "questions": [ { "type": "single", "title": "…", "required": true,
                   "options": [{ "label": "是" }, { "label": "否" }] } ] }
// 201 响应：{ "id": 42, "updatedAt": "…" }   // 跳转编辑器
```

校验：title 非空 ≤200 字符；questions 若带则逐题走统一校验（题型白名单、选择题 ≥2 选项、matrix 列 ≥2）。实现复用 `createSurvey` + `insertDraftQuestions` 思路（新写一个 service 函数，**不经过 SurveyBuilderDO**）。

## 4. 写端点细节

### 4.1 PATCH /api/admin/surveys/:id（survey 级）

请求：`{ title?, description?, anonymous?, allowMultipleResponses?, maxResponsesPerUser?, baseUpdatedAt }`。draft 内自由改；实现走 `updateDraftSurvey`（其 WHERE 已含 draft+owner 约束；admin 代管时放宽 owner 条件的服务端封装）。响应 `{ updatedAt }`。

### 4.2 POST …/questions（新增题目）

请求：单个题目对象（同 §3 元素）。`order` 服务端定为当前末尾。**响应返回新题目及选项的完整 ID 集**（前端把临时 key 换成真 ID）。校验同 §3。

### 4.3 PATCH …/questions/:qid

请求：`{ title?, description?, required?, settings?(matrix columns), validation?, baseUpdatedAt }`。实现：`updateQuestionTitle` / `updateQuestionRequired` + 新增 `updateQuestionDescription` / `updateQuestionSettings` / `updateQuestionValidation`（写既有列，repository 层新增三个小函数）。**v1 不接受改 type**（改题型语义等价于删+建，前端引导"删除重加"，避免答案列错位）。

### 4.4 POST …/questions/reorder

请求：`{ "questionIds": [13, 11, 12], "baseUpdatedAt" }`——完整顺序数组。校验：集合与该问卷现存题目 ID 集合**完全一致**（不多不少）。实现：新增 `normalizeQuestionOrder(db, surveyId, orderedIds)`，`db.batch` 逐条 `UPDATE … SET "order"=?`，保持 0..n-1 不变量。响应 `{ updatedAt }`。

### 4.5 选项端点

PATCH：`{ label, baseUpdatedAt }` → `updateQuestionOptionLabel`（保 ID，label/value 同步）。DELETE：`deleteQuestionOption`（batch 内含补位）。追加选项：`PATCH questions/:qid` 附 `appendOptions: [{label}]` 或独立小端点，实现走 `createQuestionOption`。

### 4.6 POST …/publish

请求：`{ baseUpdatedAt }`。链路：`canManageSurvey` → `assertSurveyCanPublish`（标题/题目/选项数，错误信息带题号）→ `updateSurveyStatus('published')`。响应 `{ status, publishedAt, version }`。失败 400 `publish_validation` + 具体题号文案。

## 5. 权限矩阵（也是测试矩阵）

| 场景 | 预期 |
| -- | -- |
| 无身份 / users 表无记录 | 401 |
| owner（有 trial）→ 自己的 draft | 200/201 |
| owner（无 trial）→ 创建或写自己的问卷 | 403 `creator_trial_required`（bot 同语义：不能创建/管理） |
| owner A → 问卷 B（任何写端点） | 403 |
| admin → 任意问卷写 | 200 |
| 任何身份 → 非 draft 问卷的结构端点 | 403 `survey_locked` |
| 任何身份 → 有答卷问卷的结构端点 | 403（assertSurveyQuestionsEditable 语义） |
| baseUpdatedAt 过期 | 409 `stale_write` |
| 非 GET/POST/PATCH/DELETE 混用 | 405 |
| 路径不存在 | 404 |

## 6. 错误码清单

`unauthorized`(401) / `forbidden`(403) / `creator_trial_required`(403) / `survey_locked`(403) / `not_found`(404) / `method_not_allowed`(405) / `validation_failed`(400，message 带字段与题号) / `publish_validation`(400) / `stale_write`(409)。

## 7. 测试要求（vitest，沿用 tests/unit/http/admin-api.test.ts 模式）

- 权限矩阵全行（§5）逐条用例。
- 校验：题型白名单、boolean 拒绝、选项数量、matrix 列数、标题长度。
- reorder：乱序/缺项/多项 ID → 400；成功后 order 连续。
- publish：草稿不完整 → 400 带题号；成功 → status/publishedAt/version。
- 409：updated_at 不匹配。
- 兼容性回归：编辑题目/选项后，既有 `getSurveyFlow` + engine 跳题路径不破坏（沿用 tests/unit/survey/ 引擎用例）。

## 8. 显式不做（v1）

媒体上传端点、问卷删除、跳题规则写端点、published 直改、自动保存服务端推送、分页题目（单问卷题目量级不需要）。

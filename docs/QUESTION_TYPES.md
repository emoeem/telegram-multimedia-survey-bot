# Question Types（Phase 2.0 调研产物）

> 现状盘点日期：2026-08-22。全部基于当前代码（`src/db/schema.ts:41-55`、`src/survey/schema.ts:3-18`、`src/bot/survey-handler.ts`、`src/durable-objects/survey-builder.ts`）。
> **原则：Phase 2 编辑器第一版只支持现有稳定题型，不凭空创造新题型。**

## 1. 题型清单

DB 层 `QuestionType`（`src/db/schema.ts:41-55`，**14 种**；`survey_questions.type` 为 `TEXT NOT NULL`，无 SQL CHECK 约束，`db/migrations/0002_questions.sql:4`）：

| 类型 | 中文名 | 选项存储 | 答案存储（answers 列 / json_value） | Bot 创建向导 | Bot 事后编辑 | Web 编辑器 v1 建议 |
| -- | ---- | ---- | ---- | ---- | ---- | ---- |
| `single` | 单选题 | `question_options`（≥2） | `json_value=[optionId]` + `answer_options` | ✅ | ✅（选项增删改/排序） | ✅ 完整支持 |
| `multiple` | 多选题 | `question_options`（≥2） | `json_value=[optionId,…]` + `answer_options` | ✅ | ✅ | ✅ 完整支持 |
| `text` | 单行文本 | 无 | `text_value` | ✅ | ✅（仅标题/必答） | ✅（placeholder/长度限制见 §3） |
| `long_text` | 多行文本 | 无 | `text_value` | ✅ | ✅ | ✅ |
| `number` | 数字题 | 无 | `number_value` | ✅ | ✅ | ✅ |
| `yes_no` | 是非题 | `question_options`（≥2，通常"是/否"） | `json_value=[optionId]` + `boolean_value` | ✅ | ✅ | ✅（默认生成是/否两个选项） |
| `rating` | 评分题 | `question_options`（≥2，即分值档位） | `json_value=[optionId]` + `rating_value` | ✅ | ✅ | ✅（选项=分值，默认 1-5） |
| `matrix` | 矩阵题 | 行=`question_options`（≥1）；**列=`settings_json.columns`（≥2）** | `json_value={"kind":"matrix","selections":{rowId:colIndex}}` | ✅（先输行，再输列） | ✅（行选项可编辑；列无编辑命令） | ✅（行/列都可编辑；列存 settings_json，无需迁移） |
| `date` | 日期题 | 无 | `date_value`（YYYY-MM-DD） | ✅ | ✅ | ✅ |
| `time` | 时间题 | 无 | `time_value`（HH:MM） | ✅ | ✅ | ✅ |
| `image` | 图片题（要求上传图片作答） | 无 | `json_value={"mediaAssetId":N}` + `answer_media` | ✅ | ✅（附件管理） | ⚠️ v1 只读展示，上传走 Bot（见 §4） |
| `video` | 视频题 | 同上 | 同上 | ✅ | ✅ | ⚠️ 同上 |
| `audio` | 音频题 | 同上 | 同上 | ✅ | ✅ | ⚠️ 同上 |
| `file` | 文件题 | 同上 | 同上 | ✅ | ✅ | ⚠️ 同上 |

## 2. 题型定义不一致（Phase 2.1 需统一，属代码级修正，非迁移）

| 位置 | 题型集合 | 差异 |
| -- | -- | -- |
| `src/db/schema.ts:41-55`（DB 层 QuestionType） | 14 种 | 事实标准 |
| `src/survey/schema.ts:3-18`（领域层 SurveyQuestionType，JSON 导入用） | 15 种 | **多出 `boolean`**——无任何运行时代码产生该类型，`validator.ts` 却接受它 |
| Bot 创建向导（`survey-builder.ts:210-251`） | 全部 14 种可选 | 校验：single/multiple ≥2 选项；matrix 行≥1 列≥2 |
| 发布校验（`survey.service.ts:60-99`） | 按类型判断 | single/multiple/yes_no/rating ≥2 选项；**matrix 不要求** |
| JSON 导入校验（`src/survey/validator.ts:100-112`） | 15 种（含 boolean） | single/multiple/yes_no/rating/**matrix** ≥2 选项 |

**建议统一规则（Phase 2.1 前置任务）**：题型集合收敛到 14 种（从 `SurveyQuestionType` 移除 `boolean`）；选项数量规则统一为——single/multiple/yes_no/rating ≥2 选项；matrix 行 ≥1、列 ≥2。三处校验共用一个常量模块。

## 3. 每题可配置字段（现有 schema 支持的能力边界）

| 字段 | 存储 | Bot 现状 | Web 编辑器 v1 |
| -- | -- | -- | -- |
| 标题 | `question_questions.title` | ✅ 创建+编辑 | ✅ |
| 描述/帮助文本 | `description` 列 | 创建向导未暴露，**列已存在** | ✅（写入既有列） |
| 必答 | `required` | ✅ | ✅ |
| 顺序 | `"order"`（0..n-1 连续整数，删除补位，相邻交换） | 上移/下移 | 拖拽排序（需新增批量 normalize API） |
| 题目媒体 | `question_media` 关系表 | ✅（bot 内上传） | v1 只读展示 |
| 选项媒体 | `option_media` 关系表 | ✅ | v1 只读展示 |
| 跳题规则 | `condition_json` + `skip_to_question_id`（只向前跳） | ✅ 事后配置（single/yes_no/rating） | Phase 2 v1 不做 UI，保留数据不破坏 |
| 校验参数（min/max 长度、小数、多选数量上下限、MIME 白名单、数量/大小上限） | `validation_json` **列已存在、全代码未使用**；领域模型 `SurveyValidation`（`src/survey/schema.ts:55-66`）已定义完整结构 | ❌ 未使用 | ✅ 可直接启用（写 JSON，无需迁移）；答题端强制执行属后续增强 |
| Matrix 列 | `settings_json` `{columns:[…]}` | ✅ | ✅ |
| 占位符 placeholder / help_text | 领域 schema 字段（`SurveyQuestion.placeholder/help_text`），DB 无专列 | ❌ | v1 不做（避免加列；如需要并入 settings_json） |

## 4. 媒体题（image/video/audio/file）的 Web 限制

媒体资产 = Telegram `file_id` 存 `media_assets` 表（**无 R2 绑定**，`r2_key` 恒 null）。`file_id` 只能通过 Bot API 消息产生；浏览器无法直接上传获得 file_id。已有可复用通路：`uploadMediaForReuse`（`src/bot/builder-handler.ts:810`，把外部媒体以消息转发到目标 chat 换 file_id 后删除临时消息）。

**v1 决策**：媒体题在 Web 编辑器中显示已有附件（只读）+ 提示"在 Bot 中上传/更换"；媒体上传通路（浏览器 multipart → Worker → Bot API multipart 转发 → 换 file_id）列为 Phase 2 后期或 Phase 3 任务。

## 5. 渲染/答题端对题型的消费（兼容性约束）

- 答题端每次交互都从 D1 重载题目（`ORDER BY "order", id`），编辑保存即时生效（`src/bot/question.service.ts:4-13`）。
- 选择题答案按 **option 数值 ID** 存储（`answer_options` 外键 `ON DELETE CASCADE`）——编辑选项必须保 ID（改 label 安全；删除/重建会切断历史答卷关联）。
- 矩阵答案按 `{rowId: columnIndex}` 存储——**列的顺序变化会改变历史答案语义**（存的是索引不是 ID）。
- 现有防线：问卷一旦有任何 `survey_responses` 记录，`assertSurveyQuestionsEditable`（`src/services/survey.service.ts:101-122`）锁定全部题目/附件编辑。

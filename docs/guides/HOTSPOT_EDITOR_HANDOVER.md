# 互动场景（scene）功能 · 交接文档

> 更新：2026-10-27 晚 · **场景编辑器已完成、门禁全绿并部署生产**（Version `b6c8283b`）；生产手动验收待做。
> 接手先看本文，再看 `docs/guides/HOTSPOT_SCENES.md`（配置/管线/媒体约束）。
> **不要 git commit**（沿用用户硬约束）；改动全部留在工作区。

---

## 1. 一句话状态

- **互动场景题型（scene）已完成并上线生产**：`/s/9136` 可真实点击（4 个热点 + 1 个二级场景），探索记录写入答卷。
- **场景编辑器（admin）已完成并上线生产**：6 个类型错误清零、编辑器 CSS 写完、`qa/visual/scene-editor.spec.ts` 7 用例 + `editor-layout.spec.ts` 新增 1 用例全绿；已随 Version `b6c8283b` 部署（路由 `/admin/surveys/:id/scene/:qid`），生产手动验收待做。
- 生产最近一次部署还把**上一个会话未提交的「纸条聊天 /notes」功能**一起带上了（见 §7），不要回滚工作区。

---

## 2. 生产状态（已核验）

| 项                  | 值                                                                                                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker              | `telegram-multimedia-survey-bot`，`https://emoe.eu.cc`（`/health` → 200，version 0.3.0）                                                                                           |
| 最近部署 Version ID | `b6c8283b-c713-439b-8130-91b8eb0c93c0`（2026-10-27，含 notes + scene + 场景编辑器）                                                                                                |
| 生产问卷            | `https://emoe.eu.cc/s/9136`《雨夜书房 · 互动场景》                                                                                                                                 |
| 问卷结构            | 2 题（scene + long_text 选填）、7 个热点（room 4 + shelf 3）、8 张 WebP（media id 从 858 起）                                                                                      |
| 发布状态            | published；`anonymous=0`（平台注册墙：填写需邮箱/TG 登录，产品决策，不是 bug）                                                                                                     |
| 导入脚本 verify     | 全 ✓：问卷已发布 / scene 类型 / settings_json 一致 / question_media 8/8 / alt+尺寸+大小齐备                                                                                        |
| 生产冒烟            | 4 热点、弹层「窗外」、书架二级场景、返回后进度 2/7、答案 payload `{kind:"scene",visited:[…]}`、0 控制台错误（身份端点用 Playwright mock 绕过注册墙，定义/媒体/前端产物均来自生产） |
| 部署后核验（10-27） | `/health` 200 · `/admin/` 200 · `/admin/surveys/9136/scene/1` 200 · `SceneEditorPage-CacyZ_ox.js` 200 · 9136 定义仍是 room+shelf / 7 热点 / 8 媒体 · 前 3 张媒体 200               |
| 部署内容            | 含 scene 功能 + 上一个会话的 notes 功能 + 场景编辑器（`b6c8283b`）                                                                                                                 |

编辑/修改这份生产问卷：平台规则 `loadWritableSurvey` 要求**草稿且 0 答卷**。已发布的 9136 只读；在后台复制为草稿后再编辑，或在草稿里新建 scene 题。

---

## 3. 已完成：scene 题型（生产）

### 3.1 数据与答案

- 题型：`src/db/schema.ts` 的 `QuestionType` 加 `"scene"`；`src/survey/question-rules.ts` 的 `SURVEY_QUESTION_TYPES` 加 `"scene"`；`src/survey/schema.ts` 的 `SurveyQuestionType` 加 `"scene"`。**无迁移**（`survey_questions.type` 是 TEXT，无 CHECK）。
- 配置：存 `survey_questions.settings_json` 的 `{ scene: HotspotSceneConfig }`；`src/survey/hotspot.ts` 是前后端共用的类型 + 严格校验器（坐标 0..1、id 全局唯一、引用完整性、URL 白名单、12 场景/24 热点护栏；导入校验额外放行 `kv://` 占位）。
- 投影：`src/http/survey/presentation.ts` 的 `questionView` **原样透传 settings**，所以零投影改动、零缓存 bump。
- 媒体：场景图 + 全部内层图挂 `question_media`；`src/http/survey/media.ts` 第一路 UNION 让发布后的问卷素材自动公开（alt 也随 `question.media` 下发）。**只写进 settings_json 的媒体 URL 不命中公开豁免**。
- 答案：`json_value = {"kind":"scene","visited":[hotspotId,…]}`；写入闸门在 `src/http/survey/answers.ts` 的 `planWebAnswer`（未知 id/重复 id 丢弃、非字符串 400、空 visited 清答案），`isWebAnswerPresent` 把空 visited 视为未答。
- 导出：`src/services/export.service.ts` 把 visited 转成热点 label 串联（多场景带场景名）。
- Bot：`src/bot/builder-handler.ts` 的题型标签表加 `scene: "互动场景"`；**不在 Bot 创建向导提供**（与 note 同策略）。Bot 填卷本就走 `/s/:id` 网页链接，无额外适配。

### 3.2 前端

- `admin/src/survey/HotspotScene.tsx`：React 查看器（归一化坐标、`<button>` 热点、clip-path 弹层、焦点陷阱、子场景、visited、断点续答、`scene.intro` 已补渲染）。
- `admin/src/survey/SurveyApp.tsx`：`type === "scene"` 分支；必答门禁「至少探索一处」；探索即入保存队列（点击热点就落库，不等翻题）。
- `admin/src/survey/api.ts`：`AnswerValue` 加 `{kind:"scene",visited:string[]}`。
- `admin/src/index.css`：`.hotspot-*` 查看器样式（主题变量适配）。

### 3.3 内容管线

```
scripts/hotspot/
├── hotspot-survey.json         # 《雨夜书房》定义（kv:// 占位 + mediaMeta）
├── import_hotspot_survey.py    # KV 上传 → 建卷/题 → settings 回填 → question_media → 发布+快照 → verify()
└── assets/                     # 8 张 WebP（约 190KB）
```

- `python3 scripts/hotspot/import_hotspot_survey.py` 是 dry-run；`--apply` 才写远程。
- 脚本内部替换了 wenai `run()`：错误取 stdout+stderr，网络类失败有界重试（wrangler `--json` 把错误打在 stdout，原实现会误报）。
- `insertQuestionWithOptions` 只为 matrix 持久化 settings——所以新建 scene 题必须“POST 空题 + PATCH 写配置”，脚本和编辑器都遵循这一点。

### 3.4 测试（均已通过）

| 文件                                           | 结果                                 |
| ---------------------------------------------- | ------------------------------------ |
| `tests/unit/hotspot-survey.test.ts`            | 12/12                                |
| `tests/unit/http/survey-answers-scene.test.ts` | 5/5（sqlite-d1 全量迁移真实 schema） |
| `tests/unit/scene-editor-model.test.ts`        | 17/17                                |
| `qa/visual/hotspot-scene.spec.ts`              | 3/3（含 axe；route mock）            |
| `qa/visual/scene-editor.spec.ts`               | 7/7（含 axe）                        |
| `pnpm test` 全量                               | 181 文件 / 1297 用例通过             |
| 生产冒烟                                       | 见 §2                                |

`pnpm test:visual` 全量：75 passed；`survey.spec` / `trial.spec` 的截图基线失败是**存量问题**——上一个 commit `98101f9`（暗金默认主题）改了主题但基线只能在 CI 字体环境生成；已在干净 HEAD 上用 `git stash` 复现，与 scene/编辑器无关。**不要本地重拍基线**（仓库约定由 CI 工作流生成，见 `8561188`）。

---

## 4. 场景编辑器（已完成并部署）

### 4.1 计划与决策

- 独立路由 `/admin/surveys/:id/scene/:qid`，不塞进 builder：
  - `useSurveyEditor` 的 `EditableQuestion` 只保留 columns/speaker，`diffOps` 只发 `{columns}`，undo 会把 `settings.scene` 覆盖掉。
- 后端已具备编辑能力（无需新接口/迁移）：`PATCH /api/admin/surveys/:id/questions/:qid` 的 settings 白名单已放行 scene，`editor.ts` 的 speaker-only 检查对 scene 放行。
- 新建：`POST /questions` 建空 scene 题（不传 settings）→ 跳转编辑器 → PATCH 写配置。
- 媒体 URL 双轨：编辑器显示用 `/api/admin/media/<id>/image`（草稿可靠）；保存进配置一律 `/api/survey/media/<id>`；预览前用 `transformConfigForPreview` 把公开 URL 映射回 admin URL。
- 只读边界：`!survey.editable`（非草稿或有答卷）时禁用保存/拖拽/上传，保留预览，并显示原因。

### 4.2 已写文件

新增：

- `admin/src/routes/SceneEditorPage.tsx` — 页面外壳：加载 `GET /editor`、找 scene 题、初始化草稿、baseline/dirty、保存 PATCH、409 重新加载、`useBlocker` + `beforeunload`、只读 banner、侧栏（场景/热点列表）、画布挂载、检查器、媒体选择器、预览、一键新建后的落地页。
- `admin/src/scene-editor/model.ts` — 纯函数：矩形 normalize/move/resize/nudge、id 生成、媒体 URL 双向映射、`transformConfigForPreview`、`validateDraft`、`displayMediaUrl`。
- `admin/src/scene-editor/SceneCanvas.tsx` — Pointer Events 绘制/移动/8 向缩放、`setPointerCapture`、最小尺寸/越界夹紧、键盘列表配合。
- `admin/src/scene-editor/SceneInspector.tsx` — 热点/场景/题目三面板、字段级错误、动作类型切换、起始场景/删除保护。
- `admin/src/scene-editor/MediaPicker.tsx` — 题目图片选择器 + 上传入口（只用已挂 question_media 的图片）。
- `admin/src/scene-editor/PreviewOverlay.tsx` — 全屏预览，复用 `HotspotScene`；Escape/Tab 不与热点弹层抢。
- `tests/unit/scene-editor-model.test.ts` — **17/17 通过**。
- `qa/visual/scene-editor.spec.ts` — 编辑器 E2E（7 用例，见 §4.4）。

已修改：

- `admin/src/App.tsx` — 懒加载 + 路由 `surveys/:id/scene/:qid`。
- `admin/src/components/Layout.tsx` — 页头 title「场景编辑器」。
- `admin/src/components/editor/QuestionCard.tsx` — scene 题加「编辑场景」按钮 + `onOpenSceneEditor` prop；chip 文案改为「用编辑场景配置」。
- `admin/src/routes/EditorPage.tsx` — `openSceneEditor`（先 `flushDraft` 再跳转）、`addSceneQuestion`（POST 空题 + 跳转）、工具栏「添加互动场景」、类型选择器「互动场景」卡片、active QuestionCard 传 `onOpenSceneEditor`。
- `admin/src/api.ts` — `EditorQuestion.settings` 加 `scene?: unknown`。
- `admin/src/survey/HotspotScene.tsx` — 渲染 `scene.intro`（配置里有但之前 UI 没显示）。
- `admin/src/scene-editor/model.ts` — 自跳转校验（scene 动作不能指向当前场景）。

### 4.3 已修复的类型错误（记录）

`pnpm --dir admin exec tsc --noEmit` 当时 6 个错误，现已清零：

1. `QuestionCard.tsx` — 参数列表补 `onOpenSceneEditor,`。
2. `SceneEditorPage.tsx` — 类型导入补 `HotspotScene`。
3. `PreviewOverlay.tsx` — 原生 keydown 改 `trapFocusWithin(overlayRef.current, event)`（这不是 React 合成事件）。
4. `SceneInspector.tsx` — `HotspotPanel` 顶部提前收窄 `imageAction` / `sceneAction`，JSX 与三个 onChange 全部用收窄后的值。

### 4.4 完成情况

1. ✅ **编辑器 CSS** — `admin/src/index.css` 末尾新增 `.scene-editor-*`、`.scene-canvas-*`、`.scene-editor-media-*`、`.scene-editor-preview`、`.hotspot-intro`：三栏（220 / 1fr / 360，≤999px 堆叠）、画布 `pointer-events` 分层、8 向手柄与光标、预览 z-index 70 / 内部弹层 80 + `--survey-*` 映射、390px 无横向溢出、只读 banner / 错误 / dirty 标记。
2. ✅ **Playwright** — 新增 `qa/visual/scene-editor.spec.ts`（7 用例）；`editor-layout.spec.ts` 加「添加互动场景 → POST → 跳转」。覆盖：拖拽新建→选图→保存 payload、移动/缩放/方向键、加场景/设起始/scene 动作、上传刷新 `baseUpdatedAt`、只读（published / responseCount>0）、409 重新加载、axe、1440/390 无溢出。
3. ✅ **文档** — `docs/guides/HOTSPOT_SCENES.md` §6 改为独立场景编辑器；`docs/guides/QUESTION_TYPES.md` scene 行改为「独立场景编辑器」。
4. ✅ **门禁（本次全绿）** — admin tsc 0；`pnpm typecheck` / `pnpm lint` / `pnpm format:check` 通过；`pnpm test` 181 文件 / 1297 用例；`pnpm build:admin` 通过；`pnpm exec playwright test hotspot-scene scene-editor editor-layout` **17/17**。
5. ⏳ **手动验收（待做，需要生产管理员会话）** — 后台把 9136 复制为草稿 → 打开场景编辑器 → 拖一个热点/改图/保存 → 预览 → 确认原 9136 未被修改。
6. ✅ **部署（2026-10-27）** — `pnpm deploy` 已上线，Version `b6c8283b-c713-439b-8130-91b8eb0c93c0`；包含 notes + scene + 场景编辑器。部署后 `/health`、`/admin/`、编辑器路由与新 chunk 均 200。

---

## 5. 关键约束 / 坑（不要踩）

- **不要 git commit**：工作区大量改动是用户明确要求保留的；不要 `git checkout`/`git reset`/`git stash pop` 乱动。
- **不要把 scene 加进 `EDITABLE_TYPES`**：那会进 builder 的新建题型列表、触发类型切换/undo/diffOps，而 `EditableQuestion` 不保留 `settings.scene`，保存会清掉配置。编辑器是独立路由。
- **不要改热点 id**：答案存的是 id；编辑器只读展示。删除热点会让历史答案里的 id 在提交时被服务端丢弃。
- **不要把场景配置放进 theme**：用户自选主题预设会整体替换 theme（`SurveyApp.tsx` 的 `resolvedUserPreset ? {preset} : survey.theme`），热点会整体消失；且用户主题覆盖是既有行为。
- **不要只把媒体 URL 写进 settings_json**：公开性检查扫 `question_media`（和 `surveys.settings_json`），题目 settings 里的 URL 不命中豁免，草稿预览/发布后都可能 404。场景图/内层图必须挂 question_media。
- **不要编辑已发布/有答卷的问卷**：`loadWritableSurvey` 会拒；编辑器只读 banner 就是为此。要编辑先复制为草稿。
- **不要本地重拍 visual 基线**：见 §3.4。
- **生产 9136 的 `anonymous=0` 是产品决定**：注册墙对所有问卷生效；local smoke 用 mock 身份端点，不代表线上能匿名填。
- `insertQuestionWithOptions` 只持久化 matrix settings：新建 scene 题不要试图在 POST body 里带 settings。
- `SURVEY_DEFINITION_CACHE_VERSION` **不需要** bump：settings 原样透传，投影形状没变。

---

## 6. 验证命令速查

```bash
cd /home/emo/code/telegram-bot

# 类型检查
pnpm --dir admin exec tsc --noEmit

# 门禁
pnpm typecheck
pnpm lint
pnpm format        # 新文件先格式化
pnpm format:check
pnpm test
pnpm build:admin   # 会重生成 cert/cert.html；之后需 pnpm exec prettier --write cert/cert.html
pnpm exec playwright test hotspot-scene scene-editor editor-layout

# 内容管线（dry-run / 生产）
python3 scripts/hotspot/import_hotspot_survey.py
python3 scripts/hotspot/import_hotspot_survey.py --apply

# 生产核验
curl -s https://emoe.eu.cc/health
curl -s https://emoe.eu.cc/api/survey/9136 | python3 -m json.tool | head
```

---

## 7. 工作区 / 未提交改动（重要）

`git status` 里除了本次 scene/编辑器，还包含**上一个会话完成的「纸条聊天 /notes」**：

- 新增：`admin/src/survey/NoteScreen.tsx`、`note-api.ts`、`src/http/note-api.ts`、`src/services/note-chat.service.ts`、`db/migrations/0089_note_chat.sql`、`tests/unit/note-chat.test.ts`、`docs/guides/EDITOR_GUIDE.md`、`docs/releases/RELEASE_2026-10-24.md`
- 修改：`admin/src/survey/CoinCenter.tsx`、`MyScreen.tsx`、`src/http/public-page.ts`、`src/index.ts`、`src/services/coin/ledger.service.ts`、`src/services/database-maintenance.service.ts`、`cert/*`、`admin/public/sw.js` 等
- `0089_note_chat.sql`：`wrangler d1 migrations apply` 显示 **No migrations to apply**（远程已应用）；不要重复/回滚。
- 最近一次 `pnpm deploy` 已把 notes + scene 带上生产；编辑器是之后才写的，**未部署**。

不要回滚这些改动；下一步的门禁/构建会同时覆盖它们。

---

## 8. 下一步（编辑器已上线）

1. 读本文 + `docs/guides/HOTSPOT_SCENES.md`；门禁与测试现状见 §4.4。
2. 生产手动验收：后台把 9136 复制为草稿 → 场景编辑器 → 拖热点/改图/保存 → 预览 → 确认原 9136 未变。
3. 后续改动部署同前：`pnpm deploy`（会把整个工作区 notes + scene + 编辑器一起上传）。
4. 部署后按 §2 的方式复跑生产冒烟；不要本地重拍 visual 基线（§3.4）。

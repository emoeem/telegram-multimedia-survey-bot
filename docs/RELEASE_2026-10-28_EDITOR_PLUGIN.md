# 更新日志 · 2026-10-28（编辑器插件化 / 素材库补缺 / 编辑器增量）

> 承接同日《RELEASE_2026-10-28_GAME_ZONE_MEDIA.md》（小游戏区 + 双联动 + 素材库首版）。
> 本轮主题是**把"新增一个游戏"从改代码变成装插件**，并补齐上一轮留下的两个缺口。
> 下一步要做的事见 `docs/HANDOVER_EDITOR_P2_PLAN.md`。

## 一句话总结

游戏玩法改成插件化接入（**写一个目录 + 一行注册**，主程序零改动），交付「答题翻牌」示例插件并端到端可玩；
素材库补上**孤儿 blob 回收**（真 bug）与**选项媒体的选库入口**；编辑器加入**基础/专业模式、依赖感知删除、
逻辑关系面板、三套模板**；修掉**小游戏题创建被服务端白名单拦截**的 bug。

## 一、游戏插件化

### 1.1 协议：一个 id、两半身

得分必须服务端权威计算（客户端分数一律丢弃），所以插件不是单一 React 组件：

| 半身               | 位置                                            | 内容                                                  | 编译进         |
| ------------------ | ----------------------------------------------- | ----------------------------------------------------- | -------------- |
| 清单 + 属性 Schema | `src/game-plugin/plugins/<id>/manifest.ts`      | 元信息、`PropField[]`、默认值                         | Worker + admin |
| 服务端引擎         | `src/game-plugin/plugins/<id>/engine.ts`        | `createRun / apply / grade / view / isAction`，纯函数 | 仅 Worker      |
| 客户端视图         | `admin/src/game-plugins/plugins/<id>/index.tsx` | `EditView` + `PlayView`                               | 仅 admin       |

两半用同一个 `id` 绑定，id 落进 `task_packs.game_type`。

### 1.2 新增基础设施

- `src/game-plugin/types.ts`：`GamePluginManifest`、7 种 `PropField`（`collects` 标记是否参与作答数据）、
  `ConfigOf<P>` 值类型推导、`GameRunView`、`GameEngine<S,A>`、`ConfigIssue`。**禁止 import react**（Worker 也要编译）。
- `src/game-plugin/props.ts`：`defaultConfig / normalizeConfig / validateWithSchema`。
  白名单归一化是安全边界——`settings_json` 可写，越界键丢弃、数值夹取、类型回落、列表先过滤再截断。
- `src/game-plugin/registry.ts`：注册中心。hostApi / id 格式 / 重名在**启动期**报错；
  `validateConfig` 是保存任务包前的统一闸门。错误信息里的 id 经 `safeIdForMessage()` 截断清洗。
- `src/game-plugin/server-plugins.ts`：**新增玩法唯一需要改的文件（一行）**。
- `admin/src/game-plugins/loader.ts`：`import.meta.glob` 自动发现客户端半身 → **客户端零注册**，每插件独立 chunk。
- `admin/src/game-plugins/SchemaForm.tsx`：按 Schema 自动生成属性面板（media 选库、嵌套 list 增删排序、字段级错误）。
- `admin/src/game-plugins/types.ts` / `define.ts`：`GamePluginClient<P,C>`（C 是插件自己的配置类型）、
  `defineGamePlugin`（冻结）、`GameHostBridge`、`GameLifecycleHooks`。

### 1.3 示例插件「答题翻牌」（flip-card）

- 内容：卡组（正面/背面/选项/分值）、打乱、通关线、封面。
- 服务端权威判分：正确项固定为 `options[0]`，**只存在于服务端配置**；`view.payload` 永不输出正确性。
- 幂等：动作带 `step`（0 基游标），陈旧提交（网络重试/重连）不推进指针、不重复加分。
- 确定性随机：`random` 由宿主注入，同 seed 同卡序（可测、可重放）。
- 容错：空配置 total=0 直接结算；越界选项夹到合法区间；状态损坏由 API 按"放弃"结算，不让人卡死。

### 1.4 服务端分发

- 新文件 `src/http/trial-plugin-api.ts`：插件局的开局 / 动作 / 断线恢复 / 放弃。
- `task_runs.state_json` 存信封：`{kind:"plugin", plugin, state, grade?}`；
  `step/total` 映射到 `current_floor/max_floor`、`score` 直接写 `score` —— 排行榜、历史列表、进度条
  无需知道"这局是什么玩法"。
- `src/trial/engine-registry.ts`：玩法清单 = 内置 `tower` + 注册表插件；`normalizeGameType` 同时对两者生效。
- `src/http/admin/write.ts`：任务包写入走 `registry.validateConfig`，有 error 即 400。
- `src/http/survey/answers.ts`：插件局评级取信封里的 `grade`；爬塔仍实时算。

### 1.5 两端接线

- 后台「小游戏管理」：玩法下拉来自 `/api/trial/packs` 的 `gameTypes`（服务端注册表）；
  插件包显示 `SchemaForm` + 插件自己的 `EditView` 预览；爬塔包保持原任务清单表单。
- 问卷答题：`game` 题按 `settings.game.gameType` 选渲染器——`tower` 走内置 `GamePlayer`，
  其余走新宿主 `PluginGamePlay`。
- `PluginGamePlay` 的三条边界：网络只在宿主；答案只走规范形状
  `{kind:"game", runId, score, grade, completed}`；**配置不下发给 PlayView**（它需要的一切都来自 `view.payload`）。

## 二、素材库补缺

### 2.1 孤儿 blob 回收（bug 修复）

内容寻址 blob（`media:blob:<sha256>`，无 TTL）在每日孤儿清扫里只删了 `media_assets` 行，
blob 会永久留在 R2。现在：删行前取 `storage_key`，删完若已无任何 asset 行指向同一 key
（去重后可能被别的行共享）才删对象。`runDatabaseMaintenance` 增加可选 `store` 参数，cron 传入 `createMediaStore`。

### 2.2 选项媒体「从素材库选择」

`editor.ts` 选项上传端点新增 JSON `{assetId}` 分支；`QuestionCard` 每个选项行复用 `LibraryPicker`。
至此题目附件与选项媒体都能引用已有素材（只建关联、不重传）。

### 2.3 仍未做（有意）

BGM / 场景图写入侧仍是 URL 字符串（已登记 `media_refs` 弱引用，但未改存 mediaAssetId）——
会动场景编辑器，违反 `HOTSPOT_EDITOR_HANDOVER` 的三条禁令，见交接文档「专项」。

## 三、编辑器增量改造

| 能力            | 行为                                                                                               | 落地                                                   |
| --------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 基础 / 专业模式 | 顶栏切换，`localStorage: admin:editor-mode`；只改可见性不动文档，切换不丢进度                      | `EditorPage`                                           |
| 依赖感知删除    | 删除前扫描全部 condition（选项跳转/答案规则/flag/旧式 skipTo），列出影响面，确认后级联清理、可撤销 | `admin/src/editor/dependencies.ts` + 单测              |
| 逻辑关系面板    | 右栏「逻辑」页签（仅专业模式），列出去向/来源，点击跳到目标题                                      | `components/editor/LogicPanel.tsx`                     |
| 模板            | 添加栏「从模板开始」：问卷基础 / 单题小游戏 / 混合互动，按序插入、可撤销                           | `EditorPage` + `useSurveyEditor.addQuestion(settings)` |
| 撤销 / 重做     | 沿用既有快照 + Ctrl+Z / Ctrl+Shift+Z；新增删除/模板走同一条待保存队列                              | 既有 `useSurveyEditor`                                 |

**未做（P2）**：三栏外壳整体重排（物料/画布/属性）、画布拖拽吸附、画布连线。原因与完整方案见交接文档。

## 四、顺带修复的 bug

1. **小游戏题建不出来**：`SURVEY_QUESTION_TYPES`（`src/survey/question-rules.ts`）漏了 `"game"`，
   上一轮只加了联合类型。后台建题会被 `admin/helpers.ts:332` 的白名单直接 400。
2. **validator 缺游戏题校验**：补 `settings.game.packId` 必填检查。
3. **素材 blob 泄漏**：见 2.1。

## 五、数据与接口变化

- `task_packs.settings_json`：插件配置，写入前经 Schema 归一化；爬塔不使用。
- `task_runs.state_json`：新增插件信封 `{kind:"plugin", plugin, state, grade?}`；爬塔形状不变。
- 问卷 `settings.game`：新增可选 `gameType`（只用于答题端选渲染器；服务端仍以 `task_packs.game_type` 为准）。
- `GET /api/trial/packs`：`gameTypes` 现在包含已注册插件。
- 插件局的 `POST /api/trial/runs` 与 `/:id/action` 返回 `{run, view, finished, result}`（爬塔响应不变）。
- **无新数据库迁移**；上线仍需先跑上一轮的 `0090_game_zone.sql`、`0091_media_library.sql`。

## 六、验证结果

| 项                                                | 结果                                                    |
| ------------------------------------------------- | ------------------------------------------------------- |
| 单测 `pnpm test`                                  | **194 文件 / 1410 用例全绿**（本轮 +4 文件 / +38 用例） |
| 类型 `pnpm typecheck` + `admin` 内 `tsc --noEmit` | 干净                                                    |
| 构建 `pnpm build:admin`                           | 通过（chunk 体积警告为既有现象）                        |
| `eslint` 新代码                                   | 无告警                                                  |

**本轮未跑（环境限制，接手必须补）**：`pnpm test:visual:gate`、`pnpm test:visual:prod`、axe a11y。
本轮改了编辑器顶栏/右栏/添加栏与后台任务包页，**视觉基线必然变化**，须走 CI 手动工作流
「Visual baseline」重生成，**不要本地 `--update-snapshots`**。

## 七、部署注意与已知限制

1. **部署顺序**：`pnpm migrate:remote`（0090/0091）→ `pnpm deploy`。存量任务包自动为 `tower`。
2. **视觉基线**：只能由 `.github/workflows/visual-baseline.yml`（workflow_dispatch）生成。
3. **已知限制**：
   - 插件玩法在 Bot 端只读题面（网页交互），Bot 向导不能新建 game 题。
   - 「抽取玩法」尚未作为独立玩法上线：抽取服务 `game-draw.service.ts` 已就绪、认证卡在用；
     做成游戏包只需按插件协议补 engine（见交接文档）。
   - 场景图 / BGM 仍是 URL 字符串引用。
   - 三栏画布外壳与连线未做（P2）。
4. **客户部署**：去重与插件都只在实例内生效（D1/R2 物理隔离）。

## 八、文件清单

**新增 · 服务端 / 共享**
`src/game-plugin/types.ts`、`props.ts`、`registry.ts`、`server-plugins.ts`、
`plugins/flip-card/manifest.ts`、`plugins/flip-card/engine.ts`、`src/http/trial-plugin-api.ts`

**新增 · admin**
`src/game-plugins/types.ts`、`define.ts`、`loader.ts`、`SchemaForm.tsx`、`plugins/flip-card/index.tsx`、
`src/survey/PluginGamePlay.tsx`、`src/components/editor/LogicPanel.tsx`、`src/editor/dependencies.ts`

**新增 · 测试**
`tests/unit/game-plugin/{props,registry,flip-card}.test.ts`、`tests/unit/editor/dependencies.test.ts`

**新增 · 文档**
`docs/EDITOR_PLUGIN_ARCHITECTURE.md`、`docs/RELEASE_2026-10-28_EDITOR_PLUGIN.md`（本文）、
`docs/HANDOVER_EDITOR_P2_PLAN.md`

**主要修改**
`src/survey/question-rules.ts`、`validator.ts`、`game.ts`、`src/http/trial-api.ts`、`admin/write.ts`、
`admin/editor.ts`、`survey/answers.ts`、`task-run.repository.ts`、`trial/engine-registry.ts`、
`services/database-maintenance.service.ts`、`src/index.ts`、`EditorPage.tsx`、`QuestionCard.tsx`、
`TaskPacksPage.tsx`、`SurveyApp.tsx`、`useSurveyEditor.ts`、`admin/src/api.ts`

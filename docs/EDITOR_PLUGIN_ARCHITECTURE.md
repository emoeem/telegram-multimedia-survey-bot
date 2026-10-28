# 游戏插件协议与编辑器改造（2026-10-28）

## 一、插件协议：一个 id、两半身

本项目的小游戏得分必须由服务端权威计算（客户端提交的分数一律丢弃），所以
"插件"不是单一 React 组件：

| 半身 | 位置 | 内容 | 编译进 |
|---|---|---|---|
| 清单 + 属性 Schema | `src/game-plugin/plugins/<id>/manifest.ts` | 元信息、`PropField[]`、默认值 | Worker + admin |
| 服务端引擎 | `src/game-plugin/plugins/<id>/engine.ts` | `createRun/apply/grade/view/isAction`，纯函数 | Worker |
| 客户端视图 | `admin/src/game-plugins/plugins/<id>/index.tsx` | `EditView` + `PlayView` | admin bundle |

两半用同一个 `id` 绑定，id 落进 `task_packs.game_type`。

### 关键文件

- `src/game-plugin/types.ts` — 协议类型（`GamePluginManifest`、`PropField`、
  `ConfigOf<P>`、`GameEngine<S,A>`、`ConfigIssue`）。**禁止 import react**。
- `src/game-plugin/props.ts` — 默认值 / 白名单归一化 / 结构校验（纯函数）。
  `task_packs.settings_json` 是管理员可写 JSON，归一化是安全边界。
- `src/game-plugin/registry.ts` — 注册中心（重名、hostApi、id 格式启动期校验）。
- `src/game-plugin/server-plugins.ts` — **唯一需要改动的注册文件（一行）**。
- `admin/src/game-plugins/loader.ts` — `import.meta.glob` 自动发现客户端半身（零注册）。
- `admin/src/game-plugins/SchemaForm.tsx` — 按 `PropField[]` 自动生成属性面板。
- `admin/src/game-plugins/types.ts` — 客户端协议（`GamePluginClient`、宿主桥、生命周期）。

### 新游戏接入步骤

1. `src/game-plugin/plugins/<id>/manifest.ts`：manifest + `props`（`collects` 标记是否参与作答数据）。
2. `src/game-plugin/plugins/<id>/engine.ts`：实现 `GameEngine`，导出 `{ manifest, props, engine }`。
3. `admin/src/game-plugins/plugins/<id>/index.tsx`：`defineGamePlugin({...})`。
4. `src/game-plugin/server-plugins.ts` 加一行。
5. 跑测试：`tests/unit/game-plugin/registry.test.ts` 断言「插件目录集合 === 注册集合 === 客户端实现集合」，漏登记直接红。

之后：物料区/任务包下拉自动出现玩法、属性面板自动生成、答题端自动渲染。主程序零改动。

### 安全边界（改代码时别顺手破）

- `PluginGamePlay` **不把任务包配置下发给 PlayView**：正确项存在于 settings，
  客户端要展示的一切都来自服务端算好的 `view.payload`。
- 动作白名单在插件引擎（`isAction`），未知动作 400。
- 幂等：flip-card 的动作带 `step`，陈旧提交（网络重试）不推进指针。
- 插件状态损坏（升级后 schema 变化）→ API 按「放弃」结算，不让参与者卡死。

## 二、服务端分发

- `src/http/trial-plugin-api.ts`：插件局的开局 / 动作 / 断线恢复 / 放弃。
- `task_runs.state_json` 存信封 `{kind:"plugin", plugin, state, grade?}`；
  step/total 映射到 current_floor/max_floor，score 直接写 score——排行榜、
  历史列表、进度条都不必知道玩法。
- `src/trial/engine-registry.ts`：玩法清单 = 内置 `tower` + 注册表里的插件。
- `src/http/admin/write.ts`：任务包写入走 `registry.validateConfig` 归一化，error 即 400。
- `src/http/survey/answers.ts`：插件局的评级取信封里的 `grade`（爬塔实时算）。

## 三、编辑器增量改造（本轮）

- **基础 / 专业模式**：顶栏切换，`localStorage` 持久化；只改可见性不动文档。
  基础模式隐藏「逻辑」页签，切换不丢进度。
- **依赖感知删除**：删除题目先扫描所有 condition（选项跳转 / 答案规则 /
  flag 跳转 / 旧式 skipTo），确认框列出影响面，确认后级联清理（同一批待保存
  操作，可撤销）。纯函数在 `admin/src/editor/dependencies.ts`，有单测。
- **逻辑关系面板**：右栏「逻辑」页签，列出去向/来源，点击即跳到目标题。
- **模板**：添加栏「从模板开始」，问卷基础 / 单题小游戏 / 混合互动三套，
  按顺序插入（可撤销）。
- 撤销/重做沿用既有快照 + Ctrl+Z / Ctrl+Shift+Z。

**本轮未做（按迁移计划 P2）**：三栏画布外壳整体重排（物料区/画布/属性区）、
画布拖拽吸附与连线、属性区右移。原因：需替换 1437 行编辑器外壳并重建视觉
基线（只能 CI 生成），一次性提交无法验证；计划用 `?ui=next` 并行验证。

## 四、素材库补缺

- **孤儿 blob 回收（bug 修复）**：内容寻址 blob（`media:blob:<sha256>`，无 TTL）
  在每日清理删行后若已无任何 asset 行引用，连 blob 一起删除；
  `runDatabaseMaintenance` 新增可选 store 参数，cron 传入 `createMediaStore`。
- **选项媒体「从素材库选择」**：`editor.ts` 选项上传端点新增 JSON `{assetId}`
  分支，QuestionCard 每个选项行复用 `LibraryPicker`。
- **仍缺（已知）**：BGM/场景图写入侧仍是 URL 字符串（已登记弱引用，未结构化）；
  场景图结构化留专项，避免动场景编辑器。

## 五、验证

- 单测：194 文件 / 1410 用例全绿（本轮 +4 文件 / +38 用例）。
  新增覆盖：属性 Schema 归一化与校验、注册表约束与目录一致性、flip-card 引擎
  （判分/幂等/视图不泄露答案/确定性随机/空配置不崩）、编辑器依赖分析。
- 双端 `tsc --noEmit` 干净；`pnpm build:admin` 通过；新代码 eslint 干净。
- 无新迁移：复用 `task_packs.settings_json` 与 `task_runs.state_json`。
- 需先跑 0090 / 0091（上一轮已交付）。

## 六、其它修复

- `src/survey/question-rules.ts` 的 `SURVEY_QUESTION_TYPES` 补 `"game"`：
  上一轮加了联合类型却漏了运行时白名单，会导致后台创建小游戏题被 400。
- `validator.ts` 补 game 题的 `settings.game.packId` 校验。

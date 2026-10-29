# 更新日志 · 2026-10-28 晚（编辑器 P2 三栏外壳 S0–S3）

> 承接同日《RELEASE_2026-10-28_EDITOR_PLUGIN.md》，执行 `docs/guides/HANDOVER_EDITOR_P2_PLAN.md` 的
> P2 第 S0–S3 步。旧编辑器仍是默认；新壳在 `/admin/surveys/:id/editor?ui=next` 并行验证。

## 一句话总结

`?ui=next` 路由开关 + 从 QuestionCard 抽出 QuestionForm（纯重构）+ 三栏新壳骨架
（物料区 / 画布 / 属性面板，选中即配置）+ 选中卡快捷条（复制 / 上下移 / 必答 / 级联删除）。
旧壳 DOM 与视觉零变化；单测 194→196 文件、1410→1422 用例全绿。

## 一、交付内容（对照交接文档步骤）

### S0 · 路由开关

- `EditorPage.tsx` 顶部读 `?ui=next`：命中才 lazy 加载新壳 chunk（`Suspense` + 动态 import），
  默认路径与既有行为、包体零变化。

### S1 · QuestionForm 抽取（纯重构）

- 新文件 `admin/src/components/editor/QuestionForm.tsx`：题卡表单体整体搬出（标题/描述/说话人、
  小游戏包、必答、题面附件+素材库、分页、选项（媒体·跳转·Flag）、矩阵列、Flag 跳转、校验），
  `commitCondition` 四区段合并逻辑随迁。
- 新文件 `question-types.ts`：EDITABLE_TYPES 等题型集合与 `editableTypeList()`，
  QuestionCard 保留 re-export。
- `QuestionCard.tsx` 只剩头部（题号/题型切换/场景提示/复制/删除），内部渲染 QuestionForm；
  对外 props 契约不变。DOM 类名不动——旧壳视觉零差异是本步硬约束。

### S2 · 三栏新壳骨架

- `admin/src/components/editor/next/EditorShell.tsx`：顶栏（返回/可编辑标题/保存状态/
  基础·专业/撤销重做/保存/预览/发布）+ 三栏；预览改为顶栏按钮弹层（复用 SurveyPreview modal）；
  自动保存、Ctrl+Z/Y、SPA 离开守卫与旧壳同一节奏。
- `next/MaterialPanel.tsx`（左栏物料区）：题型分组（与 TypePickerSheet 同一份数据）、互动场景、
  分页管理、三套模板；点击即插入（走同一条待保存队列，可撤销）。
- `next/Canvas.tsx`（中栏画布）：摘要卡列表 + 选中高亮 + 问卷设置入口 + 底部添加栏。
- `next/PropertiesPanel.tsx`（右栏属性区）：选中题目 → 完整 QuestionCard；选中设置 →
  SurveySettingsPanel；专业模式追加「逻辑」页签（LogicPanel）。
- **两壳共用同一套动作**：新钩子 `admin/src/editor/editor-actions.ts` 把旧壳的结构/媒体/发布/
  级联删除/模板动作原样收拢，旧壳 `EditableEditor` 改为消费它——语义只有一份，不会漂移。
- 共享组件抽出（旧壳同步改用）：`QuestionSummaryRow`、`TypePickerSheet`（含 TYPE_GROUPS）、
  `SurveySettingsPanel`（含金币解锁/结局奖池/报告模板）、`EditableTitle`、
  `templates.ts`（默认题稿 + 三套模板，纯函数）。

### S3 · QuickBar 快捷条

- `next/QuickBar.tsx`：激活卡浮层，复制 / 上移 / 下移 / 必答 / 删除。
- 删除走 `admin/src/editor/delete-with-cascade.ts`（纯函数：`planQuestionDeletion` +
  `deletionConfirmMessage`）：有跳转指向时先列影响面确认，确认后清引用 + 删除在同一批
  待保存操作里，Ctrl+Z 可整体回退——两壳同一语义。
- 必答 = 本地立即生效 + 入队（与旧壳批量必答同一条语义）；复制沿用「直连 API + 刷新」。

## 二、测试

- 新增 `tests/unit/editor/templates.test.ts`（7 用例）：默认稿覆盖全部可编辑题型、未知题型回落、
  三套模板的插入数量与顺序。
- 新增 `tests/unit/editor/delete-with-cascade.test.ts`（5 用例）：选项跳转 / flag 跳转 /
  旧式 skipTo 的影响面与清引用补丁、只剩空壳置 null、确认文案 6 条截断。
- `qa/visual/editor-layout.spec.ts` 追加「P2 三栏外壳（?ui=next）」6 个用例（几何断言，不用像素）：
  135 题三栏等高无页面滚动、画布栏内滚动、新壳无内嵌手机预览、选中即配置 + 快捷条必答切换、
  问卷设置入口、物料添加即选中（待保存态）、空问卷、900px 窄屏属性栏隐藏。
- **顺带修复**：`admin/src/format.ts` 不再从 `api.ts` 导入 `SurveyStatus`（类型定义移入 format，
  api.ts re-export）——否则新增单测会把浏览器代码拉进 Worker 侧根编译（无 DOM lib 报错）。

## 三、验证结果

| 项                                               | 结果                                                                 |
| ------------------------------------------------ | -------------------------------------------------------------------- |
| 单测 `pnpm test`                                 | **196 文件 / 1422 用例全绿**（基线 194/1410，+2 文件 / +12 用例）    |
| `pnpm typecheck`（Worker）+ admin `tsc --noEmit` | 干净                                                                 |
| `pnpm lint`                                      | 无告警                                                               |
| `pnpm build:admin`                               | 通过（chunk 体积警告为既有现象）                                     |
| `pnpm exec playwright test editor-layout`        | **13/13 通过**（旧壳 7 + 新壳 6）                                    |
| 视觉门禁 `pnpm test:visual:gate`                 | 107 失败 = **检查点提交上逐个相同**（经 stash 对照验证），本轮零新增 |

### 视觉基线欠账（接手必须补，与交接文档一致）

107 个快照失败是多轮累计漂移（上一轮及更早改过的编辑器/任务包/答题端/admin 页面），本轮经
「stash 对照」验证**没有新增任何一处**。唯一正确做法照旧：
GitHub → Actions → **Visual baseline**（workflow_dispatch）重生成，**不要本地 `--update-snapshots`**。
重生成需先推送本提交。

## 四、部署注意与已知限制

1. **无新数据库迁移**；本轮纯 admin 前端。
2. 新壳默认关闭（`?ui=next` 显式进入），线上用户不受影响；S10 才切默认。
3. 新壳当前能力边界（后续步骤补齐）：无拖拽（S4）、撤销走既有快照模型（命令日志是 S5）、
   无画布连线（S6）、插件 SchemaForm 属性配置未迁入属性区（S7，配小游戏包仍走题卡内
   GamePackField）、场景题仍跳独立编辑器（壳内浮层是 P3）。
4. 旧壳入口、行为、截图不变。

## 五、文件清单

**新增 · admin**
`components/editor/QuestionForm.tsx`、`components/editor/question-types.ts`、
`components/editor/QuestionSummaryRow.tsx`、`components/editor/TypePickerSheet.tsx`、
`components/editor/SurveySettingsPanel.tsx`、`components/editor/EditableTitle.tsx`、
`components/editor/next/{EditorShell,MaterialPanel,Canvas,PropertiesPanel,QuickBar}.tsx`、
`editor/editor-actions.ts`、`editor/delete-with-cascade.ts`、`editor/templates.ts`

**新增 · 测试 / 文档**
`tests/unit/editor/templates.test.ts`、`tests/unit/editor/delete-with-cascade.test.ts`、
`docs/releases/RELEASE_2026-10-28_EDITOR_P2_SHELL.md`（本文）

**修改**
`admin/src/routes/EditorPage.tsx`（消费共享模块 + ?ui=next 分支）、
`admin/src/components/editor/QuestionCard.tsx`（只剩头部 + QuestionForm）、
`admin/src/api.ts` 与 `admin/src/format.ts`（SurveyStatus 归位）、
`qa/visual/editor-layout.spec.ts`（新壳几何用例）

## 六、下一步（按交接文档）

S4 拖拽（物料拖入 + 同页排序 + 8px 吸附）→ S5 命令日志接入撤销/保存 → S6 画布连线 →
S7 基础/专业 + 模板 + 插件配置完整迁入 → S8 往返逐字节测试 → S9 视觉基线（CI）+ a11y →
S10 切默认。另有交接文档 §5 的两个高优速赢（draw 插件、Bot 端 web_app 按钮）未动。

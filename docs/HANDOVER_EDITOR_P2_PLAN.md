# 交接与下一步完整计划（编辑器外壳 P2 · 场景媒体结构化 · 遗留项）

> 面向接手的人。读完这份文档，你应该知道：**已经有什么、还缺什么、每一件怎么做、做完怎么验。**
> 配套阅读：`docs/EDITOR_PLUGIN_ARCHITECTURE.md`（插件协议与接入）、
> `docs/RELEASE_2026-10-28_EDITOR_PLUGIN.md`（本轮更新日志）、
> `docs/HOTSPOT_EDITOR_HANDOVER.md`（场景编辑器的三条禁令，动编辑器前必读）。

---

## 0. 先跑一遍，确认起点

```bash
pnpm install
pnpm --dir admin install
pnpm test          # 期望：194 个文件 / 1410 个测试全绿
pnpm typecheck     # Worker
cd admin && pnpm exec tsc --noEmit && cd ..   # admin
pnpm build:admin   # 期望：构建成功（chunk 体积警告是既有现象）
```

基线数字写在 `docs/RELEASE_2026-10-28_EDITOR_PLUGIN.md`。**任何后续改动都应让这两个数字只增不减**
（新增测试文件会改第一个数字，属正常）。

---

## 1. 已经完成什么（不要重做）

| 领域 | 已完成 | 关键文件 |
|---|---|---|
| 游戏插件协议 | manifest + 属性 Schema + 服务端引擎 + 客户端视图，一个 id 两半身 | `src/game-plugin/*`、`admin/src/game-plugins/*` |
| 插件注册与发现 | 服务端一行注册；客户端 `import.meta.glob` 零注册；三方一致性测试 | `server-plugins.ts`、`loader.ts`、`tests/unit/game-plugin/registry.test.ts` |
| 示例插件 | 答题翻牌（服务端判分、step 幂等、视图不泄露答案） | `plugins/flip-card/*` |
| 插件局运行 | 开局/动作/断线恢复/放弃；`state_json` 插件信封 | `src/http/trial-plugin-api.ts`、`task-run.repository.ts` |
| 后台配置 | 玩法下拉来自注册表；插件包用 SchemaForm + EditView 预览 | `TaskPacksPage.tsx`、`SchemaForm.tsx` |
| 答题端 | `game` 题按 `gameType` 选渲染器；宿主桥不碰插件网络 | `PluginGamePlay.tsx`、`SurveyApp.tsx` |
| 编辑器增量 | 基础/专业模式、依赖感知删除、逻辑关系面板、三套模板 | `EditorPage.tsx`、`dependencies.ts`、`LogicPanel.tsx` |
| 素材库 | 内容寻址去重、Telegram 复用 + 回读 R2、弱引用登记、**孤儿 blob 回收**、题目/选项选库 | `media-dedup.service.ts`、`database-maintenance.service.ts` |

### 1.1 五条不可破坏的不变量

动任何代码前先记住这五条，它们都有测试或血的教训兜着：

1. **服务端权威计分**：客户端提交的分数一律丢弃；插件配置（含正确项）**不得下发**给答题端
   （`PluginGamePlay` 只给 `PlayView` 传 `config={{}}`，一切展示来自 `view.payload`）。
2. **数据形状不改**：`condition_json` / `settings_json` 的形状是兼容前提。编辑器只能换"怎么编辑"，
   不能换"存什么"。任何结构调整都要有"旧文档 → 新模型 → 旧文档"往返测试。
3. **视觉基线只能 CI 生成**：`toHaveScreenshot` 对字体极敏感，本地 `--update-snapshots` 会把本地字体写进基线，
   推上去每张图都失败。唯一通道：GitHub Actions 手动跑 `Visual baseline`（`.github/workflows/visual-baseline.yml`）。
4. **场景三条禁令**（详见 `HOTSPOT_EDITOR_HANDOVER.md`）：`scene` 不进 `EDITABLE_TYPES`（undo 会清掉
   `settings.scene`）、不改热点 id（历史答案会被服务端丢弃）、场景媒体必须挂在 `question_media`
   （否则草稿/发布后 404）；场景配置不能塞进 theme（用户主题预设会整体替换）。
5. **插件三方一致**：`src/game-plugin/plugins/*`（目录）=== `server-plugins.ts`（注册）===
   `admin/src/game-plugins/plugins/*`（客户端实现）。`registry.test.ts` 会拦。

---

## 2. P2：三栏画布外壳（优先做，工作量最大）

### 2.1 为什么本轮没做

- 要替换整个编辑器外壳（`EditorPage.tsx` 约 1500 行）并重排 `QuestionCard.tsx`（约 1170 行）的编辑表单；
- 会改动编辑器所有截图，`admin.spec.ts-snapshots` 现有 **80 张**基线（40 个页面 × 2 视口）需要全部重生成；
- 基线只能 CI 生成，本地无法验证像素结果，一次性提交风险过高。

### 2.2 目标形态

```
┌──────────────────────────────────────────────────────────────┐
│ 顶栏：返回 │ 标题·状态 │ 已保存 · 撤销/重做 · 基础/专业 · 预览 · 发布 │
├───────────────┬──────────────────────────────┬───────────────┤
│ 左：物料区     │ 中：画布（可缩放、拖拽、吸附） │ 右：属性区      │
│ 题目/游戏/模板 │ 卡片 + 快捷条 + 连线层        │ 选中即配置      │
└───────────────┴──────────────────────────────┴───────────────┘
```

关键变化：**右栏从「实时预览」变成「属性面板」**，预览移到顶栏按钮打开的抽屉（已有 `SurveyPreview` 可复用）。

### 2.3 组件切分（建议，可按实际情况微调）

| 组件 | 职责 | 复用 |
|---|---|---|
| `EditorShell.tsx` | 三栏布局、页签、模式、命令日志接线 | `useSurveyEditor` |
| `MaterialPanel.tsx` | 题目类型（现有 `TypePickerSheet` 的目录化）、小游戏（来自 `/api/trial/packs` 的 `gameTypes` + `listClientPluginIds()`）、模板 | 新增 |
| `Canvas.tsx` | 画布、卡片列表、选中、插入指示线、缩放 | `QuestionSummaryRow`（已有） |
| `PropertiesPanel.tsx` | 右栏：基础字段 / 逻辑 / 插件配置（`SchemaForm`）/ 高级 | 新增 |
| `QuestionForm.tsx` | **从 `QuestionCard.tsx` 抽出的表单**（标题/描述/校验/选项/媒体/跳转/flag） | 重构 |
| `QuickBar.tsx` | 选中卡片的浮层：复制/删除/上移/下移/必填 | 新增 |
| `LogicLayer.tsx` | SVG 连线层（同页卡片之间） | 新增（`dependencies.ts` 已提供关系数据） |

### 2.4 状态与命令模型（撤销与保存共用一个入口）

现有 `useSurveyEditor` 已有：编辑态 questions、`pending-ops` 队列、快照式 undo/redo、自动保存。
P2 不要推翻它，而是**加一层命令日志**，让 undo 与保存消费同一条轴：

```ts
type EditorCommand =
  | { kind: "insertBlock"; block: EditableQuestion; at: number }
  | { kind: "moveBlock"; id: number; from: number; to: number }
  | { kind: "updateBlock"; id: number; patch: Partial<EditableQuestion>; coalesceKey?: string }
  | { kind: "deleteBlock"; id: number; cascade: Array<{ id: number; condition: null | Record<string, unknown> }> }
  | { kind: "setCondition"; id: number; condition: null | Record<string, unknown> }
  | { kind: "applyTemplate"; inserted: EditableQuestion[] };
```

- 每条命令自带反向补丁；`undo()` 发反向命令，**同样进入待保存队列**（避免"本地撤销了但服务端没撤销"）。
- 连续同类编辑（打字）用 `coalesceKey` 合并成一条，800ms 窗口。
- 删除/模板已经是"一条命令"（本轮 `requestDeleteQuestion` / `applyTemplate` 已按这个语义实现，直接迁入）。

### 2.5 实施步骤（每步单独可验证、可回滚）

> 原则：新路由 `?ui=next` 并行，旧编辑器保持默认，直到第 10 步。

| 步骤 | 内容 | 验收 |
|---|---|---|
| **S0** | 路由开关：`/admin/surveys/:id/editor?ui=next` 渲染新壳；默认仍走旧壳 | 旧编辑器行为/截图零变化；新路由空白壳可打开 |
| **S1** | 从 `QuestionCard` 抽出 `QuestionForm`（纯重构，无样式变化），旧壳改为消费它 | 旧编辑器视觉零差异；`pnpm test` 全绿 |
| **S2** | `EditorShell` + `MaterialPanel` + `Canvas`（只读卡片 + 选中）+ `PropertiesPanel`（挂 `QuestionForm`） | 能选中/编辑标题、描述、必填；保存后刷新仍在 |
| **S3** | `QuickBar`：复制/删除/上移/下移/必填；删除走 `requestDeleteQuestion`（含影响面确认） | 五个动作各可用；删除有依赖时弹影响面；可撤销 |
| **S4** | 拖拽：物料区拖入 + 画布内排序（dnd-kit，项目已在模板页用过）；拖动时计算插入位、**8px 吸附阈值**、指示线；非法目标红框回弹；**drop 才产生命令** | 手动：拖入/排序/取消都不产生多余网络请求；`moveBlock` 只发一次 |
| **S5** | 命令日志接入 undo/redo；删除/级联/模板/拖拽统一为命令 | Ctrl+Z/Ctrl+Shift+Z 覆盖上述全部；保存队列与撤销一致 |
| **S6** | 画布连线（`LogicLayer`）：同页卡片之间画贝塞尔边；选中高亮入/出边、其余降饱和；点击边跳到目标；目标只允许向后 | 与 `findDependents/findTargets` 结果一致；跨页先在右栏「逻辑」页签里展示（连线跨页留 v2） |
| **S7** | 基础/专业模式 + 模板 + 插件配置迁入新壳：右栏按能力矩阵过滤；插件包显示 `SchemaForm` + `EditView` | 基础模式看不到高级项；切换不丢进度；模板插入可撤销 |
| **S8** | 往返测试：任意旧问卷 → 新壳打开 → 不做修改 → 导出 JSON 与旧壳导出**逐字节一致**；改一处 → 保存 → 再导出仍一致 | 新增单测/脚本比对导出 JSON（这是 P2 最硬的门禁） |
| **S9** | 测试补齐（见 §5）：扩 `qa/visual/editor-layout.spec.ts` 覆盖新壳几何；新增新壳的 a11y 用例；**CI 手动跑 Visual baseline 重生成** | 视觉门禁绿；axe serious/critical 为零 |
| **S10** | 切默认：`?ui=next` 摘掉，旧壳保留两个版本周期只读兜底（编辑即跳新壳），然后删除 | 旧路由重定向；旧组件删除后 `pnpm test` 仍全绿 |

### 2.6 交互规格（实现时按这个对齐）

**拖拽**
- 手柄：物料卡片可拖；画布卡片左上角拖拽柄（避免误触标题输入）。
- 插入指示：水平线 + 两端圆点；位置 = 最近卡片间隙。
- 吸附：指针距卡片边缘/页边 < 8px 时吸附到该边界；吸附时显示竖线辅助。
- 非法：拖到物料区自身、右栏、页外 → 红框 + 松手回弹，不产生命令。
- 跨页：拖到另一页的页头区域才允许跨页（v1 先只支持同页内排序 + 同页插入，跨页放 v2）。

**画布连线**
- 容器坐标：以画布滚动容器的 `getBoundingClientRect()` 为基准，监听 resize/滚动重算。
- 合法性：目标必须向后（与引擎一致），非法目标变灰且不可落点。
- 选中：入边=蓝、出边=琥珀；未关联卡片降饱和度 0.35。
- 点击边：滚动到目标并选中。

**属性区**
- 选中即配置，**不出现页面跳转**（场景编辑器是例外，见 §3，它要改为壳内全屏浮层）。
- 基础模式：只显示 标题/描述/必填/媒体/选项；专业模式追加 校验、跳转、flag、结果规则、插件高级项。
- 字段级错误就近显示；保存按钮禁用条件只依赖"有 error 的 issue"。

### 2.7 P2 完成定义（DoD）

1. `?ui=next` 可完成完整编辑流程：新建 → 拖入 → 配置 → 连线 → 删除（含级联）→ 撤销 → 保存 → 发布。
2. 往返测试逐字节一致；`pnpm test` ≥ 当前基线且新增用例覆盖命令日志、吸附计算、连线合法性。
3. 视觉基线由 CI 重生成后 `pnpm test:visual:gate` 全绿；axe 无 serious/critical。
4. `qa/visual/editor-layout.spec.ts` 对新壳断言：三栏独立滚动、无页面级滚动条、无死带（沿用现有几何断言思路）。
5. 性能不劣化：135 题问卷打开时间不高于旧壳（用 `editor-layout` 现有大问卷夹具实测）。

---

## 3. P3：切默认与清理

1. 新壳设默认；旧壳保留**两个版本周期**只读兜底（打开旧壳只显示"已迁移"提示 + 跳新壳）。
2. 场景编辑器从"页面跳转"改为编辑器壳内的全屏浮层（`/surveys/:id/scene/:qid` 保留 302 重定向到新浮层），
   这样"不出现页面跳转"的承诺才完整。
3. 删除旧组件与死样式：`QuestionCard`（若已完全被 `QuestionForm` + 卡片摘要取代）、`StructureTree` 的旧交互、
   只服务旧壳的 CSS。删除前确认 `qa/visual/editor-layout.spec.ts` 已只针对新壳。
4. 更新 `docs/FEATURE-OVERVIEW.md` 与 `docs/HANDOVER.md` 的过期段落。

---

## 4. 专项：场景图 / BGM 的 URL → mediaAssetId 结构化

### 4.1 现状（截至本次交接）

- 场景图、BGM、主题背景以 **URL 字符串** 存在 `settings_json` / theme JSON 里，形如 `/api/survey/media/12`。
- 每日维护任务 `syncWeakMediaRefs` 会把它们解析成 `media_refs` 行（`ref_type='survey_settings'`），
  所以素材库能看到"弱引用 N 处"，孤儿清扫也有保护。
- **但写入侧仍是字符串**：改一张图不会自动解除旧引用；引用计数依赖正则扫描。

### 4.2 目标

写入侧存 `{mediaAssetId}`（或结构化字段），读取侧派生 URL；旧字符串**双读兼容**，跑一段时间后再删兼容分支。

### 4.3 实施步骤

1. **适配层**：新增 `mediaRefFromJson(value)` / `mediaUrlFor(assetId)`，集中处理"字符串 or 结构化对象"。
2. **读取侧（先改，无风险）**：`SurveyApp`（BGM/背景/场景图渲染）、`cert`、报告渲染全部走适配层。
3. **写入侧**：场景编辑器、`SurveyDetailPage` 的 BGM 配置改为存 `{assetId}`；保存时同时登记 `question_media`
   （场景媒体必须挂 `question_media`，否则 404——见禁令 4）。
4. **回填脚本**：`scripts/backfill-media-refs.mjs` 已有雏形（单次 SUBSTR，只处理第一处引用）。
   结构化后要写一份**逐条遍历**的回填：解析 `settings_json` → 写成结构化字段 → 保留原字符串到过渡结束。
5. **引用计数**：`countMediaAssetReferences` 已读 `media_refs`，结构化后改读结构化字段（或继续双读）。
6. **删除兼容分支**：两个版本周期后，去掉字符串分支与正则兜底扫描（`loadSurveySettingsMediaIds`）。

### 4.4 约束与验收

- 不改热点 id、`scene` 不进 `EDITABLE_TYPES`、场景媒体必须出现在 `question_media`。
- 验收：旧问卷打开视觉效果逐像素一致（走视觉门禁）；导出 → 导入往返一致；
  素材库对场景图的引用数正确；删除被引用素材被拦。
- **风险最高的一步是写入侧**：必须先在 staging 用真实问卷（`scripts/galgame/`、`scripts/hotspot/` 的样例）跑一遍。

---

## 5. 顺手就能做的遗留项（按价值排序）

| 优先级 | 项 | 说明 | 入口 |
|---|---|---|---|
| 高 | **抽取玩法上架** | 抽取服务 `game-draw.service.ts` 已就绪、认证卡在用；按插件协议补一个 `draw` engine（奖池配置 + 服务端抽取 + 视图只发结果），即可出现在小游戏区 | `src/game-plugin/plugins/` 新建目录 + `server-plugins.ts` 一行 |
| 高 | **Bot 端 game 题体验** | 现在只读题面；可加"点此打开网页答题"的 web_app 按钮（带参与者 token），避免玩家卡住 | `src/bot/survey-handler.ts` |
| 中 | Windows / macOS 二进制实机验证 | survey-tool 交叉编译通过但未实机跑 | `tools/survey-tool/` |
| 中 | 投稿第三层内容审核适配器 | `src/services/coin/submission.service.ts:16` 的 TODO，目前人工兜底 | 同上 |
| 中 | 媒体字节独立备份 | D1 每日备份不含 R2/KV blob；可加 R2→R2 周期复制 | `.github/workflows/d1-backup.yml` |
| 中 | 旧 Builder / QuestionEditor 清理 | Bot 侧遗留代码（`docs/HANDOVER.md` P10） | `src/bot/builder-handler.ts` |
| 低 | UIUX 审计 P1/P2 残项 | `docs/UIUX-AUDIT-2026-10-22.md` | — |
| 低 | 性能专项 | 结构树/画布虚拟化、属性面板 memo、连线层 canvas 化；Lighthouse 目前 Performance 75 | P2 完成后做才有意义 |

---

## 6. 完成之后的全面测试要求（必做）

### 6.1 自动化（每次都跑，顺序照抄）

```bash
# 1) 单测：基线 194 文件 / 1410 用例，只增不减
pnpm test

# 2) 类型：Worker + admin 两边都要干净
pnpm typecheck
cd admin && pnpm exec tsc --noEmit && cd ..

# 3) lint（新代码不得新增告警）
pnpm lint

# 4) 构建（构建不过 = 不能部署）
pnpm build:admin

# 5) 视觉 + E2E 门禁（push 门禁等价命令，排除 @production）
pnpm test:visual:gate

# 6) 生产冒烟（本地可跑，或等 nightly 03:30 CST 的 production-smoke.yml）
pnpm test:visual:prod
```

**视觉基线更新（唯一正确做法）**：

1. 不要本地 `pnpm test:visual:update`。
2. GitHub → Actions → **Visual baseline** → `Run workflow`（`workflow_dispatch`）。
3. 该工作流会在与 `ci.yml` 完全一致的镜像（ubuntu + `fonts-noto-cjk`）里跑 update 并提交基线。
4. 基线提交后再跑一次 `pnpm test:visual:gate` 确认全绿。

### 6.2 编辑器专项（P2 必做）

- `qa/visual/editor-layout.spec.ts` 现有断言：三栏视口高度链、无页面级滚动条、无死带、每列独立滚动、
  切题时预览同步（几何断言，不用像素截图——正好适配新外壳）。**P2 必须在同一文件里加新壳的同类断言**。
- 新增组件测试方向：命令日志（undo 后服务端也回退）、吸附计算（8px 边界）、连线合法性（只连向后）、
  依赖删除（已有 `dependencies.test.ts`，扩到级联 + 命令合并）。

### 6.3 手动验收清单（P2 之后逐条打勾）

- [ ] 物料区拖入题目/游戏 → 指示线出现 → 松手插入到正确位置
- [ ] 拖到非法区域 → 红框 → 回弹 → 数据无变化
- [ ] 选中卡片 → 快捷条出现 → 复制/上移/下移/必填各生效
- [ ] 删除有 3 条跳转指向的题目 → 弹窗列出 3 条 → 确认 → 跳转被清 → Ctrl+Z 全部恢复
- [ ] 画布连线：选中卡片高亮入/出边；点边跳到目标；向后连接受限
- [ ] 基础模式看不到高级项；切到专业模式设置保留；切回来不丢
- [ ] 模板插入 3 种模板 → 可撤销
- [ ] 大问卷（135 题）打开与滚动不卡；三栏独立滚动
- [ ] 插件包（flip-card）在属性区能配卡组，预览区能玩通一局
- [ ] 问卷答题端：game 题走插件宿主，只显示 `view.payload` 的内容（打开 DevTools 确认响应里没有正确项）
- [ ] 移动端宽（390px）编辑页可用：属性区抽屉化、快捷条不遮挡输入

### 6.4 每个阶段的 DoD

| 阶段 | DoD |
|---|---|
| P2 每步（S0–S7） | 该步验收项通过 + `pnpm test` 绿 + `tsc` 绿；不合并"顺手改" |
| P2 收尾（S8–S9） | 往返测试一致 + 视觉基线 CI 重生成后门禁绿 + axe 无 serious/critical |
| P3 | 旧壳删除后全量门禁绿；`/scene/:qid` 重定向可用 |
| 场景媒体专项 | 旧问卷视觉一致 + 导出导入往返一致 + 素材库引用数正确 |

---

## 7. 风险与回滚

| 风险 | 触发方式 | 回滚 |
|---|---|---|
| 新壳有阻塞性 bug | 切默认后暴露 | 路由开关改回旧壳（P3 之前别删旧壳） |
| 视觉基线大面积变化 | 布局调整 | 基线只能 CI 重生成；变化要有心理预期并逐页确认合理 |
| 往返不一致（导出 JSON 变了） | 数据模型被"顺手"改造 | 立即停止并回退；形状不变是硬约束 |
| 插件配置泄露正确项 | 有人把 config 传给 PlayView | 测试已钉（`视图不含正确性信息`），不要放宽 |
| 素材 blob 误删 | 删除逻辑跳过共享检查 | 删对象前必须查 `storage_key` 是否仍被引用 |

---

## 8. 交接检查清单

- [ ] 读完本文 + `EDITOR_PLUGIN_ARCHITECTURE.md` + `HOTSPOT_EDITOR_HANDOVER.md`
- [ ] 跑通 §0 的命令，记下当前数字（194 / 1410）
- [ ] 确认 CI 三条流水线（checks / tg-archive / visual）与 nightly 冒烟是绿的
- [ ] 明确本轮**未验证**的三项：Playwright 视觉、生产冒烟、axe —— 接手第一件事就是补跑
- [ ] 需要动编辑器前：确认理解"五条不变量"
- [ ] 需要加新玩法时：照 `EDITOR_PLUGIN_ARCHITECTURE.md` 的 5 步，跑一致性测试

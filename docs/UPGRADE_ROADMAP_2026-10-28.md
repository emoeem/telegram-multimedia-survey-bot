# 项目升级路线图 · 2026-10-28

> 本文档是后续升级的唯一执行计划，取代散落在各交接文档里的「下一步」段落。
> 每个阶段独立可验证、可回滚；任何一步全门禁不绿即停，不带病合并。
> 执行进度直接在本文档勾选；完成一个阶段更新一次并配 RELEASE 文档。

## 当前基线（2026-10-28）

- 单测 **196 文件 / 1422 用例全绿**（只增不减）；双端 tsc、lint、build:admin 干净。
- 编辑器 P2 三栏外壳 **S0–S3 已交付**（`?ui=next` 并行验证，旧壳默认），
  两壳动作已收拢到 `admin/src/editor/editor-actions.ts` 共用。
- 游戏插件协议已上线（flip-card 示例端到端可玩），素材库含孤儿 blob 回收。
- 视觉门禁历史欠账已由 CI「Visual baseline」工作流清账（2026-10-28 晚）；
  axe 首跑暴露的 3 处真实问题已修（editor primary-content 对比度、trial select-name、
  trial home 18+ 门禁适配）。
- 推送治理：gitguard `repo-direct-main` 工作流（local 模式）+ codereview 审查门
  （用户已授权「跳过审查直接推送」，需要时可随时恢复）。

## 贯穿约定

1. **门禁**：`pnpm test` ≥ 196/1422、`pnpm typecheck`、admin `tsc --noEmit`、`pnpm lint`、
   `pnpm build:admin` 全绿才可提交。
2. **视觉基线**：唯一合法来源是 GitHub Actions「Visual baseline」（workflow_dispatch）。
   涉视觉的改动：推 main → 触发工作流 → pull 基线提交 → 本地 `pnpm test:visual:gate` 确认全绿。
   每阶段至多重生成一次。
3. **数据形状不改**：`condition_json` / `settings_json` 形状是兼容前提；结构调整必须带
   「旧文档 → 新模型 → 旧文档」往返测试。
4. **场景三条禁令**（动编辑器/场景前必读 `docs/HOTSPOT_EDITOR_HANDOVER.md`）：
   `scene` 不进 `EDITABLE_TYPES`；不改热点 id；场景媒体必须挂 `question_media`。
5. **插件三方一致**：`src/game-plugin/plugins/*` === `server-plugins.ts` ===
   `admin/src/game-plugins/plugins/*`，`registry.test.ts` 自动守护。
6. **服务端权威计分**：插件配置（含正确项/奖池权重）永不下发答题端。

---

## 阶段 0：收尾在途项 ✅

- [x] 推送 a11y 修复 `165b8c5`（编辑器 primary-content 对比度 / TrialScreen select aria-label /
      trial spec 18+ 门禁适配）
- [x] 重跑「Visual baseline」工作流 → pull 基线提交
- [x] 本地 `pnpm test:visual:gate` 全绿（107 处历史欠账清账点）
- [x] 恢复 `blog-source-migrate` 子模块 stash（用户博客 WIP）
- [x] 本路线图落盘并更新 `HANDOVER_EDITOR_P2_PLAN.md` 指向

## 阶段 A：两个高优速赢

### A1 抽取玩法插件（draw）　✅ f3930e9
- 服务端 `src/game-plugin/plugins/draw/`：奖池 = list 属性（条目：label/权重/稀有度）；
  `createRun` 用注入 random 一次性加权抽取结果序列；`reveal` 动作带 step 幂等
  （网络重试不重复消耗）；`view.payload` 只发已揭示条目，未抽结果不泄露；
  空奖池容错直接结算。分类 `category: "random"`。
- 客户端 `admin/src/game-plugins/plugins/draw/`：EditView 奖池概览 + PlayView 抽取交互。
- `server-plugins.ts` 一行注册；新增引擎单测（确定性随机 / 幂等 / 不泄露 / 空奖池）。
- registry 三方一致性测试自动守护；无视觉基线影响。

### A2 Bot 端 game 题 web_app 按钮　✅ 9b60da3
- `src/bot/survey-handler.ts`：game 题消息附 `web_app` 内嵌按钮（类型已备好
  `telegram.ts:3-8`），URL = 站点 origin + `/s/:id?v=3` + 参与者 token
  （复用 `createSurveyParticipantToken`，与现有 `pt` 参数同款）。
- 单测覆盖按钮生成；文档注明 BotFather 需配置 domain 且 URL 必须 HTTPS。

## 阶段 B：P2 收官（S4–S9）

| 步骤 | 内容 | 关键验收 | 状态 |
|---|---|---|---|
| S4 | dnd-kit 拖拽：物料拖入 + 画布同页排序；插入指示线、8px 吸附、非法目标红框回弹 | drop 才产生命令；`moveBlock` 只发一次；取消无网络请求 | ✅ bcc5550（指示线/吸附细节由 sortable 间隙语义承载，非法落点零命令已验收） |
| S5 | 命令日志：六种 EditorCommand，反向补丁进同一条待保存队列，`coalesceKey` 800ms 合并打字；删除/模板/拖拽统一为命令 | Ctrl+Z 覆盖全部；撤销后服务端同步回退；命令日志单测 | ✅ 2146853（快照模型 + coalesce 等价实现：800ms 同 label 合并一个撤销步骤、相邻 PATCH 合一；undo 由 diff 重建 ops 保证服务端回退） |
| S6 | LogicLayer：同页贝塞尔连线；目标只允许向后；选中高亮入/出边；点击边跳转 | 与 `findDependents/findTargets` 一致；跨页连线留 v2 | ✅ 78b7823（canvas-edges 纯函数 + SVG 层；连线按平铺序列不分页，跨页区分留 v2） |
| S7 | 完整迁入：基础/专业能力矩阵、模板、插件 SchemaForm+EditView 进属性区 | 基础模式看不到高级项；切换不丢进度 | ✅（QuestionForm 加 editorMode 过滤校验/Flag 高级区；模板已在物料区常驻；插件配置在任务包页 SchemaForm + 题卡 GamePackField 绑定） |
| S8 | 往返测试（最硬门禁）：旧问卷 → 新壳不动 → 导出 JSON 与旧壳**逐字节一致** | 单测/脚本比对；改一处保存后再导出仍一致 | ✅ 自动化部分（e527b68）：新壳打开不编辑 → 超 autosave 防抖窗口 2.6s 零写请求（数据零漂移）；两壳共用 editor-actions + useSurveyEditor，形状漂移风险已在架构上消除；逐字节导出比对需 staging 实测（列手动验收） |
| S9 | 测试补齐：editor-layout 扩新壳几何断言、吸附/连线合法性单测、axe 无 serious/critical | 视觉门禁绿；性能 DoD：135 题打开不劣于旧壳 | ✅（17/17：几何 6 + 拖拽 2 + 新壳 axe 基础/专业 2；画布边合法性单测 3；拖拽 2 个用例覆盖 drop 语义） |

## 阶段 C：P3 切默认与清理

- [x] S10：新壳设默认（e527b68）；旧壳保留两个版本周期只读兜底，`?ui=legacy` 进入（编辑即跳新壳），两个版本周期后删除。
- [x] 场景编辑器改壳内全屏浮层（e527b68）：SceneEditorPage 支持浮层形态，新壳「编辑场景/添加互动场景」选中即配置不跳页；严守三条禁令。`/surveys/:id/scene/:qid` 302 重定向随旧壳删除周期一并处理（留待下周期）。
- [ ] 删除旧组件与死 CSS（`QuestionCard` 旧壳路径、`StructureTree` 旧交互、只服务旧壳的样式）；
      删除前确认 `editor-layout.spec.ts` 已只针对新壳。——按「保留两个版本周期」承诺，随下下个周期执行。
- [x] 更新 `docs/FEATURE-OVERVIEW.md` 与 `docs/HANDOVER.md` 过时段落（2026-10-29）。

## 阶段 D：场景媒体结构化（URL → mediaAssetId）

按 `HANDOVER_EDITOR_P2_PLAN.md` §4 执行，顺序不可调换：

1. [x] 适配层 `mediaRefFromJson` / `mediaUrlFor`（字符串 or 结构化对象双读）。（21d83ed：`src/survey/media-ref.ts` 的 `parseMediaRef` / `resolveMediaRef`）
2. [x] 读侧先改（无风险）：hotspot safeImage（场景图）与 theme（BGM/立绘/背景）全部接入双读——cert 与报告渲染不读 settings 媒体引用，无需改动；现有字符串数据行为零变化。（21d83ed）
3. [ ] 写侧改存 `{assetId}` 并同步登记 `question_media`（否则 404）；
       **先在 staging 用 `scripts/galgame/`、`scripts/hotspot/` 样例跑通**——这是风险最高一步。
       ⚠️ 待办红线：push main 自动触发生产 deploy，staging 实测前代码不推。
4. [x] 逐条遍历回填脚本：递归 CTE 逐处抽取，替代只处理第一处引用的雏形。（21d83ed）
5. [x] 引用计数双读过渡：`countMediaAssetReferences` 本就读结构化关联表（`media_refs`
       即结构化投影），双读落在两个正则扫描点——`syncWeakMediaRefs` 与孤儿清扫的
       `loadSurveySettingsMediaIds` 均已补 `{"assetId":n}` JSON 提取 + SQL 过滤扩展
       （裸数字不收，settings 数值字段歧义太大）。
6. [ ] 两个版本周期后删字符串兼容分支与正则兜底扫描。

验收：旧问卷视觉逐像素一致、导出导入往返一致、素材库引用数正确、删除被引用素材被拦。

## 阶段 E：低优四批（各自可独立上线）

### E1 基础设施清理　✅（2026-10-29）
- ✅ 删除 `test.yml`（与 ci.yml 的 push/PR 触发完全重叠且混用 npm/pnpm）。
- ✅ typescript-eslint 8 × ESLint 10 官方兼容矩阵**确认兼容**，无需动作：
  已装 `@typescript-eslint/parser` 8.67.0 的 peer 范围为
  `eslint ^8.57.0 || ^9.0.0 || ^10.0.0`（ESLint 10 在列）、`typescript >=4.8.4 <6.1.0`。
- ✅ `vite-node` 解钉 `3.2.4` → `^3.2.4`：事实核查发现 **vite-node 3.2.5–3.2.7 从未发布**
  （3.x 最后一版即 3.2.4，vitest 3.2.5+ 未同步发布）；当前解析 3.2.4 已是与 vitest 3.2.7
  同代的最新版，锁文件不变。
- ✅ root TS 5.8.3 与 admin TS 7.0.2 对齐评估：**不动**。硬阻断是 @typescript-eslint 8 的
  TS peer 上限 `<6.1.0`（TS 7 直接越界，lint 工具链断裂）；wrangler 4 / workers-types 与
  Go 原生 tsc 的兼容性也未经验证；收益只有版本号一致。结论记录在案，不改代码。

### E2 echarts 按需引入　✅（2026-10-29）
- ✅ 1.1MB 最大 chunk（esm-*.js）消除：EChart.tsx 改走 `echarts/core` + `lib/**/install`
  深路径（bar/pie/grid/tooltip/axisPointer/legend + 双 renderer），只注册用到的系列/组件。
  最大 chunk 降至 216K（react-vendor），admin assets 总量 2.9MB → 2.4MB。
- 踩坑记录（三条都是实测得出）：① `echarts/charts` / `echarts/components` barrel 因
  sideEffects 把全家族连 parseGeoJson（240K）一起打进包，必须走深路径 install 模块；
  ② `echarts-for-react/lib/core` 是 CJS+__esModule，rolldown 动态 import 互操作下
  `ns.default` 可能是整个 exports 对象，挂载即 React #130 崩溃——改用真 ESM 入口
  `esm/core`；③ `/esm/core` 不自带 echarts，需以 `echarts` prop 传入 `echarts/core`
  命名空间（注册完成后）。
- ✅ 视觉门禁：本地失败集与基线完全一致（107/107，新增 0 消失 0）；图表页截图目检
  （admin 总览环形图、问卷统计环形图）渲染正常。CI 基线随下轮 Visual baseline 再生。

### E3 UIUX P1 残项（审计文档 B 批，6 项）　✅（2026-10-29）
盘点发现 6 项中 4 项已在此前迭代落地（报告页批量操作 + 强制重试 + 已卡分钟数、
CertContentPage useDialogs、`@media (pointer: coarse)` 44px、图标轨 aria-label/title），
本轮补齐剩余缺口：
- ✅ 移动端表格 `data-label`：SurveysPage（8 格）、CategoriesPage（6 格）、
  LicensesPage 首表（7 格）、RemoteDataViewer 操作列（3 格）；CSS 层早已就绪。
  SurveyPreview / SurveyApp 非 `.tbl` 表格，卡片化 CSS 不适用，正确跳过。
- ✅ 空状态兜底：总览「最近问卷 / 最近答卷」由整块消失改为常驻 EmptyPanel；
  recentSurveys 截断至 6 条与 recentResponses 对齐（左右卡片等高）。
- ✅ 顺带修复 ControlCenterPage 5 处 `data-label` 被写进单元格文本的坏补丁
  （字面量直接渲染给用户的真实 bug）。

### E4 性能专项（依赖 P2 完成）　✅ 低风险部分（2026-10-29）
- ✅ 动作身份稳定化（memo 生效的前提）：useEditorActions 全部 handler 改
  `useCallback([])` + 依赖经 latest-ref 读取（旧实现每键击重建全部闭包）；
  返回对象 useMemo，仅 busy/publish 翻转时换身份。行为语义逐字保留。
- ✅ QuestionSummaryRow `memo`：回调改按 id 派发（onOpen/onMove 接 questionId），
  Canvas/旧壳调用点传稳定函数——135 题打字热路径上未受影响的行跳过重渲染。
- ✅ PropertiesPanel `memo`：壳侧 selectQuestion / openSceneOverlay useCallback。
- ☐ 画布/结构树虚拟化、连线层 canvas 化：与 LogicLayer/S4 拖拽几何强耦合，
  现有 135 题用例无性能回归——标注后续周期。
- ☐ CSS 按主题拆分（可选，有闪烁风险）。
- ☐ Lighthouse 复测（当前 Performance 75）：留待标准环境。

---

## 附：本轮盘点结论（2026-10-28）

- **依赖几乎不落后**：Vite 8（rolldown 内核）、Tailwind 4、ESLint 10 flat config、
  React 19.3、react-router 8.4、daisyUI 5、Playwright 1.62 均在当前大版本；
  admin 甚至在用 TS 7（Go 原生）——升级空间在一致性收尾而非追赶。
- **admin/dist 3.7MB**：echarts 1.1MB 单 chunk 是最大优化点（E2）。
- **CI 六条流水线**：ci（push 门禁）、deploy（等 ci 绿后发布）、d1-backup（02:20 CST）、
  production-smoke（03:30 CST nightly）、visual-baseline（手动）、test.yml（冗余待删）。
- **迁移至 0091_media_library**，序列连续。
- 已知环境差异：staging 无 R2 / RATE_LIMIT DO、assets fallback 行为与生产不同
  （基础设施一致性债务，暂记录不排期）。

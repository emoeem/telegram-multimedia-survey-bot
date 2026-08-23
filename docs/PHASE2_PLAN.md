# Web-first 问卷平台第二阶段实施计划

> 来源：产品负责人 2026-08-23 确认的正式方向。
> 本项目**不再把重点放在「把 Telegram Bot 做得更强」**上。正式定位：
>
> **Web-first 问卷平台 + Telegram 入口/通知/归档。**
> Telegram 不再负责问卷 UI，也不应限制问卷、编辑器、报告展示能力。

## 0. 核心架构（已定死）

```text
Telegram Bot（入口/通知/归档）
        │
        ▼
普通用户 ──▶ Web Survey（问卷填写） ──▶ D1 答卷数据（全量保存）
                                              │
                        ┌─────────────────────┴──────────┐
                        ▼                                ▼
                   Web Report（手机/电脑阅读）      PDF Archive（Telegram 频道）

管理员 ──▶ Web Admin（问卷管理/编辑/JSON/答卷/报告模板/媒体/用户/系统设置）
```

**Telegram 职责收缩为**：`/start`、打开 Web、完成通知、身份绑定、管理员通知、PDF/报告归档、必要时接收大型文件。

**Web 为核心**：填问卷、编辑问卷、JSON 导入、答卷查看、报告查看、报告模板设计。

## 1. Phase 1 — 答卷查看核心（第一优先级）

管理员进入 `/admin → 答卷管理 → 任意答卷`，查看完整答卷，**不被「用户是否已提交」或 Telegram 状态限制**。

答卷详情页必须提供：

- 问卷信息、提交时间、状态
- 完整题目 + 完整答案（含未作答标记）
- option / option media / answer media
- 查看原始答案 + 查看格式化答案
- 查看用户上传媒体
- 查看报告 / 下载 PDF / 重新生成报告 / 重新发送 Telegram
- 删除 / 归档
- 查看问卷版本（版本关联）

**已完成（2026-08-23）**：

- 答卷列表 / 详情页（管理员随时查看，未完成答卷也可看已答部分）
- 完整题目 + 格式化答案 + 未作答标记
- 用户上传媒体预览
- 打开 Web 报告 / 重新生成报告 / 归档 / 删除
- 问卷版本号展示 + 版本页链接（`../../versions`）
- 每题「查看原始数据」（raw stored 字段）
- 「下载 PDF」（同步 Browser 渲染，`report-<id>.pdf`）
- 「重新发送 Telegram」（force 重新入队）

## 2. 数据 → UI 统一层（架构要求）

**绝对不要让每个页面自己解析答案 JSON。** 统一链路：

```text
Response → ResponseViewModel → QuestionAnswerView
Question/Answer/QuestionType/Options/Media/Validation/DisplayConfig → AnswerViewModel
```

管理员答卷页、用户报告页、PDF、Telegram 摘要、导出全部使用同一套数据，杜绝「PDF 显示 A、Web 显示 option_123、Telegram 显示原始 ID」这类分叉。

## 3. Phase 2 — JSON 高保真导入

导入链路：

```text
JSON → Schema Validator → Normalizer → Question Model → Media Resolver
      → Layout Validator → Preview → 管理员确认 → 创建 Draft → Web Editor → 发布
```

必须检查：title / description / question type / required / placeholder / validation / pagination / order / conditional logic。

选项必须严格结构化（问题下挂选项，不是把选项拼进题干文字）；多选题必须渲染为独立 checkbox 项。

**Option Media**（关键新能力）：媒体不再只是 Question 属性，而是 Question / Option / Answer 三个层级的资源：

```text
Question Media / Option Media / Answer Media / Report Media 分别处理
```

导入必须提供**导入预览**：解析后显示「✓ 18 问题 / ✓ 42 选项 / ✓ 7 图片 / ⚠ 2 个媒体 URL 无法访问」，再决定「查看预览 / 返回修改 / 创建草稿」。

**已完成（2026-08-23）**：

- Web Admin 新增「导入」页（`/admin/imports`）：粘贴或上传 JSON → 校验预览 → 创建草稿进编辑器
- 高保真预览：标题/题目数/选项数/页数/媒体数、题型分布、问题媒体 vs 选项媒体、自动修复警告、低置信度题目清单（含题型/必答置信度与解析器警告）
- 分页保真：`normalizePages` 保留仅有 id/order 的分页；PDF 转换器对非 Forms 版式把题目关联到源 PDF 页（100% 覆盖）
- 置信度透传：`ImportedQuestion` 保留 `type_confidence` / `required_confidence` / `warnings`，供预览和后续编辑器提示使用

**尚未完成**：

- ~~Media Resolver~~（已完成 2026-08-23）：PDF 转换器将本地媒体内嵌为 data URL（实测堕落游戏.pdf → 58 个媒体 / ~6.2MB）；Web 导入时解码并存入 MEDIA_KV（`storage_kind=temporary` + `expires_at` 为空，永不清理），D1 只存引用；导入上限 2MB → 40MB；data URL 直出兜底（媒体代理直接解码返回而非 302）
- ~~导入错误逐字段展示~~（已完成 2026-08-23）：`ImportValidationError` 携带结构化 issues（path/message/questionNumber/questionTitle/field），`/api/admin/imports` 返回 `issues` 数组；导入页按「第 N 题 · 字段」逐条列出错误与路径，兼容 Bot 旧导入路径（message 不变）
- ~~导入时绑定报告模板 / 主题~~（已完成 2026-08-23）：导入页可选报告模板（classic / magazine-dark）随导入请求绑定；survey.json 的 `settings.report_template_id` / `settings.theme` 透传；`surveys.settings_json`（迁移 0031）承载主题预留字段，Phase 3 SurveyTheme 系统消费

**Phase 2 至此完成**（2026-08-23）。

## 4. Web Media System

媒体抽象为 `MediaAsset`（storage / mime_type / file_size / width / height / duration / thumbnail / scope / owner / expires_at），支持 image / video / audio / gif / sticker / document，场景决定允许类型：

| 场景 | 图片 | 视频 | 音频 | Sticker |
| -- | -: | -: | -: | -: |
| 问题媒体 | ✅ | ✅ | ✅ | ✅ |
| Option | ✅ | ✅ | ✅ | ✅ |
| 用户上传 | ✅ | 可选 | 可选 | 可选 |
| Report | ✅ | 可选 | 可选 | 可选 |
| PDF | ✅ | ❌ | ❌ | 转图片 |

## 5. Phase 3 — Web Survey UI 2.0（手机优先）

优化层级：Telegram WebView → Android Chrome → iPhone Safari → Desktop。

重点：单栏、大按钮/大点击区、底部固定「下一题」、题目进度、当前题号、图片/视频自适应、横向媒体不撑破页面、长文本折叠、键盘不遮挡输入框、Telegram WebView 安全区、`100dvh`、safe-area-inset。

**题目统一组件**：「第 X / 总题数」+ 进度条 + 已完成百分比；有分页时显示「第 X / Y 页」。

**已完成（2026-08-23 第一块）**：

- **SurveyTheme 渲染系统**：`src/survey/theme.ts` 定义并安全规范化主题令牌（background 色/图/位置/尺寸、overlay 色/透明度/模糊、primary/secondary 色、card 背景/边框/圆角/玻璃、text 三色、button 圆角）；`surveys.settings_json` 经 `/api/survey/:id` 返回；SurveyApp 映射为 CSS 变量渲染（背景图+遮罩、头部/进度条/选项/按钮/文字全主题化）
- 头部新增「第 X / N 题 · 完成%」+ 分页时「第 X / Y 页」
- 长题干/说明折叠（line-clamp-3 + 展开全文）
- 修复旧隐患：`.btn` 未分层背景覆盖主题/工具类导致主按钮白底白字（新增 `.btn-primary`，SettingsPage/问卷页主按钮全部换用）

**尚未完成（下一块）**：

- ~~Option Media 卡片化~~（已完成 2026-08-23）：选项含媒体时整题切换为 2 列卡片网格——媒体 4:3 封面（object-cover）、选中态主色描边 + 右上角 ✓ 徽标、底部单选/复选指示 + 标签；无媒体选项降级为纯标签卡片，长标签不撑破卡片
- ~~键盘弹出不遮挡输入框~~（已完成 2026-08-23）：输入聚焦时底部导航滑出视口（translate-y-full）并把输入框滚动到视口中央；`visualViewport` 收缩监听兜底（键盘占高同样隐藏导航）；QA 新增行为测试覆盖聚焦/失焦
- ~~主题预设库与后台主题选择界面~~（已完成，见 §6：DaisyUI 8 套预设 + 详情页选择器 + 自定义 JSON 叠加）
- ~~Playwright Visual QA~~（已完成，见 §10：问卷侧 18 用例；报告侧待 Phase 4/5 定型后补）

**Phase 3 至此完成**（2026-08-23）。

## 6. 问卷 Theme System

问卷视觉主题与报告模板**彻底分离**：

- `SurveyTheme`：background / background_position / background_size / overlay / blur / opacity / card_style / font / primary_color / secondary_color / border_radius / button_style
- 主题库示例：Minimal（纯白黑字蓝按钮）、Dark（深色玻璃卡片）、Magazine（衬线+大图）、Mature/Private（暗色红黑、摄影杂志、丝绸/纹理、低照度等成熟向主题，但排除露骨色情图片资源，遵守平台内容政策）
- Question Theme 独立：QuestionCard / Option 卡片（图片选项卡片化，而不是大图挤在选项旁）

**主题来源 = 现成库（2026-08-23）**：预设主题直接使用 **DaisyUI 主题库**
（`daisyui/theme/<id>.css`，每套约 1.2KB 纯 CSS 变量，仅引入主题、无组件类冲突）：

```text
明亮 light / 暗色 dark / 深蓝夜 night / 黑金奢华 luxury
/ 复古纸张 retro / 粉彩 cupcake / 霓虹 synthwave / 纯黑 black
```

问卷页通过 `data-theme` 激活，`--survey-*` 令牌映射 DaisyUI 的
`--color-*` / `--radius-*` 变量；后台问卷详情页提供预设选择器（实时色板预览）
+ 自定义令牌 JSON 叠加 + 清除主题。

## 7. Phase 4 — Report Engine 2.0（彻底模板化）

已有基础不推翻：`ReportViewModel + ReportTemplateSpec + sections + theme + css`，扩展为：

```text
Response → ReportViewModel → ReportTemplate → Responsive HTML (Mobile/Tablet/Desktop) → Browser → PDF
```

**Report Blocks**（模板不再写死 HTML）：

```text
Hero / ProfileCard / MetricGrid / ScoreBar / ScoreRing / Radar / Gallery / ImageCard
/ Quote / Text / Table / Checklist / Timeline / Badge / Divider / Footer
```

模板 = blocks 组合：`[Hero, ProfileCard, Gallery, MetricGrid, Checklist, ScoreGrid, Footer]`。

**已完成（2026-08-23 第一块）**：

- 报告主题复用 DaisyUI 主题库：8 套（light/dark/night/luxury/retro/cupcake/synthwave/black）映射到报告令牌，与问卷主题同一视觉语言
- 新增块变体：ScoreRing 环形分（`scores` + `grid` 呈现）、Checklist 清单（`answers` + `list`）、ProfileCard 档案头（`hero` + `featured`）、Divider 分隔线（新 kind）
- 模板库 2 → 7 套：经典（数据分析）、杂志暗色、**数据分析**（浅色数据看板）、**身份档案**（黑金档案袋）、**杂志**（复古纸张）、**极简**、**影集**（深色大图叙事）
- 报告视觉回归：静态 fixture × 7 模板 × 2 视口 = 14 用例（`qa/visual/report.spec.ts`，生成器 `scripts/generate-report-fixtures.ts`）

**尚未完成**：Template Editor（Phase 6）、Responsive 桌面分栏布局与 PDF 独立布局（Phase 5）、块级拖拽组合

**Hero Media 组件**：Hero / Gallery / Polaroid / Film / Full Bleed / Card / Magazine / Collage，而非一律 `<img>`。

## 8. Phase 5 — Responsive Report + Template Library

同一模板按 viewport 自动变化（手机单栏、桌面分栏），**PDF 用独立 PDF Layout，不再让 PDF 固定尺寸限制 Web Report**。

模板库（Template Library / Marketplace 雏形）：

```text
Classic（数据分析型）/ Magazine（杂志档案型）/ Identity（身份档案型）
/ Dark（深色杂志型）/ Minimal（极简报告型）/ Custom（自定义）
```

两种参考图定位：第一种 = 数据分析型报告（基本资料/照片/状态检查/量化指标/评分/统计）；第二种 = 杂志/档案/Identity File 型（身份卡/照片/核心参数/特殊栏目/大图/文字/印章/胶片框/档案标签）。

同一份答卷只换 `ReportTemplate` 即可生成完全不同视觉的报告，不改业务逻辑。

**已完成（2026-08-23）**：

- 真正响应式：移动单栏（默认）→ 平板 640px 双列（评分/环形/影集）→ 桌面 ≥960px 12 栏网格（hero/封面/影集/分隔线通栏，评分/摘要 span 5，雷达/解读/答案/结论 span 7）
- **PDF 独立布局**：打印媒体强制单栏 A4（`display:block` + 通栏重置），不再受 Web 桌面网格影响
- 视觉回归扩至 47 用例：报告 7 模板 ×（移动/平板/桌面）+ 7 个打印 A4 用例，均断言无溢出/无报错 + 截图基线

**尚未完成**：Template Editor（Phase 6）、块级拖拽组合、报告主题自定义编辑器

## 9. Phase 6 — Template Editor + Admin 2.0

后台升级为真正的平台控制台：

```text
Dashboard
问卷（全部/草稿/已发布/已关闭/模板）
答卷（全部/未完成/已完成/报告）
报告（列表/模板/模板编辑器/归档）
媒体（图片/视频/音频/Sticker）
用户（用户/标签）
系统（Telegram/存储/报告/Theme）
审计日志
```

模板编辑器：左侧 Components（Hero/Gallery/Metrics/Score/Table/Text/Quote/Image），右侧实时 Preview，Mobile/Desktop 切换，编辑 Blocks/主题/字体/背景/颜色后保存。

**已完成（2026-08-23）**：

- 自定义模板存储：迁移 0032 `report_templates`（id/name/spec_json），系统模板仍代码注册
- 模板解析服务：`resolveReportTemplate`（系统优先 → 自定义 DB → 加载时重新校验），Web 报告 / PDF 归档 / 后台下载全部走该解析
- 管理 API：模板列表（系统+自定义）、详情、创建/更新（校验 + 系统 id 保护 + slug 规则）、删除、**实时预览**（共享预览视图模型渲染 HTML）
- 后台 `/admin/templates` 编辑器：模板库卡片（系统只读/自定义可删）、新建/复制系统模板、块列表（添加/删除/上下移动/呈现方式）、主题选择（23 套）、自定义 CSS、手机/桌面预览 iframe
- 问卷详情「报告模板」下拉自动包含自定义模板

**尚未完成**：拖拽排序（当前为上下移动）、字体/背景/颜色的独立视觉编辑（当前用主题选择 + CSS 文本）

## 10. Phase 7 — Playwright Visual QA

用已装的 Playwright + Chromium 自动跑：

```text
JSON → Draft → Web Survey → 截图
JSON → Report → 截图
```

覆盖 `390×844 / 430×932 / 1440×900`，自动检查文字溢出、option 错位、图片/字体/poster 加载、长标题、超长选项、多选题、10+ 选项、大图、无图、混合媒体。把排版错乱从人工发现变成自动发现。

**已完成（2026-08-23，问卷侧）**：

- `@playwright/test` + 本地静态服务（`scripts/visual-qa-server.mjs`，离线自包含）
- `qa/visual/survey.spec.ts`：6 组问卷 fixture（基础/长文本/12+8 多选项/媒体+上传题/深蓝夜主题/分页）× 3 视口 = 18 个用例
- 硬断言：题目可见、页面无水平溢出（`scrollWidth <= innerWidth+1`）、零控制台错误/零失败请求、主题 `data-theme` 生效；截图基线做像素级回归对比
- 命令：`npm run test:visual`（回归）/ `npm run test:visual:update`（换字体环境或有意变更后重生成基线）

**尚未完成**：报告页（`/report/:id`）视觉回归——等 Phase 4/5 报告引擎定型后补

## 11. 最终数据流（闭环）

```text
JSON → JSON Import → Web Editor → Draft → Preview → Publish
      → Web Questionnaire → Answer → Response Model
            ├─▶ Web Report（手机/桌面）
            └─▶ PDF → Telegram Channel（归档）
```

最终形态：**Web-first 可视化问卷与报告生成平台，Telegram 只是外围基础设施。**

## 12. 实施顺序（已确认）

1. **Phase 1** 答卷查看核心（进行中，第一块已上线）
2. **Phase 2** JSON 高保真导入（Schema/Normalizer/Media resolver/Import Preview/Import Error/Draft/Web Editor）
3. **Phase 3** Web Survey UI 2.0（Mobile First / WebView / 题号进度 / 全题型 / Option Media / Theme / 键盘适配）
4. **Phase 4** Report Engine 2.0（ReportBlock / ReportTemplate / ReportTheme / ReportLayout，制作 6 套模板）
5. **Phase 5** Responsive Report（Mobile/Tablet/Desktop，PDF 独立布局）
6. **Phase 6** Template Editor
7. **Phase 7** Playwright Visual QA

## 13. 关键原则

- 问卷视觉主题与报告模板**彻底分离**，各自独立设计，互不绑定
- 所有渲染（Admin/报告/PDF/Telegram/导出）共享同一 ViewModel 层
- 媒体是 Question / Option / Answer 三层的资源，不做全局 if 分支
- Telegram 永远只是外围基础设施
- **优先使用现成库（2026-08-23 产品决策）**：新增能力先找成熟库（如主题用 DaisyUI），不手搓通用轮子；已有依赖（Tailwind/React/dnd-kit/Telegram SDK/Puppeteer/resvg/xlsx/Playwright）优先复用

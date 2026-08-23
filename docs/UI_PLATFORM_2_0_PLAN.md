# Web UI Platform 2.0 — 调研与重构计划

> 状态：调研完成，待决策。日期：2026-08-23。
> 范围：问卷渲染层 / 后台设计系统 / 报告模板系统。
> 原则：不推倒后端（D1 / API / Auth / Telegram / Queue / ReportViewModel 全部保留），只重构 UI/Renderer 层。

## 0. 结论速览

| 方案 | 结论 | 理由 |
| -- | -- | -- |
| SurveyJS Form Library（survey-core + survey-react-ui） | **推荐，先 PoC 再替换** | MIT 授权；JSON 驱动；响应式/暗色/自定义题型/媒体选项均可扩展；与现有后端可解耦 |
| SurveyJS Creator / Dashboard / PDF | 暂缓（商业授权） | 参考其交互与主题体系，不引入；Dashboard 如需接入需授权评估 |
| Apache ECharts（SSR SVG） | **推荐直接引入** | Apache-2.0；5.3+ 支持 Node 端零依赖 SVG 渲染，可替换手写柱状/雷达，Web/PDF/PNG 三端统一 |
| 现有报告版式引擎（html-report-renderer） | **优先打通，不要重新发明** | 仓库已存在 6 种真版式（editorial/bento/magazine/data/gallery/profile），只是没接入 Web/PDF 模板与后台 |
| Playwright 视觉回归 | **推荐扩展** | 已具备基础（问卷+报告），补手机/平板/桌面矩阵与后台页面 |
| jikji / 现成报告模板 / 整体换框架 | 不推荐 | 重、授权不明、收益低 |

## 1. 现状盘点（三层）

### 1.1 问卷渲染层
- DB 标准 14 种题型（`src/db/schema.ts`），领域 schema 15 种（`boolean` 冗余，需收敛）。
- 自研渲染：单题一屏、逐题保存、条件跳题（仅向前）、媒体题、主题预设（8 套 DaisyUI）。
- 问题点：
  - 题目 DOM 层级松散（QuestionHeader / QuestionBody / ChoiceList 未结构化）；
  - 选项媒体（图片/视频/音频/贴纸/GIF）由 `OptionCard` 手写，无统一媒体组件；
  - 矩阵、多选在窄屏的排版没有系统性规则；
  - 暗色模式已补，但 token 尚未系统化。

### 1.2 后台设计系统
- Tailwind 4 + daisyUI 5 + 自研组件类；已有：卡片/表格/按钮/徽章/空状态/统计卡/暗色模式。
- 编辑器已有拖拽排序 + 实时手机预览（`SurveyPreview`），缺：设备切换预览、属性面板、媒体管理、主题编辑器。

### 1.3 报告模板系统
- **双引擎并存**：
  - A. `src/services/report/web.ts` 响应式模板：7 个模板 = sections 顺序 + 主题 + 少量 CSS → 观感上“换皮”。
  - B. `src/services/html-report-renderer.service.ts` 版式引擎：6 种真版式（区域编排、密度、bento/编辑风/影集/数据/档案），仅用于图片/PNG 路径，**未接入 Web 报告、PDF 与后台模板选择器**。
- 这就是“模板之间没差别”的根因：不是没有好引擎，而是它没被接到用户可见的链路上。

## 2. 与成熟方案逐项映射

### 2.1 题型映射（现有 14 种 → SurveyJS）

| 现有类型 | SurveyJS 候选 | 备注 |
| -- | -- | -- |
| single / yes_no / rating | `radiogroup` / `boolean` / `rating` | rating 用选项=分值，可映射 |
| multiple | `checkbox` | 数量上下限走 `minSelectedChoices/maxSelectedChoices` |
| matrix | `matrix`（行单选） | SurveyJS 支持纵向紧凑模式，正好解决窄屏问题 |
| text / long_text | `text` / `comment` | 校验映射 minLength/maxLength |
| number | `text` + inputType=number | 或自定义 number 题型 |
| date / time | `text` + 格式校验 | 或自定义 widget |
| image / video / audio / file | `file` + 自定义题型 | 上传走现有 media API；浏览器上传需新增 multipart→Bot 转发通路 |
| 选项级媒体（图/视频/音频/贴纸/GIF） | 自定义 widget / custom question type | SurveyJS 官方支持自定义题型与第三方组件；需 PoC |
| 跳题（option_equals，只向前） | `visibleIf` / `expression` | 需要 condition_json → SurveyJS 表达式转换器；注意“只向前”语义保留 |
| 分页/进度/返回 | 内置多页 + `showProgressBar` | 与现有 settings 对齐 |

### 2.2 答案存储映射（关键决策点）
- 现状：单选/多选按 **option 数值 ID** 存 `answer_options`（历史答卷强约束：改 label 安全、删选项断关联）；矩阵按 `{rowId: columnIndex}`。
- SurveyJS 输出的是选项 **value**（字符串）数组。方案：引入 adapter 层：
  - `SurveyJS answer JSON → 现有 D1 行`（value 解析回 optionId）；
  - 生成 SurveyJS JSON 时把 optionId 作为 `value` 直接使用，则答案可无损映射。
- 结论：**不需要动 D1 schema**，只需 renderer adapter。

### 2.3 媒体模型
- 现有 `SurveyMedia`（telegram_file_id / url / storage_key）→ 自定义媒体选择 widget 消费；
- Telegram sticker/GIF：前端无法直接取 file_id，沿用“Bot 转发换 file_id”通路；渲染端按 media_type 分发（photo/video/audio/animation/sticker/document）。

### 2.4 主题 / 暗色
- SurveyJS 主题 = CSS variables + theme JSON（light/dark/panelless 共 32 变体），与现有“预设即 daisy 主题”可映射：
  - 现有 8 套 daisy 预设 → SurveyJS theme JSON（颜色/圆角/字体）；
  - 自定义 JSON token（背景/卡片/文字/按钮）→ theme JSON 覆盖；
  - 暗色跟随系统：`prefers-color-scheme` + `colorPalette: dark`。
- 后台/问卷/报告统一走同一份 token 源，避免三处手写。

### 2.5 报告图表
- 现状：手写 SVG 雷达 + div 柱状。
- 方案：ECharts 5.3+ SSR（`echarts.init(null, null, { renderer:'svg', ssr:true })` → `renderToSVGString()`），Node 零依赖出 SVG，直接内嵌进报告 HTML → Web 可见、PDF 打印、PNG 复用同一份图表 SVG。
- 覆盖：雷达、横向条形、环形占比、折线（趋势）、仪表盘。

### 2.6 Web / PDF 分离
- 保持现状路线：Web 响应式为主，PDF 用 Playwright A4 归档样式；两者共用 ReportViewModel 与版式引擎，样式各自写（已有雏形）。

### 2.7 视觉回归
- 现有：390/768/1440 × 问卷 6 屏 + 报告 7 模板 ×3 + A4 打印。
- 扩展：375/390/430/768/1280/1920；页面清单加入后台 Dashboard/Editor/Responses/Login、问卷列表、图片题、长文本题；
- 检查项：截图 diff、overflow ≤1px、console error=0、（可选）accessibility snapshot。

## 3. 推荐决策

### 推荐做（下一阶段优先）
1. **报告引擎打通**：把 `html-report-renderer` 的 6 种真版式接入 Web/PDF 与后台模板选择器；现有 7 个“换皮模板”保留为“主题+版式组合”。这是性价比最高的一项。
2. **ECharts SSR 图表**：替换手写图表，报告三端统一。
3. **Design Token 正式化**：light/dark/system + 断点 + 间距/圆角/阴影单一来源；后台/问卷/报告共用。
4. **Playwright 矩阵扩展 + 后台页面纳入回归**。
5. **问卷渲染层结构化**（无论是否用 SurveyJS）：DOM 规范 QuestionHeader/Body/ChoiceList；媒体选项组件统一。

### 有条件推荐（需要 PoC 与决策门）
6. **SurveyJS Form Library 替换自研渲染器**：
   - PoC 内容：14 题型映射、选项媒体自定义 widget（图/视频/音频/贴纸/GIF）、答案 adapter（optionId ↔ value）、主题映射、暗色；
   - 决策门：PoC 在真机上达到当前交互完整度（逐题保存、续答、跳题、媒体上传）→ 替换；否则保留自研但按规范重构。

### 暂缓 / 不推荐
- SurveyJS Creator / Dashboard / PDF（商业授权，未列入预算前不引入）；
- jikji / 现成报告模板套壳；
- 整体换框架或推倒后端。

## 4. 分阶段计划

| Phase | 内容 | 预估 | 产出 |
| -- | -- | -- | -- |
| P0 基线 | 视觉回归矩阵、多设备预览、bug 清单（boolean 收敛、矩阵列语义） | 1–2 天 | 回归基线 + 问题单 |
| P1 Design System | token 单一来源、light/dark/system、后台/问卷/报告共用组件 | 2–3 天 | tokens.css + 组件库规范 |
| P2 Survey Renderer | SurveyJS adapter PoC → 决策门 → 替换或重构自研 | 3–5 天 | 渲染器 + adapter + 媒体组件 |
| P3 报告统一 | 版式引擎接入 Web/PDF/后台；ECharts SSR；PDF 归档样式 | 3–5 天 | 6 版式 × 主题可选的报告系统 |
| P4 Admin 2.0 | 编辑器设备预览、属性面板、媒体管理、主题编辑器 | 4–6 天 | 后台新编辑器 |
| P5 Report Studio | 拖拽版式 + 实时预览 + 保存模板 | 4–6 天 | 版式工作室 |

每阶段收尾固定做：单元测试 + 视觉回归 + 部署核验（线上资源 hash 与本地一致）。

## 5. 风险与开放问题
- SurveyJS 自定义媒体选项（贴纸/GIF）复杂度：需 PoC 验证，风险可控但不可忽略。
- 答案 adapter 的边界情况：历史答卷只读、版本快照、选项删除保护。
- 双引擎并存期维护成本：P3 前报告存在两套代码，需明确过渡策略（以版式引擎为准，web.ts 降级为兼容层）。
- 浏览器上传媒体：需要新增 multipart → Worker → Bot API 转发通路（此前文档已列为后期任务）。
- 特殊氛围/成人向主题：以“自定义背景/视觉主题”能力实现，不硬编码具体内容；合规由运营侧控制。
- 需要拍板：是否同意 P2 用 SurveyJS 做 PoC？ECharts 依赖是否接受（Apache-2.0 无授权成本）？报告版式优先级（先把 6 版式打通，还是先做 Design System）？

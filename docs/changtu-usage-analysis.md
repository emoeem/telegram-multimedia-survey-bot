# changtu 使用分析（2026-10-31）

> 结论先行：**选 c（组合）——「文章长图」作为独立功能引入（组件集成其 `src/lib`
> 排版引擎），与认证卡生成器保持「卡片 + 长文」互补；不把 changtu 的 Web UI
> 搬进来，也不让两者互相替代。** 本工作流只做分析，实现与否见「待确认决策」。

## 1. 它是什么

`/home/emo/code/changtu`：把一段文本（标题/正文/标签/信息行/页脚）排成**竖版
长图**的生成器，双形态：

- **网页版**（`src/web/main.ts`，1078 行纯 TS+DOM）：左贴文本右实时出图，全本地；
- **CLI**（`src/cli/render.ts`，649 行）：txt/stdin 批量出图，`--pages` 自动分页、
  多页打 zip、`--json` 元信息。

技术栈 **TypeScript 7 + Vite 8 + 原生 TS**（Node 渲染用 `@napi-rs/canvas`，
zip 用 `fflate`——两者均不进浏览器路径）。**MIT 许可证**（LICENSE + package.json
双标），允许集成进自有项目，仅需保留版权声明，无法律风险。

## 2. 能做什么

- 三种文本写法混用：front matter / 行标记（`【标题】``#标签``>页脚`）/ 字段覆盖；
- 输出 PNG/JPEG/WebP，默认宽 1080 的 2 倍图；单页超长自动分页（max-height
  8000px）不丢一行；
- **14 套主题**（light/dark/paper/poster/film/photo/scroll + 8 套夜场），
  背景照片模糊/压暗/遮罩/暗角/按亮度自动深浅字（`background.ts` 653 行）；
- 竖排标题、标题/标签光晕、自定义字体注册。

## 3. 代码质量

- 结构清晰：`src/lib`（核心 3898 行，浏览器/Node 渲染分离，`render-browser.ts`
  产出 Blob——显式的「浏览器安全」入口）；`src+test` 共 7644 行；
- **有测试**：8 文件 1768 行（parse/layout/theme/background/render/args 全覆盖）；
- 文档充足（20KB README + 截图）；
- git 活动度弱：仅 1 个压扁的初始提交（2026-10-24），仓库残留 `tmp/`、`out/`；
  `src/web/main.ts` 单文件偏臃肿。
- 亮点：懒渲染（只画可见页）、光晕不占排版空间且有测试钉住。

## 4. 集成成本（对 telegram-bot 的 React 19 + Vite 8 + TS + Tailwind 4）

**低成本**：浏览器路径**零 npm 依赖**——`src/lib` 是纯 TS 模块，拷入或 path
引入即可；React 侧只需 `useRef<canvas>` + `useEffect` 的薄包装调
`prepareContentImages` / `paintPage`。实测 dist 主 JS 62.7KB + 浏览器渲染
chunk 8.8KB（未压缩），对 admin 包体可忽略。Vite/TS 版本与 admin 完全对齐。

## 5. 与认证卡生成器的关系

两者都是 canvas 2D「文字 + 背景照片」，但输出形态不同：

- 认证卡（`cert/`）：**卡片**（证件/证书版式，1:1～9:16，单页），版式层
  `render.js` 4667 行；
- changtu：**文章长图**（多段落自动分页，最长 8000px/页）。

**互补，不重叠**：卡装不下长文，长文不需要证件版式。可复用的是思路与部件：
changtu 的背景处理（平均亮度→自动深浅字、tint overlay）可反哺 cert 的
`photoBox` 长图模式；它的分页排版（`layout.ts` 1014 行）直接补齐 cert
「长图」比例下多段落文案排不下的缺口。

## 6. 结论（禁止和稀泥，明确二选一或组合）

**选 c（组合），边界如下：**

| 部分                                                                      | 处置                                                                      | 理由                                                                                                      |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `src/lib` 排版引擎（layout/draw/theme/background/parse + render-browser） | **集成**：拷入 `admin/src/lib/changtu/`（保留 MIT 声明），加薄 React 包装 | 零依赖、有测试、MIT、体积可忽略；长图是问卷分享/总结文案的真实需求（试卷结果页「把你的结果排成长图」）    |
| `src/web` Web UI                                                          | **不搬**                                                                  | 与 admin 的表单/预览体系重复，且 1078 行单文件质量一般；需要时用 admin 组件重写薄 UI                      |
| `src/cli` + Node 渲染                                                     | **不用**                                                                  | Worker 侧引 @napi-rs/canvas 会炸 bundle；浏览器本地渲染已满足                                             |
| 认证卡生成器                                                              | **保持独立**（不合并）                                                    | 「卡片」与「长文」是两个入口、两种心智；cert 是独立静态页（共享 localStorage 主题预设），合并只会互相拖累 |

**集成点草图**（若实现）：

- 新路由 `/tools/longform`（或 admin 工具页一个 tab）：左文本框（复用
  changtu 的 parse 三写法）右 canvas 预览；
- 数据流：`themePreset`（localStorage `surveyPreset`，与 cert 同源）→ 映射
  changtu 主题；导出走 cert 同款 `shareToChannel` 通道（`/api/cert/share`
  已支持 WebP/JPEG/PNG + 多图 album——**无需新后端**）；
- 复用任务2 的盖章链路：长图导出同样可烧认证章（`R.drawSeal` 通用化）。

## 7. 一句话

> changtu = MIT 协议、零依赖、带测试的中文竖版长图排版引擎；**取其
> `src/lib` 嵌入 admin 做独立「文章长图」工具，与认证卡互补，不搬 UI 不进
> Worker**——实现与否见待确认决策。

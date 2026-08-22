# Report Template System

> 架构升级：不再是"PDF 报告系统"。报告由 **ReportViewModel + Template**
> 驱动，Web / PDF / Image 只是同一个模板的不同 renderer。

## 分层

```text
ReportViewModel（数据层，不变）
        │
        ▼
ReportTemplateSpec（模板：决定显示什么 / 怎么显示 / 什么主题）
        │
   ┌────┼────┐
   ▼    ▼    ▼
 Web  PDF  Image（renderer）
  │    │    │
手机报告 归档 PDF 分享图片
```

## 模板结构（src/services/report/template.ts）

```ts
interface ReportTemplateSpec {
  id: string;
  name: string;
  version: number;
  theme: ReportTheme;                    // 15 套内置主题之一
  sections: Array<{                      // 顺序即渲染顺序，控制"显示什么"
    kind: "cover"|"hero"|"summary"|"scores"|"radar"|"insights"|"quotes"|"answers"|"gallery"|"verdict";
    title?: string;                      // 覆盖内置标题
    presentation?: "cards"|"list"|"grid"|"featured"|"full";
  }>;
  renderers: Array<"web"|"pdf"|"image">;
  css?: string;                          // 自定义样式（渐变/字体/动画/封面）
}
```

- 内置模板：`classic`（经典）、`magazine-dark`（杂志暗色，含大图封面）
- `validateReportTemplateSpec` 提供 JSON 校验，未来可直接存 DB
- Web 报告 URL 支持 `?template=magazine-dark` 切换模板
- PDF 与 Web 共用同一模板与同一份 HTML（print CSS 排版）

## 自定义模板示例（比如"杂志封面"风格）

```json
{
  "id": "magazine-cover",
  "name": "杂志封面",
  "version": 1,
  "theme": "dracula",
  "renderers": ["web", "pdf"],
  "sections": [
    { "kind": "cover", "presentation": "full" },
    { "kind": "summary" },
    { "kind": "scores" },
    { "kind": "gallery", "presentation": "grid" },
    { "kind": "answers" }
  ],
  "css": ".report-cover{min-height:70vh;background-size:cover}.report-cover h1{font-size:44px;letter-spacing:.02em}"
}
```

`cover` 会自动使用 `ReportViewModel.hero.coverImage` 作为背景大图，天然支持
"特殊封面 / 大图 / 图片背景"类需求。

## Renderer 边界

| Renderer | 实现 | 说明 |
| -- | -- | -- |
| Web | `src/services/report/web.ts` | 模板驱动响应式单页（移动端优先） |
| PDF | `src/services/report/pdf.ts` | 同一模板 + `@media print`，图片压缩 ≤1200px |
| Image | 现有 PNG 管线（`html-report-renderer` 固定画布 / `visual-template` resvg） | 分享卡/结果卡导出 |

## 后续（未实现）

- `report_templates` 表：DB 存储自定义模板 + 版本
- Web Admin 模板编辑器：选择区块/主题/自定义 CSS，实时预览
- 问卷级默认模板配置（`survey_report_visual_settings` 或新列）

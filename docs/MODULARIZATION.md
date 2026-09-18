# HTTP / Bot 模块化拆分（结构重构）

> 状态：已完成，行为不变（无路由、响应、文案改动）。

## 目标

把两个超长单体文件按职责拆成模块，保持行为完全一致：

- `src/http/admin-api.ts`（原 3869 行）→ `src/http/admin/`
- `src/bot/survey-handler.ts`（原 3659 行）→ 保留入口，抽出报告/导出/媒体与回调路由模块

拆分采用“整段搬运 + 原样保留”的方式，没有重写任何业务逻辑；所有分支判断、
错误码、响应体、文案都与拆分前一致。

## Admin API

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `src/http/admin-api.ts` | 6 | 向后兼容 re-export（`handleAdminApi` 等） |
| `src/http/admin/index.ts` | 242 | 顶层认证（Telegram initData / 浏览器登录 / 开发期身份）、总调度、Telegram WebApp 校验 |
| `src/http/admin/write.ts` | 646 | `handleAdminWrite`：JSON/multipart body 读取、设置、导入、任务包、系统修复，以及各域模块调度 |
| `src/http/admin/read.ts` | 1012 | `handleAdminRead`：全部 GET 读取路由 |
| `src/http/admin/surveys.ts` | 355 | 问卷级嵌套写路由（答卷批量导出、复制、关闭/归档/重开、删除、发布、答卷报告链接） |
| `src/http/admin/editor.ts` | 575 | 编辑器写路由：题目/分页/选项/媒体附件 + 版本回滚 + 元数据 PATCH |
| `src/http/admin/users.ts` | 74 | 用户标签、封禁 |
| `src/http/admin/reports.ts` | 43 | 报告投递重试 |
| `src/http/admin/templates.ts` | 84 | 自定义报告模板创建/预览/删除 |
| `src/http/admin/community.ts` | 94 | 个人画廊、广场帖子/评论状态 |
| `src/http/admin/licenses.ts` | 258 | 授权、发行版本、创作者试用 |
| `src/http/admin/helpers.ts` | 716 | 共享类型、校验、问卷可写性检查、审计、媒体存储等 |

调度顺序与拆分前 `handleAdminWrite` 的 `if` 链顺序一致：域模块返回
`Response | null`，`null` 表示未命中，继续下一个模块；未命中时最后的
`404 not_found / Not found` 与拆分前完全相同。

## Bot survey handler

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `src/bot/survey-handler.ts` | 2878 | 消息入口、菜单/列表/设置/发布等 UI 流程（保持不变） |
| `src/bot/survey-report.ts` | 727 | 答卷报告与导出：媒体关系解析（批量查询）、`ResponseReport` 组装、图片内联、报告模板选择、PDF/PNG/CSV/ZIP/JSON/统计 PDF 导出 |
| `src/bot/survey-callbacks.ts` | 174 | `owner:response*` / `owner:export*` 回调路由（返回 `boolean` 表示是否命中） |

说明：

- 报告/媒体块拆到 `survey-report.ts` 时保留原函数签名与实现，仅加上
  `export`；`survey-handler.ts` 继续从该模块导入使用。
- `sendResponseReportExport` 仍从 `survey-handler.ts` re-export，导出 worker 的
  动态 `import("../bot/survey-handler")` 不受影响。
- 依赖渲染状态机的分支（问卷编辑 `qedit:*`、海报、builder 等）没有移动，
  避免引入回归。

## 验证

```bash
npm run typecheck
npx vitest run tests/unit/http/admin-api.test.ts tests/unit/http/admin-plaza.test.ts
npx vitest run tests/unit/bot/survey-handler-routing.test.ts
npm test
npm run lint
npm run build:admin
```

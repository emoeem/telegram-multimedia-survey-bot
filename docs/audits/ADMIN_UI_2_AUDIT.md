# Admin UI 2.0：现状 UI / API / 路由审计

日期：2026-09-18

## 1. 现状结论

Admin 已经具备完整的 React Router + lazy loading 路由骨架，业务 API 也基本覆盖问卷、答卷、报告、设置等核心链路。本轮不重写业务协议，只改善信息架构、视觉层级、响应式体验和重复交互。

## 2. 核心路由

- `/`：Dashboard
- `/surveys`：问卷列表
- `/surveys/:id`：问卷详情
- `/surveys/:id/editor`：问卷编辑器
- `/surveys/:id/responses`：单问卷答卷
- `/surveys/:id/responses/:responseId`：答卷详情
- `/surveys/:id/analytics`：统计
- `/surveys/:id/versions`：版本
- `/responses`：全局答卷动态
- `/reports`：报告交付
- `/settings`：系统设置

其它既有路由：导入、模板、用户、树洞、个人画廊、任务包、审计、授权等保持不变。

## 3. 核心 API 覆盖

- `/api/admin/dashboard`
- `/api/admin/surveys*`
- `/api/admin/responses`
- `/api/admin/surveys/:id/responses*`
- `/api/admin/report-deliveries*`
- `/api/admin/report-templates*`
- `/api/admin/settings`
- `/api/admin/users*`
- `/api/admin/audit-logs`
- `/api/admin/auth/telegram/*`

前端统一通过 `api.ts` 注入管理员身份头，并对 401 自动回到 Telegram 登录页。

## 4. UI 主要问题

1. Layout、页面标题、卡片、表格的视觉层级还不够统一。
2. 桌面端侧栏信息完整，但主内容缺少明显的页面上下文和操作区域。
3. Dashboard、Surveys、Responses、Reports 都重复实现统计卡片和筛选工具条。
4. 表格在数据较多时缺少更明确的 hover / row affordance。
5. 移动端虽然已有响应式实现，但操作区容易堆叠，页面节奏不够清晰。
6. Response Detail 信息量最大，需要更强的“摘要 → 操作 → 答案 → 环境信息”层级。
7. Settings 已有功能完整，但表单分组和保存状态反馈还可以更清晰。

## 5. 本轮实施原则

- 不改变既有 API 协议。
- 不制造假数据。
- 不新增假的后端服务。
- 保留所有现有业务操作。
- 保留 lazy route loading。
- 保留移动端可用性。
- 统一 Design Tokens、页面容器、统计卡、工具条、表格和状态反馈。
- 完成后必须通过 typecheck、lint、unit test、admin build、Playwright 与 `git diff --check`。

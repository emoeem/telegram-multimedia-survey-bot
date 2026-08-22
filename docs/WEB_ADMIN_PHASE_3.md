# Web Admin Phase 3：答卷与统计

> 状态：Phase 3a 第一批已完成，2026-08-22。无数据库迁移。

## 已完成

- `GET /api/admin/surveys/:id/responses`
  - 按状态筛选，20 条分页，最多 50 条/页。
  - owner 仅可读取自己的问卷；admin 可读取全部问卷。
  - 匿名问卷不向浏览器返回 Telegram 身份。
- `GET /api/admin/surveys/:id/responses/:responseId`
  - 返回按题目顺序组织的答案。
  - 选择题显示选项文案，矩阵题显示“行：列”，文本/数字/日期时间按原类型显示。
  - 媒体仅返回 `asset_scope=response` 的安全元数据，不暴露 Bot token 或存储绑定。
- `GET /api/admin/surveys/:id/responses/:responseId/media/:assetId`
  - 同时校验问卷权限、答卷归属、附件关系和 `asset_scope=response`。
  - Worker 使用 Bot token 从 Telegram 拉取文件并中继；前端使用带认证请求的 Blob URL 预览。
  - 单文件限制 20MB，响应启用 `nosniff`，文件名进行响应头安全清理。
- `GET /api/admin/surveys/:id/analytics`
  - 开始数、完成数、完成率、各状态数量。
  - 单选/多选/是否/评分选项分布。
  - 数字题与评分题的平均值、最小值、最大值和样本数。
- Web 页面：答卷列表、答卷详情、统计页；问卷详情和 Dashboard 最近答卷均可进入。

## 保持不变

- 所有数据仍来自现有 D1 表，不新增第二数据源。
- 浏览器不接触 D1、KV、Queue、Bot token 或 Cloudflare 绑定。
- Bot 的旧答卷/统计 callback 继续兼容，但入口已按 Phase 2.7 隐藏。
- 本批只读，不提供修改或删除答卷能力。

## Phase 3a 后续批次

1. Web 导入/导出任务 UI：复用现有导出服务和 Queue，增加浏览器可查询的任务状态与下载交付方式。
2. 用户目录与权限管理。
3. 媒体库按 `survey`、`response`、`template`、`identity_card` 等 scope 分区。

以上批次继续遵循 staging 先行和完整回归要求。

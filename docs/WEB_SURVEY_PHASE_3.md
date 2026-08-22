# Web Survey（Phase 3）实现说明

> 状态：已实现，未部署。对应 Web-first 迁移计划 Phase 3。

## 目标

提供移动端优先的网页问卷填写入口，与 Telegram 答题流程共享同一份
Survey Schema、跳题引擎与答案存储；Telegram 仍是入口与通知渠道。

## 路由

```
GET  /s/:id                       网页问卷页（admin/dist/survey.html，SPA 产物）
GET  /api/survey/:id              问卷定义（仅 published）
POST /api/survey/:id/access       校验访问密码
POST /api/survey/:id/responses    开始/续填答卷
GET  /api/survey/:id/responses/:rid      读取已保存答案（续填）
POST /api/survey/:id/responses/:rid/answers   保存单题答案
POST /api/survey/:id/responses/:rid/submit    提交答卷（必答校验）
POST /api/survey/:id/media        上传答卷媒体（R2，≤20MB）
GET  /api/survey/media/:id        媒体读取（按 scope 鉴权）
```

## 身份

- Telegram 内打开（有 `initData`）：验证签名后复用 `user_{id}` participant hash，
  与 Bot 端完成去重/次数限制一致。
- 浏览器打开（无 `initData`）：`x-participant-key`（localStorage 生成的 UUID），
  participant hash 为 `web_{key}`。

## 答题语义（与 Bot 一致）

- 单选 / 是否 / 评分：`json_value=[optionId]` + boolean/rating 列
- 多选：`json_value=[ids]` + `answer_options` 行
- 矩阵：`json_value={kind:"matrix",selections:{rowId:colIndex}}`
- 文本 / 长文本 / 数字 / 日期 / 时间：对应专用列
- 图片 / 视频 / 音频 / 文件：R2 上传 → `media_assets(scope='response')` →
  `answer_media` 关联

## 前端

`admin/survey.html` + `admin/src/survey/*`，Vite 多页面构建（index.html + survey.html）。
支持：进度条、分页标题、跳题规则、必答/长度/范围/多选数量校验、矩阵点选、
媒体题上传、断点续填。

## 媒体策略（Phase 1 起生效）

用户上传媒体是**临时数据**，不是长期对象存储：

- 仅允许 JPEG / PNG / WebP；单张 ≤ 10MB；单份答卷总量 ≤ 50MB；暂不支持 GIF / 视频
- 存储走 `TemporaryMediaStore`（当前 KV 实现 `MEDIA_KV`，键前缀
  `media:temp:{responseId}:{uuid}`，7 天 TTL 兜底），DB 中
  `media_assets.storage_kind = 'temporary'` + `expires_at`
- 答卷提交后自动入队 `report_delivery`（EXPORT_QUEUE），报告归档成功后
  删除临时图片；cron 兜底清理过期对象
- `storage_kind` 显式区分 `temporary / telegram / r2 / url`，语义不靠默认值

同时需要应用迁移 `0026` 与 `0027`。

## 验证

```bash
npm run typecheck
npm test
npm --prefix admin run build
```

手工验证（staging）：发布一份含多选/矩阵/媒体题的问卷 → 打开
`https://<worker>/s/<id>` → 填写提交 → admin 答卷详情核对。

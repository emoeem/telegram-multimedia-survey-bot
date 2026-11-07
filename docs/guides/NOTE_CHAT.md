# 纸条聊天与复核（/notes + /admin/notes）

> 匿名双向纸条：抽一张陌生人的纸条、回信、拉黑与举报；管理端有纸条复核页。
> 身份一律 `participant_hash`（与金币、挑战同一套匿名身份），纸条不暴露 Telegram 身份。
> 本文重点覆盖 2026-11-07 第二批补齐的安全闭环与站内通知（迁移
> [`0094_note_chat_safety.sql`](../../db/migrations/0094_note_chat_safety.sql)，纯新增两张表）。

## 用户侧（/notes）

- **抽纸条 / 回信**：`POST /api/note/draw` 开局，`GET /api/note/threads` 列会话、
  `GET /api/note/threads/:id/messages` 读消息（`src/http/note-api.ts:295-313`）。
  每人同时至多一张进行中的纸条（`note-chat.service.ts` 的 already_active 守卫）。
- **发布前过滤（第二批）**：发言/新纸条先过 `src/services/note-content-filter.service.ts`
  的词表（`NOTE_BLOCKED_WORDS`）；命中直接 **422 拒收**，notes / note_messages 零落库。
  设计上接受漏报（谐音、拆字不追），靠举报 + 管理复核兜底。
- **会话级拉黑（第二批）**：`POST /api/note/threads/:id/block` 拉黑、`DELETE` 解除
  （`note-api.ts:336`）。拉黑**双向生效**：双方互相不可见会话，且抽取池排除双向。
- **消息举报（第二批）**：`POST /api/note/threads/:id/messages/:id/report`（`note-api.ts:349`）。
  仅会话参与者可举报；同一人对同一消息去重。
- **站内通知（第二批）**：`GET /api/me/notifications` + `POST /api/me/notifications/seen`
  （`src/http/me-api.ts:258,264`）。两类事件（`src/services/note-chat.service.ts:539-573`，
  链接统一 `/notes`）：
  - `note_drawn`（被抽中）：**离散事件，有意不折叠**——每条都可带抽中上下文；热门作者
    的铃铛未读可堆积，若运营反馈刷屏可按 note_reply 同款单点改造；
  - `note_reply`（收到回信）：**按参与者折叠**——先刷新未读那条的 body/created_at，
    每参与者至多 1 条未读，写放大封顶。
- **轮询（第二批）**：对话页轮询由 `admin/src/survey/note-poll.ts` 驱动——按页面可见性
  退避（前台密集、后台稀疏），不新增常驻轮询端点。

## 管理端（/admin/notes）

- 入口：后台社区工作区「纸条复核」（`admin/src/App.tsx:106` →
  `admin/src/routes/NoteReviewPage.tsx`）。**零新 API**，全部复用既有管理端接口：
  - `GET /api/note/admin/notes`：按状态列纸条，隐藏/被举报优先（`note-api.ts:236`）；
  - `GET /api/note/admin/messages?reported=1`：被举报的会话消息，按消息聚合举报数、
    倒序最近 50 条（`note-api.ts:242`）。
- 处置动作（恢复/移除）走既有处置路径并落 `audit_logs`（writeAudit）。
- 边界：V1 只展示文本与元数据——adminListNotes 的 SELECT 未含 image_asset_id，
  图片预览留待后续（api.ts 注释已写明）。

## 数据与运维要点

- 迁移 0094 仅新增 `note_block`（`0094_note_chat_safety.sql:31`）与
  `note_message_reports`（`:39`）两张表，对既有数据零影响；生产应用前照例
  `wrangler d1 export` 备份 → staging 验证 → 生产。
- 通知复用 notifications 表（0084），零新迁移，回滚 = 纯代码 revert。
- 已知取舍与低危遗留（全角变体绕过词表、通知列表排序、拉黑解除响应语义等）见
  [`reports/WORK_REPORT_2026-11-07_BATCH2_COMMUNITY.md`](../reports/WORK_REPORT_2026-11-07_BATCH2_COMMUNITY.md)
  §五/§六。

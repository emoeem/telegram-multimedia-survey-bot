-- 公开发布的「是否匿名 / 想说的话」是答卷者自己的选择，必须和
-- report_publication_requested（是否公开）一起落在答卷行上：发布是异步的
-- （export job → 队列/内部路由 → 浏览器渲染 → Telegram），发布那一刻无处
-- 再问用户，只能从这条记录读回来。
--
-- 1) publish_anonymous：1 = 发布时剥离 Telegram 身份（用户名/姓名/user id/
--    头像链接一律不出现）。默认 1（隐私优先）：泄漏出去的频道消息收不回来，
--    而老答卷在发布时已无法追溯当时的选择，因此一律按匿名处理。
-- 2) publish_message：答卷者想在公开发布里附带的一句话（可空，服务端仍按
--    上限截断；前端上限见 admin/src/survey/publish-choice.ts）。
--
-- 落地方式（与既有迁移一致，用 wrangler 的顺序编号 apply）：
--   本地：pnpm migrate:local    # wrangler d1 migrations apply DB --local
--   远端：pnpm migrate:remote   # wrangler d1 migrations apply DB --remote
-- 未 apply 的旧库不会崩：读取侧一律 `publish_anonymous ?? 1`（按匿名）且
-- publish_message 缺席视为无留言，见 src/services/public-report.service.ts 的
-- isResponsePublishAnonymous 与 src/db/repositories/response.repository.ts。
ALTER TABLE survey_responses ADD COLUMN publish_anonymous INTEGER NOT NULL DEFAULT 1;
ALTER TABLE survey_responses ADD COLUMN publish_message TEXT;

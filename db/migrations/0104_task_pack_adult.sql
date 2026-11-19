-- 0104: /trial 18+ 门禁从页级下沉到包级——包级 adult 标志 + 包级 ack 偏好存储。
--
-- 动机：/trial 现行 18+ 门禁是纯客户端整页 localStorage 键
-- （trialAdultAgreement:v1，TrialScreen.tsx 的页级 renderGate），/api/trial/*
-- 全部接口对 adult 内容零服务端校验（P0 轮通读 trial-api.ts 证实），清掉
-- localStorage 即可绕过。本迁移给门禁下沉提供两块存储：
--
-- 1) task_packs.adult（INTEGER NOT NULL DEFAULT 1）：包级 18+ 标志，管理端
--    可编辑。存量包默认 1 = 保持「页级门挡所有人」的现状（避免行为回归）；
--    新包默认 1 与存量一致，管理员显式取消勾选才降为 0。
--    插件玩法不加列/不改协议：effective adult 走清单现成的
--    capabilities.adult（src/game-plugin/types.ts:38，如 quest=true、
--    flip-card=false），读取侧见 engine-registry.isAdultGamePack——因此
--    插件包行上的 adult 列值仅作存储冗余，不参与玩家侧判定。
--
-- 2) participant_preferences 两个 ack 偏好列（0080 同表先例，按
--    participant_hash）：服务端强制点（POST /api/trial/runs 对 adult 包
--    校验 ack）的判定状态。语义（复核修订，与客户端 localStorage 键对齐）：
--    - trial_adult_ack_all：全局 ack 标志——客户端既有全局键 '1' 的服务端
--      落点（单向同步，幂等）；
--    - trial_adult_acked_pack_ids：包级 ack 列表（JSON 数组）——包级 ack 键
--      为权威，**绝不回写全局键**（回写会立即废掉包级粒度）。
--    放行规则 = ack_all 或 包 id 命中列表，任一即放行；不含 0080 的
--    age_verified_at——/trial 与 /s 是独立上下文（/trial 新确认的用户会被
--    /s 自身门禁再确认一次，属一次性独立确认而非回归），存量全局键用户经
--    客户端单向同步零回归。

ALTER TABLE task_packs ADD COLUMN adult INTEGER NOT NULL DEFAULT 1;

ALTER TABLE participant_preferences ADD COLUMN trial_adult_ack_all INTEGER NOT NULL DEFAULT 0;
ALTER TABLE participant_preferences ADD COLUMN trial_adult_acked_pack_ids TEXT NOT NULL DEFAULT '[]';

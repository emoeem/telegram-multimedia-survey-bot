-- 0108_game_room_visibility.sql
--
-- 房间可见性（用户验收需求：私人房间防滥用 + 降低服务器负担）：
--   public  = 默认；出现在对应玩法的公共房间列表，可直接点击加入。
--   private = 不进公共列表，仅凭房间码/房间号加入；创建时扣积分
--             （game-api.ts 的 PRIVATE_ROOM_FEE，幂等键 game_room_private_fee:{roomId}）。
-- 历史行默认 public，行为不变。
ALTER TABLE game_rooms ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public';

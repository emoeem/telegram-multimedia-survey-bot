-- 0105: 多人对局房间索引表 game_rooms + 比赛历史表 game_matches（P0 加固批次 G1）。
--
-- 动机：G1 是多人对局基座（GameRoomDO + 协议骨架 + 房间 REST），实时态
-- （棋盘、手牌、回合、去重表、在线连接）全部住在 Durable Object storage
-- （src/durable-objects/game-room.ts），不进 D1——"每步棋不触 D1"。
-- 本迁移只建**索引与终态**两张表：
--   · game_rooms：房间目录。自增数字 id 即房间唯一标识，深链接格式锁定为
--     `https://t.me/<bot>?startapp=room_<id>`（room_ 前缀 + 数字 id，与
--     DO 实例名 gameRoomDOName 一致，见 src/game/multiplayer/engine-types.ts）。
--     由 G3 的深链接生成器与 GameScreen 消费；加入统一走
--     POST /api/game/rooms/:id/join，本批不引入独立「房间代码」概念。
--   · game_matches：终态战绩。一局结束时由 REST 层把 DO 的结算快照落进来
--     （结果 + snapshot_json），供"我的对局"等只读查询；对局进行中这里
--     没有任何行。
--
-- 形态参照 web_apps（0104）：小表、TEXT 时间戳（ISO 字符串）、状态列 CHECK
-- 收紧（新状态值出现时再迁移放宽）。
CREATE TABLE game_rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 玩法类型（引擎注册表 gameType：G2 五子棋 gomoku 等，注册表校验在代码层）。
  game_type TEXT NOT NULL,
  -- lobby → playing → settled；closed 仅空房回收/主动关闭。
  status TEXT NOT NULL DEFAULT 'lobby' CHECK(status IN ('lobby','playing','settled','closed')),
  -- 房主身份哈希（resolveParticipant 的 participantHash），列表"我创建的"过滤用。
  host_participant_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
);

-- 玩家侧列表热路径：进行中/待加入的房间按新旧排（状态过滤 + 时间倒序）。
CREATE INDEX idx_game_rooms_status_created
  ON game_rooms(status, created_at DESC, id DESC);

-- "我创建/参与过的房间"回看。
CREATE INDEX idx_game_rooms_host
  ON game_rooms(host_participant_hash, created_at DESC);

CREATE TABLE game_matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 房间引用：room_<id> 深链接即由该 id 拼出。
  room_id INTEGER NOT NULL REFERENCES game_rooms(id),
  game_type TEXT NOT NULL,
  -- 结果（'host_win' | 'guest_win' | 'draw' | 'timeout' | 'aborted'…，
  -- 引擎可扩展，与协议 GameSettlement.result 同源，不设 CHECK 以免每加
  -- 结果形态都要迁移）。
  result TEXT NOT NULL,
  settled_at TEXT NOT NULL,
  -- 结算快照 JSON（棋谱、比分、回合数…引擎自由格式，DO settlement 键的落盘）。
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 按房间回看一局。
CREATE INDEX idx_game_matches_room
  ON game_matches(room_id, settled_at);

-- 按玩法取最近战绩（榜单/历史页）。
CREATE INDEX idx_game_matches_game_type
  ON game_matches(game_type, settled_at DESC);

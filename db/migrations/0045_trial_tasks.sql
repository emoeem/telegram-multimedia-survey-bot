-- 网页任务系统（trial）：任务包 / 任务条目 / 游玩局。
-- 内容与机制分离：机制（楼层、积分、跳过）固定在引擎里，任务文案全部
-- 存库，可在管理端随时编辑并即时生效。
CREATE TABLE IF NOT EXISTS task_packs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  normal_floors INTEGER NOT NULL DEFAULT 10,
  hell_floors INTEGER NOT NULL DEFAULT 12,
  prep_items TEXT NOT NULL DEFAULT '[]',
  prep_text TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pack_id INTEGER NOT NULL REFERENCES task_packs(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  warning TEXT NOT NULL DEFAULT '',
  score INTEGER NOT NULL DEFAULT 5,
  persona TEXT NOT NULL DEFAULT 'any',
  mode TEXT NOT NULL DEFAULT 'any',
  min_floor INTEGER NOT NULL DEFAULT 1,
  max_floor INTEGER NOT NULL DEFAULT 99,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_items_pack ON task_items(pack_id, enabled, persona, mode);

CREATE TABLE IF NOT EXISTS task_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pack_id INTEGER NOT NULL REFERENCES task_packs(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  participant_hash TEXT NOT NULL,
  persona TEXT NOT NULL,
  mode TEXT NOT NULL,
  starting_floor INTEGER NOT NULL DEFAULT 1,
  current_floor INTEGER NOT NULL DEFAULT 1,
  max_floor INTEGER NOT NULL DEFAULT 10,
  score INTEGER NOT NULL DEFAULT 0,
  completed_tasks INTEGER NOT NULL DEFAULT 0,
  skipped_tasks INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  state_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  finished_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_runs_leaderboard ON task_runs(pack_id, mode, status, score DESC);
CREATE INDEX IF NOT EXISTS idx_task_runs_participant ON task_runs(participant_hash, started_at DESC);

-- 示例任务包（可在管理端「任务包」里编辑或删除）。全部为虚构角色扮演
-- 文案，玩家端有 18+ 声明确认门。prep_items 是开局前展示的准备清单。
INSERT INTO task_packs (name, description, normal_floors, hell_floors, prep_items, prep_text, enabled, sort_order, created_at, updated_at)
VALUES ('示例 · 楼道挑战', '虚构模拟：在想象中的楼道里逐层上行，每层抽取一个任务。18+ 成人向角色扮演，请勿在现实中于公共场所实施任何违法行为。', 10, 12,
'["手机（计时与记录用）","一杯水（放在出发处）","一块毛巾","便签纸和笔（记录感受）","身上穿容易脱下叠好的衣物"]',
'出发前把准备清单放在门口，按顺序确认。全程在虚构想象中进行，不要在现实公共场所实施任何任务。', 1, 1, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z');

INSERT INTO task_packs (name, description, normal_floors, hell_floors, prep_items, prep_text, enabled, sort_order, created_at, updated_at)
VALUES ('示例 · 卧室调教', '虚构模拟：室内私下进行的服从与羞耻任务，从轻到重逐层递进。18+ 成人向角色扮演。', 8, 10,
'["一面可以照到全身的镜子","一杯温水","一条薄毯（休息用）","床头盒子（收纳书写条）","手机（计时用）"]',
'确认房门已锁、手机静音。先把准备清单按顺序摆在桌面，再开始第一层。', 1, 2, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z');

-- 楼道挑战示例任务（persona: any/male/female, mode: any/normal/hell）
INSERT INTO task_items (pack_id, title, description, score, persona, mode, min_floor, max_floor, enabled, sort_order, created_at, updated_at) VALUES
(1, '门厅整装', '想象你站在门厅的镜子前：把外套脱下叠好，检查自己只剩下预先约定的装束，对镜子说一句“我要上楼了”。', 3, 'any', 'any', 1, 3, 1, 1, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z'),
(1, '声控灯', '想象声控灯熄灭的瞬间，你在黑暗里静止十秒，数自己的心跳，灯再亮起时才准继续上行。', 4, 'any', 'any', 1, 5, 1, 2, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z'),
(1, '台阶计数', '连续两层不扶墙、不看手机，每踏一级在心里报一次层数，报错就退回本层起点重来。', 4, 'any', 'any', 2, 8, 1, 3, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z'),
(1, '转角停留', '在下一个转角平台停留三十秒，想象自己被恰好路过的人看见，把最想躲藏的冲动写进随行笔记。', 5, 'any', 'any', 3, 10, 1, 4, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z'),
(1, '窗边剪影', '想象楼道尽头的窗户把你的轮廓照成剪影：摆一个“被观赏”的姿势，保持到数完二十个呼吸。', 5, 'female', 'any', 4, 12, 1, 5, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z'),
(1, '扶手冰冷', '想象你只能用一只手扶着冰冷的扶手上行，另一只手放在头顶，像被牵引着走完这一层。', 4, 'male', 'any', 4, 12, 1, 6, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z'),
(1, '电梯厅点名', '（仅地狱模式）在想象中的电梯厅立正站好，报出自己的身份称呼三遍，每一遍都要比上一遍更大声。', 6, 'any', 'hell', 6, 12, 1, 7, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z'),
(1, '镜面自述', '对着想象中的防火门镜面，用第三人称描述自己此刻的样子，不少于三句话。', 5, 'any', 'any', 5, 12, 1, 8, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z'),
(1, '半层回声', '在两层之间的半层平台跺一次脚，听回声，然后说出“这一层是我的”。', 3, 'any', 'any', 1, 6, 1, 9, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z'),
(1, '顶层加冕', '到达顶层的最后一段，放慢速度，想象聚光灯打在你身上，用一句话给自己的挑战收尾。', 8, 'any', 'any', 9, 12, 1, 10, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z'),
(1, '惩罚回廊', '（仅地狱模式）闭眼想象回廊两侧都是注视你的眼睛，原地转一圈后继续上行。', 6, 'any', 'hell', 7, 12, 1, 11, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z'),
(1, '俯身前行', '想象这一层的灯坏了：弯腰俯身、手扶台阶，用“爬”的姿势前进五级台阶。', 6, 'male', 'hell', 5, 12, 1, 12, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z'),
(1, '裙摆检查', '每上一层都向想象中的督导汇报一次装束状态：“报告，第X层，装束完好/不完好”。', 5, 'female', 'any', 3, 12, 1, 13, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z'),
(1, '终点结算', '站在想象中的顶层平台，面向天空深呼吸三次，念出这一局你给自己的评语。', 7, 'any', 'any', 8, 12, 1, 14, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z');

-- 卧室调教示例任务
INSERT INTO task_items (pack_id, title, description, score, persona, mode, min_floor, max_floor, enabled, sort_order, created_at, updated_at) VALUES
(2, '跪姿报到', '在房间中央跪好，双手放膝，低头报出你的称呼和今天的第几层。', 3, 'any', 'any', 1, 4, 1, 1, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z'),
(2, '叠衣仪式', '把身上多出的衣物一件件叠成方块摆在床角，每叠一件说一次“交给您”。', 4, 'any', 'any', 1, 5, 1, 2, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z'),
(2, '计数拍打', '想象督导的指令：用手掌在腿上按节拍计数到三十，数字不允许跳过或含糊。', 5, 'any', 'any', 2, 8, 1, 3, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z'),
(2, '姿势保持', '摆出“展示”姿势靠墙站好，保持两分钟，计时结束前不允许移动重心。', 5, 'female', 'any', 3, 8, 1, 4, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z'),
(2, '口令复述', '把今天给自己定的三条规矩大声复述一遍，漏一条就加一层任务。', 4, 'any', 'any', 2, 6, 1, 5, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z'),
(2, '镜前自评', '对着衣柜镜从上到下打量自己，说出三个“今天做得好”和一个“还不够”的地方。', 6, 'any', 'any', 4, 10, 1, 6, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z'),
(2, '低温考验', '把一件金属物件贴在锁骨上数十秒，想象这是“冷静项”，结束后汇报感受。', 5, 'any', 'any', 5, 10, 1, 7, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z'),
(2, '延时注视', '盯着一处点蜡烛的想象火苗（或夜灯）凝视一分钟，中途眨眼就重新计时。', 4, 'any', 'any', 3, 8, 1, 8, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z'),
(2, '书写臣服', '在纸上写下“这一层我服从”，签名并按下指印（想象即可），放进床头盒子里。', 6, 'male', 'any', 5, 10, 1, 9, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z'),
(2, '终局告白', '挑战结束：对镜子说出这一局里最羞耻的瞬间，以及明天想挑战的下一层。', 8, 'any', 'any', 7, 10, 1, 10, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z'),
(2, '静音行走', '（仅地狱模式）全程踮脚完成本层任务，脚跟落地一次就在心里记一笔欠账。', 6, 'any', 'hell', 4, 10, 1, 11, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z'),
(2, '感官剥夺', '（仅地狱模式）闭眼完成本层的全部移动，只靠手摸墙面辨认方向。', 6, 'any', 'hell', 6, 10, 1, 12, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z');

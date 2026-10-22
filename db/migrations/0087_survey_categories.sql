-- 0087 · 问卷分类
--
-- 用户反馈：公开目录里 88 份问卷平铺成一张无限长的列表，没有任何归类，
-- 新访客无法判断「从哪份开始」，老访客找不到上次看到的那一类。
--
-- 设计取向（为什么是一张表 + 一个外键，而不是给 surveys 加一个枚举列）：
--   * 分类是运营内容，需要能改名、调序、增删，写死在代码里的枚举做不到；
--   * 一份问卷只属于一个分类（多标签是另一套交互，会把这个列表页变成
--     筛选器迷宫），所以是外键而不是多对多关联表；
--   * 分类被删除时问卷不应该跟着消失：category_id 置空 = 「未分类」，
--     公开目录把它归到「全部」里，管理端给一个筛选项专门捞它。
--
-- 存量归类：下面按标题模式给已有问卷做了一次确定性归类（只填空值，
-- 可重复执行也只会影响未分类的行）。这是起点不是结论——管理端可以
-- 单条改、也可以勾选批量改。分错的成本很低，漏掉的（未分类）在管理端
-- 一眼可见。

CREATE TABLE IF NOT EXISTS survey_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE surveys ADD COLUMN category_id INTEGER REFERENCES survey_categories(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_surveys_category ON surveys(category_id, status);

INSERT INTO survey_categories (slug, name, description, sort_order, created_at, updated_at) VALUES
  ('scenario', '情景剧情', '有场景、有对手戏的沉浸式剧情，从头读到尾', 10, '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z'),
  ('command',  '指令任务', '一条条指令照着做，做完回来打卡', 20, '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z'),
  ('training', '调教养成', '长期驯化路线，分阶段推进', 30, '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z'),
  ('quiz',     '自测评估', '打分测评，交完卷出一份属于你自己的结果', 40, '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z'),
  ('persona',  '身份反差', '人前一套、人后一套的对照与自曝', 50, '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z'),
  ('novel',    '互动小说', '视觉小说式阅读，逐字推进、分支结局', 60, '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z'),
  ('profile',  '个人档案', '自我介绍与基本资料，用来让别人认识你', 70, '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z');

-- ── 存量归类（顺序即优先级，先匹配先落位）──────────────────────────────
-- 1) 互动小说：有 VN 模式的卷最没歧义。
UPDATE surveys SET category_id = (SELECT id FROM survey_categories WHERE slug = 'novel')
 WHERE category_id IS NULL
   AND (title LIKE '%视觉小说%' OR title LIKE '%互动小说%');

-- 2) 个人档案。
UPDATE surveys SET category_id = (SELECT id FROM survey_categories WHERE slug = 'profile')
 WHERE category_id IS NULL
   AND (title LIKE '%个人档案%' OR title LIKE '%基本信息%');

-- 3) 情景剧情优先段：标题自己写了「情景」「成人大学」的，不该被下面的
--    「调教/羞辱/篇」抢走（同一部作品的三章必须落在同一类）。
UPDATE surveys SET category_id = (SELECT id FROM survey_categories WHERE slug = 'scenario')
 WHERE category_id IS NULL
   AND (title LIKE '%成人大学%' OR title LIKE '%情景%');

-- 4) 指令任务。
UPDATE surveys SET category_id = (SELECT id FROM survey_categories WHERE slug = 'command')
 WHERE category_id IS NULL
   AND (title LIKE '%指令游戏%' OR title LIKE '%任务系列%' OR title LIKE '%骰子游戏%' OR title LIKE '%指令%');

-- 5) 自测评估。
UPDATE surveys SET category_id = (SELECT id FROM survey_categories WHERE slug = 'quiz')
 WHERE category_id IS NULL
   AND (title LIKE '%测试%' OR title LIKE '%自测%' OR title LIKE '%调查%'
        OR title LIKE '%指数%' OR title LIKE '%评估%' OR title LIKE '%考试%');

-- 6) 身份反差。
UPDATE surveys SET category_id = (SELECT id FROM survey_categories WHERE slug = 'persona')
 WHERE category_id IS NULL
   AND (title LIKE '%反差%' OR title LIKE '%双面%' OR title LIKE '%伪娘%' OR title LIKE '%档案%');

-- 7) 调教养成。
UPDATE surveys SET category_id = (SELECT id FROM survey_categories WHERE slug = 'training')
 WHERE category_id IS NULL
   AND (title LIKE '%调教%' OR title LIKE '%训练%' OR title LIKE '%养成%' OR title LIKE '%洗脑%'
        OR title LIKE '%母畜%' OR title LIKE '%母狗%' OR title LIKE '%驯化%' OR title LIKE '%圈养%'
        OR title LIKE '%羞辱%');

-- 8) 情景剧情兜底：标题里有明确场景词（酒吧/学校/地铁/宿舍…）或剧情结构
--    （上下篇、之旅、答辩、胁迫）的都算情景。
UPDATE surveys SET category_id = (SELECT id FROM survey_categories WHERE slug = 'scenario')
 WHERE category_id IS NULL
   AND (title LIKE '%剧情%' OR title LIKE '%之旅%' OR title LIKE '%篇%' OR title LIKE '%游戏%'
        OR title LIKE '%酒吧%' OR title LIKE '%学校%' OR title LIKE '%校园%' OR title LIKE '%办公室%'
        OR title LIKE '%地铁%' OR title LIKE '%宿舍%' OR title LIKE '%婚礼%' OR title LIKE '%会所%'
        OR title LIKE '%校妓%' OR title LIKE '%小巷%' OR title LIKE '%答辩%' OR title LIKE '%胁迫%'
        OR title LIKE '%友爱俱乐部%' OR title LIKE '%灵魂%' OR title LIKE '%初体验%'
        OR title LIKE '%媚足%' OR title LIKE '%申请%' OR title LIKE '%沉沦%' OR title LIKE '%老师%');

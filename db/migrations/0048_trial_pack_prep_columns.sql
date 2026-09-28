-- 0045 的 CREATE TABLE 已经声明了 prep_items / prep_text 两列（本迁移与 0045
-- 同一提交，0045 曾在远端应用后又回改过定义）。这里不再重复 ALTER —— 否则在
-- 全新数据库上会报 "duplicate column name: prep_items" 导致迁移链在 0047 中断，
-- 后面的 0049-0054（task_items/task_runs、email_accounts、关键索引）全部不执行。
-- 只保留对两个内置示例任务包的回填。

-- 给两个内置示例任务包回填准备清单。
UPDATE task_packs SET
  prep_items = '["手机（计时与记录用）","一杯水（放在出发处）","一块毛巾","便签纸和笔（记录感受）","身上穿容易脱下叠好的衣物"]',
  prep_text = '出发前把准备清单放在门口，按顺序确认。全程在虚构想象中进行，不要在现实公共场所实施任何任务。'
WHERE name = '示例 · 楼道挑战';

UPDATE task_packs SET
  prep_items = '["一面可以照到全身的镜子","一杯温水","一条薄毯（休息用）","床头盒子（收纳书写条）","手机（计时用）"]',
  prep_text = '确认房门已锁、手机静音。先把准备清单按顺序摆在桌面，再开始第一层。'
WHERE name = '示例 · 卧室调教';

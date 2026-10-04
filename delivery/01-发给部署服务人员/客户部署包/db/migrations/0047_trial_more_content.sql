-- More trial content: two new sample packs plus extra tasks for the first
-- two packs. All copy is fictional indoor/private role-play for the 18+
-- gate; floors/personas/modes are editable in the admin task editor.
INSERT INTO task_packs (name, description, normal_floors, hell_floors, enabled, sort_order, created_at, updated_at)
VALUES ('示例 · 浴室晨课', '虚构模拟：想象中的浴室与更衣间里的晨间自课，从松弛到专注逐层递进。18+ 成人向角色扮演，仅在想象中的私密空间进行。', 8, 10, 1, 3, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z');

INSERT INTO task_packs (name, description, normal_floors, hell_floors, enabled, sort_order, created_at, updated_at)
VALUES ('示例 · 宅邸夜巡', '虚构模拟：想象深夜的私人宅邸里独自巡夜，灯光、声音与规矩逐层收紧。18+ 成人向角色扮演，请勿在现实中实施。', 10, 12, 1, 4, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z');

-- Extra tasks for 示例 · 楼道挑战
INSERT INTO task_items (pack_id, title, description, score, persona, mode, min_floor, max_floor, enabled, sort_order, created_at, updated_at)
SELECT id, '喘息停顿', '想象在两层之间靠墙站定，闭上眼睛深呼吸三次，第三次呼气时才准继续上行。', 4, 'any', 'any', 2, 7, 1, 50, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z' FROM task_packs WHERE name = '示例 · 楼道挑战';
INSERT INTO task_items (pack_id, title, description, score, persona, mode, min_floor, max_floor, enabled, sort_order, created_at, updated_at)
SELECT id, '台阶口令', '每一步踏稳后在心里默念“臣服一层”，走到本层平台后把默念的次数报给想象中的督导。', 5, 'any', 'any', 3, 9, 1, 51, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z' FROM task_packs WHERE name = '示例 · 楼道挑战';
INSERT INTO task_items (pack_id, title, description, score, persona, mode, min_floor, max_floor, enabled, sort_order, created_at, updated_at)
SELECT id, '门后光线', '想象某扇门后漏出一条光线，在光线照到的地方站十秒，把影子当作督导的注视。', 5, 'female', 'any', 4, 11, 1, 52, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z' FROM task_packs WHERE name = '示例 · 楼道挑战';
INSERT INTO task_items (pack_id, title, description, score, persona, mode, min_floor, max_floor, enabled, sort_order, created_at, updated_at)
SELECT id, '衣料摩擦', '想象走动时衣料与墙面擦过的声音：放慢脚步，让每一声都被自己听见，然后继续。', 4, 'male', 'any', 3, 8, 1, 53, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z' FROM task_packs WHERE name = '示例 · 楼道挑战';
INSERT INTO task_items (pack_id, title, description, score, persona, mode, min_floor, max_floor, enabled, sort_order, created_at, updated_at)
SELECT id, '回望楼梯', '到本层后回头望一眼来时的楼梯，向想象中的督导复述自己这一路“最想藏起来的一步”。', 6, 'any', 'hell', 5, 12, 1, 54, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z' FROM task_packs WHERE name = '示例 · 楼道挑战';
INSERT INTO task_items (pack_id, title, description, score, persona, mode, min_floor, max_floor, enabled, sort_order, created_at, updated_at)
SELECT id, '无声上行', '（仅地狱模式）想象本层不许发出任何脚步声：踮脚走完，若落地一次就在心里记一笔“欠账”，到顶时一并汇报。', 7, 'any', 'hell', 6, 12, 1, 55, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z' FROM task_packs WHERE name = '示例 · 楼道挑战';

-- Extra tasks for 示例 · 卧室调教
INSERT INTO task_items (pack_id, title, description, score, persona, mode, min_floor, max_floor, enabled, sort_order, created_at, updated_at)
SELECT id, '点名应答', '想象督导喊你的称呼，立刻应答“在”，并用一句话说明自己此刻在做什么。', 4, 'any', 'any', 1, 5, 1, 60, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z' FROM task_packs WHERE name = '示例 · 卧室调教';
INSERT INTO task_items (pack_id, title, description, score, persona, mode, min_floor, max_floor, enabled, sort_order, created_at, updated_at)
SELECT id, '视线训练', '想象督导坐在对面：目光只许落在他的膝前地面，说出三件你此刻“不敢抬眼”的事。', 5, 'female', 'any', 2, 7, 1, 61, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z' FROM task_packs WHERE name = '示例 · 卧室调教';
INSERT INTO task_items (pack_id, title, description, score, persona, mode, min_floor, max_floor, enabled, sort_order, created_at, updated_at)
SELECT id, '单臂托举', '想象用单手把一本书托过头顶走完房间一圈，另一只手背在身后；书若落下就从头再来。', 4, 'male', 'any', 2, 6, 1, 62, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z' FROM task_packs WHERE name = '示例 · 卧室调教';
INSERT INTO task_items (pack_id, title, description, score, persona, mode, min_floor, max_floor, enabled, sort_order, created_at, updated_at)
SELECT id, '静默等待', '想象自己被命令“原地不许动”：保持姿势数到六十，期间只许眨眼与呼吸。', 5, 'any', 'hell', 3, 8, 1, 63, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z' FROM task_packs WHERE name = '示例 · 卧室调教';
INSERT INTO task_items (pack_id, title, description, score, persona, mode, min_floor, max_floor, enabled, sort_order, created_at, updated_at)
SELECT id, '床头汇报', '跪在床尾，把这一局里“做得最差的时刻”和“最想被奖励的时刻”各说一遍。', 6, 'any', 'any', 5, 10, 1, 64, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z' FROM task_packs WHERE name = '示例 · 卧室调教';
INSERT INTO task_items (pack_id, title, description, score, persona, mode, min_floor, max_floor, enabled, sort_order, created_at, updated_at)
SELECT id, '熄灯仪式', '想象只留一盏小夜灯：在暗处完成本层任务，灯灭之前不许抬头看窗外。', 7, 'any', 'hell', 7, 10, 1, 65, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z' FROM task_packs WHERE name = '示例 · 卧室调教';

-- 示例 · 浴室晨课
INSERT INTO task_items (pack_id, title, description, score, persona, mode, min_floor, max_floor, enabled, sort_order, created_at, updated_at)
SELECT id, '水温掌控', '想象把水温调到比自己习惯的更凉一点，站在水下数到十，告诉自己“清醒从皮肤开始”。', 4, 'any', 'any', 1, 4, 1, 1, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z' FROM task_packs WHERE name = '示例 · 浴室晨课';
INSERT INTO task_items (pack_id, title, description, score, persona, mode, min_floor, max_floor, enabled, sort_order, created_at, updated_at)
SELECT id, '水汽计数', '想象蒸汽在镜面凝结：用手指写下一个数字，每多写一笔就默念一遍今天的规矩。', 4, 'any', 'any', 1, 5, 1, 2, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z' FROM task_packs WHERE name = '示例 · 浴室晨课';
INSERT INTO task_items (pack_id, title, description, score, persona, mode, min_floor, max_floor, enabled, sort_order, created_at, updated_at)
SELECT id, '湿发垂落', '想象洗完后不立刻擦干，让湿发贴着脖颈站一分钟，像等待发令。', 5, 'female', 'any', 2, 6, 1, 3, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z' FROM task_packs WHERE name = '示例 · 浴室晨课';
INSERT INTO task_items (pack_id, title, description, score, persona, mode, min_floor, max_floor, enabled, sort_order, created_at, updated_at)
SELECT id, '毛巾规矩', '想象毛巾只许搭在指定位置：叠好、对齐、放回，动作完成前不许碰其他东西。', 4, 'male', 'any', 2, 5, 1, 4, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z' FROM task_packs WHERE name = '示例 · 浴室晨课';
INSERT INTO task_items (pack_id, title, description, score, persona, mode, min_floor, max_floor, enabled, sort_order, created_at, updated_at)
SELECT id, '镜前慢梳', '对着想象里的镜子慢慢梳头，每梳一下说一个“今天要记住的规矩”。', 5, 'any', 'any', 3, 7, 1, 5, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z' FROM task_packs WHERE name = '示例 · 浴室晨课';
INSERT INTO task_items (pack_id, title, description, score, persona, mode, min_floor, max_floor, enabled, sort_order, created_at, updated_at)
SELECT id, '冷水收尾', '想象最后用冷水冲一下脚踝，站在水声里说完一句“我准备好了”。', 5, 'any', 'any', 4, 8, 1, 6, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z' FROM task_packs WHERE name = '示例 · 浴室晨课';
INSERT INTO task_items (pack_id, title, description, score, persona, mode, min_floor, max_floor, enabled, sort_order, created_at, updated_at)
SELECT id, '水声口令', '想象花洒的水声是督导的提问：每数到三次水流变化，就开口回答一句内心独白。', 6, 'any', 'hell', 3, 8, 1, 7, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z' FROM task_packs WHERE name = '示例 · 浴室晨课';
INSERT INTO task_items (pack_id, title, description, score, persona, mode, min_floor, max_floor, enabled, sort_order, created_at, updated_at)
SELECT id, '雾镜签名', '（仅地狱模式）想象自己在雾镜上写下今天的称呼，写完后用指尖抹掉，再对镜自报一遍。', 6, 'any', 'hell', 4, 9, 1, 8, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z' FROM task_packs WHERE name = '示例 · 浴室晨课';
INSERT INTO task_items (pack_id, title, description, score, persona, mode, min_floor, max_floor, enabled, sort_order, created_at, updated_at)
SELECT id, '更衣顺序', '想象按固定顺序更衣：里到外、慢到快，每件都先展开再穿，不许跳步。', 6, 'female', 'any', 5, 9, 1, 9, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z' FROM task_packs WHERE name = '示例 · 浴室晨课';
INSERT INTO task_items (pack_id, title, description, score, persona, mode, min_floor, max_floor, enabled, sort_order, created_at, updated_at)
SELECT id, '皮带扣响', '想象系皮带的动作被放慢：扣好、拉紧、轻拍一下，像替督导完成一次检查。', 5, 'male', 'any', 5, 8, 1, 10, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z' FROM task_packs WHERE name = '示例 · 浴室晨课';
INSERT INTO task_items (pack_id, title, description, score, persona, mode, min_floor, max_floor, enabled, sort_order, created_at, updated_at)
SELECT id, '出浴自省', '走出想象里的浴室前，对着门框说出今天最想改掉的一个习惯。', 7, 'any', 'any', 6, 10, 1, 11, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z' FROM task_packs WHERE name = '示例 · 浴室晨课';
INSERT INTO task_items (pack_id, title, description, score, persona, mode, min_floor, max_floor, enabled, sort_order, created_at, updated_at)
SELECT id, '晨课结业', '想象自己站在浴室门口向督导复述今天的三条收获，每一条都换一种语气。', 8, 'any', 'any', 7, 10, 1, 12, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z' FROM task_packs WHERE name = '示例 · 浴室晨课';

-- 示例 · 宅邸夜巡
INSERT INTO task_items (pack_id, title, description, score, persona, mode, min_floor, max_floor, enabled, sort_order, created_at, updated_at)
SELECT id, '熄灯就位', '想象整栋宅邸的灯已关完，只剩你手里的光：在玄关站十秒，报出“夜巡开始”。', 4, 'any', 'any', 1, 4, 1, 1, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z' FROM task_packs WHERE name = '示例 · 宅邸夜巡';
INSERT INTO task_items (pack_id, title, description, score, persona, mode, min_floor, max_floor, enabled, sort_order, created_at, updated_at)
SELECT id, '一束光', '想象手电只照脚下两步远：在黑暗里巡过一段走廊，不照墙、不照镜。', 5, 'any', 'any', 1, 6, 1, 2, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z' FROM task_packs WHERE name = '示例 · 宅邸夜巡';
INSERT INTO task_items (pack_id, title, description, score, persona, mode, min_floor, max_floor, enabled, sort_order, created_at, updated_at)
SELECT id, '挂钟敲点', '想象大厅挂钟敲响：每响一声就立正一次，响完三声后向钟面鞠一个躬。', 5, 'any', 'any', 2, 7, 1, 3, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z' FROM task_packs WHERE name = '示例 · 宅邸夜巡';
INSERT INTO task_items (pack_id, title, description, score, persona, mode, min_floor, max_floor, enabled, sort_order, created_at, updated_at)
SELECT id, '门锁检查', '想象逐一检查门锁：每确认一扇，就说一句“已上锁”，语气一次比一次稳。', 4, 'male', 'any', 2, 6, 1, 4, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z' FROM task_packs WHERE name = '示例 · 宅邸夜巡';
INSERT INTO task_items (pack_id, title, description, score, persona, mode, min_floor, max_floor, enabled, sort_order, created_at, updated_at)
SELECT id, '长裙下摆', '想象夜巡时穿着及地长裙：每上一层楼都要先提起下摆再迈步，像被礼仪牵引。', 5, 'female', 'any', 3, 9, 1, 5, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z' FROM task_packs WHERE name = '示例 · 宅邸夜巡';
INSERT INTO task_items (pack_id, title, description, score, persona, mode, min_floor, max_floor, enabled, sort_order, created_at, updated_at)
SELECT id, '地毯边界', '想象走廊地毯与地板交界处有一条规矩线：过线前单膝触地一次，再继续巡夜。', 6, 'any', 'any', 4, 10, 1, 6, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z' FROM task_packs WHERE name = '示例 · 宅邸夜巡';
INSERT INTO task_items (pack_id, title, description, score, persona, mode, min_floor, max_floor, enabled, sort_order, created_at, updated_at)
SELECT id, '楼梯轻响', '（仅地狱模式）想象木质楼梯一踩就响：用脚尖探路走完本层，声响超过三次就退回重走。', 7, 'any', 'hell', 4, 11, 1, 7, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z' FROM task_packs WHERE name = '示例 · 宅邸夜巡';
INSERT INTO task_items (pack_id, title, description, score, persona, mode, min_floor, max_floor, enabled, sort_order, created_at, updated_at)
SELECT id, '窗帘不碰', '想象夜巡时窗帘一律不许碰：经过每扇窗前把视线放低，心里默念“不看外面”。', 5, 'any', 'any', 3, 8, 1, 8, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z' FROM task_packs WHERE name = '示例 · 宅邸夜巡';
INSERT INTO task_items (pack_id, title, description, score, persona, mode, min_floor, max_floor, enabled, sort_order, created_at, updated_at)
SELECT id, '书房留灯', '想象书房留着一盏台灯：进去后只准看灯光照到的那一角，把桌面整理到角线对齐。', 6, 'male', 'hell', 5, 10, 1, 9, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z' FROM task_packs WHERE name = '示例 · 宅邸夜巡';
INSERT INTO task_items (pack_id, title, description, score, persona, mode, min_floor, max_floor, enabled, sort_order, created_at, updated_at)
SELECT id, '梳妆镜前', '想象夜巡经过梳妆镜：不许开大灯，只用镜面反光看自己一眼，说“巡夜人，报数”。', 6, 'female', 'hell', 5, 10, 1, 10, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z' FROM task_packs WHERE name = '示例 · 宅邸夜巡';
INSERT INTO task_items (pack_id, title, description, score, persona, mode, min_floor, max_floor, enabled, sort_order, created_at, updated_at)
SELECT id, '巡夜收尾', '想象在顶楼尽头站定，把手电关掉，在黑暗里说出今晚“最怕的一处”和“最守好的一处”。', 8, 'any', 'any', 8, 12, 1, 11, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z' FROM task_packs WHERE name = '示例 · 宅邸夜巡';
INSERT INTO task_items (pack_id, title, description, score, persona, mode, min_floor, max_floor, enabled, sort_order, created_at, updated_at)
SELECT id, '天亮之前', '想象黎明前最后一段：每走一步数一声，数到整十就低声报一次“宅邸安好”。', 7, 'any', 'hell', 6, 12, 1, 12, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z' FROM task_packs WHERE name = '示例 · 宅邸夜巡';

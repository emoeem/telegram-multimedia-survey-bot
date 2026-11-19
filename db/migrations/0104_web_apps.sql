-- 0104: web_apps 应用中心「网页导航」数据表（P0 加固批次 M2）。
--
-- 动机：M1 已落 /app 应用中心屏（admin/src/survey/AppCenterScreen.tsx），
-- 网页导航区消费 GET /api/web-apps——M1 的 web-apps.ts:4-8 明确把数据面
-- 留给 M2：接口 404/坏形状一律收敛为空态。M3/M4 也要消费同一份数据
-- （M4 的 miniapp 打开方式与域名白名单），所以本迁移把 open_mode 与
-- allowed_domains 一次建齐，M4 只收口语义不再动表。
--
-- 管理面：M2 同批落地 admin CRUD/排序/启停/审计（src/http/admin/web-app.ts，
-- 复用 categories.ts 的 writeAudit 先例）；URL 必须是合法 https://（校验在
-- HTTP 层，M4 再收口 allowed_domains 白名单语义）。
--
-- 形态参照 task_packs（0045）：小表、运营手工维护、无级联子表——所以
-- 没有软删列，删除走硬删（DELETE），审计日志保留操作痕迹（helpers.ts
-- writeAudit 的职责，不靠墓碑）。
CREATE TABLE web_apps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  -- 必须 https://（HTTP 层强校验，拒绝 http:// 与任意非法串）。
  url TEXT NOT NULL,
  icon_url TEXT,
  -- 运营自由分类（展示用分组标签，如「工具」「资源」），可空。
  category TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  -- 打开方式：'miniapp'=小程序/WebView 内嵌（M4 按白名单域校验）；
  -- 'browser'=外跳浏览器。默认外跳，最保守。
  open_mode TEXT NOT NULL DEFAULT 'browser' CHECK(open_mode IN ('miniapp','browser')),
  -- M4 打开白名单：JSON 数组字符串（小写主机名列表，如 ["a.example.com"]）。
  -- NULL = 未配置。打开规则本就公开（随只读 API 下发给玩家端）。
  allowed_domains TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 玩家侧热路径：GET /api/web-apps 的默认过滤与排序（enabled + sort_order, id）。
-- 启用行才入索引（局部索引，同 0101 idx_task_packs_active_list 的先例）。
CREATE INDEX idx_web_apps_active_list
  ON web_apps(enabled, sort_order, id) WHERE enabled = 1;

-- 分类视图：管理端按 category 分组查看 / 玩家侧可能的分组展示。
CREATE INDEX idx_web_apps_category_sort
  ON web_apps(category, sort_order, id);

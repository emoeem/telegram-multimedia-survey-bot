# 互动场景题（scene · 图片热点）

> 2026-10-27 落地。让问卷从「一题一答」升级为「可探索的场景」：一张场景图上放若干可点击区域，
> 点开看内层图片、或切换到子场景；探索过的热点作为答案数据落库。
> 交互原型：`/home/emo/code/hotspot-scene-demo`（纯前端参照实现，保留作参考）。

## 1. 能力概览

- **新题型 `scene`**：可作答题型（不是 note），参与者在场景图上点击热点即被记录。
- **答案形状**：`json_value = {"kind":"scene","visited":[hotspotId,…]}`——与 matrix 的
  kind-tagged JSON 同款；导出时转换为热点 label 串联（多场景带场景名前缀）。
- **探索即落库**：点击热点当刻答案入保存队列（与文本输入「翻题才存」不同——探索动作本身
  就是要记录的数据，关页/断网不丢已看过的内容）。重复入队是幂等 upsert，无害。
- **子场景**：热点 `action.kind="scene"` 可跳到配置内的另一个场景，前端内返回；visited
  跨场景累计。
- **必答语义**：`required=true` 时至少探索一处热点才能进入下一题。
- **无障碍**：热点是真实 `<button>`（键盘 Tab/Enter、aria-label）；弹层有焦点陷阱
  （`focus-trap.ts`）+ Escape；`prefers-reduced-motion` 关闭动画；axe 门禁在
  `qa/visual/hotspot-scene.spec.ts` 内实测通过。
- **主题自适应**：选框/弹层配色全部走 `--survey-*` 变量，自动适配 foxgold/dark/light。
- Bot 向导不提供创建入口（同 note 的先例）；Bot 填卷本就走 `/s/:id` 网页链接，无适配成本。

## 2. 配置格式

配置存 `survey_questions.settings_json`（`questionView` 原样透传给前端，零投影改动）：

```jsonc
{
  "scene": {
    "version": 1,
    "start": "room",
    "scenes": {
      "room": {
        "id": "room", // 必须匹配 ^[a-z0-9][a-z0-9_-]{0,31}$
        "title": "雨夜书房",
        "intro": "点击画面里发亮的区域。",
        "image": "/api/survey/media/123", // 场景底图
        "width": 1600,
        "height": 1000, // 原始像素，仅用于 aspect-ratio
        "alt": "全景插画替代文本",
        "hotspots": [
          {
            "id": "window", // 全局唯一（跨场景也不能重复）
            "x": 0.05,
            "y": 0.08,
            "w": 0.31,
            "h": 0.58, // 0..1 归一化坐标
            "label": "窗外",
            "meta": "01", // 选框角标（可选）
            "action": {
              "kind": "image",
              "src": "/api/survey/media/124",
              "title": "窗外",
              "caption": "弹层正文（可选）",
              "note": "弹层引文（可选）",
            },
          },
          {
            "id": "shelf",
            "x": 0.835,
            "y": 0.08,
            "w": 0.15,
            "h": 0.5,
            "label": "书架",
            "action": { "kind": "scene", "sceneId": "shelf" },
          },
        ],
      },
    },
  },
}
```

硬约束（`src/survey/hotspot.ts` 严格校验，导入期与运行时共用）：

- 坐标 0..1、矩形不越界；热点 id / 场景 id 满足 `[a-z0-9][a-z0-9_-]{0,31}`；
- 热点 id **跨场景全局唯一**（答案是一份扁平 visited 列表）；
- `sceneId`/`start` 必须引用配置内存在的场景；
- ≤12 场景、每场景 ≤24 热点；URL 白名单同主题（`data:image/`、`https://`、`/` 相对路径）；
  导入校验额外放行 `kv://` 占位（脚本落库前替换）；
- 校验失败 → 导入报错（validator）/ 前端回退为提示文案（不会白屏）。

## 3. 媒体：为什么必须挂 question_media

场景底图和全部内层图都要挂到该题的 `question_media`（声明顺序即 sort_order）：

- 媒体端点 `src/http/survey/media.ts` 的公开性检查第一路 UNION 扫 `question_media`——
  问卷 once-published 后素材自动公开（`/api/survey/media/<id>` 裸 `<img>` 可用）；
- 前端 `question.media` 自带 `url + alt`，`HotspotScene` 按 URL 匹配取 alt；
- ⚠️ 只有 `surveys.settings_json` 和 `question_media`/`option_media`/封面在 linkage
  白名单里；**写在题目 settings_json 里的 URL 不命中豁免**（第四路 instr 只扫问卷级），
  所以不要把图片只写进配置。

## 4. 内容管线（批量导入 / 首次交付）

```
scripts/hotspot/
├── hotspot-survey.json        # 声明：问卷 + scene 配置（kv:// 占位）+ mediaMeta（尺寸/alt）
├── import_hotspot_survey.py   # 复刻 galgame importer：KV 上传 → draft 建卷 →
│                              # settings_json 回填 → question_media → 发布+快照 → verify()
└── assets/                    # 素材（8 张程序化生成的 WebP，约 190KB）
```

```bash
python3 scripts/hotspot/import_hotspot_survey.py            # dry-run：SQL 预览 + 媒体清点
python3 scripts/hotspot/import_hotspot_survey.py --apply    # 远程 KV + D1 + 发布 + verify
```

- 脚本对 Cloudflare API 的偶发 `fetch failed` 做了有界重试（并修复了 wrangler `--json`
  把错误打在 stdout、wenai `run()` 只回显 stderr 的问题——仅在本脚本内替换，不改共享文件）。
- `verify()` 用独立 SQL 复核：问卷已发布、settings_json 与定义逐字段一致、
  question_media 挂载完整、媒体 alt/尺寸/大小齐备。
- 同名问卷已存在（含回收站）会拒绝重导——先删再导。
- `surveys.version+1 + updated_at` 使定义缓存自动失效；**无需 bump
  `SURVEY_DEFINITION_CACHE_VERSION`**（questionView 的输出形状没变）。

## 5. 更新已有场景内容

参照 `scripts/galgame/update_galgame_survey.py` 的原地更新模式（UPDATE settings_json +
version+1 + 快照 + verify）。第一次需要时再写 `scripts/hotspot/update_hotspot_survey.py`，
注意 collect_media_refs 要遍历全部被引用素材（galgame 交付报告 C-3 的教训：校验器与被
校验对象不能共享同一把漏尺）。

## 6. 编辑器（admin Web）

场景题走**独立路由** `/admin/surveys/:id/scene/:qid`，不塞进 builder：

- 原因：`useSurveyEditor` 的 `EditableQuestion` 只保留 columns/speaker，`diffOps` 只发
  `{columns}`，undo 会用旧 settings 覆盖 `settings.scene`。
- 画布：底图上拖拽新建热点、拖动移动、8 向角柄缩放、方向键微调（Shift ×4）、
  Delete 删除；`touch-action:none` + Pointer Events，坐标仍存归一化 0..1。
- 检查器：热点（名称/编号/图片或 scene 跳转/弹层文案）、场景（标题/引导语/底图/alt/
  设起始/删除保护）、题目（标题/描述/必答）。
- 保存：`PATCH /api/admin/surveys/:id/questions/:qid`，body 带 `settings.scene` 与
  `baseUpdatedAt`；后端白名单早已放行 scene（`parseHotspotScene` 消毒后落库），409 时
  确认后重新加载服务端版本。
- 新建：builder 的「添加互动场景 / 类型选择器」先 `POST /questions` 建空 scene 题，
  再跳到编辑器由 PATCH 写配置（`insertQuestionWithOptions` 只持久化 matrix settings）。
- 媒体：只列已挂 `question_media` 的图片，上传走既有 `POST .../media`。显示用
  `/api/admin/media/<id>/image`；写进配置一律 `/api/survey/media/<id>`；预览前用
  `transformConfigForPreview` 映射回 admin URL。
- 只读：`survey.editable=false`（非草稿 / 有答卷 / 无权限）时禁用保存、拖拽与上传，
  保留预览，banner 说明具体原因。
- scene 题仍**不在** `EDITABLE_TYPES`——避免 builder 的类型切换/undo/diffOps 清掉配置；
  卡片上的「编辑场景」按钮就是入口。
- 样式：`admin/src/index.css` 末尾 `.scene-editor-*` / `.scene-canvas-*` / `.hotspot-intro`。

## 7. 测试与验证

| 层   | 文件                                           | 覆盖                                                                                                                                      |
| ---- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 单测 | `tests/unit/hotspot-survey.test.ts`            | 校验器 12 用例（拒绝矩阵/白名单/占位符/护栏）+ 定义文件结构断言                                                                           |
| 单测 | `tests/unit/http/survey-answers-scene.test.ts` | sqlite-d1 真实 schema 上：合法 visited 落库、失效 id 丢弃、空 visited 清答案、形状 400、配置缺失 400、`isWebAnswerPresent`                |
| E2E  | `qa/visual/hotspot-scene.spec.ts`              | route-mock 定义：点击热点→弹层→payload `{kind:"scene",visited}`、子场景往返累计、必答门禁、提交；内含 axe 扫描                            |
| E2E  | `qa/visual/scene-editor.spec.ts`               | 编辑器：拖拽新建→选图→保存 payload、移动/缩放/方向键、加场景/设起始/scene 动作、上传刷新 `baseUpdatedAt`、只读、409、axe、1440/390 无溢出 |
| 线上 | 脚本 `verify()`                                | 对生产 D1 独立复核                                                                                                                        |

## 8. 边界与后续

- 未发布草稿的媒体 404 是平台既有行为（发布后自动放开），预览配置需 admin session。
- 形状目前只有矩形；不规则物体需要 SVG 多边形/clip-path 时再扩展校验器与渲染。
- 视频热点：同一套坐标 + `start/end` 时间窗（`timeupdate` 显隐），未实现。
- 「每人一份不同场景」的个性化、热点点击埋点、离线单文件导出（demo 里已验证的三条
  导出路径）都还没接——需要时从 `hotspot-scene-demo/app.js` 移植。
- Web 拖拽编辑器已完成（见 §6）；底图仍以题目媒体为准，不支持在编辑器里直接裁剪。

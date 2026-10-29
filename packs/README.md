# 小游戏扩展包（quest）

扩展包是一个 ZIP，导入后**不改代码**即可生成一个可玩的剧情小游戏（挂在 `/trial` 的任务包列表里，也可在问卷里建 `game` 题引用）。

```
quest-pack.zip
├── manifest.json   包元信息（必填）
├── quest.json      游戏内容（必填，格式见下）
└── assets/         可选图片（≤20 张、单张 ≤2MB，png/jpg/jpeg/webp/gif）
```

## manifest.json

```jsonc
{
  "formatVersion": 1, // 目前固定为 1
  "id": "example-lost-study", // 小写字母/数字开头，≤32 位，[a-z0-9_-]
  "title": "示例 · 迷失书房", // ≤60 字，任务包显示名
  "author": "survey-platform", // ≤40 字
  "description": "一句话说明", // ≤300 字
  "adult": false, // true = 答题端先弹 18+ 确认
}
```

## quest.json

权威格式定义与护栏：`src/game-plugin/plugins/quest/content.ts`（节点 ≤60 / 道具 ≤24 / 每节点选项 ≤6 / 单段文本 ≤600 字）。

```jsonc
{
  "version": 1,
  "title": "迷失书房",
  "intro": "开场引言（≤200 字）",
  "start": "wake", // 起始节点 id
  "grades": { "s": 85, "a": 65, "b": 45 }, // 可选，评级线（百分比）
  "items": [
    // 道具（可选）
    { "id": "clue-photo", "name": "烧掉一角的照片", "icon": "🖼️", "kind": "clue", "desc": "线索道具：结局屏列出" },
    {
      "id": "token-star",
      "name": "黄铜星星",
      "icon": "⭐",
      "kind": "collectible",
      "desc": "收集品：+2 分/件，计入收集统计",
    },
    { "id": "key-study", "name": "书房钥匙", "icon": "🗝️", "kind": "key", "desc": "分支钥匙：门控选项" },
  ],
  "nodes": [
    {
      "id": "wake",
      "chapter": "序章", // 可选，名牌
      "speaker": "旁白", // 可选
      "text": "叙事正文（≤600 字）",
      "image": "asset:cover.png", // 可选；asset: 引用 assets/ 里的文件，导入时替换为站内 URL
      "choices": [
        { "text": "检查书桌", "goto": "desk", "score": 2 },
        { "text": "撬抽屉", "goto": "locked", "requireItem": "key-study" }, // 无钥匙时锁定
        { "text": "捡起星星", "goto": "shelf", "give": ["token-star"] },
      ],
    },
    { "id": "ending", "text": "……", "endingTitle": "关灯的人", "endingNote": "评语（可选）" },
  ],
}
```

规则（导入器强校验）：

- 所有 id 匹配 `^[a-z0-9][a-z0-9_-]{0,31}$` 且全局唯一；`goto` / `requireItem` / `give` 必须指向存在的节点/道具；
- 没有选项的节点是**结局节点**；至少要有一个结局；从 `start` 出发建议全图可达；
- 选项分值 0–20；同一选择**首次经过**才计分/发放道具（回路刷不了分）；
- 评级 = 得分 ÷（全部选项分值 + 收集品件数 × 2）。

## 导入

管理端 `/admin` → 挑战任务 → 「导入扩展包」，上传 ZIP 即生成任务包（审计记录 `task_pack.import`）。

手写示例包（每个都过 `tests/unit/game-plugin/packs.test.ts` 的整包解析与引擎剧本回归）：

- [`quest-example-lost-study/`](quest-example-lost-study/) —— 三类道具与四结局，无图片素材（assets 整体可选）；
- [`quest-example-midnight-station/`](quest-example-midnight-station/) —— 悬疑向：分支钥匙「名牌」解锁隐藏真结局，含 `asset:` 封面引用（多结局分支道具样本）；
- [`quest-example-old-house-cat/`](quest-example-old-house-cat/) —— 温馨向：钥匙在井房取得、开玄关阁楼门，依赖跨场景回溯；collectible 也能当 `requireItem` 门控（跨场景钥匙样本）。

## 打包

```bash
cd packs/quest-example-lost-study
zip -r ../quest-example-lost-study.zip manifest.json quest.json assets
```

# 《雨夜书房 · 雨停之前》作品包 · 导览与交付说明

> 交付快照：2026-11-14（补齐更新）。**结构与文案齐备；插画 9/9 已就位；氛围短片已生成（12s）**。
> 本文档是作品包导览，也是最终交付主文档；状态细节见 §6「缺口」（已清空，留档为「作画与合成方法」）。

---

## 1. 作品是什么

**《雨夜书房 · 雨停之前》是生产问卷 [/s/9136](https://emoe.eu.cc/s/9136)《雨夜书房 · 互动场景》的内容补全包**：
把 2026-10-27 上线的雏形（room + shelf 两场景、7 热点、8 张图，见
`docs/guides/HOTSPOT_EDITOR_HANDOVER.md` §2）重制为完整叙事版——

| 维度 | 数量        | 明细                                                                                                                                                                                      |
| ---- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 问卷 | 1 页 · 2 题 | 页 p1「雨夜书房」；q-scene（scene 题型，必答）+ q-farewell（long_text 选填，≤500 字）；`anonymous: 0`（平台注册墙为既有产品决策）                                                         |
| 场景 | 5 个        | room 书房全景（起始）→ window 窗前 / melody 唱机旁 → shelf 书架深处 → closet 暗格·终章（≤12 上限）                                                                                        |
| 热点 | 16 个       | image 8 + scene 跳转 8；每场景 4 / 3 / 3 / 3 / 3（≤24 上限）；id 跨场景全局唯一，`meta` 01–16 按叙事顺序编号                                                                              |
| 资产 | 9 张        | panorama 1600×1000（五个场景共用底图，兼作短片首帧规划）+ 内层图 8（1200×900 横 ×4、1200×1600 竖 ×4）；`kv://` 占位 9 个唯一键、22 处引用（question.media 9 + 场景底图 5 + image 动作 8） |
| 短片 | 1（12s）    | `video/rainy-study.mp4`（1280×800 · 30fps · H.264+AAC 雨声）：panorama 慢推镜 + 雨丝帧叠加 + 暗角渐入出；生成方式见 §6                                                                    |

核心概念是「**一幅画，四个驻点**」：场景切换不换画，换的是驻足的位置（标题 + 引导语 +
热点区域随之改变），全景画里预埋全部可点对象（雨窗、信、唱机、褪色的书、透光的细缝），
热点归一化坐标与画面对象对齐。四条线索（雨夜 / 旧信 / 旋律 / 秘密）与起承转合的完整
叙事说明见 `study-room/copy.md` §0；收束热点是 `final-letter`（meta 16，全局最后一个）。

## 2. 目录结构

```
study-room/
├── README.md                      # 本文档（导览 + 上线路径 + 缺口）
├── copy.md                        # 文案定稿：四条线索/叙事弧、逐场景热点文案、alt 总表、数量核对
├── asset-plan.json                # 插画清单：9 条 {id, kind, path, prompt, alt}，prompt 含统一风格前缀
├── scenes/
│   ├── hotspot-survey.json        # 可导入问卷定义：survey（kv:// 占位）+ mediaMeta（尺寸/alt）——本包核心
│   └── hotspot-survey.resolved.json  # （占位替换后由 apply_scenes.py --resolve 生成，当前不存在）
│   └── hotspot-survey.pre-apply.json # （--apply 前自动备份，当前不存在）
├── art/                           # 插画成品：9 张 PNG（与 asset-plan.json 一一对应，§6 说明作画方法）
├── art-svg/                       # 插画源稿：9 幅手作 SVG（成套美术系统，可改后重新栅格化）
├── tools/
│   ├── render-art.mjs             # SVG → PNG 栅格化（Playwright Chromium，pnpm exec node 运行）
│   └── gen-rain-frames.mjs        # 雨丝帧序列生成器（视频叠加层，种子化伪随机）
├── video/
│   └── rainy-study.mp4            # 氛围短片成品（12s，见 §6）
├── video-frames/                  # 雨丝帧序列（90 帧 @1600×1000，合成短片用，可删）
├── apply_scenes.py                # 落库脚本（草案）：校验 → 解析占位 → D1 原地更新 → verify
└── media-map.json                 # （素材入库后手工/脚本生成：{"study-room/<id>": media_id}，当前不存在）
```

参照文件（包外，本包交付内容的依据）：

- `docs/guides/HOTSPOT_SCENES.md` —— 场景题配置格式与硬约束（§2）、媒体必须挂
  question_media 的原因（§3）、内容管线与原地更新模式（§4/§5）；
- `docs/guides/HOTSPOT_EDITOR_HANDOVER.md` —— 生产 9136 状态与「已发布问卷只读」规则；
- `src/survey/hotspot.ts` —— 前后端共用严格校验器（本包数量已在护栏内，见 §3）；
- `scripts/galgame/apply_scenes.py` / `scripts/hotspot/import_hotspot_survey.py` /
  `scripts/wenai/import_wenai_survey.py` —— `study-room/apply_scenes.py` 的结构蓝本。

## 3. 配置与约定速览

- **键名换算**（`copy.md` §0.3）：`kv://study-room/<id>`（占位）↔ asset-plan 的 `id` ↔
  `study-room/art/<id>.png`（文件）。`mediaMeta` 用全键 `study-room/<id>`。
- **URL 白名单**（`docs/guides/HOTSPOT_SCENES.md` §2）：配置里只认 `data:image/`、
  `https://`、`/` 相对路径；`kv://` 仅导入校验期放行，**落库前必须替换**——这是本包
  「占位 → 素材 id」两步走的原因。
- **校验器护栏**（`src/survey/hotspot.ts:17-19`）：场景 ≤12（本包 5 ✓）、每场景热点 ≤24
  （本包最多 4 ✓）、id 正则 `^[a-z0-9][a-z0-9_-]{0,31}$` ✓；坐标 0..1、矩形不越界、
  `sceneId`/`start` 引用完整性由校验器在导入期把关。
- **数量核对**已在 `copy.md` §8 声明并由本包脚本复核：16 热点、9 占位 ↔ 9 清单条目 ↔
  9 mediaMeta 条目（`apply_scenes.py` dry-run 实测「结构对齐」✓，见 §7）。

## 4. 上线路径（三步）

### ① 素材入库：art/*.png → 管理端「素材库」→ `/api/survey/media/:id`

插画生成后（见 §6 待办），在管理端素材库逐张上传 `study-room/art/` 下的 9 个 PNG
（上传走既有 `POST .../media`，编辑器媒体列表只列已挂 question_media 的图，见
`docs/guides/HOTSPOT_SCENES.md` §6）。把返回的 `/api/survey/media/<id>` 中的 `<id>`
抄进 `study-room/media-map.json`：

```json
{ "study-room/panorama": 901, "study-room/letter-desk": 902, "…": 0 }
```

脚本路径的替代：`python3 study-room/apply_scenes.py --use-wenai …` 会复用
`scripts/hotspot/import_hotspot_survey.py` 的 KV 上传管线自动上传 `art/*.png` 并建
映射（KV storage_key 前缀 `media:survey-studyroom`，与生产 858… 那批不混用）。

### ② 替换占位：`kv://study-room/<id>` → `/api/survey/media/<id>`

```bash
python3 study-room/apply_scenes.py --resolve --media-map study-room/media-map.json
```

脚本深遍历 `question.media[].url`、场景底图 `image`、热点 `action.src`，替换后写出
`scenes/hotspot-survey.resolved.json`（管理端 JSON 导入用）。替换逻辑已实测：22 处
引用全换、9 个唯一 id、无 `kv://` 残留（§7）。

### ③ 导入生效（二选一）

- **③-a 管理端导入**：编辑器 JSON 导入 `scenes/hotspot-survey.resolved.json`
  （survey 结构同 `scripts/hotspot/hotspot-survey.json`）。注意生产 **9136 已发布、
  管理端只读**（`loadWritableSurvey` 要求草稿且 0 答卷，见
  `docs/guides/HOTSPOT_EDITOR_HANDOVER.md` §2）——请先在后台把 9136 复制为草稿再导入，
  草稿验收后发布。
- **③-b 脚本落库**（原地更新模式，参照 `scripts/galgame/apply_scenes.py` +
  `docs/guides/HOTSPOT_SCENES.md` §5）：

  ```bash
  python3 study-room/apply_scenes.py --apply --media-map study-room/media-map.json --survey-id 9136
  ```

  执行内容：`UPDATE survey_questions.settings_json`（scene 题）→ 重建该题
  `question_media`（先删后挂，声明顺序即 sort_order）→ `media_assets` 回填
  alt/width/height → `surveys.version+1 + updated_at`（定义缓存键含两者，旧缓存自动
  失效，无需 bump `SURVEY_DEFINITION_CACHE_VERSION`）→ `survey_versions` 快照 →
  独立 SQL `verify()`。脚本**不翻转发布状态**；目标草稿副本时，发布在管理端完成。
  本机未对远程 KV/D1 执行过（工作区约束禁止生产写操作），动生产前先对草稿演练。

## 5. 质量与无障碍

- **alt 三层齐备且逐字一致**：场景 `alt`（5 个驻点各一条）、内层图 `alt`（8 张，挂在
  `question.media[].alt` 与热点 `action` 弹层）、`mediaMeta.alt`（落库回填
  `media_assets.alt_text`，导出与前端 alt 都从这里读）——三处文本与 `copy.md` §7 总表
  逐字对齐。前端 `HotspotScene` 按 URL 匹配取 alt（`docs/guides/HOTSPOT_SCENES.md` §3）。
- **键盘可达**：热点是真实 `<button>`（Tab/Enter、aria-label）；弹层有焦点陷阱
  （`focus-trap.ts`）+ Escape 关闭；`prefers-reduced-motion` 下关闭动画。axe 门禁在
  `qa/visual/hotspot-scene.spec.ts` 与 `qa/visual/scene-editor.spec.ts` 内实测通过
  （`docs/guides/HOTSPOT_SCENES.md` §1/§7）。
- **主题变量**：热点选框与弹层配色全部走 `--survey-*` 变量，自动适配
  foxgold/dark/light 三套主题；本包不引入任何硬编码色值。
- **必答语义与落库**：`required=true` 时至少探索一处热点才能进入下一题；探索即落库
  （点击当刻入保存队列，关页不丢），答案形状 `{"kind":"scene","visited":[hotspotId,…]}`，
  导出时转热点 label 串联。`meta` 01–16 是给参与者的隐式路径提示，探索顺序不限。
- **画面约定**：全部插画无文字（信、票、谱在画中只是模糊墨线/墨点质感），prompt 统一
  前缀已约束（`asset-plan.json`）。

## 6. 作画与合成方法（原「缺口」节，2026-11-14 已清空）

原两项缺口（插画 0/9、短片未生成）均已补齐。过程与方法的如实记录：

- **生图 / 生视频 API 不可用**：批一工作流的插画线 0/9 与本会话直调均为同一账号级错误
  （image/video 生成 MCP 返回 code 3706「需关联 Z.ai 账号并绑定手机号」），非代码或提示词问题。
- **替代方法（确定性，非 AI 生成）**：
  1. **插画**：按 `asset-plan.json` 的构图描述，手工创作 9 幅 SVG（成套美术系统：深蓝夜色
     `#0a1424-#1a3050` × 琥珀暖光 `#f5d6a8-#b8865a`，共享雨丝/噪点/柔光/暗角 defs；画面无文字、
     无人物正面，与原 prompt 的叙事约束一致）→ `tools/render-art.mjs` 用 Playwright Chromium
     以 1:1 像素栅格化为 PNG（尺寸与 mediaMeta 一致）。源稿在 `art-svg/`，改后可重渲染。
  2. **短片**：`tools/gen-rain-frames.mjs` 生成 90 帧雨丝叠加层（种子化伪随机，1600×1000 带透明通道）
     → ffmpeg 合成：panorama 慢推镜（zoompan ≤1.16）+ 雨丝 overlay + 暗角 + 1.2s 渐入/渐出
     - 程序化雨声（粉噪 → 带通 150–900Hz）。成品 `video/rainy-study.mp4`（12s · 1280×800 · 30fps）。
- 与 AI 生成相比的差异（如实）：这套插画是「扁平叙事插画风」而非水彩笔触；但九张共享同一
  美术系统，风格一致性反而是优势。若后续想要水彩质感，`asset-plan.json` 的 prompt 仍可直接
  用于任何生图管线，替换 `art/` 后按 §4 重走（mediaMeta 尺寸不变）。

| #   | 事项                     | 状态                                                                                                                         | 影响                                                                          |
| --- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | ~~插画 0/9~~             | ✅ 9/9 就位（`art/` 与 asset-plan 一一对应）                                                                                 | 上线三步解锁：① 可入库，② 可替换映射                                          |
| 2   | ~~短片未生成~~           | ✅ `video/rainy-study.mp4`（12s）                                                                                            | 「作品包含短片」成立                                                          |
| 3   | `apply_scenes.py` 为草案 | 本机完成 `py_compile` + dry-run 门禁验证 + 占位替换逻辑实测（§7）；**未对远程 KV/D1 端到端跑通**（工作区约束禁止生产写操作） | ③-b 首次使用前，先对草稿副本演练 `--apply` 并确认 `verify()` 全绿             |
| 4   | `media-map.json` 不存在  | 依赖素材入库后生成（插画已就位，随时可做）                                                                                   | ③-a 需要手工把 resolved 稿喂给编辑器；③-b 需要 `--media-map` 或 `--use-wenai` |

上线前待办（按序）：素材入库 → media-map → `--resolve` + 编辑器草稿验收 →（可选）`--apply`
落库 + verify 全绿。

## 7. 复现

```bash
# ① 插画清单核对（2026-11-14 补齐后：9/9 就位）
ls -A study-room/art/ | wc -l          # → 9
for f in panorama letter-desk rain-street glass-rain record-spinning \
         unmailed-letter ticket-book hidden-open final-letter; do
  [ -f "study-room/art/$f.png" ] && echo "OK  $f" || echo "MISS $f"
done                                    # → OK ×9

# ①b 插画重渲染（改 art-svg/ 源稿后）
pnpm exec node study-room/tools/render-art.mjs

# ①c 短片重合成（改 panorama 或帧参数后）
pnpm exec node study-room/tools/gen-rain-frames.mjs 90
ffmpeg -y -i study-room/art/panorama.png -stream_loop -1 -framerate 30 -t 12 \
  -i study-room/video-frames/rain%03d.png \
  -f lavfi -t 12 -i "anoisesrc=color=pink:amplitude=0.4:seed=2026" \
  -filter_complex "[0:v]zoompan=z='min(1+0.00055*on,1.16)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=360:s=1280x800:fps=30[bg];[bg][1:v]overlay=0:0:shortest=1[comp];[comp]vignette=PI/4.5,fade=t=in:st=0:d=1.2,fade=t=out:st=10.6:d=1.4,format=yuv420p[v];[2:a]lowpass=f=900,highpass=f=150,volume=0.20,afade=t=in:st=0:d=1.5,afade=t=out:st=10.3:d=1.7[a]" \
  -map "[v]" -map "[a]" -c:v libx264 -preset medium -crf 20 -c:a aac -b:a 96k \
  -movflags +faststart study-room/video/rainy-study.mp4
# → duration=12.000000

# ② 落库脚本语法 + 校验门禁
python3 -m py_compile study-room/apply_scenes.py   # → 无输出（通过）
python3 study-room/apply_scenes.py                 # 预期回显见下

# ③ 占位替换逻辑（纯内存验证，不触库）
python3 -I - <<'EOF'
import importlib.util, json, re
spec = importlib.util.spec_from_file_location("m", "study-room/apply_scenes.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
d = json.loads(open("study-room/scenes/hotspot-survey.json").read())
refs = m.collect_media_refs(d)
fake = {r: 900 + i for i, r in enumerate(refs)}          # 假映射
blob = json.dumps(m.resolve_refs(d["survey"], fake))
assert "kv://" not in blob
print(len(re.findall(r"/api/survey/media/\d+", blob)), "处替换，", len(set(re.findall(r"/api/survey/media/\d+", blob))), "个唯一 id")
EOF
# → 22 处替换， 9 个唯一 id
```

② 的实际回显（2026-11-13，缺图门禁按设计拦截）：

```
🎯 目标环境：生产（默认）——确认这是你想要的，或加 --config wrangler.staging.toml
问卷《雨夜书房 · 雨停之前》：2 题，5 场景，16 热点，9 个唯一媒体占位
结构对齐：配置 9 个占位 ↔ 清单 9 条 ↔ mediaMeta 9 条
✗ art/ 缺 9/9 张插画: ['panorama', 'letter-desk', 'rain-street', 'glass-rain', 'record-spinning', 'unmailed-letter', 'ticket-book', 'hidden-open', 'final-letter']
  先按 study-room/asset-plan.json 的 prompt 生成后再跑（见 README「缺口」节）。
```

插画补齐后，② 的预期回显变为 `插画 9/9 就位（磁盘像素与 mediaMeta 一致）`，随后按
§4 的 ①→③ 顺序走完上线路径。

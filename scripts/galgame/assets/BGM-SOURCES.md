# BGM 来源、许可与处理记录

**结论先行**：`scripts/galgame/assets/bgm-*.mp3` 是 **8 首来自「魔王魂」（maou.audio）的曲目**，
许可为 **CC BY 4.0**（作者自订的自由利用条款，实质等同），**要求署明出处**。
本文件逐曲记录曲名、作者、许可原文、授权页、直接下载地址、原始参数与处理后参数。
8 首**已上传到生产 KV 并在 `/s/118` 生效**（见下方「五、线上状态」）。

> 与早期版本的关系：本文件曾记录过一批 OpenGameArt 的 CC0 候选曲
> （cynicmusic / symphony / Yoiyami，原始文件在 `/tmp/cc0/`）。最终交付采用的是
> **魔王魂这 8 首**，理由是 8 首同源同许可、风格可分、覆盖 7 个页面 + 16 个节点级转折，
> 而 CC0 候选只覆盖 6 个曲名、且会让同一份问卷混用两套许可。候选的评估结论保留在
> 「六、评估过但未采用的音源」，不是把它们说成已交付内容。

## 一、许可（逐字核实，非按网站名推断）

- 授权条款页：<https://maou.audio/rule/>（已实际抓取并阅读）
- 许可类型：**CC BY 4.0** 或作者等价的自由利用条款
- 作曲者：**森田交一（Koichi Morita）**
- 署名要求：**著作表记必要** → 本作统一署名 `魔王魂（maou.audio）／森田交一`
- 明确允许：个人 / 商用 / 任何题材，**作为游戏等作品的 BGM 使用明确允许**
- 明确禁止：把曲目**单独再配布**（不得以独立音乐文件形式分发）、上流媒体/商店发售、
  注册进 AI 作曲系统
- 对公开分发的含义：本作的音频经鉴权端点 `/api/survey/media/<id>` 提供，属于
  「作为作品 BGM 的组成部分」而非「单独再配布」；且已在问卷内署名。

## 二、逐曲记录

| 目标文件 | 曲名 | 情调标签（作者自打） | 授权页 | 直接下载地址 | 原始参数 | 成品参数 |
|---|---|---|---|---|---|---|
| `bgm-rain.mp3` | ヒーリング14 雨の音無し版 | 癒し / ピアノ / 静寂 / 夜明け | https://maou.audio/bgm_healing14b/ | https://maou.audio/sound/bgm/maou_bgm_healing14b.mp3 | 155.3s / 160kbps | 115.0s / 96kbps |
| `bgm-secret.mp3` | ピアノ19 | 静か / 勇気 / 感動 | https://maou.audio/bgm_piano19/ | https://maou.audio/sound/bgm/maou_bgm_piano19.mp3 | 114.1s / 160kbps | 110.0s / 96kbps |
| `bgm-distance.mp3` | ピアノ34 | 郷愁 / 寂しい / 穏やか | https://maou.audio/bgm_piano34/ | https://maou.audio/sound/bgm/maou_bgm_piano34.mp3 | 234.6s / 160kbps | 115.0s / 96kbps |
| `bgm-warm.mp3` | アコースティック50 | カフェ / ピアノ / のどか / ランチ | https://maou.audio/bgm_acoustic50/ | https://maou.audio/sound/bgm/maou_bgm_acoustic50.mp3 | 138.4s / 160kbps | 115.0s / 96kbps |
| `bgm-deep.mp3` | ヒーリング10 | ピアノ / ハープ / 回想 / 夢 / 癒し | https://maou.audio/bgm_healing10/ | https://maou.audio/sound/bgm/maou_bgm_healing10.mp3 | 124.9s / 160kbps | 110.0s / 96kbps |
| `bgm-playful.mp3` | アコースティック44 | かわいい / 猫 / 犬 / 動物 / 3拍子 | https://maou.audio/bgm_acoustic44/ | https://maou.audio/sound/bgm/maou_bgm_acoustic44.mp3 | 95.9s / 160kbps | 95.9s / 96kbps |
| `bgm-finale.mp3` | オーケストラ03 | オープニング / 壮大 / 感動 | https://maou.audio/bgm_orchestra03/ | https://maou.audio/sound/bgm/maou_bgm_orchestra03.mp3 | 155.0s / 160kbps | 130.0s / 96kbps |
| `bgm-tension.mp3` | ヒーリング11 | 暗い / 悲しみ / 挫折 / 雨 | https://maou.audio/bgm_healing11/ | https://maou.audio/sound/bgm/maou_bgm_healing11.mp3 | 323.0s / 160kbps | 125.0s / 96kbps |

全部为**合法自动获取**：直接 HTTP 下载，无登录、无验证码、无付费墙。
获取与处理脚本：`scripts/galgame/fetch_bgm.py`（清单 `scripts/galgame/bgm-manifest.json`，
缓存 `scripts/galgame/.bgm-cache/`，重跑可离线复现）。

## 三、处理链（对 8 首完全相同，可复核）

1. **无缝循环**：取 `[0, L]` 作为主体、`[L-4, L]` 作为尾段，用
   `acrossfade=d=4:c1=tri:c2=tri` 把尾段叠回开头 ⇒ `audio.loop` 的接缝是呼吸而不是咔哒。
2. **响度统一**：`loudnorm=I=-19:TP=-1.5:LRA=11` ⇒ 切页换曲时不会忽大忽小，真峰值留有余量。
3. **编码**：`libmp3lame -b:a 96k -ar 44100 -ac 2` ⇒ mp3 是 iOS Safari / Android Chrome
   都能直接解码的格式；单曲 1.15–1.56MB，8 首合计约 12MB（VN 循环垫乐的合理体积）。

### 实测（`ffmpeg -af ebur128=peak=true`，非估算）

| 文件 | 时长 | 综合响度 | 真峰值 | 谱心 | 起始密度 |
|---|---|---|---|---|---|
| `bgm-rain.mp3` | 115.0s | −18.6 LUFS | −4.8 dBTP | 610.9 Hz | 0.47 /s |
| `bgm-secret.mp3` | 110.0s | −18.6 LUFS | −5.5 dBTP | 972.0 Hz | 0.74 /s |
| `bgm-distance.mp3` | 115.0s | −19.3 LUFS | −7.7 dBTP | 671.7 Hz | 0.58 /s |
| `bgm-warm.mp3` | 115.0s | −18.8 LUFS | −7.6 dBTP | 1523.6 Hz | 0.42 /s |
| `bgm-deep.mp3` | 110.0s | −19.2 LUFS | −9.9 dBTP | 960.9 Hz | 0.22 /s |
| `bgm-playful.mp3` | 95.9s | −19.8 LUFS | −9.3 dBTP | 1519.2 Hz | 0.80 /s |
| `bgm-finale.mp3` | 130.0s | −18.5 LUFS | −3.4 dBTP | 1566.2 Hz | 0.31 /s |
| `bgm-tension.mp3` | 125.0s | −20.2 LUFS | −4.6 dBTP | 1744.2 Hz | 0.27 /s |

响度极差仅 1.7dB，真峰值全部 ≤ −3.4dBTP（无削波）。
谱心/起始密度可用于客观校验选曲不是拍脑袋：`playful` 最亮最密（1519Hz / 0.80），
`rain` 最暗最疏（611Hz / 0.47），与「轻松俏皮 vs 雨夜独处」的用途一致。
8 首 md5 互不相同（体积偶有相同是 CBR 所致，不代表内容相同）。

## 四、节点 ↔ 曲目映射

页级（`theme.audio.byPage`，键 = 0 起的页码）：

| 页 | 章节 | 曲目 | 选曲依据 |
|---|---|---|---|
| 0 / 1 | 序章 · 雨夜频率 | `bgm-rain` | 午夜电台、雨窗、独处；最暗最疏 |
| 2 | 距离线 · 隔座的月光 | `bgm-distance` | 克制、留白、想触碰又收回手 |
| 3 | 慢热线 · 台灯与手稿 | `bgm-warm` | 日常的暖意 |
| 4 | 深入线 · 凌晨三点的语音条 | `bgm-deep` | 交心、亲密、回忆；起始密度最低（0.22） |
| 5 | 默契线 · 猫、外卖与碎碎念 | `bgm-playful` | 轻快俏皮；作者标签直接写着「猫」 |
| 6 | 尾声 · 天亮之前 | `bgm-finale` | 情绪释放与落幕；管弦、LRA 最大（8.9） |

节点级覆盖（`theme.audio.byQuestion`，16 项，键 = 题目 `order`）：

- `8`（四选一的开场门）、`26` / `38`（同意关卡）→ `bgm-secret`
- `27`（亲密场景）→ `bgm-deep`
- `17` `18` `29` `30` `41` `42` `53` `54`（四条线各一对「失联 → 追问」）→ `bgm-tension`
- `19` `31` `43` `55`（四个结局）→ `bgm-finale`

**每条节点级曲目都必须与其所在页的页级曲目不同**，否则视为死配置（已剔除 1 条冗余项）。

## 五、线上状态（已生效，非"待导入"）

- KV storageKey 前缀 `media:survey-galgame`，由 `scripts/galgame/update_galgame_survey.py --apply` 写入。
- 媒体 id：`bgm-rain` #732、`bgm-distance` #733、`bgm-warm` #734、`bgm-deep` #735、
  `bgm-playful` #736（**同 storageKey 原地替换，id 不变**）；
  `bgm-finale` #749、`bgm-secret` #750、`bgm-tension` #751（本轮新增行）。
- 独立校验脚本 `scripts/galgame/verify_production.py` 对**线上**逐个 HEAD：
  8 个音频 URL 全部 200 且 MIME `audio/mpeg`。
- 浏览器侧 E2E（`qa/visual/galgame-playthrough.spec.ts`）证明：同一次游玩中真的发生了换曲、
  且至少请求到 1 条 `byQuestion` 节点级曲目（即节点级覆盖不是只存不用）。

## 六、评估过但未采用的音源（如实记录）

| 音源 | 实测结果 | 处置 |
|---|---|---|
| **哔哩哔哩**（用户建议用 `yt-dlp` 取音频） | 单视频可下载，但 `license` 元数据为 **NA**；命中的是版权唱片公司官方 MV（如索尼音乐中国）。`bilisearch5:` 检索直接 **HTTP 412** 风控 | **不采用**。无许可元数据 + 默认版权音乐，不能用于公开问卷；除非用户提供自己拥有权利的具体链接 |
| **FreePD.com** | 站点已关停（抓到 5,391 字节关闭公告，页内 0 个 mp3 链接） | 剔除 |
| **Pixabay Music** | `/music/` 返回 **403**（拦截脚本）；且其条款含「不得以独立文件再分发」 | 剔除（另见下方说明） |
| **DOVA-SYNDROME** | 首页可达（301），但目录为 JS 站内检索，无静态直链 | 未采用 |
| **OpenGameArt（CC0 筛选）** | 可达；抓取 `field_art_licenses_tid[]` 实测得 **CC0 = 4**（早期误把 17981=CC-BY 4.0 当成 CC0）；逐页读到 `License(s): CC0` 的有 6 首（Another August / November Snow / Calm Piano 1 / Calm Ambient 3 / Summers / First Light Particles） | **未采用**（只覆盖 6 个曲名，会让同一问卷混用两套许可；原始文件与逐曲记录仍在 `/tmp/cc0/` 与本文件历史版本中） |

> Pixabay 的「不得以独立文件再分发」与公开无鉴权媒体端点 `/api/survey/media/<id>` 的
> 潜在冲突，是本轮主动回避 Pixabay 的原因之一，需由项目方自行确认后再考虑。

## 七、可复现与回退

```bash
python3 scripts/galgame/fetch_bgm.py --verify   # 校验清单/文件/实测参数一致
python3 scripts/galgame/fetch_bgm.py            # 从缓存重新母带化（离线可跑）
```

- 换曲后要生效：`python3 scripts/galgame/update_galgame_survey.py --apply`（含 KV 重传 + D1 更新 + 自校验）。
- 回退：`git checkout -- scripts/galgame/assets/bgm-*.mp3`（若已提交），或重跑上一条命令用旧文件覆盖。
- 署名位置：问卷最后一个节点（`order 58`）描述末尾的「《雨季信箱》剧本 · 分镜插画：本作原创 /
  音乐：魔王魂（maou.audio）／森田交一 — CC BY 4.0」，每次通关都会读到。

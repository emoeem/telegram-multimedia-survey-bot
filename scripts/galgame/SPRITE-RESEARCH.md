# SPRITE-RESEARCH.md — 苏晚棠立绘素材调研（许可证已逐条目验）

- 调研日期：**2026-10-11**（Asia/Shanghai）
- 目标用途：https://emoe.eu.cc/s/118 的小型免费公开非商业 18+ 视觉小说；现代日系恋爱 VN，**单一女主角苏晚棠**（约 24 岁、及肩黑发、安静温和），当代中式雨城背景；玩家为男性、第一人称不入镜。
- 调研目录（本文件之外唯一的写入范围）：`/home/emo/code/telegram-bot/scripts/galgame/.sprite-raw/`
- 抓取工具：`curl`（Chrome 131 UA + Referer + `-L`）；验证工具：`file` + Pillow 12.3.0（逐文件 `size`/`mode`/alpha 覆盖率/palette 探针）
- **重要诚实声明**：本机 modlens 视觉桥**没有任何可用 provider**（`npx --yes @liustack/modlens doctor` 报告 antigravity-cli / gemini-api / openai / anthropic / claude-cli / kimi-cli 全部缺失或未配置，无可用 provider），因此**本次没有"用眼睛看过"任何一张图的像素**。下文所有"画风=日系动画"的判断都来自 **① 出处页面作者的自我描述与 tags** 与 **② 量化像素探针**（alpha 覆盖率、主色占比、暗部线稿占比）两条证据，并已逐条标注证据来源。凡涉及"是否好看/是否符合苏晚棠"的结论一律标注为**待人工看图确认**。

---

## 一、结论摘要

**结论：可用（partial，偏乐观的 partial）。** 在"许可证明文、可无人值守下载、允许商用+修改+放进游戏"的硬条件下，**确实存在同一角色、多表情、透明背景、日系动画风的立绘套组**，其中 3 套可直接用、1 套有条件可用、1 套必须人工登录才能取。

优先级排序（针对"一个女孩的多个表情"这一核心需求）：

| 排名                      | 套组                                              | 为什么                                                                                            | 许可             | 本地状态                        |
| ------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------- |
| **1（首选）**             | **Codel Visual Novel Sprite**                     | 1 人 1 姿势 12 张成品表情/脸红差分，1078×2089 RGBA，**作者页自述棕发**，最接近"苏晚棠"            | CC-BY 4.0        | ✅ 已下载并解压（12 PNG）       |
| **2（最强多样性）**       | **KUUDERE Visual Novel Sprite**                   | **同一角色 98 张 PNG**：4 套服装（含外套变体）× 7 表情 × 2 头部朝向，510×1000 RGBA，含 PSD 可改色 | CC-BY 4.0        | ✅ 已下载并解压（98 PNG）       |
| 3（小尺寸但情绪最"日常"） | Cute Maid Portrait                                | 1 人 6 表情 + RPG Maker faceset，320×578 RGBA；作者页+包内 ToU.txt 双重授权                       | CC-BY 3.0        | ✅ 已下载并解压（8 PNG）        |
| 4（有条件）               | Dress-Up Illustration Set - Lin Tongze            | 1 人模块化立绘：7 表情气泡、7 眉/13 眼/27 嘴、9 种脸红汗泪、兽耳、眼镜等，1668×2388               | **CC-BY-SA 4.0** | ✅ 已下载并解压（10 PNG + PSD） |
| 5（需人工）               | BOOTH 免费立ち絵（秘密結社K NPC学生 / Ailearium） | 质量与"现代女学生"匹配度最高，但**下载必须登录 BOOTH**                                            | 见 §4 原文       | ❌ 未下载，进人工清单           |

**必须如实说明的三件事：**

1. **"同一女孩多表情"是存在的**（第 1、2、3、4 名都是同一角色多表情），因此不算"只有一堆不同的女孩"。但**没有任何一套的造型 = 苏晚棠本尊**，也没有任何一套是"当代中式雨城/黑发及肩/24 岁"的现成匹配；最接近的是 Codel（棕发女学生）与 KUUDERE（紫发/校服，需 PSD 改色）。
2. **18+ 用途是一个真实的许可雷区**：Ailearium 的免费立ち絵明确写了 **「成人向け（R18・R18G）作品での使用」禁止**（§4 有原文），对本案是**直接不可用**；而 CC-BY/CC0 的 OGA 素材**不含**任何成人向限制。凡走 CC-BY/CC0 路线，18+ 属性在许可层面是安全的。
3. 本次**没有经过视觉确认**（无 provider），排名仅是"许可 + 结构 + 量化探针"的结果，**最终选型必须由人看图拍板**（见 §6 人工清单第 0 项）。

---

## 二、候选清单表

> 直链均为**页面 URL**与**文件 URL**两列；"允许商用/允许修改"依据许可本身，非推测。

| #   | 套组名                                                         | 来源站        | 作者                                      | 许可（含链接）                                                  | 署名要求                                         | 允许商用                                        | 允许修改                               | 尺寸 / 格式                                                | 表情数                                          | 已下载本地               | 备注                                                                                               |
| --- | -------------------------------------------------------------- | ------------- | ----------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------- | -------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------- |
| 1   | Codel Visual Novel Sprite                                      | OpenGameArt   | （页面未给作者名，按用户名）              | [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/)       | **必须**署名（CC-BY 要求）                       | ✅                                              | ✅                                     | 1078×2089，PNG RGBA ×12 + PSD                              | 7 表情 + 脸红（成品 12 张）                     | ✅ `oga-codel/`          | **首选**；1 姿势 1 服装；PSD 可改                                                                  |
| 2   | KUUDERE Visual Novel Sprite                                    | OpenGameArt   | **LisadiKaprio**                          | [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/)       | **必须**署名 LisadiKaprio                        | ✅                                              | ✅                                     | 510×1000，PNG RGBA ×98 + PSD                               | 每个服装 7 表情/头位 × 7 服装目录 × 2 头向 = 98 | ✅ `oga-kuudere/`        | 同一角色，量最大；含泳装（非裸露）；HEAD UP/HEAD DOWN 两套头位                                     |
| 3   | Cute Maid Portrait（Character Portrait ~ Maid）                | OpenGameArt   | **jupitersdaughter / Jupiter's Daughter** | [CC-BY 3.0](https://creativecommons.org/licenses/by/3.0/)       | **必须**署名 Jupiter's Daughter                  | ✅（作者页明说 "you can use her commercially"） | ✅                                     | 320×578，PNG RGBA ×6 + faceset 576×288 + Cover 315×250 RGB | 6（Neutral/Happy/Sad/Angry/Confused/Blush）     | ✅ `oga-cute-maid/`      | 作者页与包内 `Terms of Use.txt` **双份**授权；尺寸偏小，当头像/半身可用                            |
| 4   | Dress-Up Illustration Set - Lin Tongze                         | OpenGameArt   | **THE13RUIN**                             | [CC-BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | **必须**署名                                     | ✅                                              | ✅ **但衍生作品须同协议 CC-BY-SA 4.0** | 1668×2388，PNG RGBA ×10 + PSD                              | 7 表情气泡；7 眉/13 眼/27 嘴/9 脸红汗泪         | ✅ `oga-lintongze/`      | ⚠️ **share-alike 会传染**：见 §3 第 4 条的警告                                                     |
| 5   | VISUAL NOVEL CHARACTER SPRITE                                  | OpenGameArt   | 韩国作者（页面未具名）                    | [CC0](https://creativecommons.org/publicdomain/zero/1.0/)       | 无                                               | ✅                                              | ✅                                     | 2000×3000 RGBA（每角色 9–20 张）                           | cha1 20 / cha2 10 / cha3 10 / cha4 11 / cha5 9  | ✅ `oga-vncharsprite/`   | ❗**5 个不同角色**，不是同一女孩；且探针显示为**底色/色块模板**（见 §3 第 5 条），不是成品阴影立绘 |
| 6   | actress with regency dresses                                   | OpenGameArt   | （页面未给作者名）                        | [CC-BY 3.0](https://creativecommons.org/licenses/by/3.0/)       | **必须**署名                                     | ✅                                              | ✅                                     | 595×842 RGBA ×8（+ 999×1413 RGB 线稿 ×8）                  | 8（含 "act one normal / act one worried" 等）   | ✅ `oga-actress/`        | 同一角色多表情，但**摄政时期戏服**，与中式雨城现代设定不符                                         |
| 7   | Visual Novel Style Characters（Set1）                          | OpenGameArt   | madameberry                               | [CC0](https://creativecommons.org/publicdomain/zero/1.0/)       | 无                                               | ✅                                              | ✅                                     | 1078×2559 RGBA（body1–4 × skin1–6 + outline）              | 0（模板，非表情）                               | ✅ `oga-madameberry/`    | 身体/肤色换色模板，**没有表情**；不能单独当立绘                                                    |
| 8   | Anime Girl：Hachi                                              | OpenGameArt   | HachiStudio                               | CC-BY 4.0 / CC-BY 3.0 / CC0（三选，页面同时列出）               | 建议署名（CC0 部分不强制）                       | ✅                                              | ✅                                     | 800×800 RGBA ×4（back/eyes/front/mouth）                   | 0（分层线稿）                                   | ✅ `oga-hachi/`          | 供 HachiViewerPlus 组合的**线稿层**，不是成品立绘                                                  |
| 9   | Character Imageset                                             | OpenGameArt   | HachiStudio                               | [CC0](https://creativecommons.org/publicdomain/zero/1.0/)       | 无                                               | ✅                                              | ✅                                     | 2046×1447 RGBA ×1                                          | —                                               | ✅ `oga-hachi-imageset/` | **"一组不同角色"**，非同一人表情                                                                   |
| 10  | Anime Girl and Boy Portraits                                   | OpenGameArt   | stevenburrow                              | [CC0](https://creativecommons.org/publicdomain/zero/1.0/)       | 无（作者说 optional）                            | ✅                                              | ✅                                     | 组件式（2 女 + 2 男发型 / 每模型 3 眼 4 嘴）               | 组件式                                          | ⬜ 未下载（3.5 MB）      | 模块化零件，**非成品同一女孩表情套**；若不需要可不取                                               |
| 11  | Nekomimi girl portrait                                         | OpenGameArt   | —                                         | CC0                                                             | 无                                               | ✅                                              | ✅                                     | 像素画，单表情                                             | 1                                               | ⬜ 未下载                | ❌ 同时违反"多表情"与"非像素画"两条                                                                |
| 12  | BOOTH：秘密結社K「【無料】【立ち絵素材】NPC学生 (表情差分有)」 | BOOTH / pixiv | 秘密結社K                                 | 页面自述条款（见 §4）                                           | 非必须（"あれば嬉しいですが必須ではありません"） | ✅ 商用・非商用可                               | ✅（トリミング・加工自由）             | 1280×1280 PNG ×9 差分                                      | 9 差分                                          | ❌ **需登录**            | ⚠️ **再配布禁止**（二次配布不可），但"放进游戏"未被禁止；**无 R18 限制**                           |
| 13  | BOOTH：Ailearium「【立ち絵素材_01】女の子【無料版あり】」      | BOOTH / pixiv | Ailearium_エルアリウム_                   | 页面自述条款（见 §4）                                           | 任意（"クレジット表記は任意"）                   | ✅                                              | ✅                                     | 1000×3167 透過 PNG（ベスト有 表情差分 8 種）               | 8                                               | ❌ **需登录**            | ❌ **明确禁止 R18/R18G 用途** → 对本案**直接不可用**，仅因"若将来做全年龄版"而保留在人工清单       |

---

## 三、每条的许可原文引用（原文语言 + 中文要点）

### 1) Codel Visual Novel Sprite — CC-BY 4.0

页面：https://opengameart.org/content/codel-visual-novel-sprite ｜ 直链：https://opengameart.org/sites/default/files/Codel%20sprite.zip（15.1 MB）

- 许可块（页面右侧 License 区，原文）：**CC-BY 4.0**，链接 https://creativecommons.org/licenses/by/4.0/
- 页面正文（原文）：_"A character-sprite, suitable for Visual Novels and other projects. The PSD-file (1078x2089) contains: - a base (1 pose, 1 outfit on) - 7 different expressions + a blush The pack also contains 12 PNG-files (same resolution) with premade emotions (with and without the blush)."_
- **中文要点**：一个 1 姿势 1 服装的基础立绘 + 7 表情 + 脸红，另附 12 张成品情绪 PNG；CC-BY 4.0 = 允许商用、允许修改、允许再分发，**唯一强制条件是署名**。

### 2) KUUDERE Visual Novel Sprite — CC-BY 4.0

页面：https://opengameart.org/content/kuudere-visual-novel-sprite ｜ 直链：https://opengameart.org/sites/default/files/kuudere_lisadikaprio.zip（17.9 MB）

- 许可块（原文）：**CC-BY 4.0**
- 页面正文（原文）：_"The archive includes 98 PNGs of one character wearing 4 different outfits (school uniform, casual wear, dress and swimsuit, plus variations of these outfits with a jacket on) each with 7 emotions/head positions."_、_"Dimensions: 510x1000"_、_"I've included a PSD-file, that way you can recolor the sprite as you wish."_
- Tags（原文）：anime, Dating sim, sprites, visual novel, VN, cute
- **中文要点**：**一个角色**、98 张 PNG、4 套服装（校服/便服/连衣裙/泳装 + 外套变体）、每套 7 个表情或头部朝向；510×1000；附 PSD 可自由改色；CC-BY 4.0 需署名 LisadiKaprio。
- 探针补证：`HEAD UP/school uniform/neutral.png` 不透明占比 0.374，主色 `(1,1,1)=0.29` 线稿 + `(170,160,213)=0.22` 淡紫服装 + `(251,243,229)=0.17` 肤色 + `(95,91,105)=0.15`，符合"平涂 + 深色线稿"的日系动画上色特征。

### 3) Cute Maid Portrait — CC-BY 3.0（+ 包内 ToU 双重声明）

页面：https://opengameart.org/content/character-portrait-maid ｜ 直链：https://opengameart.org/sites/default/files/Cute%20Maid%20Portrait.zip（1.2 MB）

- 许可块（原文）：**CC-BY 3.0**
- 页面正文（原文）：_"A cute maid girl with multiple emotions as well as a faceset optimized for RPG Maker MV ... Emotions Neutral Happy Sad Angry Confused Blush She is free to use, modify, recolor, whatever you want at no cost. And yes, you can use her commercially. I only ask that you do credit me and maybe give me a link back (but that part is optional)."_
- 包内 `Terms of Use.txt`（逐字，含行尾 CRLF）：
  > The resource pack "Cute Maid Portrait" is free to use commercially and free to modify.
  > If used, all that is required is a listed credit to Jupiter's Daughter.
  > Any inquiries should be sent to jupitersdaughter.contact@gmail.com.
- **中文要点**：允许商用、允许修改、允许改色，唯一要求是**列出署名 Jupiter's Daughter**；"链接回作者"是可选的。这是本次**证据链最完整**的一条（页面 + 包内文本两处一致）。

### 4) Dress-Up Illustration Set - Lin Tongze — CC-BY-SA 4.0 ⚠️

页面：https://opengameart.org/content/dress-up-illustration-set-lin-tongze ｜ 直链：https://opengameart.org/sites/default/files/lin_tong_ze_-li_hui_.zip（19.5 MB）

- 许可块（原文）：**CC-BY-SA 4.0**，链接 https://creativecommons.org/licenses/by-sa/4.0/
- 包内 `使用声明.pdf`（`pdftotext -layout` 提取，逐字）：
  > 立绘角色名为「林同泽」
  > 作者名称：THE13RUIN
  > 许可协议链接：https://creativecommons.org/licenses/by-sa/4.0/
  > 许可协议：CC BY-SA 4.0 您被授予复制、分发、修改、重混、演绎本作品的权利，包括商业用途，前提是：署名…相同方式共享：如果您对本作品进行修改或演绎，则修改或演绎后的作品必须采用与本协议完全相同的协议（CC BY-SA 4.0）发布，不得附加任何额外限制。
  > 内容清单：表情气泡 7 个；兽耳&兽尾 2 套（猫、兔子）；眼镜套组（黑框/红框、普通镜片/墨镜镜片）；黑发/白发发型套组；面部表情附件（脸红/流汗/泪水共 9 种）；眉毛 7 种；眼睛 13 种；嘴型 27 种；围巾 2 色。
- **中文要点 + 警告**：允许商用与修改，**但"相同方式共享"条款落到"把立绘渲染成 PNG 再放进游戏"这一衍生行为上，法律上很可能要求你的整张衍生图（甚至包含它的游戏画面）也以 CC-BY-SA 4.0 发布**。本案是免费公开项目，若可接受该传染性，则本套是**模块化程度最高**的一套（可自由换眉/眼/嘴/发型/围巾）；若不愿承担 share-alike，**建议改用第 1–3 名（纯 CC-BY）**，或仅原样使用包内 7 张已合成的示例/表情图并署名 THE13RUIN（不修改 = 不触发 share-alike 义务）。**这是本节最需要人来拍板的一条。**

### 5) VISUAL NOVEL CHARACTER SPRITE — CC0

页面：https://opengameart.org/content/visual-novel-character-sprite ｜ 直链：https://opengameart.org/sites/default/files/character_5.zip（26.2 MB）

- 许可块（原文）：**CC0**；页面的 Copyright/Attribution Notice 字段原文只有一句：_"It's free"_。
- 作者留言（原文）：_"There may be Korean in the layer"_
- **中文要点**：CC0 = 公共领域贡献，无署名义务、可商用可修改。但结构上它是 **cha 1 … cha 5 五个不同角色**，不是同一女孩的多表情；且每角色只提供 2000×3000 的**底色/色块层**（探针：`cha 3/image/pl3 happy.png` 主色 `(200,200,200)=0.41` + `(255,255,255)=0.27` + `(178,234,193)=0.08` + `(91,155,108)=0.05`，全图 flat6≈1.0、暗部线稿≈0）——**看起来是待合成的模板/底色，不是已上阴影的成品立绘**（因无视觉工具，此为"未目视确认"的推断）。**不建议作为主素材**，可作为"不同路人角色"的补充。

### 6) actress with regency dresses — CC-BY 3.0

页面：https://opengameart.org/content/actress-with-regency-dresses ｜ 直链：https://opengameart.org/sites/default/files/actress%20with%20regency%20dresses.zip（1.7 MB）

- 许可块（原文）：**CC-BY 3.0**
- 页面正文（原文）：_"transparent raster .pngs + lineart of several expressions for character, in multiple outfits, originally made for a visual novel about putting on a play, hence the regency costumes"_
- **中文要点**：允许商用、允许修改，需署名。同一角色、多表情、透明背景，主题是"英国摄政时期戏服"，**与中式现代雨城不符**；但其中的 "worried / embarrassed" 情绪与含 alpha 的透明 PNG 结构对测试游戏内立绘管线仍有价值，故保留为备选。

### 7) Visual Novel Style Characters（Set1）— CC0

页面：https://opengameart.org/content/visual-novel-style-characters ｜ 直链：https://opengameart.org/sites/default/files/VisualNovel_Set1_MadameBerry.zip（14.3 MB）

- 许可块（原文）：**CC0**；正文（原文）：_"Character templates for a visual novel style game, with a variety of body types, skin colors, and hair. Included is a PSD ... and all of the exported PNGs"_
- **中文要点**：CC0 无义务。**没有表情**，是"身体 × 肤色"换色模板（body1–4 × skin1–6 + 线稿），只能作为自绘立绘的底座，不能直接当苏晚棠。

### 8) Anime Girl：Hachi — CC0 / CC-BY 3.0 / CC-BY 4.0（页面同时列出三项）

页面：https://opengameart.org/content/anime-girl%EF%BC%9Ahachi ｜ 直链：https://opengameart.org/sites/default/files/hachi_0.zip（709 KB）

- 许可块（原文）：同时列出 **CC-BY 4.0、CC-BY 3.0、CC0**；正文（原文）：_"Please use it freely."_
- **中文要点**：按最宽松的 CC0 理解时无署名义务（若走 CC-BY 分支则需署名）。内容是 `back/eyes/front/mouth` 四张 800×800 分层线稿（`front.png` 主色黑占 0.67），**必须配合作者自己的 HachiViewerPlus 组合**才能出生成立绘，不是开箱即用的素材。

### 9) Character Imageset — CC0

页面：https://opengameart.org/content/character-imageset ｜ 直链：https://opengameart.org/sites/default/files/hachiimages2.png（1.4 MB）

- 许可块（原文）：**CC0**。单张 2046×1447 的"一组不同角色"图集，**非同一女孩表情套**。

### 10) Anime Girl and Boy Portraits — CC0

页面：https://opengameart.org/content/anime-girl-and-boy-portraits ｜ 直链：https://opengameart.org/sites/default/files/allanime-11-28-2020.zip（3.5 MB）

- 许可块（原文）：**CC0**；正文（原文）：_"I created (from scratch) the portraits of some girls and boys, and then cut it into components ... two female and two male haircuts ... Each model has 3 eyes and 4 mouths. ... This is completely public domain, do whatever you wish with it. If you want to attribute me, that's fine, but not necessary."_
- **中文要点**：完全公共领域、署名可选；但为**零件式组件**（2 女 + 2 男），不是成品同一女孩表情套。**未下载**，如需自绘可再取。

---

## 四、BOOTH / pixiv 免费立ち絵（**需登录，未下载**，条款原文照录）

### A) 秘密結社K「【無料】【立ち絵素材】NPC学生 (表情差分有)」

- 页面：https://booth.pm/zh-tw/items/6015661 ；免费下载直链（**需登录**）：https://booth.pm/downloadables/4971059?variation_id=10164255 ；文件 `学生NPC.zip`（2.3 MB，9 张 1280×1280 差分 PNG）
- 页面条款（原文，逐字）：
  > 【利用規約】商用・非商用問わずご利用いただけます。トリミングや加工もご自由にどうぞ。クレジット表記はあれば嬉しいですが必須ではありません。禁止事項 著作権は放棄しておりません。自作発言や二次配布はおやめください。
- **中文要点**：商用非商用都可、裁剪加工自由、署名非强制（有则更好）；禁止事项为"不放弃著作权、禁止自称原创、**禁止二次配布（再配布）**"。→ **注意**：把素材放进你的游戏再公开分发游戏本体，是否算"二次配布素材"存在解释空间（多数日本作者的用意是禁止"把素材包本身转手"）；**这条需要人来定夺**，若谨慎处理则可只在本机/私域使用，或直接放弃改用纯 CC-BY 素材。
- **无 R18 限制**（条款中未出现成人向禁止）。

### B) Ailearium_エルアリウム_「【立ち絵素材_01】女の子【無料版あり】」

- 页面：https://booth.pm/ja/items/8542099 ；免费下载直链（**需登录**）：https://booth.pm/downloadables/9187706?variation_id=14255576 ；免费版规格：全身立ち絵 透過 PNG **1000×3167 px / 350 dpi**，ベスト有，**表情差分 8 種**
- 页面条款（原文，逐字）：
  > 【利用可能】・商業利用 ・動画、配信、ゲーム、TRPG、SNS等での使用 ・トリミング、サイズ変更、色味調整等の加工 【禁止事項】・成人向け（R18・R18G）作品での使用 ・自作発言 ・AI学習への使用 ・素材データの再配布、再販売 ・購入者以外が素材データを取得できる形での公開 【クレジット表記】クレジット表記は任意です。例：イラスト：Aile_エル_ X：@aile_Illust
- **中文要点**：允许商业利用、允许用于游戏、允许裁剪缩放调色，署名任意；**禁止事项第一项就是"禁止用于成人向（R18・R18G）作品"** → 本案目标是 18+ VN，**因此这套素材直接不可用**（除非将来出全年龄版本才可考虑）。
- 另注：该条同时禁止"素材数据的再配布、再販売"与"让购买者以外的人能取得素材数据的公开形式"。

### 下载受阻的实证

对上述两个 `booth.pm/downloadables/...` 直链用浏览器 UA + Referer 实际请求，结果是：

- `http=200`，`content_type=text/html`，`size=10087`，`final=https://booth.pm/users/sign_in` → 服务器把请求重定向到登录页，**返回的是 10 KB 登录 HTML 而非 zip**；`file` 识别为 `HTML document`。→ 与硬规则"不得依赖登录/付费"冲突，**未尝试绕过**，一律转入人工清单。
- 另：`すても`（sutemo）实际指向 BOOTH 店铺 https://sutemo.booth.pm/（JS 渲染，静态 HTML 内检索不到 `利用規約`/`商用`/`0 JPY`/`立ち絵`/`再配布` 任何字符串）→ 同样需要人工用浏览器打开并逐件读条款。

---

## 五、已下载文件清单

> 全部位于 `/home/emo/code/telegram-bot/scripts/galgame/.sprite-raw/`；总计 **233 MB**。完整逐文件清单见同目录 `INVENTORY.csv`（269 行，列为 `path,bytes,dimensions,mode,alpha_coverage,style_probe`）。所有 PNG 均能用 Pillow 正常打开（无损坏/无伪装文件）；唯一的非图片文件是 `oga-cute-maid/zip/Terms of Use.txt`（§3 第 3 条已逐字引用）。

| 目录                  | 压缩包                                     | 解压后 PNG 数 | PNG 总大小 | 尺寸 / 模式                                                                         | alpha                       | 说明                                       |
| --------------------- | ------------------------------------------ | ------------- | ---------- | ----------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------ |
| `oga-codel/`          | `Codel_sprite.zip`（15,077,049 B）         | 12            | 11.30 MB   | Codel1–12.png 均 **1078×2089 RGBA**                                                 | ✅ 覆盖率 0.407             | **首选**；+ `Codel.psd`                    |
| `oga-kuudere/`        | `kuudere_lisadikaprio.zip`（17,879,385 B） | 98            | 15.61 MB   | 均 **510×1000 RGBA**                                                                | ✅ 约 0.357（泳装 0.351）   | 7 服装目录 × 2 头向 × 7 表情；+ PSD        |
| `oga-cute-maid/`      | `Cute_Maid_Portrait.zip`（1,221,091 B）    | 8             | 1.17 MB    | 6 表情均 **320×578 RGBA**；`Maid Faceset.png` 576×288 RGBA；`Cover.png` 315×250 RGB | ✅ 表情 0.536；Cover 无     | + `Terms of Use.txt`                       |
| `oga-lintongze/`      | `lin_tong_ze.zip`（19,506,008 B）          | 10            | 8.4 MB     | 均 **1668×2388 RGBA**                                                               | ✅ 0.15–0.17                | + `使用声明.pdf`、`林同泽.psd`             |
| `oga-vncharsprite/`   | `character_5.zip`（26,170,320 B）          | 66            | 8.7 MB     | 每角色立绘 **2000×3000 RGBA**（`plN.png` 1000×1000 RGBA，alpha 1.0）                | ✅ 每角色 0.28–0.39         | ❗5 个不同角色；疑为底色模板（§3 第 5 条） |
| `oga-madameberry/`    | `set1.zip`（14,340,110 B）                 | 53            | 6.1 MB     | body/skin 均 **1078×2559 RGBA**；`Set1_PREVIEW.png` 3027×2559 RGB                   | ✅ 约 0.30；PREVIEW 无      | CC0 换色模板，**无表情**                   |
| `oga-actress/`        | `actress.zip`（1,652,684 B）               | 16            | 1.6 MB     | 立绘 **595×842 RGBA** ×8；线稿 **999×1413 RGB** ×8                                  | ✅ 立绘约 0.46–0.47；线稿无 | 摄政戏服，设定不符                         |
| `oga-hachi/`          | `hachi.zip`（709,277 B）                   | 5             | 0.9 MB     | 4 层均 **800×800 RGBA**（+ `front_5.png`）                                          | ✅ 0.177                    | 分层线稿，需 HachiViewerPlus               |
| `oga-hachi-imageset/` | 无（单文件）`hachiimages2.png`（1.4 MB）   | 1             | 1.3 MB     | **2046×1447 RGBA**                                                                  | ✅ 0.436                    | 一组不同角色                               |

**辅助脚本（同在 `.sprite-raw/`，非交付素材）**：`_probe_oga.py`（抓取 OGA 内容页并打印标题/作者/许可块/署名/文件/正文）、`_oga_search.py`（OGA 高级检索）、`_inventory.py`（遍历生成 `INVENTORY.csv` 并打印每目录 PNG 数/体积）。

---

## 六、明确的不可用清单及原因

| 候选/来源                                                                       | 不可用原因                                                                                                                                                            |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **BOOTH / pixiv `downloadables/*` 全部**                                        | **需登录**：重定向到 `https://booth.pm/users/sign_in`，返回 10 KB HTML；违反"不得依赖登录/付费"硬规则，且未尝试绕过                                                   |
| **Ailearium「立ち絵素材_01」**                                                  | 条款**明文禁止成人向（R18・R18G）作品使用** → 对 18+ VN 直接不可用（即便登录取得也不可用）                                                                            |
| **秘密結社K「NPC学生」**                                                        | 非"完全禁用"但含**再配布禁止**，与"放进游戏并公开分发"存在解释冲突 → **需人工定夺**，故列入不可自动采用                                                               |
| **itch.io 全部成品素材页**                                                      | HTTP **403** Cloudflare 挑战（"Just a moment..."），本会话无法取得                                                                                                    |
| **lemmasoft.renai.us 论坛资源（如 Free Anime Character Sprites by Chulang）**   | HTTP **403** Cloudflare                                                                                                                                               |
| **Nekomimi girl portrait**                                                      | 作者自述为**像素画**且**仅 1 个表情**，违反画风与多表情两条                                                                                                           |
| **vnstudio.org**                                                                | `curl` 退出码 000，站点已不可达                                                                                                                                       |
| **Wikimedia Commons 动漫 PNG 类目**                                             | API 检索（`srsearch=anime girl transparent png`, namespace 6）结果以 SVG 徽标/派生上传为主，**无成体系的同一角色多表情立绘**，未继续                                  |
| **ニコニ・コモンズ / ニコニ立体ちゃん、「キャラクターなんとか機」、たけのこ屋** | **未验证**：本次未抓到其条款原文（无论可用或不可用都不应据此判断）；たけのこ屋 `takenokoya.blog.fc2.com` 返回 302，`charat.me`/`picrew.me` 为角色生成器而非素材下载站 |

---

## 七、人工下载清单（需要人来做的事）

| 序    | 用途                                                                                            | 准确下载页 URL                                                                                                                                       | 许可要求                                                                                                           | 建议文件名                                 | 目标目录                                                                                                               |
| ----- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| **0** | **看图拍板**（最优先）：本次无视觉工具，无法确认哪套最像苏晚棠。请用图片查看器打开下列 3 张对比 | 本地：`oga-codel/zip/Codel1.png`、`oga-kuudere/zip/KUUDERE LisadiKaprio/HEAD UP/school uniform/neutral.png`、`oga-cute-maid/zip/Neutral.png`         | —                                                                                                                  | —                                          | —                                                                                                                      |
| 1     | 若采用 Codel：署名落地                                                                          | https://opengameart.org/content/codel-visual-novel-sprite                                                                                            | CC-BY 4.0，**必须**署名作者（页面未单列作者名，建议写 "Codel sprite by OpenGameArt user, CC-BY 4.0" 并附页面链接） | `codel-<表情>.png`（如 `codel-smile.png`） | 建议 `.sprite-raw/selected/codel/` 或游戏 `public/sprites/su-wantang/`（**本任务写入范围之外，需人工或后续任务执行**） |
| 2     | 若采用 KUUDERE：署名落地                                                                        | https://opengameart.org/content/kuudere-visual-novel-sprite                                                                                          | CC-BY 4.0，**必须**署名 **LisadiKaprio**                                                                           | `kuudere-<outfit>-<expr>.png`              | 同上                                                                                                                   |
| 3     | 若采用 Cute Maid：署名落地                                                                      | https://opengameart.org/content/character-portrait-maid                                                                                              | CC-BY 3.0，**必须**署名 **Jupiter's Daughter**                                                                     | `maid-<表情>.png`                          | 同上                                                                                                                   |
| 4     | 若接受 CC-BY-SA：模块化立绘加工                                                                 | https://opengameart.org/content/dress-up-illustration-set-lin-tongze                                                                                 | CC-BY-SA 4.0：署名 **THE13RUIN**，且**衍生作品必须以 CC-BY-SA 4.0 发布**                                           | `lintongze-<组件>.png`                     | 同上                                                                                                                   |
| 5     | 下载 BOOTH 免费立ち絵（可选）                                                                   | https://booth.pm/zh-tw/items/6015661 （秘密結社K，无 R18 限制但**再配布禁止需定夺**）                                                                | 商用非商用皆可、加工自由、署名非必须、禁自作发言与二次配布                                                         | `student-npc-<差分>.png`                   | 人工自定                                                                                                               |
| 6     | 二创/补足：若三套都不合适，可取 CC0 零件自绘                                                    | https://opengameart.org/content/anime-girl-and-boy-portraits （CC0）、https://opengameart.org/content/visual-novel-style-characters （CC0 换色模板） | CC0，**无任何义务**                                                                                                | 自定                                       | 自定                                                                                                                   |

---

## 八、署名（attribution）落地建议

游戏内若采用 CC-BY 系素材，`credits` / `关于` 页需要**逐条**列出（CC-BY 的强制条件即署名）：

- _Sprite "Codel" — [OpenGameArt](https://opengameart.org/content/codel-visual-novel-sprite), licensed [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/)_
- _Sprite "Kuudere" by LisadiKaprio — [OpenGameArt](https://opengameart.org/content/kuudere-visual-novel-sprite), licensed [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/)_
- _Sprite "Cute Maid Portrait" by Jupiter's Daughter — [OpenGameArt](https://opengameart.org/content/character-portrait-maid), licensed [CC-BY 3.0](https://creativecommons.org/licenses/by/3.0/)_
- _（若采用）Dress-Up Illustration Set "Lin Tongze" by THE13RUIN — [OpenGameArt](https://opengameart.org/content/dress-up-illustration-set-lin-tongze), licensed [CC-BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)_
- CC0 素材（madameberry、hachi-imageset、character_5、anime-girl-and-boy-portraits）**无署名义务**，但建议一并致谢。

---

## 九、本报告的证据等级声明

| 判断                                                        | 证据                                                                         |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 许可证类型（CC0 / CC-BY x.0 / CC-BY-SA 4.0 / 页面自述条款） | **强**：均为 2026-10-11 在源站页面 HTML 中亲眼所见，原文已逐条引用（§3、§4） |
| 可商用 / 可修改 / 需署名                                    | **强**：直接由许可文本或作者明示语句推出                                     |
| 图片真实性与规格（尺寸、模式、alpha、像素量）               | **强**：`file` + Pillow 逐文件实测，`INVENTORY.csv` 可复算                   |
| "画风属于日系动画"                                          | **中**：出自作者自述与 tags + 平涂/线稿量化探针，**未目视确认**              |
| "哪套最像苏晚棠 / 哪套更好看"                               | **无**：无视觉工具，**必须人工拍板**                                         |

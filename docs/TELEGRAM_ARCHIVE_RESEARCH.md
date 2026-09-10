# Telegram Personal Archive —— 技术调研报告

> 调研对象：Telegram 个人聊天/内容归档与整理系统
>
> 检索日期：2026-09-07
>
> 文档性质：技术调研与方案设计（尚未进入编码阶段）
>
> 重要说明：检索环境无法直连 core.telegram.org，涉及官方页面的结论均以官方文档镜像/存档、官方开源仓库与多个独立社区来源交叉验证；来源之间存在冲突之处已在正文中明确标注。

> **需求更新（2026-09-07）**：目标产品核心功能调整为“把归档内容直接保存进用户自己拥有的 Telegram 频道”（即频道即存档，浏览/检索发生在 Telegram 客户端内，本地数据库与 Web UI 降级为可选索引层）。可行性、保真度、组织方式与架构影响详见文末《附录 A：核心功能聚焦 —— 直接保存到自己的 Telegram 频道》。

## 目录

1. 项目需求理解
2. Telegram 数据模型
3. Telegram Content Protection 原理
4. Bot API
5. MTProto
6. TDLib
7. Telegram Web
8. Browser Extension
9. UserScript
10. Android
11. LSPosed / Xposed
12. 第三方客户端 / 库
13. 各技术路线横向对比
14. 五套以上完整架构方案
15. 推荐方案
16. 数据库设计
17. 媒体存储设计
18. 搜索系统
19. 标签系统
20. 同步系统
21. 傻瓜化产品设计
22. 开发路线图
23. 风险与 Telegram 条款
24. 最终结论
    附录 A：核心功能聚焦 —— 直接保存到自己的 Telegram 频道

---

## 1. 项目需求理解

目标产品在架构上可以拆成三层：

1. **采集层（Collector）**：从 Telegram 拿到“登录用户有权看到的数据”，包括消息正文、发送者、时间、回复/转发关系、媒体等。
2. **规范化与归档层（Normalizer + Archive Core）**：把 Telegram 的 TL 对象转成自有的、稳定的数据模型，落库、落文件、索引。
3. **体验层（DB + Indexer + Tag + Web UI）**：按人/群/时间/类型/标签检索，媒体去重管理。

关键认知是：**Telegram 没有“导出别人内容”的官方开放 API**。Bot API 是只读未来的、受限的；MTProto/TDLib 是“客户端协议”，能做多少取决于“以什么身份登录、Telegram 服务器/官方客户端把你当什么”。而 Content Protection 是这套体系里唯一真正“挡路”的机制，它的实现层级直接决定每个技术路线能走多远。因此本报告把“能做什么 / 为什么 / 属于哪一层 / 违反什么”分开讲。

---

## 2. Telegram 数据模型（与归档直接相关的部分）

以 MTProto/TDLib 的对象模型为准（Bot API 是它的子集）：

- **User**：`user_id`、用户名、昵称/姓名、手机号（仅自己可见）、头像；在群里可能以匿名身份发送（`MessageSenderChat`，即“群身份发送”）。
- **Chat 层级**：Private Chat（双人）→ Basic Group（小群，ID 为正的群号）→ Supergroup（大型群，ID 表现为 `-100xxxxxxxxxx`）→ Channel（频道，同为 `-100` 前缀）；Supergroup 可开启 Forum/Topics；Basic Group 可“升级”为 Supergroup（**ID 会变，归档必须处理迁移**，GeiserX/Telegram-Archive 为此专门做了 `FOLLOW_CHAT_MIGRATIONS`）。
- **Message**：核心身份是 `(peer, message_id)`；字段包括 `date/edit_date`、`sender_id`、`reply_to`、`fwd_from`（转发来源，若可获取且未隐藏）、`media`、`grouped_id`（相册）、`via_bot`、`reactions`、`views`、`restriction`（内容保护、观看限制）、`ttl`（阅后即焚）、`noforwards` 相关标志。
- **Media / File**：`document/photo/video/audio/voice/sticker/animation`；文件用 `file_id`（Bot API）或 `FileLocation + access_hash + dc_id`（MTProto）寻址；**文件引用（file reference）会过期**，下载失败需重新拉取消息刷新引用（Telethon 社区普遍遇到 `FILE_REFERENCE_EXPIRED`，见 [Stack Overflow 讨论](https://ru.stackoverflow.com/questions/1423856)，2022-06）。
- **Reaction**：TDLib 归入 `MessageInteractionInfo`；实时 reaction 流在多数客户端库里只能做到“尽力而为的聚合”，Telegram-Archive 的做法是定期 sweep 校准（见下）。
- **Restriction / Protection**：聊天级 `has_protected_content`（Bot API 字段，TDLib `Chat.has_protected_content`），消息级 `can_be_saved`（TDLib `Message.canBeSaved`），以及消息限制原因 `RestrictionReason`。

来源：[TDLib Message 类定义（pub.dev 镜像，检索 2026-09-07）](https://pub.dev/documentation/tdlib2/latest/td_api/Message-class.html)、[ExTDLib Chat 定义](https://hexdocs.pm/ex_tdlib/ExTDLib.Object.Chat.html)、[Telegram-Archive README](https://github.com/GeiserX/Telegram-Archive)。

---

## 3. Telegram Content Protection 原理（核心）

### 这是什么机制？

官方口径（2021-12-06 博客 _Protected Content, Delete by Date and More_）：

> 群组/频道所有者可限制“转发消息”，这会**同时阻止截图、限制保存帖子中的媒体**。

原文见 [telegram.tg 官方博客镜像](https://telegram.tg/blog/protected-content-delete-by-date-and-more/es?setln=en)（2021-12-06）与 [Wayback 快照](https://web.archive.org/web/20211208180925/https://telegram.org/blog/protected-content-delete-by-date-and-more)。2026-02 的更新把同类限制下放到**私聊**（_Disable Sharing_），见 [官方博客镜像](http://telegram.tg/blog/member-tags-disable-sharing-and-more/tr?setln=en)（2026-02-28）。

### 逐层回答关键问题

**1. Content Protection 到底在什么层实现？**

服务器负责**打标记和限制转发**：聊天/消息携带保护标志（TL 层 `noforwards`；Bot API `has_protected_content`；TDLib `Chat.has_protected_content` / `Message.canBeSaved`）。而“不能保存 / 不能复制 / 不能截图”的**执行发生在客户端**：官方客户端根据标志隐藏“保存 / 转发 / 复制”入口；Android 端再加 `FLAG_SECURE` 让系统层禁止截图/录屏；桌面与 Web 没有等价的 OS 级强制，只能靠客户端 UI 与 DOM 行为限制。

**2. 服务器是否仍向正常客户端发送消息数据？**

**发送**。成员必须收到消息正文和媒体（密聊/阅后即焚是另一套 TTL 机制）才能显示。Telegram 的内容保护不是“密文不给密钥”式 DRM，而是“转发受限 + 客户端配合”的软保护。三个独立证据：

- 官方博客描述的是“限制保存能力”而不是“不发送”；
- 基于用户账号的 Pyrogram/Telethon 下载工具（如 [tangyoha/telegram_media_downloader](https://github.com/tangyoha/telegram_media_downloader)，其 DeepWiki 明确写了 protected content 的“先下载再转存”处理，2026-03）能取到媒体；
- 官方 Desktop 客户端补丁项目（[Layerex/telegram-desktop-patches](https://github.com/Layerex/telegram-desktop-patches)，2025-01）只需改客户端本地行为就能“在禁止保存的频道恢复保存/复制”，说明限制在客户端侧。

**3. 服务器是否根本不发送某些内容？**

对“有权限的普通成员”，正文与媒体照常下发。**不发送/不可见的场景另有其因**：阅后即焚、Secret Chat（端到端）、你不在成员列表里的私密频道、账号被限制等。内容保护 ≠ 这些。

**4. 客户端拿到数据以后有哪些限制？**

官方客户端：隐藏转发按钮、隐藏“保存到相册/下载”、禁止文本选择/复制（桌面/Web 通过 UI 与剪贴板事件）、Android 设 `FLAG_SECURE` 禁截图；会显著阻碍“把媒体另存下来”的常规操作。限制**不阻止你在屏幕上看到**，也不阻止桌面端截屏/录屏（OS 不配合时无解，这是所有 IM 的共有事实，官方博客也只说“阻止截图”是平台尽力行为）。

**5. 为什么 Web UserScript 能实现“保存按钮”？**

因为 Telegram Web（Web A / Web K）本身就是跑在浏览器里的完整 MTProto 客户端：它为了“让你看到”，已经把消息文本、文件对象、可播放/可预览的媒体流都拿到了页面里。Web 客户端在受保护聊天里只是**不画“下载”按钮、禁用复制**。脚本做的是把用户已经看到的客户端内容“重新提供下载入口”：

- 读页面已缓存的媒体流地址（形如 `stream/{dcId, location, size, mimeType…}` 的内部端点），用当前登录会话发起带 `Range` 的分片请求，再拼成文件交给浏览器下载（代表项目 [Neet-Nestor/Telegram-Media-Downloader](https://github.com/Neet-Nestor/Telegram-Media-Downloader)，2026-03；另有 [Greasy Fork 同类脚本](https://greasyfork.org/en/scripts/567432-telegram-web-media-batch-downloader)）；
- 对文本，恢复 DOM 的 `user-select` / 剪贴板行为（[Telegram Ultimate Enhancer](https://greasyfork.org/zh-CN/scripts/590834-telegram-ultimate-enhancer) 等描述可见）。

脚本通常不动服务器、不伪造身份、不解密任何东西——它们利用的是“客户端已合法持有数据”这个事实，做的是 **UI/行为层增强**。个别脚本更深（Hook 客户端内部 JS、调用其内部 download 流程、读 IndexedDB 缓存），但底层逻辑相同：**数据早已在客户端**。

**6. 这些脚本到底改变了什么？**

改变了“客户端是否执行保存限制”这一本地行为层，本质与打补丁的官方 Desktop 修改、LSPosed 模块同类——都是绕过客户端执行策略，而非攻破 Telegram 服务器/加密。

**7. 这与真正从服务器获取数据是不是一回事？**

对普通内容：是（网页客户端本来就在实时从服务器拿）。对“媒体文件本身”：脚本往往通过**网页客户端持有的流式 URL**（带会话鉴权）去取，服务器仍然在服务这个合法会话，所以从服务器视角这不是越权读取；但从聊天所有者的保护意图和 Telegram 平台规则视角，它是规避了对方设置的保存限制。

**8. TDLib / MTProto 对 Protected Content 的行为？**

- **TDLib**：明确把“保护”落到客户端行为里。它给聊天/消息暴露 `has_protected_content`、`can_be_saved`、`updateChatHasProtectedContent`，且内部下载入口会做检查——[tdlib/td 源码检索](https://grep.app/search?q=canBeSaved&filter%5Brepo%5D%5B0%5D=tdlib%2Ftd) 可见类似 `CanBeAddedToDownloads => CanBeSaved && !Chat.HasProtectedContent && …` 的逻辑，即受保护聊天的音频/文档/视频**不会进入其下载管理器**。换言之 TDLib 主动选择“遵守”该限制。
- **裸 MTProto 库（Telethon / Pyrogram / GramJS / gotd）**：它们只做协议搬运，默认**不**替你在下载前判断“该聊天是否保护”。因此很多工具（如 `tangyoha/telegram_media_downloader`、各类 “restricted content downloader” 项目）用用户会话仍能下载受保护聊天的媒体——但**不保证 100% 成功**：报错常见于 DC/CDN 与文件引用处理（如 [iyear/tdl #106](https://github.com/iyear/tdl/issues/106) 的 `DC_ID_INVALID`、[iyear/tdl #842](https://github.com/iyear/tdl/issues/842)：作者报告某受保护群官方客户端能下载而 tdl 不能，2025-01）。
- **结论**：服务器通常仍在为“合法成员的正常客户端会话”提供媒体数据；**最终能不能拿到，取决于你用的客户端实现是否执行保护策略**。这就是 TDLib 与裸 MTProto 库最大的行为分叉。

**9. 各类数据逐项说明**（前提：你是该聊天有权成员）

| 数据                             | 官方客户端/MTProto 用户会话能否读取 | 说明                                                                                |
| -------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------- |
| Message 正文/元数据              | ✅ 能                               | 服务器正常下发；TDLib 有 `canBeSaved=false` 但文本仍在消息对象里                    |
| Sender / 昵称 / 用户名           | ✅ 能                               | 匿名群身份时会得到“群身份”而非具体用户                                              |
| Timestamp / edit_date            | ✅ 能                               | 常规字段                                                                            |
| Photo                            | 🟡 能看，保存受限                   | 官方客户端禁止“另存”；TDLib 不加入下载队列；裸 MTProto 通常可下载（视 DC/file ref） |
| Video / Document / Audio / Voice | 🟡 同上                             | 同上；语音消息在 Web K 才较完整支持（Neet-Nestor README 注明）                      |
| Sticker                          | 🟡 能看                             | Web 脚本往往只能拿到贴纸图源，WebP/TGS/Lottie 混合                                  |
| Reaction 明细                    | 🟡 部分                             | 实时性差；需轮询/定期 sweep（Telegram-Archive 的做法）                              |

> **安全边界说明**：以上是机制层面的调研结论；若做成开源产品，建议把“是否突破客户端保存限制”作为一个显式、可关闭、默认关闭且带风险声明的开关，而不是主功能卖点——理由见第 23 节。

---

## 4. Bot API（方案 A）

### 能做什么

- 以 bot token 登录，加入群/频道（需被添加、通常需管理员/关闭 privacy mode 才能拿到全量消息流）。
- 通过 `getUpdates` / webhook 拿到“加入之后”的新消息（含正文、发送者、`protect_content`、`has_protected_content` 字段）。
- 能下载 bot 自己“看得到”的媒体（有 `file_id` 就能调 `getFile`），能发消息/转发/复制消息（受保护语义限制）。

### 不能做什么

- **不能读历史**：Bot API 没有 `getHistory` 等价物；官方 Bot FAQ 只定义“bot 能收到哪些消息”，社区与官方库维护者反复确认 “bots can't read past chat history”（[kotlin-telegram-bot #334](https://github.com/kotlin-telegram-bot/kotlin-telegram-bot/issues/334)，2024-08；[openclaw #408](https://github.com/openclaw/openclaw/issues/408) 还确认 bot 永远看不到其他 bot 的消息，2026-01）。
- 不能代表用户身份；看不到你私聊/非其所在群的内容；不能登录用户账号。
- 内容保护语义下 Bot 同样受转发/保存限制约束；Bot API 是“产品机器人”接口，不是归档接口。

### 评价

功能完整度 2/10，实现难度低，稳定性高（官方服务），普通用户难度低但**根本不适合归档**。Bot 只能作为“产品通知/交互入口”，不能作为数据源。

来源：[官方 Bots FAQ（Wayback 快照 + 社区引用）](https://web.archive.org/web/20150909214447/https://core.telegram.org/bots/faq)、[Bot API 9.5（2026-03-01）发布记录](https://newreleases.io/project/github/pengrad/java-telegram-bot-api/release/9.5.0)。

---

## 5. MTProto + 用户账号（方案 B）

### 技术事实

- MTProto 是 Telegram 客户端使用的二进制协议；用“普通用户账号 + api_id/api_hash（my.telegram.org 申请）”登录，就是一台“你自己的客户端”。
- 核心能力：`messages.getDialogs`（拉会话列表）→ `messages.getHistory`（按 `offset_id` 向前翻页取完整历史）→ `messages.getMessages` / `getMedia`（刷新 file reference）→ `upload.getFile`（下载）→ 长连接 `updates`（实时增量：新消息/编辑/删除/反应）。
- 会话即“登录态”：Telethon `.session` 文件、Pyrogram string session、GramJS StringSession 等；多设备语义上 Telegram 允许（登录会出现在设备列表），但非官方客户端登录会被标记观察（见第 23 节）。
- 限流：`FLOOD_WAIT_x`（420，官方错误体系，见 [Telethon errors 文档](https://raw.githubusercontent.com/LonamiWebs/Telethon/e1905d0d7ad3014e02bda9d5d468f669c21a7353/readthedocs/concepts/errors.rst)、[gotd floodwait 中间件](https://pkg.go.dev/github.com/gotd/contrib/middleware/floodwait)），以及 `AUTH_KEY_DUPLICATED`、`FILE_REFERENCE_EXPIRED`、`DC_ID_INVALID` 等。

### 作为 Archive Client 的可行性

**高，且是被广泛验证的路线。** 现成例子：

- [GeiserX/Telegram-Archive](https://github.com/GeiserX/Telegram-Archive)（Telethon + FastAPI + Vue，v8.x，2026-08 仍活跃）：增量备份、实时 listener、相册、service message、去重、SQLite/Postgres、定时与 FloodWait 参数全可调。
- [knadh/tg-archive](https://github.com/knadh/tg-archive)：Telethon + SQLite 增量同步 → 静态网页，mailing-list 风格。
- [tangyoha/telegram_media_downloader](https://github.com/tangyoha/telegram_media_downloader)：Pyrogram 用户会话批量媒体下载 + 断点 + 上传 S3/rclone。

### 关键结论

用户账号采集是“能力上限最高”的路线，也是“合规风险标签最重”的路线（非官方客户端、userbot 语义、观察与封禁条款）。媒体下载通常可行（含许多受保护聊天），但协议细节（DC、CDN、file ref 过期、FloodWait）需要成熟处理，属于中高工程量。

---

## 6. TDLib（方案 C，重点评价）

### 定位

TDLib = Telegram Database Library，是 Telegram 官方开源的“造客户端引擎”（C++17，Boost 许可）。它替你完成 MTProto 连接、加密、会话、本地缓存、消息数据库、文件下载队列、离线同步、更新排序，并暴露稳定 API。官方 README 声称 Bot API 后端由 TDLib 实例支撑（每实例服务 4 万+ bot，见 [tdlib/td README](https://github.com/tdlib/td/blob/master/README.md)）。

### 与 MTProto 的关系

TDLib 是 MTProto 之上的完整客户端实现；裸 MTProto 库只给“协议 + 对象”，TDLib 多给“应用级状态机”。

### 能力与事实

- 平台：Android / iOS / Windows / macOS / Linux / WebAssembly 等（README 列表）；官方绑定 C++ / Java(JNI) / .NET，其他语言走 JSON 接口（`td_json_client`）；Rust / Node / Python 等均有社区绑定（如 tdlib-rs、airgram、pytdlib），成熟度需自行评估，官方只保证 C++/Java/.NET/JSON。
- 本地数据库：`use_message_database` / `use_chat_info_database` / `use_file_database` 可开；本地数据用用户提供的 key 加密（README 原文 “all local data is encrypted using a user-provided encryption key”）。**注意**：它的本地 DB 是“客户端缓存”，不等同于你的归档库——建议自建库，TDLib DB 只做采集缓存。
- 实时更新：`updateNewMessage` / `updateMessageEdited` / `updateMessageDeleted` 等按序投递，网络差时自动恢复，这是裸库要自己补的工程。
- Media：自带下载管理器（优先级、断点、限速语义），**但对受保护聊天有行为限制**（见第 3 节第 8 点）。
- 认证：手机号验证码 + 2FA，与官方客户端可并存为另一“设备”。

### 是否应作为第一选择

分情况：

- 若目标是“稳定的官方级采集内核、跨平台、长期维护、不主动突破内容保护”→ **是**。它有官方背书、协议层最全、更新/重连/顺序保证省掉大量工程。
- 若目标包含“必须拿到受保护聊天的媒体”→ TDLib 反而挡路（有意为之），这时需要换裸 MTProto 库（Telethon/Pyrogram/gotd）或在采集层前面加“视图层采集器”。
- 工程成本：C++ 构建与各端集成高于 Telethon；但用 JSON 接口 + 打包好的 `tdjson` 可大幅降低。

来源：[TDLib README](https://github.com/tdlib/td/blob/master/README.md)、[TDLib Chat/Message 字段镜像](https://hexdocs.pm/ex_tdlib/ExTDLib.Object.Chat.html)、[TDLib 源码检索](https://grep.app/search?q=canBeSaved&filter%5Brepo%5D%5B0%5D=tdlib%2Ftd)。

---

## 7. Telegram Web（方案 D 的前半段）

### 当前架构（2026 现状）

官方网页版有两个活跃客户端：

- **Telegram Web A**（[Ajaxy/telegram-tt](https://github.com/Ajaxy/telegram-tt)，GPLv3）：自研 Teact + 自改 GramJS 作为 MTProto 实现，WebSocket / Web Worker / WASM、PWA 多级缓存；部署于 `web.telegram.org/a`。README 原话确认它“在浏览器里完整跑 MTProto”。
- **Telegram Web K**（[AKJUS/tweb](https://github.com/AKJUS/tweb)（原 morethanwords/tweb），GPLv3，TypeScript，Webogram 血统）：部署于 `web.telegram.org/k`。
- **命名混乱必须标注**：社区资料互相矛盾——有的说 WebZ 是“第二个轻量客户端”（webz.telegram.org 仍是 tweb 系），有的说 `webz` 已 301 到 `weba`，有的把 WebA 直接叫“原 WebZ”（[对比 1](https://onetelegram.com/2026/03/19/telegram-web-guide-a-vs-k/)、[对比 2](https://tianwenwangluo.com/telegram-web-login-2026/)、[Fandom Apps 页](https://telegram.fandom.com/wiki/Apps)）。对开发者的实际含义：**以 A/K 两套 DOM/内部结构分别适配，并以 `a|k|z` 三个域名为兼容目标**（主流脚本就是这么做的），别把“Z”当成一个独立稳定客户端。

### 数据落在哪

- 两个客户端都把“已加载会话”持久化在 **IndexedDB**（会话密钥、peer 缓存、消息缓存），媒体以 blob/缓存形式存在于页面内存与浏览器缓存。学术调研（高丽大学 2025 学位论文，分析 Telegram Desktop 导出 + WebK/WebA 的 IndexedDB 结构）确认 WebZ(K 系) 的 IndexedDB 存在 `messages.byChatId` 结构（[论文页](https://dcollection.korea.ac.kr/common/orgView/000000305955)）。
- 页面内部有完整的 MTProto 调用能力；Web A 的 README 甚至教你在 console 里直接调 `invoke(new GramJs.xxx())`（开发模式）。

### 能获取哪些数据

取决于“网页客户端已加载 / 可加载多少”：

- 当前可见消息：全字段（DOM / 内存 / IDB 都有）。
- 历史：客户端本身有“向上翻页拉历史”的机制；**理论上可以编程式滚动拉完整个会话**，但很慢、易触发限流、对百万级消息不现实。
- 媒体：页面能播/能预览的内容都能取到（脚本验证过 photo/video/voice）；原图/原文件质量取决于客户端加载策略。
- 实时：长连接 updates 在跑，页面能看到新消息；外部脚本可监听 DOM/内部事件。
- 稳定对象模型？**没有**——A/K 各自内部对象名、存储键、DOM 结构都不同且不公开，随版本变。

### Telegram Web 更新后是否容易失效

**非常容易**。这不是猜测，而是这类脚本反复改版的原因（Neet-Nestor 脚本 1.x 持续迭代、多个 Greasy Fork 脚本半年内更新十余次）。Web 客户端是高频改版的在线应用，任何依赖内部对象/DOM/URL 形态的采集都要持续维护。

来源：[telegram-tt README](https://github.com/Ajaxy/telegram-tt)、[tweb](https://github.com/AKJUS/tweb)、[Neet-Nestor/Telegram-Media-Downloader](https://github.com/Neet-Nestor/Telegram-Media-Downloader)。

---

## 8. Browser Extension（MV3 视角）

浏览器扩展相比 UserScript 的优势：可长驻、可后台同步、可管理下载、可配 UI、可分发到商店；劣势在 **Manifest V3**：

- 背景页换成 service worker，长连接被节流；持续轮询/长时间后台下载要设计成“唤醒式”，不适合做永远在线的 collector。
- 不能执行远程代码、不能注入任意页面 JS 与页面共享作用域（content script 是 isolated world）；访问 Telegram Web **内部 JS 对象/闭包**比 UserScript 更受限（UserScript 管理器有 `unsafeWindow` 便利）。
- 网络层：`webRequest` 的 blocking 能力大减，改用 `declarativeNetRequest`；想拦截/改写客户端与服务器间的请求会受限。
- IndexedDB / DOM 是**同源共享**的，content script 可以直接读页面 IndexedDB、DOM；但要小心两套客户端结构不同，且读取时机依赖客户端完成缓存。
- 跨域流媒体：页面内的 `stream/...` 请求带会话凭据；扩展若在页面上下文 fetch 则可行，在扩展后台 fetch 则需要处理凭据/CORS。

### 结论

扩展能做“能看到什么就抓什么”的采集器，适合个人使用与少量会话；不适合作为“全量历史 + 百万级 + 稳定”的归档主力。它真正的价值是**双采集器架构里的“视图层补充”**：捕获 TDLib/MTProto 拿不到或不想拿的受保护内容（见第 14 节方案 4）。

---

## 9. UserScript / Tampermonkey（方案 E）

### 调研到的实际项目（含机制）

- [Neet-Nestor/Telegram-Media-Downloader](https://github.com/Neet-Nestor/Telegram-Media-Downloader)（GPLv3，2026-03 活跃）：匹配 `web.telegram.org/a|k|z`。机制：**DOM/UI 层注入下载按钮 + 读取播放器已有流地址 + 用当前会话发起 Range 分片 fetch + 浏览器下载 API / File System Access 保存**；对语音消息区分 A/K 支持度（K 更好）。它不新增服务器权限。
- Greasy Fork “[Telegram Web Media Downloader — Save Restricted Photos & Videos (Batch) + Copy Text](https://greasyfork.org/zh-CN/scripts/477900-telegram-web-media-downloader-save-restricted-photos-videos-batch-copy-text)”（2026-06 更新）：批量下载 + 恢复文本复制，同样是 DOM/行为层。
- [Telegram Ultimate Enhancer](https://greasyfork.org/zh-CN/scripts/590834-telegram-ultimate-enhancer)（2026-08）：恢复右键/复制/原生下载动作，另加 PiP、倍速等——明确属于“解除客户端 UI 限制”。
- 中文区同类（weiruan-Telegram 等，2025-12 ~ 2026-01）：功能描述与上述一致（解除右键/选择/拖拽限制 + 下载受限媒体）。

### 它们到底改哪一层

按问题逐条归类：

1. 修改 DOM：✅（注入按钮、恢复右键/选择）。
2. Hook JavaScript：🟡 部分脚本会拦截/调用客户端内部函数；多数并不需要。
3. 调用内部 API：🟡 通过页面上下文读取客户端缓存的媒体对象/流地址；不是调用私有服务器 API。
4. 读取 IndexedDB：🟡 少数直接读缓存（作为兜底），多数靠 DOM/流 URL。
5. 拦截网络请求：🟡 视频下载脚本本质上是在页面里对“客户端流端点”发 Range 请求并重组文件。
6. 浏览器下载 API：✅ 保存时用 `<a download>` / `showSaveFilePicker`。
7. 能保存哪些内容：照片、GIF、视频、音频/语音（分版本）、文本；文档类支持较少。
8. **为什么更新会失效**：依赖选择器、图标类名、`stream/` URL 的 JSON 结构与字段、客户端存储 schema、右键菜单实现；任一改动即失效。这也是 Greasy Fork 上此类脚本更新极其频繁的原因。

### 为什么它“能”而官方 App “不能”

因为 Web 客户端把“禁止保存”实现为客户端行为，浏览器环境里没有 Android `FLAG_SECURE` 那种系统级兜底，脚本与扩展天然可改 DOM/页面行为。

---

## 10. Android 原生方案（方案 F）

| 路线                                            | 能获取什么                                                | 范围                           | Root/BL | 更新破坏             | 大众友好 | Play 发布                                                                                                                                                                                                                                                          | 开源性 |
| ----------------------------------------------- | --------------------------------------------------------- | ------------------------------ | ------- | -------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| 独立 App + TDLib                                | 完整（如桌面版 TDLib），除受保护媒体下载受 TDLib 策略限制 | 已登录账号有权访问的聊天全历史 | 否      | 低（TDLib 官方维护） | 中       | 可能（需过审，注意条款）                                                                                                                                                                                                                                           | 高     |
| 第三方客户端（Nekogram/NekoX/Telegram-FOSS 系） | 完整客户端能力，常内置“保存受保护媒体”等功能              | 同账号范围                     | 否      | 中（需跟进上游）     | 低-中    | **困难**（NekoX 已无法在 Play 更新，见其 [README](https://github.com/OverflowCat/NekoX)；Nekogram 2026 年被社区指控收集手机号，需自行核实 [Android Jefe](https://www.androidjefe.com/nekogram-la-app-de-telegram-mas-popular-en-android-tiene-codigo-malicioso/)） | 中     |
| Accessibility 服务                              | 屏幕上的文本/界面树，可做“自动滚动截图/OCR”               | 仅当前打开且可见的内容         | 否      | 中                   | 中       | 可（但 Play 对无障碍滥用审查严）                                                                                                                                                                                                                                   | 中     |
| Notification Listener                           | 通知里的消息文本（被系统截断/折叠时不完整）               | 仅实时新通知，无历史           | 否      | 低                   | 高       | 可                                                                                                                                                                                                                                                                 | 高     |
| Local VPN                                       | 只能看流量元数据（MTProto 加密），**拿不到明文**          | —                              | 否      | 低                   | 低       | 可                                                                                                                                                                                                                                                                 | 中     |
| WebView 套官方 Web 客户端                       | ≈ Web 客户端能力                                          | 需一直保持登录态               | 否      | 高（同 Web）         | 低       | 边缘                                                                                                                                                                                                                                                               | 中     |
| LSPosed / Xposed                                | 见第 11 节                                                | —                              | 通常要  | 高                   | 极低     | 否                                                                                                                                                                                                                                                                 | 中     |

结论：大众向 Android Archive 的可行主力就是 **App + TDLib**（或 TDLib 前端壳）；Accessibility / Notification 只适合“轻量伴侣”，Local VPN 对明文内容无效。

---

## 11. LSPosed / Xposed（方案 G）

### 技术原理

LSPosed 是在 Magisk/Zygisk 环境下运行的 Xposed 实现，向目标 App 进程注入 Java/Kotlin 层 hook（ART 方法级）。Telegram Android 的业务逻辑（消息渲染、菜单项、下载入口、`FLAG_SECURE` 设置点）大量在 Java/Kotlin 层，所以模块能：恢复“保存/截图/复制”入口、记录编辑历史、导出媒体等。现有模块如 [Telegami](https://magisk.dev/lsposed/telegami/)、[TeleVip](https://modules.lsposed.org/module/com.my.televip/)、[TGramHooks](https://modules.lsposed.org/module/com.simo.tgramhooks/)、[Disable-FLAG_SECURE](https://github.com/Xposed-Modules-Repo/com.varuns2002.disable_flag_secure) 的功能描述就是“保存受限媒体 / 恢复私聊截图 / 记录已删消息”这类。

### Hook Java/Kotlin 还是 native

主要是 Java/Kotlin 层（ART）；协议/编解码在 native，但一般不需要 hook native。

### Telegram 更新为何失效

混淆/方法改名、R8 重命名、UI 重构、签名校验、反调试/完整性检测都可能让旧 hook 失效或触发风控。

### 依赖与成本

标准路线 = 解锁 Bootloader + Magisk + Zygisk + LSPosed + 模块；替代路线 = [LSPatch](https://github.com/taotaojs213/LSPatch)（免 Root 重打包注入），但 Telegram 官方 APK 签名会变、每次升级要重打补丁、Play 完整性检查过不了。

### 为什么不适合大众化产品核心

安装门槛高（解锁/刷机/Root 对普通用户是灾难）、维护成本高（跟随 Telegram 每个版本的 hook 点）、Google Play 不可发布、账号风险高、且整个体系“为绕过保护而生”，不可能作为开源主产品的中立卖点。它适合作为**高级用户的自选实验路线**，在产品里最多以“社区文档”形式提及。

来源：[LSPosed/LSPatch](https://github.com/taotaojs213/LSPatch)、模块仓库如上（检索 2026-07 ~ 08 活跃）。

---

## 12. 第三方客户端 / 库横向对比（方案 H）

| 技术                               | 用户账号登录 | 历史消息                          | 实时 | 媒体               | 开发难度 | 稳定性 | 备注                                                                                                      |
| ---------------------------------- | ------------ | --------------------------------- | ---- | ------------------ | -------- | ------ | --------------------------------------------------------------------------------------------------------- |
| Telegram Desktop（官方）           | ✅           | ✅（自带 Export 工具，HTML/JSON） | ✅   | ✅（受保护受限）   | —        | 高     | “零代码归档”路线，适合做初始导入源（[官方导出文档页](https://telegram.tg/blog/export-and-more?setln=uk)） |
| TDLib（官方库）                    | ✅           | ✅                                | ✅   | ✅（受保护受限）   | 高       | 高     | 推荐内核候选                                                                                              |
| Telethon（Python）                 | ✅           | ✅                                | ✅   | ✅                 | 低       | 中高   | 生态成熟：tg-archive、Telegram-Archive 均用它                                                             |
| Pyrogram（Python）                 | ✅           | ✅                                | ✅   | ✅                 | 低       | 中高   | tangyoha 下载器用它                                                                                       |
| GramJS（JS/TS）                    | ✅           | ✅                                | ✅   | ✅                 | 中       | 中     | Telegram Web A 内部用它；浏览器可跑                                                                       |
| MadelineProto（PHP）               | ✅           | ✅                                | ✅   | ✅                 | 中       | 中     | PHP 生态                                                                                                  |
| gotd（Go）                         | ✅           | ✅                                | ✅   | ✅                 | 中       | 中高   | iyear/tdl 用它，受保护下载存在边界问题（issue #842）                                                      |
| 第三方 Android fork（Nekogram 系） | ✅           | ✅                                | ✅   | ✅（常含绕过功能） | —        | 中     | Play 分发风险、供应链信任风险                                                                             |

**Archive Core 候选排序**：首选 TDLib（官方、稳定、跨平台）；次选 Telethon / Pyrogram（开发快、保护内容更宽松、但合规风险与维护责任在开发者身上）；gotd / GramJS 视团队语言而定。

---

## 13. 各技术路线横向对比

下表的“能看到 / 能获取 / 历史 / 实时 / 媒体 / 受保护”都以“该用户有访问权”为前提。

| 维度              | Bot API           | MTProto 用户会话 | TDLib                  | Web A/K 页面            | Browser Extension | UserScript   | Android+TDLib     | LSPosed          |
| ----------------- | ----------------- | ---------------- | ---------------------- | ----------------------- | ----------------- | ------------ | ----------------- | ---------------- |
| 数据来源          | 服务器推送        | 服务器拉取+推送  | 服务器拉取+推送        | 浏览器内 MTProto 客户端 | 同左（旁路读取）  | 同左         | 同 TDLib          | 注入官方 App     |
| 能看到什么        | 加入后新消息      | 全部             | 全部                   | 界面加载范围            | 界面加载范围      | 界面加载范围 | 全部              | 全部             |
| 能获取什么        | 消息+媒体(见 §4)  | 全字段+媒体      | 全字段；媒体受保护受限 | 已缓存/可滚动范围       | 同左              | 同左         | 全字段+媒体(受限) | 含“禁止保存”内容 |
| 历史              | ❌                | ✅ 分页全量      | ✅                     | 🟡 只能滚动加载         | 🟡 同左           | 🟡 同左      | ✅                | ✅               |
| 实时              | ✅                | ✅               | ✅                     | ✅（页面在跑）          | ✅                | ✅           | ✅                | ✅               |
| 媒体能力          | 有 file_id 即下载 | 强               | 强（保护受限）         | 可（流 URL）            | 可                | 可           | 强（保护受限）    | 强（可破保护）   |
| Protected Content | 跟随消息语义受限  | 多数可下载       | **主动不下载**         | 界面受限，可被脚本解除  | 可                | 可           | 主动不下载        | 可破             |
| 稳定性            | 高                | 中高             | 高                     | 低（内部结构易变）      | 低                | 低           | 高                | 低（每版本）     |
| Telegram 更新影响 | 无                | 低               | 低                     | **高**                  | **高**            | **高**       | 低                | **极高**         |
| 普通用户成本      | 低                | 中（登录+维护）  | 中                     | 低（装脚本/扩展）       | 低                | 低           | 中                | 极高（Root）     |
| 开发成本          | 低                | 中               | 高                     | 低-中                   | 中                | 低           | 高                | 高               |
| 维护成本          | 低                | 中               | 低                     | 高                      | 高                | 高           | 低                | 极高             |
| 合规风险          | 低                | 中-高            | 中                     | 低-中（绕过保护时才高） | 同左              | 同左         | 中                | 高               |

---

## 14. 五套以上完整架构方案

### 方案 1：TDLib Desktop（推荐基准）

本地桌面应用（Windows / Linux / macOS）内嵌 TDLib 内核 + 自有 SQLite / 搜索 / 媒体库 + Web UI。

- 数据流：TDLib → Normalizer → SQLite → 媒体落盘 + 索引。
- 受保护内容：正文/元数据照常归档，媒体标“不可保存”并记录 file 元数据；不主动绕过。

### 方案 2：MTProto 自研 Collector（Telethon / Pyrogram / gotd）

Docker / 服务端常驻，用户 session 拉全量历史 + listener。

- 代表参考：GeiserX/Telegram-Archive、tg-archive、tangyoha。
- 优点：受保护媒体多数能取、开发快；缺点：非官方登录的观察/封禁条款、协议边界问题要自己处理。

### 方案 3：Telegram Web + Browser Extension / UserScript

“所见即所得”采集器：用户在浏览器登录 Web A/K，扩展按需抓取当前/滚动历史消息与媒体，POST 到本地 Archive Core。

- 适合：受保护内容兜底、快速原型、移动场景（iOS Safari + Userscripts）。
- 不适合：全量百万级、长期无人值守。

### 方案 4：双 Collector（TDLib 主力 + Extension 补充）——推荐的长期架构

- Collector A（TDLib）：负责可正常获取的**全量历史 / 实时 / 媒体**。
- Collector B（Extension / Web 采集）：只处理 Collector A 标记为 `has_protected_content` 且用户明确选择“视图层采集”的聊天；默认关闭、带醒目风险提示。
- 好处：把“合规主通道”与“能力兜底”解耦；Telegram Web 更新只影响 B，不影响主归档；普通用户默认路径仍傻瓜化。

### 方案 5：Android + TDLib App

移动端归档伴侣：同一 Core 的 Android 壳；拍照 / 扫码登录；后台增量（受系统限制，需要前台服务 / WorkManager 策略）；搜索与时间线在手机上可看。

- 附加：Notification Listener 做“实时新消息轻记录”是可选的轻模式，不替代主同步。

### 方案 6（补充）：官方导出管线

Telegram Desktop 自带 “Export Telegram Data”（HTML/JSON，2026 版还加了“仅媒体 / 仅文字”开关），作为**初始导入源或零开发兜底**：用户自己导出 ZIP → 工具导入 Normalizer。官方能力、风险最低，但非实时、字段覆盖需验证（如 reaction / 编辑历史是否齐全，社区文档口径不一）。

---

## 15. 推荐方案（最终选择）

**最推荐：方案 4 = “TDLib 为默认主采集内核 + 分层 Archive Core + 可选视图层补充采集器”**，桌面三平台优先，Android 作为二期同内核客户端。

### 为什么选它

- TDLib 是唯一“官方维护 + 协议完整 + 跨平台 + 自带数据库 / 重连 / 更新排序 / 文件管理”的内核，长期维护成本最低；正好符合“开源 + 普通用户 + 多平台 + 免 Root + 可长期维护”。
- 不选裸 MTProto 作为**默认**通道，是因为非官方客户端登录本身被 Telegram 标记观察、条款风险最集中；它们可以作为开源“实验模式 / 高级模式”选项，但不应是产品默认。
- 不选 Web Extension 作为主力，是因为它只覆盖“浏览器里能看到的”，且 Telegram Web 高频改版，作为长期全量归档不可靠；但它与 TDLib 互补（受保护内容）。
- 不选 Android 定制 / LSPosed，原因见第 11 节。
- “采集层 / 归档层分离”是**合理的**：Telegram 侧没有可移植的数据格式，任何采集器输出都必须先进 Normalizer（把 `peer_id/message_id`、sender 快照、文件 ref 过期策略都抽象掉），Archive Core 才能换采集器而不换库。成熟项目已验证这条链（GeiserX 的 backup 容器与 viewer 容器分离、tg-archive 的 SQLite+静态导出、tangyoha 的下载器 + rclone 上传）。

### 技术栈建议

Rust 或 Go 做 Core（TDLib JSON 绑定成熟度：Rust `tdlib-rs`、Go 多绑定）→ 或者 Python（Telethon）先验证产品再做移植；桌面壳 Tauri / Electron；Web UI 用 Vue / React 均可；SQLite 起步、Postgres 可选。

### 数据流

`TDLib updates / 历史拉取 → Collector Adapter → EventBus → Normalizer → Archive DB + 媒体队列 → 去重落盘(SHA256) → 索引(FTS5 / Meili) → Tag Engine → Web UI`

### 组件与项目结构（草案）

```text
telegram-archive/
├── apps/
│   ├── desktop/          # Tauri/Electron 桌面壳（Windows/Linux/macOS）
│   ├── web/              # 浏览器版 UI（或嵌入桌面）
│   ├── android/          # 二期：Android TDLib 客户端
│   └── extension/        # 可选视图层采集器（MV3）
├── core/
│   ├── collector/        # 采集适配层：TDLib / MTProto / Web 三种适配器
│   │   ├── tdlib.rs      #   TDLib 主采集
│   │   ├── mtproto.rs    #   （可选）Telethon/Pyrogram/gotd 适配
│   │   └── viewport.rs   #   视图层采集协议（供 extension POST 数据）
│   ├── normalizer/       # TL/JSON → 内部稳定模型；chat 迁移、去重键
│   ├── database/         # Schema、迁移、WAL、Repository
│   ├── media/            # 下载队列、去重(SHA256)、缩略图、FileRef 刷新
│   ├── search/           # FTS5/Meili 索引层
│   ├── tagging/          # 人工/规则/自动标签（本地关键词优先）
│   ├── sync/             # 增量、断点、FloodWait、删除/编辑策略
│   └── events/           # 审计、时间线事件
└── server/               # 本地/自托管 API（FastAPI/axum）、auth、多用户可选
```

### 为什么不是更简单的单块

因为“受保护内容”注定会分化出两条采集通道；若不分离，之后加 Web 采集器会污染主库主流程。

---

## 16. 数据库设计

设计原则：**Telegram 的 ID 只做来源键，本地另有稳定主键**；消息唯一键 = `(chat_id, tg_message_id)`；用户/聊天/消息都存“来源快照”以便改名后时间线仍正确；编辑/删除不覆盖历史，用事件表审计。

草案（SQLite / Postgres 兼容；字段可再收敛）：

```sql
accounts(id, tg_user_id, api_id_hash_ref, session_ref, created_at)      -- 多账号隔离
users(id, tg_user_id UNIQUE, username, first_name, last_name,
      phone_hash, is_bot, avatar_path, raw_json, updated_at)
chats(id, tg_chat_id UNIQUE, type, title, username, is_forum,
      has_protected_content, migrated_from_id, avatar_path,
      last_sync_message_id, sync_state, raw_json, updated_at)
messages(id, account_id, chat_id, tg_message_id, sender_user_id,
         sender_snapshot, date, edit_date, content_type, text,
         caption, has_media, media_album_id, topic_id, thread_id,
         reply_to_msg_id, reply_to_chat_id, forward_from_chat_id,
         forward_from_msg_id, forward_sender_snapshot, via_bot_id,
         is_outgoing, can_be_saved, raw_json,
         UNIQUE(chat_id, tg_message_id))
media(id, message_id, media_index, tg_file_unique_id UNIQUE, tg_file_id,
      dc_id, access_hash, mime, ext, width, height, duration,
      size_bytes, original_name, sha256, status, local_path,
      thumb_path, downloaded_at)
files(id, sha256 UNIQUE, size_bytes, mime, ref_count, created_at)       -- 去重物理文件
tags(id, name UNIQUE, kind [manual|rule|auto], rule_json, created_at)
message_tags(message_id, tag_id, source, confidence, created_at, UNIQUE(...))
user_tags(user_id, tag_id, ...)
chat_tags(chat_id, tag_id, ...)
reactions(message_id, emoji, count, is_own, updated_at)
replies -- 由 messages.reply_to_* 派生，或独立表(message_id, reply_to)
forwards -- 由 messages.forward_* 派生，或独立表(message_id, origin_*)
albums(grouped_id, chat_id, msg_count, media_ids)
events(id, chat_id, tg_message_id, kind[new|edit|delete|reaction|join...],
       payload_json, created_at)                                        -- 编辑历史/审计
sync_cursors(account_id, chat_id, last_id, max_id, dirty, updated_at)
download_queue(media_id, priority, attempts, last_error, next_retry_at)
```

要点：

- **Basic Group → Supergroup 迁移**：`chats.migrated_from_id` 关联；采集器把旧群最后一条消息作为续传锚点。
- **消息删除**：默认软删除（`deleted_at`），事件表留痕；可选硬删。
- **编辑**：`messages.text` 存最新版，`message_edits`（或 events）存历史版，时间线可展开。
- **相册 / Thread / Topic**：`media_album_id` 为 grouped_id（TDLib `mediaAlbumId`）；forum 消息的 `thread_id` 即其 reply-to 消息；Topic 归属 `chat` 级 `forum_topic` 表或字段。
- **Reaction**：实时流只做近似，定期全量 sweep 校准（参考 Telegram-Archive `REACTION_RESWEEP_*`）。
- **媒体去重**：`files.sha256` 唯一 + 硬链接/引用计数；Telegram-Archive 用 symlink 实现同样目标。

---

## 17. 媒体存储设计

### 方案比较

| 方案                       | 适合         | 成本/特点                                                                                                          |
| -------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------ |
| 本地文件系统（NAS/外接盘） | 个人默认     | 最简单；目录 = `chat/date/type/msgid.ext`；配合 sha256 去重与 `files` 表；备份=rsync                               |
| MinIO                      | 自托管多设备 | S3 兼容、开源，但要自己运维，个人偏重                                                                              |
| Cloudflare R2              | 云上归档     | 存储 $0.015/GB、**零出口流量费**（[2026 对比](https://agentdeals.dev/storage-comparison-2026)），适合 Web 分享场景 |
| S3                         | 生态最全     | 出口流量费高，个人归档不划算                                                                                       |
| NAS 上的对象存储           | 家庭媒体库   | 与本地方案等价，只是协议化                                                                                         |

### 设计要点

- 目录键建议 `sha256[:2]/sha256` 内容寻址 + `media` 表指向；或 `chat_id/yyyy-mm/type/message_id.ext` 人类可读。**推荐内容寻址 + 软链接/引用计数**（去重、VERIFY_MEDIA 重新下载时天然幂等）。
- 存原文件 + 独立缩略图（webp/jpeg），缩略图也进 `files`。
- 保留 `tg_file_unique_id`（Telegram 对同一文件稳定）与 `sha256` 双键去重；file_id / access_hash 会过期，作为“下载凭据”存但要能刷新。
- 大文件断点：TDLib 自带；自研时按 range/并行分片（Telegram-Archive 的 `PARALLEL_DOWNLOAD_*` 是现成实践），并限制并发与单文件超时。
- 文档类（pdf/epub）单独类型过滤；贴纸按 webp/tgs/lottie 分开存，播放器再定。

---

## 18. 搜索系统

### 方案比较

| 方案            | 部署难度       | 速度 | 中文                                                                                                                                                                  | 个人百万级             | 备注                          |
| --------------- | -------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ----------------------------- |
| SQLite FTS5     | 零             | 快   | **需应用层分词**（unicode61 按字切，效果差；用 jieba 预分词后空格索引是社区通行做法，[参考](https://docs.rs/anamnesis-store/latest/src/anamnesis_store/cjk.rs.html)） | ✅                     | 单文件、免运维，个人默认      |
| PostgreSQL FTS  | 中             | 快   | 需 zhparser / pg_jieba / pg_search 扩展                                                                                                                               | ✅                     | 多人/多设备用                 |
| Meilisearch     | 低（单二进制） | 快   | ✅ 内置 charabia+jieba，1.15 起中文增强（[官方](https://meilisearch.dev/docs/resources/help/language)、[1.15 blog](https://meilisearch.dev/blog/meilisearch-1-15)）   | ✅（内存需求随数据涨） | 自带 UI、模糊匹配、易用性最强 |
| Typesense       | 低             | 快   | 🟡 0.24 起 field-level locale 支持 CJK（[docs](https://typesense.org/docs/0.24.1/api/)），Meili 对比页称其 CJK 分词不如自己                                           | ✅                     | 需自托管                      |
| OpenSearch / ES | 高             | 快   | ✅（IK / elasticsearch-analysis-ik 等）                                                                                                                               | ✅                     | 个人过重                      |

### 中文 Telegram 搜索建议

默认档 = SQLite FTS5 + **入库前 jieba 预分词**（存 `text_zh_tokenized` 列，仅索引用）；也可直接三列：原文、jieba 分词串、拼音/首字母（可选）。需求上升后再挂 Meilisearch（同一批消息导出即可，无需改采集层）。搜索要支持：全库、按人、按群、按时间窗、按媒体类型、按标签、按话题——这些用 SQL 过滤 + FTS MATCH 组合即可，不需要 ES。

---

## 19. 标签系统

- **人工标签**：`user_tags / chat_tags / message_tags` 多对多；支持批量、拖拽、右键。
- **规则标签**：编译成确定性的匹配器（关键词/正则/发送者/群/时间窗/媒体类型），入库或消息落库时增量打标；规则要可调试（`rule_json` 存定义，`tagging.log` 存命中原因）。例如 `Rust|Cargo|Tokio → #Rust`。
- **自动标签**（主题分类 / 关键词提取）：**注意 2026-02-03 Telegram 新增“Content Licensing and AI Scraping Terms”，明确禁止任何人抓取平台数据用于训练/微调/开发 AI 模型**（[Open Terms Archive 记录](https://opentermsarchive.org/en/memos/telegram-prohibits-collecting-data-for-ai-use/)；API Terms 原文见 [镜像](https://c.tg.goldica.ir/api/terms)）。因此产品内自动标签应使用**本地规则 + 本地小模型/词典/关键词统计**，不得把抓取内容送去第三方训练 API（即使 OpenRouter/LLM 也不行，除非数据完全是用户本人产出且明确授权——即便如此条款风险仍在，需法务评估）。分类模型建议离线路由：规则命中 → 关键词/朴素贝叶斯 →（可选）本地 LLM，全部在用户设备上跑。

---

## 20. 同步系统

- **首次同步**：`getDialogs（分页，会遇 FloodWait）→ 按用户选择过滤 chat → 每个 chat 用 messages.getHistory 从最新往回翻（offset_id 游标）→ 写库 → 媒体入队`。全量放后台任务，可暂停/续传。
- **增量**：常驻长连接 updates → 事件队列（新消息/编辑/删除/reaction/chat 变动）→ Normalizer → DB；同步间隙由定时全量 sweep 补漏（GeiserX 默认 6h cron）。
- **断点续传**：每 chat 保存 `last_sync_message_id`；每批（如 100 条）后 checkpoint（参考其 `BATCH_SIZE / CHECKPOINT_INTERVAL`）；崩溃后从最近 checkpoint 续。
- **去重**：DB 唯一键 + upsert；消息 ID 空洞用 gap-fill（`FILL_GAPS`：按 ID 区间补拉）。
- **FloodWait / 网络中断**：队列化 + 指数退避 + 长等待分档（<60s 内部等待，>60s 挂起任务并告警）；Telethon 默认 <60s 自动 sleep，gotd/TDLib 也有中间件/调度器，直接借鉴。
- **大群 / 百万级**：单 chat 串行翻页（Telegram 服务器按会话限速，无捷径）；多 chat 并发 2~5；**总速率以 FloodWait 反馈为准做自适应**。媒体下载与消息拉取分队列，下载并发可调（tangyoha 默认 5、Telegram-Archive 支持并行分片）。
- **编辑 / 删除策略**：默认记录编辑历史（events）、删除软删除；是否随源删除是可配置策略（Telegram-Archive 的 `DELETION_MODE=soft|hard` 是很好的先例）。
- **多账号**：session 各自独立、速率预算独立、数据按 `account_id` 隔离（Telegram-Archive v8 已实现，直接抄架构）。

---

## 21. 傻瓜化产品设计

目标流程：安装 → 连接 Telegram（扫码/手机号+验证码）→ 授权采集器为新“设备” → 勾选聊天 → 开始归档 → 打开时间线。

- 登录体验：优先“扫码”，其次验证码 + 2FA；**必须明确告知“这是以你的账号作为客户端登录，Telegram 会把本工具视为一台设备/非官方客户端”**。
- 默认安全：仅“本人有权限的聊天”、仅本地、默认尊重内容保护、一键导出/清理、一键删除会话与本地数据。
- 采集能力分级：`标准（TDLib）→ 扩展（视图层，需手动开）→ 实验（裸 MTProto 全量）`，向导里讲清差异。
- 首次运行：自动选“最近 N 个会话”，同步进度条 = 消息进度 + 媒体进度 + FloodWait 倒计时（这是傻瓜化关键：让用户知道“不是卡了”）。
- 结束态：一个像 Telegram 的时间线 Web UI（参考 Telegram-Archive 的“仿官方 UI + 真实时更新”已证明可行）。

---

## 22. 开发路线图

1. **P0（验证）**：TDLib/Telethon 最小采集器跑通“1 个聊天全量 + 增量 + 落 SQLite”；跑 100 万条量级压测 FloodWait/断点。
2. **P1**：Normalizer 模型 + 完整 DB schema（§16）+ 媒体队列与去重 + 基础时间线/全文搜索（FTS5 + jieba）。
3. **P2**：标签三件套、规则引擎、按人/群/媒体/时间窗查询、导出（HTML/JSON，兼容官方导出格式）。
4. **P3**：桌面三平台壳 + 自动更新 + 多账号 + 移动端 TDLib App（共享 Core）。
5. **P4**：视图层 Extension 采集器（受保护内容，默认关）+ 文档化合规边界。
6. 每阶段都做“账号安全实验账号”冒烟：确认不触发风控再放量。

---

## 23. 风险与 Telegram 条款

必须写进产品文档与 ToS 的几件事：

1. **非官方客户端观察与封禁**：Telegram API 条款及官方库文档明确：“由于 API 被滥用，**使用非官方客户端登录/注册的账号会被自动置于观察之下**；用于灌水/垃圾/刷量会永久封禁”（[TDLib SUPPORT.md](https://github.com/tdlib/td/blob/master/.github/SUPPORT.md) / [gotd SUPPORT.md](https://raw.githubusercontent.com/gotd/td/v0.54.0-alpha.1/.github/SUPPORT.md)）。归档“自己可见的内容”不等于豁免；批量高频拉取可能触发风控。
2. **AI/ML 数据禁令（2026-02-03 新增）**：禁止“为训练/微调/验证/部署 AI 模型而使用、访问或聚合平台数据”，且明确适用于**所有用户、企业与第三方服务**（[Open Terms Archive](https://opentermsarchive.org/en/memos/telegram-prohibits-collecting-data-for-ai-use/)）。→ 自动标签必须本地化、通用模型训练禁止。
3. **内容保护的“绕过”属性**：官方把它定义为“限制成员保存/转发”的平台功能；Web 脚本/客户端补丁/LSPosed 模块恢复保存能力，是在绕过对方设置的限制。它**通常不等于入侵**（数据在客户端、未解密任何东西），但违反聊天所有者的意图，且有被 Telegram 判定违反条款的风险；产品默认合规、高级功能自担风险是负责任的做法。
4. **私人数据与属地法律**：归档含私聊内容涉及个人信息处理（中国 PIPL / 欧盟 GDPR 视用户所在地）；产品应本地优先、默认不出设备；公域频道内容再分发仍涉及版权。
5. **Google Play / 应用商店**：第三方 Telegram 客户端上架历史反复证明会被下架/停止更新（NekoX 案例），内容保护绕过功能进一步增加审核风险。
6. **第三方 fork 供应链**：Nekogram 等热门第三方客户端 2026 年被曝疑似收集手机号（[Android Jefe](https://www.androidjefe.com/nekogram-la-app-de-telegram-mas-popular-en-android-tiene-codigo-malicioso/)，社区指控，需自行核实）——自研产品绝不应把用户会话交给第三方闭源库。

---

## 24. 最终结论

- **Telegram 没有“官方导出别人聊天”的接口**：Bot API 不能读历史；真正能读全量历史的是“用户账号作为客户端”的 MTProto 层。
- **Content Protection 是“服务器标记 + 客户端执行”的软保护**：服务器仍向有权限成员下发正文与媒体；官方客户端隐藏保存/复制/转发并在 Android 用 `FLAG_SECURE` 拦截图。**TDLib 选择遵守该标记（不把受保护媒体加入下载）**；裸 MTProto 库（Telethon / Pyrogram / gotd 等）多数能下载但存在边界问题；Web 脚本/桌面补丁/LSPosed 则通过修改客户端行为实现“解除限制”——它们改变的都不是服务器权限，而是**客户端是否执行保护策略**。
- **采集能力与归档能力必须分离**：TDLib / MTProto / Web / Extension 只是“不同深度、不同稳定性、不同合规成本的采集器”，共享同一个 Normalizer → Archive Core → UI 管线，才能把“Telegram 改版”和“未来换采集器”的冲击隔离掉。
- **最推荐产品架构**：TDLib 为主采集内核（官方稳定、免 Root、跨平台、自带数据库与实时同步），Telethon / Web-extension 作为显式可选通道处理边界场景，默认尊重内容保护；SQLite（+ FTS5 / 可选 Meili）+ 本地媒体库（sha256 去重）起步，Postgres / 对象存储在需要多设备 / Web 分享时再演进。
- 如果接受“更激进但更高风险”，把主采集器换成 Telethon / Pyrogram 能把受保护媒体覆盖率提上去（有多个活跃项目证明可行），代价是更频繁地直面 Telegram 的风控与条款变化——这应是一个**产品开关**，而不是默认值。

### 最需要实测验证的三件事

文档无法替代的三项验证：

1. 目标账号在 TDLib 与裸 MTProto 下对受保护聊天的真实媒体可取性；
2. 大规模全量同步时账号的实际 FloodWait 曲线与风控触发点；
3. Telegram Web A/K 在当前时点上的实际 DOM / 存储结构（报告所引脚本会随版本漂移）。

---

## 附录 A：核心功能聚焦 —— 直接保存到自己的 Telegram 频道

### A.1 需求表述

用户登录自己的账号 → 选择自己有权访问的聊天 → 归档进程把消息（正文、媒体、转发来源、时间、发送者等**可保留字段**）写入用户自己拥有的一个或多个频道。用户直接在自己的 Telegram 客户端里浏览“存档”，形成长期云端副本；本地数据库 / Web UI 不再是必需品，最多保留为索引与断点层。

### A.2 技术可行性总判

**可行。** 本质是两条链路的组合：

- 采集：采用本报告任一采集路线（推荐 TDLib 或裸 MTProto 用户会话）读取源聊天；
- 回写：以**用户账号**（MTProto / TDLib）向用户自己拥有的频道发消息。

**纯 Bot 方案不可行**：Bot 无历史读取能力，且受保护语义下限制最多，只能做“通知 / 指令入口”。回写也必须用用户账号（Bot 即便加了你的频道，也只是能发不能采）。

### A.3 回写的两条保真路径

1. **Forward（转发）**：`messages.forwardMessages`（Telethon/Pyrogram/TDLib 均有封装）。
   - 保真：转发头（原聊天名 / 发送者 / 原日期）、媒体原文件、相册结构；最快，无需先下载。
   - 限制：仅当源聊天**允许转发**时可用；内容保护聊天会直接被服务器拒绝（社区实测错误为 `CHAT_FORWARDS_RESTRICTED`，见 [WTelegramClient #198](https://github.com/wiz0u/WTelegramClient/issues/198)，2023-10；[Telegram_Restricted_Media_Downloader DeepWiki](<https://deepwiki.com/Gentlesprite/Telegram_Restricted_Media_Downloader/4.2-restricted-content-handling-(download-upload-workflow)>)，2026-04）。
2. **Copy / 重发**：`copyMessage` 语义或“下载后重传”。
   - 进入频道后显示为“你自己的新消息”，无转发头；可在 caption / 标题中附加元数据（原聊天、原 message id、原日期、链接）。
   - 受保护聊天若走“下载重传”，属于绕过源聊天所有者的转发限制，是社区工具的做法（如 [xditya/GetRestrictedMessages](https://github.com/xditya/GetRestrictedMessages)）；**本项目默认不做，若做必须放“高级模式”并由用户显式开启**，见 A.7。

### A.4 各字段在频道里的保真度

| 字段            | Forward 路径          | Copy/重发路径             | 说明                                                                            |
| --------------- | --------------------- | ------------------------- | ------------------------------------------------------------------------------- |
| 正文            | ✅ 原样               | ✅ 原样                   | copy 会失去转发头，但文本在                                                     |
| 媒体文件        | ✅ 原文件             | ✅ 原文件                 | copy 一般需下载重传                                                             |
| 相册（Album）   | ✅ 合并显示           | ✅ 需 sendMediaGroup 重组 | 重传需按 `grouped_id` 分组并保持顺序                                            |
| 转发来源        | ✅ 自动带上           | ❌ 丢失                   | 需手工写进 caption                                                              |
| 原始 message ID | ❌ 不自动保留         | ❌                        | 建议写入 caption（`from: <chat>#<msg_id>`）                                     |
| 发布时间        | 🟡 转发头显示原日期   | ❌                        | 可写进 caption；频道帖自身时间=回写时间                                         |
| Reply / Thread  | ❌ 频道内无法保留层级 | ❌                        | 只能把 `reply_to` 写进 caption；频道消息本身不能作为回复链承载                  |
| Reaction        | ❌ 不迁移             | ❌                        | 可把 reaction 统计作为文本附加                                                  |
| 编辑历史        | ❌                    | ❌                        | 可配置“源消息被编辑 → 频道发一条更新通知”                                       |
| 删除事件        | ❌                    | ❌                        | 可配置“源消息被删除 → 撤回已镜像的频道帖或发删除通知”；撤回的可行性与时限需实测 |

### A.5 组织方式选项

1. **单频道 + Hashtag/元数据**：每条消息带 `#chat:<name>`、`#user:<id>`、`#yyyy-mm` 等标签，利用 Telegram 内搜索与标签页。实现最简单，适合几百 ~ 几万条；时间线等于频道消息流。
2. **每聊天一个私有频道**：最像“群组档案页”，可分别进入查看。受账号限制影响最大（见 A.6），只适合少量重点聊天。
3. **论坛群替代方案（Supergroup + Topics）**：一个话题 = 一个源聊天/一个人，可保留更多结构、置顶与评论语义；但它不是 Channel 语义，发送者统一显示为归档账号，元数据仍需写入文本/签名。若“目录式多聊天归档”是刚需，论坛群往往比“建几百个频道”更现实。
4. **混合**：重点聊天各自独立频道，其余进统一归档频道。

### A.6 数量与大小限制（2026 口径）

- 一个账号可加入 / 创建的聊天与频道总数：标准约 500，Premium 约 1000（[DocOfCard](https://tg.docofcard.com/posts/1820)、[targethunter 限制页](https://bot.targethunter.help/platforms/tg/telegram-limity-telegram) 等社区多来源，2026-03；具体随版本变动，需实测）。
- 公开频道 / 群创建数量有单独限制（社区口径 10~20 不等，[DocOfCard](https://tg.docofcard.com/posts/1820) 与 [vpsgongyi](https://www.vpsgongyi.net/archives/3527.html) 数字不一致——建议归档全部用**私有频道**）。
- 单文件上传：免费 2 GB，Premium 4 GB（[usecarly 2026 总结](https://www.usecarly.com/blog/telegram-file-size-limit/) 等）；总存储量无官方上限，但超过单文件上限的源文件无法直接入频道。
- 发送速率：消息与媒体均有内部限速，连续大批量回写必然触发 FloodWait，必须做队列 + 节流 + 重试 + 断点。

### A.7 受保护内容（合规重点，不展开绕过步骤）

- 服务器**会拒绝**从 `noforwards` / `has_protected_content` 聊天执行 forward（错误如 `CHAT_FORWARDS_RESTRICTED`）。
- 社区工具通过“下载 → 重发”实现的“复制”，规避的是源聊天的转发限制，属于客户端行为绕过，不是服务器越权。
- **本项目默认策略**：对 `has_protected_content` 聊天只归档元数据（时间线、chat/message id、可获取的 sender/文本摘要），不自动重发媒体；如需“高级模式”，必须由用户逐聊天显式开启，并在 UI 中持续提示条款与账号风险。

### A.8 对整体架构的影响（调整后的推荐形态）

新增 **Channel Writer** 模块，数据流变为：

```text
Telegram（源聊天）
    ↓
Collector（TDLib / MTProto 用户会话）
    ↓
Normalizer
    ↓
（可选）Index DB —— 断点游标 / 去重 / 统计 / 加速搜索
    ↓
Channel Writer —— forward 优先，copy/重发兜底，含元数据 caption 策略
    ↓
你自己的 Telegram 频道（私有、按人/群/时间线组织）
```

架构影响：

- **本地媒体库不再是“最终存储”**，只作为 copy 路径的临时下载缓存；forward 路径不需要本地落盘。
- **本地 DB 保留但降级**：价值在于断点续传、防止重复回写（按 `(chat_id, msg_id)` 记录“已镜像”状态）、统计（某人消息数 / 各群分布）、以及把 caption 元数据编得规范。
- **搜索体验移交 Telegram**：频道内搜索/标签由 Telegram 提供；中文全文检索质量与本地 FTS 不同，若不够用再保留本地索引做“查询 → 跳转到频道消息链接”。
- **产品形态变化**：Web UI 从“必须”降级为“可选管理台”；桌面壳可简化为“配置向导 + 常驻同步状态”。

### A.9 更新后的推荐结论

若“频道直存”是唯一目标：

- 采集端维持第 15 节结论（TDLib 为主内核，跨平台、稳定、自带实时与断点）；
- 回写端新增 Channel Writer，**forward 优先**（保真度最高、成本最低），copy/重发仅用于转发头不重要或 forward 受限的非保护内容；
- 受保护聊天默认只归档元数据；
- 本地 DB 保留为“索引 + 断点 + 防重”层，UI 降级为向导与状态页；
- 先按“单私有频道 + 元数据标签”做 MVP，再视需要演进为“重点聊天独立频道”或“论坛群多话题”形态。

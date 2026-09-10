# tg-archive —— 把 Telegram 聊天镜像到你自己的频道（MVP）

> 对应 `docs/TELEGRAM_ARCHIVE_RESEARCH.md` 附录 A 的 MVP：
> **采集（MTProto 用户会话）→ 本地 SQLite 索引/断点 → Channel Writer 写入你自己拥有的私有频道**。
> 本地数据库是索引 + 断点 + 防重层，不是最终存储；浏览/检索发生在 Telegram 客户端内。
>
> 状态：**可运行的验证原型**（已用离线测试覆盖核心链路；尚未用真实账号做线上验证）。

## 它做什么

```text
Telegram 源聊天（你有权访问）
      │  Telethon（MTProto 用户会话，非官方客户端）
      ▼
Normalizer + SQLite（messages / events / mirror_log）
      │  copy：重发为“你自己的帖子”，caption 带 #标签
      │  forward：原样转发（保真度最高，但无法附加标签）
      ▼
你自己的私有频道（单频道 + #chat_xxx / #user_xxx / #date_2026_09）
```

核心特性：

- **增量同步 + 断点续传**：按 `chat.last_sync_message_id` 游标抓取，分页入库；`mirror_log` 记录每条消息是否已写入频道，重跑幂等。
- **两种写入模式**：
  - `copy`（默认）：带元数据标签重发，适合“单频道 + 标签组织”。
  - `forward`：服务器级转发，保真度最高，但没有附加标签。
- **受保护内容默认不写入频道**：只保留本地索引；归档需逐次显式开启高级策略：`--protected text_only`（仅文字）或 `--protected allow_media`（含媒体，“下载→重发”，绕过保存限制，高风险，详见“边界与合规”）。
- 实时增量：`mirror --listen` 同步后保持监听，新消息/编辑/删除自动入库（新消息会写入频道）。

## 快速开始

```bash
cd tg-archive

# 1. 安装（Python >= 3.10）
uv venv .venv
uv pip install --python .venv -e ".[qr]"   # qr 额外依赖用于扫码登录；不要可去掉

# 2. 配置 api_id / api_hash（https://my.telegram.org -> API development tools）
cp .env.example .env
#    编辑 .env：TG_API_ID、TG_API_HASH（可选 TG_ARCHIVE_CHANNEL / TG_PHONE）

# 3. 登录（二选一）
#    方式 A：扫码（推荐，不需要短信验证码）
.venv/bin/tg-archive login --qr
#    方式 B：手机号 + 短信验证码
.venv/bin/tg-archive login
#    session 都保存在 data/archive.session

# 4. 看有哪些会话（带 🛡️ = 内容保护）
.venv/bin/tg-archive chats

# 5. 先干跑一次：只同步索引、打印将写入的计划，不发送
.venv/bin/tg-archive mirror @你的源聊天 --dry-run

# 6. 正式镜像到私有频道（先建好频道并把自己加为管理员）
.venv/bin/tg-archive mirror @你的源聊天 --channel @你的归档频道 --yes

# 7. 之后每次跑 mirror 只处理新增；或加 --listen 常驻
.venv/bin/tg-archive mirror @你的源聊天 --channel @你的归档频道 --listen
```

常用开关：

| 参数 | 说明 |
|---|---|
| `--mode forward` | 原样转发（受保护聊天会被服务器拒绝，配合默认 skip 策略） |
| `--protected text_only` | 高级模式：受保护聊天仅复制纯文字（媒体不复制） |
| `--protected allow_media` | 高级模式：受保护聊天也下载并重发媒体（绕过保存限制，**高风险**，仅在确认有权时用） |
| `--dry-run` | 只同步本地索引并列出计划 |
| `--media-only` / `--since` / `--until` | 过滤条件 |
| `--fetch-limit N` | 单次运行最多新增 N 条后暂停（断点续传，不会丢老消息） |
| `--post-delay 1.5` | 频道写入间隔（秒），保守一点避免 FloodWait |
| `--max-posts N` | 本次最多写 N 条到频道（分批跑） |

> 扫码登录说明：`login --qr` 会在终端打印二维码并保存到 `data/login_qr.png`，
> 用手机 Telegram「设置 → 设备 → 扫码登录」扫描即可，免短信验证码；过期会自动重新生成。
> `api_id / api_hash` 仍需先在 my.telegram.org 申请一次（这是应用身份，扫码只替代“验证码”这一步）。

## 标签与元数据

`copy` 模式的 caption 形如：

```text
#chat_群名 #user_42 #date_2026_09
<原文 / 媒体原 caption>
📅 2026-09-07 04:00 UTC · 📌 群名 · msg 5
```

说明：Telegram 把 `:` 和 `-` 当作词分隔，`#chat:xxx` / `#2026-09` 并不能作为一个可搜索标签，所以 MVP 使用 `#chat_…`、`#user_…`、`#date_…` 这类下划线标签。转发（forward）不能附加文字，因此没有标签；需要标签请用 `copy`。

## 数据与本地文件

- `data/archive.sqlite3`：`chats / messages / events / mirror_log`（WAL）。
- `data/archive.session`：Telethon 登录会话（等同“另一台设备”，勿泄露）。
- `data/media/`：copy 模式临时下载缓存，发送后删除。

## 测试

```bash
cd tg-archive
.venv/bin/python -m pytest          # 19 个用例：normalizer/caption/DB/离线端到端
```

离线端到端测试用一个 FakeClient 完整跑通了「同步 → 保护策略 → copy/forward 写频道 → mirror_log 幂等」。

## 已知限制（MVP）

- **转发相册（album）**：MVP 逐条发送/转发，未按 `grouped_id` 重组相册；相册在频道里可能不合并显示。
- **超长文本**：>4000 字会截断并加标记，未做分段发送。
- **分批同步的时间线顺序**：若用 `--fetch-limit` 分批且每次直接发频道，频道时间线会先出现较新的消息；想保持时间线顺序，建议先 `--dry-run` 把索引同步完整，再正式镜像。
- **编辑/删除不回写频道**：本地 events 表记录编辑与删除，频道帖子不自动更新/撤回。
- **Basic Group → Supergroup 迁移**：未处理 `migrated_from_id`（本地表已预留列）。
- **多账号**：未实现；`accounts` 表已预留。
- **受保护聊天的“下载重传”**：仅通过 `--protected allow_media` 显式开启（见下），默认不做。

## 边界与合规（必读）

1. 本工具是**以你的普通账号作为非官方客户端**登录（Telegram 会把它列为独立设备，并可能将账号置于观察状态）。请只归档你有权访问、且你确认可以这样使用的聊天；大批量高频拉取可能触发风控。
2. **内容保护**（`has_protected_content` / `noforwards`）是“服务器标记 + 客户端执行”的软保护：服务器仍会把正文和媒体下发给有权限的成员，限制主要靠客户端执行。本项目默认策略：受保护聊天**不写入频道**，只留本地索引。
   - `--protected text_only`：仅复制纯文字，媒体不复制。
   - `--protected allow_media`：对受保护聊天执行“下载 → 重发”来保留视频/音频/图片。这会**绕过聊天所有者设置的保存/转发限制**，违背对方意图并违反 Telegram 平台规则，账号存在被观察、风控乃至封禁的风险；也可能触发服务器/DC 层的下载失败。它只应在你确认有权这样归档的聊天上使用，且每次运行都会打印风险提示。
3. 不要把归档内容送去第三方 AI/模型训练 API——Telegram 条款明确禁止采集平台数据用于 AI（自动标签等请只做本地规则）。
4. 私聊/群聊归档涉及个人信息与版权：本地优先、默认不出设备；再分发前请确认你有权这样做。

## 需要真机验证的三件事（来自调研报告 §24）

代码层已尽量收敛风险，但线上行为仍需用实验账号实测：

1. 真实账号在 Telethon 下的历史分页/FloodWait 曲线与风控触发点；
2. 受保护聊天在 `copy`（重发）与 `forward`（被拒）下的真实行为；
3. 相册、大文件（>2GB 免费限额）、voice/sticker 的实际转发/重发保真度。

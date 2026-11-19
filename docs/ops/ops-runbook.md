# 运维手册索引

面向部署运营者的操作手册。代码行为由注释和测试钉住,这里只记**需要人到 Cloudflare/GitHub 后台做的配置**。

## 1. D1 每日备份(d1-backup.yml)

**机制**:GitHub Actions 每天 18:20 UTC 用 `wrangler d1 export` 导整库 SQL → 传 R2 `d1-backup.sql` 前缀 → 回读校验(文件非空且含 `CREATE TABLE`)。

**首次启用需要配置的 secrets**(GitHub 仓库 → Settings → Secrets and variables → Actions):

| Secret                  | 值                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | 与 deploy 共用;Account 级 Workers R2 Storage: Edit + D1: Edit                          |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账户 ID                                                                     |
| `R2_BACKUP_BUCKET`      | 备份桶名;桶不存在时工作流自动创建(R2 桶默认私有,不开公开访问),未配置时守卫步骤直接报错 |

配好后用 Actions 页面的 **Run workflow**(workflow_dispatch)手动跑一次,绿了才算启用。
(2026-11-04 起工作流带守卫:`R2_BACKUP_BUCKET` 未配置会在导出前人话报错——
此前 secret 一直缺失、备份连续失败一个月才被发现;桶缺失时会幂等自动创建。)

**R2 权限排障(2026-11-19 run 44429772644 的教训)**:`CLOUDFLARE_API_TOKEN` 缺 Account 级 **Workers R2 Storage: Edit** 权限时,R2 相关步骤报 `Authentication error [code: 10000]`(请求 `GET /accounts/{account_id}/r2/buckets`),导出/上传/校验不会运行,数据库处于无备份保护状态。
判别方法:同一 token 能正常 deploy(D1/Workers 权限在),报错又带 Authentication 字样;wrangler 能解析出账户说明 token 本身有效,报 10000 就是缺 R2 权限而非密钥无效。
「桶不存在」不会报 Authentication error,报了 10000 就别再去猜桶名。
工作流已在建桶前用 `wrangler r2 bucket list` 做前置权限自检并 fail-fast(见 d1-backup.yml)。

手动授权步骤(全部在 Cloudflare/GitHub 后台操作,按顺序;清单只列步骤、不含任何凭据值):

1. 打开 [dash.cloudflare.com](https://dash.cloudflare.com) → 右上角头像 → **My Profile** → **API Tokens**;
2. 找到 `CLOUDFLARE_API_TOKEN` 对应的 User API Token → 点 **Edit**(只在后台界面操作,不要把 token 值复制到任何地方);
3. **Permissions** 里新增一行 **Account | Workers R2 Storage | Edit**,保留既有 D1/Workers 权限行不动;
4. 点 **Save** 保存;
5. 回 GitHub 仓库 → Actions → **d1-backup** → **Run workflow** 手动重跑(workflow_dispatch 入口定义在 d1-backup.yml 顶部的 `on:` 段),全绿才算修好。

可选捷径:先在 Cloudflare Dashboard → R2 手动建桶可省去工作流自动建桶一步,但**只建桶不够**:对象 put/get 用的是同一套权限,不授权的话 `Authentication error [code: 10000]` 会在上传步原样复现。

**恢复流程**:R2 下载对应日期的 SQL → `wrangler d1 execute DB --remote --file <dump>.sql`(空库重放)或按表挑选重放。SQL 里有 `CREATE TABLE`,重放前确认目标库是空的。

**保留策略**:当前 R2 不自动过期,90 天后旧文件需手动清(或给桶配一条 lifecycle rule:`prefix=d1/`,过期 90 天——在 Cloudflare 后台 R2 → 桶 → Settings → Object lifecycle 配)。

**和 Time Travel 的关系**:Time Travel(30 天 PITR)仍是第一恢复手段(快、精确到分钟);这个备份覆盖"30 天后才发现"、"整账号出问题"、"想恢复单张表"三类 Time Travel 救不了的场景。

## 2. 预算异常告警(ops-alerting.md)

单请求 D1/KV 计数突破硬阈值时发 ERROR 级 `budget_anomaly` 日志。告警接入步骤见 [ops-alerting.md](./ops-alerting.md)。

## 3. 国内中继(emoemok.top)故障预案

**现状**:国内用户唯一入口是 Vercel 上的 cn-relay(`cn-relay/vercel.json`),三条路由——`/api/submit*` 直达投稿机器人 Worker,其余全部转发 `emoe.eu.cc`。它是单点:Vercel 侧故障、域名被墙、或 `*.vercel.app` 泛解析问题都会让国内整体失联(emoe.eu.cc 本身因 SNI 阻断在国内不可直连)。

**故障时按序排查**:

1. `curl -sS -o /dev/null -w "%{http_code} %{time_total}s" https://emoemok.top/health`——通则不是中继问题;
2. 中继挂了(5xx/超时):Vercel Dashboard → cn-relay 项目 → Deployments/Logs 查状态;Vercel 平台级故障只能等,同时把社区群公告切到 Telegram 机器人入口(bot 走 Cloudflare,不经 Vercel,不受影响);
3. 中继被墙(国内全超时、海外正常):短期无解,公告引导用机器人;长期换中继域名(见下);
4. 检查 `wrangler tail` 确认源站 Worker 本身健康——中继只是转发,源站正常就只是入口问题。

**降低单点风险的候选方案**(按成本排序,均为手动操作):

- **加第二中继域名**:同一份 cn-relay 代码部署到另一个 Vercel 项目/另一个域名(成本最低;但同在 Vercel,防不了平台故障,只防单域名被墙);
- **国内可达的替代边缘**:把静态资源镜像到国内可直连的对象存储/CDN(需要备案或接受海外 CDN 的延迟,成本中);
- **接受机器人作为降级入口**:bot 全功能可用(答卷、投稿、报告),域名侧故障时它是不经过任何网页链路的独立通道——这也是为什么 `workers_dev = true` 特意保留(Telegram webhook 一直打 workers.dev 域名)。

**默认决策**:不加备用中继,依赖「机器人 = 永远可用的降级通道」。若中继一年内故障超过一次,再升级到第二中继方案。

## 4. 设置 Telegram 菜单按钮(scripts/telegram-set-menu-button.mjs)

**机制**:Bot 输入框左侧的「菜单按钮」默认展开命令列表。脚本调 Telegram 的 `setChatMenuButton` 把它换成 `web_app` 类型,点击直接进 Mini App 应用中心(`/app`,P0-M1 上线);`--reset` 恢复 Telegram 默认(展开命令列表)。注意:菜单按钮的 URL 是一次性写入 Telegram 服务端的,不会跟着 Worker 配置自动更新,所以换域名/换路径后必须重跑本脚本。

**用法**(凭据只走环境变量,脚本不读配置文件、不含任何硬编码 token):

```bash
# 预览 payload,不发请求(不需要 BOT_TOKEN)
PUBLIC_ORIGIN=https://emoemok.top node scripts/telegram-set-menu-button.mjs --dry-run

# 设置:菜单按钮 → web_app「打开应用」→ https://emoemok.top/app
BOT_TOKEN=<与 wrangler secret BOT_TOKEN 同值> PUBLIC_ORIGIN=https://emoemok.top node scripts/telegram-set-menu-button.mjs

# 自定义按钮文案
BOT_TOKEN=... PUBLIC_ORIGIN=... node scripts/telegram-set-menu-button.mjs --text "打开应用"

# 恢复默认(展开命令列表)
BOT_TOKEN=... node scripts/telegram-set-menu-button.mjs --reset
```

**环境变量**:

| 变量            | 说明                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------- |
| `BOT_TOKEN`     | Bot 凭据,仅从环境变量读取(与 Worker 绑定同名,见 `src/env.ts`);`--dry-run` 不需要它            |
| `PUBLIC_ORIGIN` | 应用中心地址来源;可用 `--origin` 参数覆盖;必须 https(`web_app` 按钮要求),配置里的尾斜杠会剥掉 |

**前置条件**:`/app` 所在域名需已在 BotFather 配置为 Mini App 域名,否则 Telegram 拒收 web_app 按钮(`BUTTON_URL_INVALID`)。

**重跑时机**:换 `PUBLIC_ORIGIN`、`/app` 路径变化或按钮文案调整之后;建议先用 `--dry-run` 核对 payload 再实跑。

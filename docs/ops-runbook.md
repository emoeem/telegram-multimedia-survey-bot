# 运维手册索引

面向部署运营者的操作手册。代码行为由注释和测试钉住,这里只记**需要人到 Cloudflare/GitHub 后台做的配置**。

## 1. D1 每日备份(d1-backup.yml)

**机制**:GitHub Actions 每天 18:20 UTC 用 `wrangler d1 export` 导整库 SQL → 传 R2 `d1-backup.sql` 前缀 → 回读校验(文件非空且含 `CREATE TABLE`)。

**首次启用需要配置的 secrets**(GitHub 仓库 → Settings → Secrets and variables → Actions):

| Secret                  | 值                                                   |
| ----------------------- | ---------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | 与 deploy 共用;权限需包含 D1 Edit + R2 Edit          |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账户 ID                                   |
| `R2_BACKUP_BUCKET`      | 备份桶名(需先在 R2 建好;建议单独一个桶,不开公开访问) |

配好后用 Actions 页面的 **Run workflow**(workflow_dispatch)手动跑一次,绿了才算启用。

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

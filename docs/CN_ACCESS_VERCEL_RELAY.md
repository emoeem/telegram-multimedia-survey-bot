# 中国大陆访问：Vercel 中继

## 为什么需要它

Cloudflare 的中国大陆节点（China Network）只对 Enterprise 开放且要求 ICP 备案，免费/Pro
无论怎么配置都拿不到境内入口。实测：从国内服务器请求 `emoe.eu.cc`（Cloudflare 共享段
`104.21.x` / `172.67.x`）会落到**阿姆斯特丹**（响应头 `Cf-Ray: ...-AMS`），同一出口请求
Vercel 托管的站点只落到**新加坡**（`X-Vercel-Id: sin1::`）。跨境链路在 GFW 下抖动严重，
表现就是"有时能开、多数时候转圈或超时"。

中继方案：在 Cloudflare 前面加一跳国内可用的入口。本项目用 Vercel（有香港/新加坡边缘、
免备案），请求路径变成：

```
国内用户 → emoemok.top（Vercel 港/新边缘）→ emoe.eu.cc（Cloudflare Worker）→ D1 / KV / DO / Queues
                │
                └─ 注入 x-relay-token，并转发访客真实公网 IP
```

Worker、D1、KV、Durable Objects、Queues、Telegram webhook 全部不动。中继只负责"让国内
用户够得着"，不承载任何业务逻辑。

## 部署步骤

1. **生成密钥**（Worker 与中继共用，泄漏等于任何人都能伪造访客 IP）：

   ```bash
   openssl rand -hex 32
   ```

2. **写入 Worker**：

   ```bash
   pnpm exec wrangler secret put RELAY_SECRET        # 交互式粘贴，别用管道（见下）
   ```

   > ⚠️ **不要用管道喂值**：`printf '%s' "$值" | wrangler secret put RELAY_SECRET` 会打印
   > `✨ Success!`，但存进去的值不可用（实测 `relayAccepted: false`）。用交互式输入，或
   > 直接用 Cloudflare API：
   > `PUT /accounts/{account_id}/workers/scripts/{script}/secrets`，
   > body `{"name":"RELAY_SECRET","text":"…","type":"secret_text"}`。
   > 写完必须验证（见"验证清单"最后两行），否则失败是静默的。

3. **建 Vercel 项目**：导入本仓库 → **Root Directory 设为 `cn-relay`** → Framework Preset
   选 **Other** → 环境变量加 `RELAY_SECRET`（Production 和 Preview 都要，与第 2 步同一个值）。
   - Hobby 不允许商用，本项目用 Pro。
   - 环境变量改完必须**重新部署**，新值才会进入生效的部署。

4. **绑定 CN 域名**：把域名加进项目，按 Vercel 提示在 DNS 服务商加记录。

5. **部署**，然后按下面的清单验证。

## 实现要点：中继如何把访客身份传给 Worker

中继本身只声明了两件事（`cn-relay/vercel.json` 的 `routes` + `transforms`）：

- 把所有请求反代到 Worker（`dest`），query string 由 Vercel 自动透传；
- 用 `transforms` 注入 `x-relay-token`（值取自环境变量 `RELAY_SECRET`）。`set` 会**覆盖**
  客户端伪造的同名头，所以攻击者无法自己冒充中继。

访客 IP 由 Vercel 自己转发。下面这张表是**线上实测**（不是照抄任何一方文档）的结果，
Worker 侧 `src/services/client-identity.service.ts` 的取头顺序就是照它定的：

| 转发头                             | 中继场景下的实际值                                      | 是否可信                                    |
| ---------------------------------- | ------------------------------------------------------- | ------------------------------------------- |
| `x-relay-token`                    | 我们注入的密钥                                          | ✅ 客户端改不动（`set` 覆盖）               |
| `x-relay-client-ip`                | 自建中继（Caddy/nginx）自行设置                         | ✅ 我们约定的头，Cloudflare 不碰            |
| `x-vercel-proxied-for`             | 访客真实 IP                                             | ✅ Vercel 覆写，客户端伪造无效              |
| `x-forwarded-for`                  | 访客真实 IP（Vercel 剥掉客户端伪造值后重设）            | ✅ 作为兜底                                 |
| `x-real-ip`                        | **Vercel 出口地址**（如 16.162.161.40），不是访客       | ❌ **Cloudflare 把它覆写成对端地址**        |
| `x-vercel-forwarded-for`           | 客户端自带的值原样透传                                  | ❌ 可伪造，故意不读                         |
| `x-vercel-ip-country`              | 未转发（为 null）                                       | — 拿不到就记 `viaRelay` 而不写国家          |

> 这张表是踩坑换来的：早期版本按 Vercel 文档去读 `x-real-ip`，结果 Cloudflare 在源站侧把它
> 覆写成"与它相连的那一跳"（即 Vercel 出口），于是每个国内访客都被记成同一个地址，限流桶
> 全部塌成一个。**改动取头顺序前，请先用临时诊断实测**（方法见验证清单最后一节）。

## 验证清单

| 检查                | 命令 / 操作                                     | 期望                                              |
| ------------------- | ----------------------------------------------- | ------------------------------------------------- |
| 回源是否通          | `curl -sI https://<CN域名>/`                    | `200`，响应头里有 `server: Vercel` 与 `cf-ray`    |
| query 是否透传      | `curl -s "https://<CN域名>/api/surveys?q=测试"` | 返回筛选后的列表（条数少于不带 `q` 的）           |
| 国内可达            | 国内服务器 / 手机流量访问                       | 200，`x-vercel-id` 落在 `hkg1` / `sin1`           |
| 大请求体            | 经中继 POST 一个 >4.5MB 的 body                 | 被 Worker 正常处理（不是 Vercel 层 413）          |
| **真实 IP 是否采信** | 见下一节                                        | 中继与直连**共用同一个限流桶**                    |
| 中继标记            | CN 域名填一份答卷 → 后台答卷详情                | IP 是访客真实公网 IP，浏览器信息里 `"viaRelay":true` |

### 真实 IP 采信的行为级验证（不必看后台）

`/api/admin/auth/password` 用的是 D1 原子限流（5 次 / 300 秒，按解析出的客户端 IP 分桶），
正好可以当"身份探针"。在**同一个 300 秒窗口**里依次执行：

```bash
D=https://emoe.eu.cc        # 直连源站
R=https://emoemok.top       # 经中继
post() { curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "Content-Type: application/json" \
         -d '{"password":"wrong"}' "$1/api/admin/auth/password"; }
post $D                                 # 401（我的桶：1）
post $R; post $R; post $R; post $R      # 已采信真实 IP 时：计数 2..5，全部 401
post $R                                 # 第 6 次 → 429
post $D                                 # 429 → 与中继共用同一个桶 = 真实 IP 生效
```

最后一行若仍是 401，说明中继请求被记在了别的地址上：回上表检查取头顺序、并确认密钥写对了。

### 临时诊断（改动取头逻辑后再验证时用）

在 `src/index.ts` 的 `/health` 里临时加几个字段，就能直接问 Worker 它看到了什么：
`relayAccepted`（本次请求的 token 是否匹配）、`relaySecretConfigured`（密钥是否绑定成功）、
`relayResolvedIp`（解析出的客户端地址），再把 `cf-connecting-ip` / `x-real-ip` /
`x-vercel-proxied-for` / `x-forwarded-for` 的值一起打出来。验证完**记得删掉再部署**。

## 切换用户可见域名

中继通了之后，把服务端生成的绝对链接也切到 CN 域名，否则国内用户点 Telegram 按钮、
og 卡片、后台登录直链时又会被送回打不开的 `emoe.eu.cc`：

```toml
# wrangler.toml [vars]
PUBLIC_ORIGIN = "https://emoemok.top"    # 本项目已切换
```

`pnpm deploy` 生效。客户端分享按钮用的是 `location.origin`，会自动跟随用户当前域名。
`emoe.eu.cc` 继续作为 Worker 的 origin 与 Telegram webhook 入口，两者互不影响。

## 限制与注意事项

- **信任模型**：Worker 只认 `x-relay-token` 与 `RELAY_SECRET` 的恒定时间比较。没有配
  `RELAY_SECRET` 时行为与改造前完全一致（一律按对端 IP 判定），所以回滚只需删掉这个 secret。
  客户端直连时伪造 `x-relay-client-ip` / `x-forwarded-for` 不会被采信（有单元测试覆盖）。
- **边缘缓存**：Vercel 对指向外部源站的 rewrite 默认沿用上游 `cache-control`。本项目 HTML 与
  API 都是 `no-store`，静态资源带内容 hash；`sw.js` 与 `manifest.webmanifest` 已在
  `cn-relay/vercel.json` 里显式 `no-store`。若仍出现陈旧内容，加
  `{"key":"x-vercel-enable-rewrite-caching","value":"0"}` 可彻底关掉该项目的边缘缓存。
- **请求体**：CDN 层反代不经过 Vercel Function，实测 6MB 请求体可正常穿过（不受 4.5MB
  Functions 限制）。
- **`/.well-known`** 路径 Vercel 保留、无法反代（本项目不使用）。
- **Telegram 在中国大陆整体不可用**：`t.me` 链接、`telegram.org/js/telegram-web-app.js` 桥接
  脚本在国内都会被阻断。中继只解决网页可达性。
- **切换 `PUBLIC_ORIGIN` 之前发出的机器人消息改不回来**：Telegram 把按钮 URL 烘焙进消息，
  早期（`PUBLIC_ORIGIN` 还没配时）机器人用的是 webhook 到达的 origin（`workers.dev`），
  这些老消息里的按钮在国内点不开，只能让用户重新发 `/start` 让机器人重发键盘。
  `pt` 参与者令牌是纯 HMAC 签名、不绑定域名，所以把老链接的 host 手工换成 CN 域名同样有效。
  另外记得检查 BotFather 里是否手工配过 Mini App / 菜单按钮 URL（代码里没有
  `setChatMenuButton` 调用，只会是手工配置的），有的话也改成 CN 域名。
- **可达性不是永久的**：Vercel 的国内可用度也可能变化。出问题时按同一协议换一个香港 VPS
  中继即可（Worker 侧零改动）。

## 其它中继（同一协议，Worker 侧零改动）

香港/新加坡 VPS + Caddy：

```caddyfile
cn.example.com {
    encode zstd gzip
    reverse_proxy https://emoe.eu.cc {
        header_up Host emoe.eu.cc
        header_up X-Relay-Token {$RELAY_SECRET}
        header_up X-Relay-Client-IP {http.request.remote.host}
        transport http { tls_server_name emoe.eu.cc }
    }
}
```

**注意**：访客 IP 走 `X-Relay-Client-IP`（我们自己的头，Cloudflare 不碰）。不要用
`X-Real-IP`——Cloudflare 会把它覆写成对端地址；也不要依赖追加式的 `X-Forwarded-For`，
让中继**覆写**它。

## 回滚

1. 删掉 CN 域名的解析（或下线 Vercel 项目）。
2. `wrangler secret delete RELAY_SECRET`。
3. `PUBLIC_ORIGIN` 改回 `https://emoe.eu.cc` 并 `pnpm deploy`。

任一步单独执行都不会让站点不可用：中继没了，Worker 依旧按对端 IP 服务所有请求。

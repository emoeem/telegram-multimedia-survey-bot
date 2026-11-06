# Web Admin（管理端前端）

Admin 是一个 Vite + React + TypeScript 工程：`admin/src` 是唯一可维护的源码，构建产物
`admin/dist` 由主 Worker 的 ASSETS binding 对外提供。本文件是 admin 前端的唯一开发入口；
手改 `admin/dist` 里的任何文件都会在下一次构建时被覆盖。

Worker 用同一份 `admin/dist` 承载三类入口（分发逻辑见 `../src/index.ts`）：

- `/admin`、`/admin/*` — 管理后台 SPA（入口 `index.html`，React Router `basename="/admin"`）；
- `/s`、`/plaza`、`/submit`、`/me` 等公开页 — 共用 `survey.html` 这一个入口，前端按路径切屏；
- `/cert` — 认证卡生成器，是 `cert/index.html` 这份独立静态页（不走 SPA），构建时从仓库根
  `cert/` 同步进来。

## 技术栈（以 `package.json` 为准）

| 依赖                            | 声明版本 | 用途                                                 |
| ------------------------------- | -------- | ---------------------------------------------------- |
| react / react-dom               | ^19.2.8  | UI 框架                                              |
| react-router                    | ^8.3.0   | 路由（`createBrowserRouter`，basename `/admin`）     |
| typescript                      | ^7.0.2   | 类型检查（admin 独立 `tsconfig.json`，不影响根工程） |
| vite                            | ^8.2.2   | 构建工具（Vite 8 / Rolldown，产物 → `admin/dist`）   |
| tailwindcss / @tailwindcss/vite | ^4.3.3   | 样式                                                 |
| daisyui                         | ^5.7.20  | 组件样式层                                           |
| echarts / echarts-for-react     | ^6.1.0   | 图表（随路由动态加载，不进首屏 vendor chunk）        |

其余运行时依赖（`@dnd-kit/*` 拖拽排序、`@xyflow/react` 场景编辑器、`lucide-react`、
`qrcode.react`、`@fingerprintjs/fingerprintjs`、`@telegram-apps/sdk`）与逐包许可审计见
[`DEPENDENCIES.md`](DEPENDENCIES.md)。UI 组件全部来自 daisyUI + Tailwind 原子类，没有引入
AntD 之类的组件库。

## 构建链

唯一入口是根目录的 `pnpm build:admin`（根 `package.json`），按序执行三步：

1. `node scripts/build-cert-single.mjs` — 把仓库根 `cert/` 内联打包成单文件离线版
   `cert/cert.html`（CSS / 全部脚本 / 词库全部内联，`file://` 双击可用；这份产物**要进
   版本库**，用于离线分发）；
2. `node scripts/sync-cert.mjs` — 把 `cert/` 单向覆盖拷贝到 `admin/public/cert/`，随 Vite
   一起拷进 `admin/dist` 由 Worker 在 `/cert` 路径对外提供（该副本不进版本库，`cert/`
   源目录始终是唯一事实来源）；
3. `pnpm --dir admin build` — 即本目录 `package.json` 的 `tsc --noEmit && vite build`，
   产物写入 `admin/dist`（`emptyOutDir: true`）。

`pnpm deploy` / `pnpm deploy:staging` 都会先跑完整 `build:admin` 再 `wrangler deploy`。
跳过前两步直接 `vite build`，产物里要么没有 `/cert`、要么是过期的 cert 副本——所以部署与
视觉回归（`pnpm test:visual` 等）一律从 `pnpm build:admin` 进入。

## admin/src 与 admin/dist 的关系（提交约定）

- `admin/src/**`、`index.html`、`survey.html`、`vite.config.ts`、`tsconfig.json`、
  `package.json`、`pnpm-lock.yaml` 是源码，正常提交；
- `admin/dist/**` 是构建产物，已被根 `.gitignore` 忽略，**不进版本库**，每次部署前由
  `build:admin` 重新生成；
- `admin/public/cert/**` 是 `sync-cert.mjs` 的单向拷贝产物，同样不进版本库；
- 红线：在未查清上述构建流程之前，**不要删除 `admin/dist`，也不要改动它的提交/忽略策略**
  ——`../wrangler.toml` 的 `assets.directory` 直接指向 `admin/dist`，少了它
  `wrangler dev` 与 `wrangler deploy` 都无法提供任何静态页面。

## 常用命令

| 命令                         | 作用                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `pnpm --dir admin dev`       | Vite dev server，只服务静态资源：`vite.config.ts` 未配置 API 代理，纯 dev server 下接口请求不可用 |
| `pnpm dev`（根目录）         | `wrangler dev`：本地完整环境（Worker + 本地 D1 + `admin/dist` 静态资源），需要联调 API 时用这个   |
| `pnpm build:admin`（根）     | 完整构建链（cert 打包 → cert 同步 → admin 构建）                                                  |
| `pnpm --dir admin typecheck` | 仅 admin 的 `tsc --noEmit`（`build` 脚本已包含，无需单独跑）                                      |
| `pnpm test`（根目录）        | Vitest 全量单测，含 `tests/unit/admin/*`（直接 import `admin/src` 的模块）                        |
| `pnpm test:visual`（根）     | Playwright 视觉回归，脚本自带 `build:admin`；覆盖 20 路由 × 2 主题 × 2 viewport 组合              |

## 与 Worker 的接口

管理端全部走 `/api/admin/*`（`../src/http/admin/index.ts` 的 `routeAdminApi`）：登录（密码 /
Telegram 身份关联 / 浏览器免登）、session、回收站、control、媒体库、金币、投稿、授权与部署
信息等。公开问卷页走 `/api/survey/*`，不属于本目录。

请求身份：

- 登录成功后凭 session cookie（过期返回 401，前端跳转 `/admin/login`）；在 Telegram 里打开
  时，每个请求还带 `x-telegram-init-data` = `encodeURIComponent(Telegram.WebApp.initData)`，
  服务端用 bot token 做 HMAC 校验，且 `auth_date` 距今不超过 24h
  （`../src/http/admin/index.ts`、`../src/http/admin/helpers.ts`）；
- `x-telegram-user-id` + `x-dev-auth-secret` 是本地开发专用的登录捷径：仅当 Worker 以
  `ENVIRONMENT=development` 运行且 `x-dev-auth-secret` 与 secret `ADMIN_DEV_AUTH_SECRET`
  常量时间比对一致时才接受（`../src/http/admin/index.ts`），公网部署无法靠伪造 header 冒充用户。

### 本地测试身份横幅

`/health` 报 `environment=development` 且不在 Telegram 里时，`/admin` 顶部出现黄色测试身份
横幅（`src/components/TestBanner.tsx`）：填入 `users` 表里存在的 Telegram 用户 ID 和
`ADMIN_DEV_AUTH_SECRET`，点「应用」后以该用户身份重新加载数据——管理员可见全部问卷，普通
用户只见自己的。生产环境不渲染横幅。

## 部署

```sh
# staging（隔离绑定，见 ../wrangler.staging.toml）
pnpm deploy:staging

# 生产
pnpm deploy
```

两者都会先执行完整 `build:admin` 再 `wrangler deploy`，静态资源随 Worker 一起发出。不要绕过
根脚本直接 `pnpm exec wrangler deploy`——那会上传一份**未重新构建**的 `admin/dist`（本地没跑
过构建时甚至没有这个目录）。

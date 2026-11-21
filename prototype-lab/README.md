# Prototype Lab（M1 高保真交互原型）

独立于生产工程的静态原型实验室：纯 HTML/CSS/JS，零新依赖，零构建步骤，不进生产 bundle，不触碰真实 API。四个核心页面的多端设计基准，配套 `docs/design/` 设计规范。

## 运行

```bash
pnpm proto            # 或 node prototype-lab/server.cjs
# 打开 http://127.0.0.1:4174/
```

- 控制台（`/index.html`）：页面 × 9 视口 × Dark/Light × 竖横屏，iframe 设备缩放预览，选择持久化、URL 可深链。
- 直开页面：`/pages/dashboard.html`、`/pages/games.html`、`/pages/room.html`、`/pages/profile.html`；支持 `?theme=light`、`?state=xxx`（每页状态机）、`room.html?frame=tg`（Telegram WebView 宿主栏模拟）、`?game=chess`。
- 每页右下角「🛠 原型控制」浮层：切换演示状态；弹层打开时自动让位。

## 验收测试（独立于主工程 CI）

```bash
pnpm test:proto       # Playwright，端口 4174，不触碰 qa/ 与 4173
```

85 项断言：36 视口打开矩阵（无横向溢出/无控制台错误）+ 布局形态随断点切换 + 43 项交互流程（含 Escape/焦点/错误态）+ Light 主题抽查 + 19 张截图输出到 `screenshots/`。

## 目录

```
prototype-lab/
  server.cjs           # 零依赖静态服务器（127.0.0.1:4174，防目录穿越）
  index.html/lab.css/lab.js   # 控制台外壳
  pages/               # dashboard / games / room / profile / placeholder
  assets/              # tokens.css（单一事实来源）、base.css（组件库）、interactions.js
  tests/proto.spec.mjs # Playwright 验收
  playwright.config.mjs
  screenshots/         # 逐视口截图（M2 证据）
```

## 红线

- 所有数据为 Mock，页面均带「原型演示 · Mock 数据」标注；不请求真实后端、不写入生产。
- 不复用/不修改 `admin/dist/`、`qa/`、`playwright.config.ts`；生产落地按 `docs/design/COMPONENT_INVENTORY.md` 映射，而非复制原型代码。
- 联机玩法设置只展示服务端已实现项（狼人杀 6–12 人、飞行棋 2–4 人；身份公/母与模式属单人试炼）。

设计规范：`../docs/design/`（BASELINE_AUDIT / tokens.json / COMPONENT_INVENTORY / RESPONSIVE_RULES / USER_FLOWS / PROTOTYPE_REVIEW / FIGMA_IMPORT_GUIDE）。

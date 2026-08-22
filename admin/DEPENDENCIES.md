# Admin Frontend Dependencies（依赖审计记录）

> 审计日期：2026-08-22。来源：安装后逐包读取 `node_modules/<pkg>/package.json` 的 `version` 与 `license` 字段（非声明值，为实际安装值）；`@telegram-apps/sdk` 的 MIT 许可另经 GitHub 组织页核实（Telegram-Mini-Apps org，~1.2k stars）。
> 红线遵循 `OPEN_SOURCE_REUSE_REPORT.md`：拒绝 GPL/AGPL/SSPL/商业/未知许可；仅浏览器静态依赖进 bundle。

| 包 | 版本 | License | 用途 |
| -- | -- | -- | -- |
| react / react-dom | 19.2.8 | MIT | UI 框架 |
| react-router | 8.3.0 | MIT | /admin 下真实路由（BrowserRouter, basename=/admin） |
| @telegram-apps/sdk | 3.11.8 | MIT | Mini App SDK（初始化接入；主题/返回键后续阶段启用） |
| vite | 8.2.2 | MIT | 构建工具（产物 → admin/dist，同一 Worker Assets） |
| @vitejs/plugin-react | 6.1.0 | MIT | React 构建 |
| tailwindcss / @tailwindcss/vite | 4.3.3 | MIT | 样式（断点 sm=640 / lg=1000 对齐 Phase 1） |
| typescript | 7.0.2 | Apache-2.0 | admin 工程类型检查（独立 tsconfig，不影响根工程） |
| @types/react / @types/react-dom | 19.2.18 / 19.2.4 | MIT | 类型 |

结论：全部 MIT / Apache-2.0，符合复用红线；无 Node 专属 API 进入生产 Worker（前端产物仅静态资源）。

运行时外部脚本：`https://telegram.org/js/telegram-web-app.js`（Telegram 官方 Mini App 脚本，Phase 1 起在用）。

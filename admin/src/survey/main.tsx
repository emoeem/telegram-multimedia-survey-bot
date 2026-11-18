import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import { SurveyApp } from "./SurveyApp";
import { buildScreenViewLine } from "./screen-view";
import { WelcomeGuide } from "./welcome-card";
import { DialogsProvider } from "../components/Dialogs";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { activateTelegramWebApp, waitForTelegramWebApp } from "../telegram";
import { initializePwa } from "../pwa";
import { warmDeviceFingerprint } from "./deviceInfo";

initializePwa();
// 指纹在后台预热（动态加载 vendor chunk，读 localStorage 缓存）：参与者的
// 第一个请求不再等完整的指纹探测，第二题起每条保存都带得上它。
warmDeviceFingerprint();

// screen_view 结构化埋点（2026-11-19 通宵批次 B3）：口径钉死「整页」——模块
// 挂载只执行一次，SPA 内部不发第二条；screen 名与 SurveyApp 的 pathname 分发
// 链一一对应（见 screen-view.ts）。自动化环境（Playwright 置位
// navigator.webdriver）不发：机器人流量不能混进用户行为数据。
const screenViewLine = buildScreenViewLine(window.location.pathname, navigator);
if (screenViewLine) {
  console.info(screenViewLine);
  // 复核修订：浏览器 console 出不了用户设备，Workers Logs 只收 Worker 侧
  // console.*——把同一条 JSON 行 keepalive 送到 /api/client-log（路径常量
  // CLIENT_LOG_PATH 在 src/http/client-log.ts，这里不直接 import：那条 import
  // 链会把 Worker 侧的 rate-limit.service 拖进 admin 工程，其 D1Result 类型
  // 在 admin 的 tsconfig 下编不过；tests/unit/http/client-log.test.ts 有静态
  // 断言钉住两侧同字面量），由 Worker 校验后再 console.info 一遍才检索得到。
  // fire-and-forget + 失败静默：埋点不能影响页面；自动化环境上面那行不发，
  // 这里同样不会执行。
  void fetch("/api/client-log", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: screenViewLine,
    keepalive: true,
  }).catch(() => undefined);
}

void (async () => {
  // Render immediately; the Telegram bridge loads in the background (initData
  // is read lazily). Blocking on telegram.org left the survey blank for up to
  // 2.5s in a plain browser.
  createRoot(document.getElementById("root") as HTMLElement).render(
    <StrictMode>
      <ErrorBoundary scope="survey">
        <DialogsProvider>
          <SurveyApp />
          {/* 首访欢迎卡：只在社区/个人类页面首次进入时弹一次，答题中永不打扰。 */}
          <WelcomeGuide />
        </DialogsProvider>
      </ErrorBoundary>
    </StrictMode>,
  );
  void waitForTelegramWebApp().then(() => activateTelegramWebApp());
})();

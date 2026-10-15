import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import { SurveyApp } from "./SurveyApp";
import { DialogsProvider } from "../components/Dialogs";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { activateTelegramWebApp, waitForTelegramWebApp } from "../telegram";
import { initializePwa } from "../pwa";
import { warmDeviceFingerprint } from "./deviceInfo";

initializePwa();
// 指纹在后台预热（动态加载 vendor chunk，读 localStorage 缓存）：参与者的
// 第一个请求不再等完整的指纹探测，第二题起每条保存都带得上它。
warmDeviceFingerprint();

void (async () => {
  // Render immediately; the Telegram bridge loads in the background (initData
  // is read lazily). Blocking on telegram.org left the survey blank for up to
  // 2.5s in a plain browser.
  createRoot(document.getElementById("root") as HTMLElement).render(
    <StrictMode>
      <ErrorBoundary scope="survey">
        <DialogsProvider>
          <SurveyApp />
        </DialogsProvider>
      </ErrorBoundary>
    </StrictMode>,
  );
  void waitForTelegramWebApp().then(() => activateTelegramWebApp());
})();

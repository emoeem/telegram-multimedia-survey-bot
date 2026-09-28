import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import { SurveyApp } from "./SurveyApp";
import { DialogsProvider } from "../components/Dialogs";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { activateTelegramWebApp, waitForTelegramWebApp } from "../telegram";
import { initializePwa } from "../pwa";

initializePwa();

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

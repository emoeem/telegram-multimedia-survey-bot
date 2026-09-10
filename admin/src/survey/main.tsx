import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import { SurveyApp } from "./SurveyApp";
import { DialogsProvider } from "../components/Dialogs";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { activateTelegramWebApp, waitForTelegramWebApp } from "../telegram";

if (import.meta.env.PROD && window.location.protocol === "https:") {
  navigator.serviceWorker?.register("/sw.js").catch(() => {});
}

void (async () => {
  await waitForTelegramWebApp();
  activateTelegramWebApp();
  createRoot(document.getElementById("root") as HTMLElement).render(
    <StrictMode>
      <ErrorBoundary scope="survey">
        <DialogsProvider>
          <SurveyApp />
        </DialogsProvider>
      </ErrorBoundary>
    </StrictMode>,
  );
})();

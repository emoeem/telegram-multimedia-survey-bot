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

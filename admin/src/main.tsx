import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { DialogsProvider } from "./components/Dialogs";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { activateTelegramWebApp, waitForTelegramWebApp } from "./telegram";
import { initializePwa } from "./pwa";
import { applyTheme, getStoredTheme } from "./theme";

void (async () => {
  await waitForTelegramWebApp();
  activateTelegramWebApp();
  applyTheme(getStoredTheme());
  initializePwa();
  createRoot(document.getElementById("root") as HTMLElement).render(
    <StrictMode>
      <ErrorBoundary scope="admin">
        <DialogsProvider>
          <App />
        </DialogsProvider>
      </ErrorBoundary>
    </StrictMode>,
  );
})();

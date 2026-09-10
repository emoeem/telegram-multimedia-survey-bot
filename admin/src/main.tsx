import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { DialogsProvider } from "./components/Dialogs";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { activateTelegramWebApp, waitForTelegramWebApp } from "./telegram";
import { applyTheme, getStoredTheme } from "./theme";

void (async () => {
  await waitForTelegramWebApp();
  activateTelegramWebApp();
  applyTheme(getStoredTheme());
  if (import.meta.env.PROD && window.location.protocol === "https:") {
    navigator.serviceWorker?.register("/sw.js").catch(() => {});
  }
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

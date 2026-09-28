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
  // Render immediately. The Telegram bridge is only needed for initData (read
  // lazily on the first API call) and WebView niceties, so blocking the first
  // paint on telegram.org (which can be slow or unreachable in a plain
  // browser) left the login page blank for up to 2.5s.
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
  void waitForTelegramWebApp().then(() => activateTelegramWebApp());
})();

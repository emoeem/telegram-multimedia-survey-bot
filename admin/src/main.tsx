import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { activateTelegramWebApp, waitForTelegramWebApp } from "./telegram";

void (async () => {
  await waitForTelegramWebApp();
  activateTelegramWebApp();
  // PWA offline shell; HTTPS only so the local QA server never registers it.
  if (import.meta.env.PROD && window.location.protocol === "https:") {
    navigator.serviceWorker?.register("/sw.js").catch(() => {
      // service worker unavailable — the app still works online
    });
  }
  createRoot(document.getElementById("root") as HTMLElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
})();

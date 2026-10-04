import { currentWebApp } from "../telegram";

/**
 * Leaves a mini-app surface.
 *
 * Inside Telegram the bridge owns the window: `window.close()` is ignored and
 * `history.back()` would return to whatever the WebView showed before the mini
 * app, so the bridge always wins. Outside Telegram the browser takes over.
 *
 * Shared by every standalone participant screen (plaza, showcase, trial) so the
 * close affordance behaves the same everywhere instead of being re-implemented
 * per page.
 */
export function closeWebApp(): void {
  const webApp = currentWebApp() as { close?: () => void } | undefined;
  if (typeof webApp?.close === "function") {
    webApp.close();
    return;
  }
  window.close();
  if (window.history.length > 1) window.history.back();
}

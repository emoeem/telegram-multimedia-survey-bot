import { currentWebApp } from "../telegram";

/**
 * True only when the page really runs as a Telegram Mini App.
 *
 * `telegram-web-app.js` is loaded lazily on every participant surface (see
 * {@link waitForTelegramWebApp}) and it installs `window.Telegram.WebApp` in
 * *any* browser — a plain tab included. Its `close()` then posts an event to a
 * host that is not there, so the promise of "leave the page" silently does
 * nothing. A non-empty `initData` is the one signal the Telegram client itself
 * injects, so it is what tells a real Mini App apart from the stray SDK object.
 */
export function isTelegramMiniApp(): boolean {
  const webApp = currentWebApp() as { initData?: unknown } | undefined;
  return typeof webApp?.initData === "string" && webApp.initData.length > 0;
}

/**
 * Leaves a mini-app surface.
 *
 * Inside Telegram the bridge owns the window: `window.close()` is ignored and
 * `history.back()` would return to whatever the WebView showed before the mini
 * app, so the bridge always wins. Outside Telegram the browser takes over:
 * prefer the page the participant came from, otherwise land on the survey hub
 * so the close affordance always has a visible effect.
 *
 * Shared by every standalone participant screen (survey, plaza, showcase,
 * trial) so the close affordance behaves the same everywhere instead of being
 * re-implemented per page.
 */
export function closeWebApp(fallbackPath = "/s"): void {
  const webApp = currentWebApp() as { close?: () => void } | undefined;
  if (isTelegramMiniApp() && typeof webApp?.close === "function") {
    webApp.close();
    return;
  }
  // Only a script-opened tab can be closed; everywhere else this is a no-op and
  // one of the two navigation fallbacks below has to run.
  window.close();
  if (window.history.length > 1) {
    window.history.back();
    return;
  }
  window.location.assign(fallbackPath);
}

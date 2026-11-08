interface TelegramWebApp {
  initData?: string;
  ready?: () => void;
  expand?: () => void;
  setHeaderColor?: (color: string) => void;
  /** Mini App 内的震动通路：iOS 上 navigator.vibrate 不存在，只有这条会真的震。 */
  HapticFeedback?: {
    notificationOccurred?: (type: "error" | "success" | "warning") => void;
    impactOccurred?: (style: "light" | "medium" | "heavy" | "rigid" | "soft") => void;
  };
}

const TELEGRAM_BRIDGE_URL = "https://telegram.org/js/telegram-web-app.js";

/**
 * Minimal structural browser globals so this file typechecks under both
 * tsconfigs that compile it: the admin app (DOM lib) and the root project's
 * unit tests, which pull it in via survey/note-api.ts with only WebWorker lib
 * where `window`/`document` are undeclared (same treatment as
 * survey/storage.ts). Runtime behavior is unchanged — the same globals,
 * reached through globalThis.
 */
const bridgeScope = globalThis as unknown as {
  window?: { Telegram?: { WebApp?: TelegramWebApp } };
  document?: {
    querySelector(selectors: string): unknown;
    createElement(tag: string): { src?: string; async?: boolean };
    head: { appendChild(child: unknown): unknown };
  };
};

/** Shared with navigation.ts so "close the mini app" has one implementation. */
export function currentWebApp(): TelegramWebApp | undefined {
  return bridgeScope.window?.Telegram?.WebApp;
}

/** Reads initData lazily so a bridge script that arrives after the module
 * still authenticates API calls; outside Telegram it is simply empty. */
export function getTelegramInitData(): string {
  const initData = currentWebApp()?.initData;
  return typeof initData === "string" ? initData : "";
}

/**
 * Ensures the Telegram Mini App bridge is available before the app mounts.
 * Inside Telegram the client serves the script locally and it resolves in
 * milliseconds; elsewhere (e.g. a plain browser where telegram.org may be
 * unreachable) we give it a short timeout so the page never blocks on the
 * network and always renders something.
 */
export async function waitForTelegramWebApp(timeoutMs = 2500): Promise<void> {
  if (currentWebApp()) return;
  const doc = bridgeScope.document;
  if (doc && !doc.querySelector(`script[src="${TELEGRAM_BRIDGE_URL}"]`)) {
    const script = doc.createElement("script");
    script.src = TELEGRAM_BRIDGE_URL;
    script.async = true;
    doc.head.appendChild(script);
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (currentWebApp()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export function activateTelegramWebApp(): void {
  try {
    const webApp = currentWebApp();
    webApp?.ready?.();
    webApp?.expand?.();
    webApp?.setHeaderColor?.("#111827");
  } catch {
    /* older Telegram clients may not support these calls */
  }
  try {
    // Initialize the SDK for upcoming theme / back-button integration; safe
    // outside Telegram (guarded) and does not replace the initData path above.
    import("@telegram-apps/sdk").then(({ init }) => init()).catch(() => undefined);
  } catch {
    /* SDK is optional */
  }
}

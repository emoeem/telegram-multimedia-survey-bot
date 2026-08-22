interface TelegramWebApp {
  initData?: string;
  ready?: () => void;
  expand?: () => void;
  setHeaderColor?: (color: string) => void;
}

const webApp = (window as { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp;

export const telegramInitData: string =
  typeof webApp?.initData === "string" ? webApp.initData : "";

export function activateTelegramWebApp(): void {
  try {
    webApp?.ready?.();
    webApp?.expand?.();
    webApp?.setHeaderColor?.("#111827");
  } catch {
    /* older Telegram clients may not support these calls */
  }
  try {
    // Initialize the SDK for upcoming theme / back-button integration; safe
    // outside Telegram (guarded) and does not replace the initData path above.
    import("@telegram-apps/sdk")
      .then(({ init }) => init())
      .catch(() => undefined);
  } catch {
    /* SDK is optional */
  }
}

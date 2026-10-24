/** Lightweight wrapper around the Haptic Feedback API (navigator.vibrate)
 *  and the Web Notification API, both of which are gracefully no-ops on
 *  platforms that don't support them (desktop Safari, older iOS WebViews, etc).
 *
 *  These helpers are used by the trial/challenge screen to give players
 *  tactile and ambient feedback for key events (complete, fail, settlement). */

export function vibrateSuccess(): void {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  navigator.vibrate(25);
}

export function vibrateFail(): void {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  navigator.vibrate([60, 40, 80]);
}

export function vibrateLight(): void {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  navigator.vibrate(15);
}

export async function requestNotificationPermission(): Promise<NotificationPermission | "unsupported"> {
  if (typeof Notification === "undefined" || typeof Notification.requestPermission !== "function") {
    return "unsupported";
  }
  if (Notification.permission === "granted" || Notification.permission === "denied") {
    return Notification.permission;
  }
  try {
    return await Notification.requestPermission();
  } catch {
    return "unsupported";
  }
}

export function notify(title: string, body?: string): void {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    new Notification(title, { body, silent: true });
  } catch {
    /* best effort — ignore */
  }
}

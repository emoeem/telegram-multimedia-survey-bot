/** Safe localStorage helpers that silently swallow StorageError / SecurityError.
 *
 * Safari ITP, some Telegram WebView configurations, and private-browsing modes
 * can throw on every `localStorage` access (`QuotaExceededError`, `SecurityError`,
 * or even `ReferenceError`). Calling sites should keep working even when
 * persistence is unavailable — they just won't remember the preference/token. */

export function safeGet(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function safeSet(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — best effort */
  }
}

export function safeRemove(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* storage unavailable — best effort */
  }
}

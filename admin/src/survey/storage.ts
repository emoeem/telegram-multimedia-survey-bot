/**
 * Minimal structural type so this file typechecks under both tsconfigs that
 * compile it: the admin app (DOM lib) and the root project's unit tests, which
 * pull frontend modules in with only WebWorker lib where `window`/`Storage`
 * are undeclared.
 */
interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Safe localStorage / sessionStorage helpers that silently swallow
 * StorageError / SecurityError.
 *
 * Safari ITP, some Telegram WebView configurations, and private-browsing modes
 * can throw on every storage access (`QuotaExceededError`, `SecurityError`,
 * or even `ReferenceError`). Calling sites should keep working even when
 * persistence is unavailable — they just won't remember the preference/token.
 */

function storage(area: "localStorage" | "sessionStorage"): StorageLike | null {
  const scope = globalThis as unknown as Record<string, StorageLike | undefined>;
  try {
    return scope[area] ?? null;
  } catch {
    return null;
  }
}

export function safeGet(key: string): string | null {
  return storage("localStorage")?.getItem(key) ?? null;
}

export function safeSet(key: string, value: string): void {
  try {
    storage("localStorage")?.setItem(key, value);
  } catch {
    /* storage unavailable — best effort */
  }
}

export function safeRemove(key: string): void {
  try {
    storage("localStorage")?.removeItem(key);
  } catch {
    /* storage unavailable — best effort */
  }
}

export function safeSessionGet(key: string): string | null {
  return storage("sessionStorage")?.getItem(key) ?? null;
}

export function safeSessionSet(key: string, value: string): void {
  try {
    storage("sessionStorage")?.setItem(key, value);
  } catch {
    /* storage unavailable — best effort */
  }
}

export function safeSessionRemove(key: string): void {
  try {
    storage("sessionStorage")?.removeItem(key);
  } catch {
    /* storage unavailable — best effort */
  }
}

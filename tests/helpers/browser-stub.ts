import { vi } from "vitest";
import { SURVEY_PARTICIPANT_TOKEN_VERSION } from "../../src/services/participant-session.service";

/**
 * Minimal `window` stub for the identity code paths (participant-token):
 * a URL doubles as `location` (the code only reads `search`/`href`), storage
 * areas are in-memory maps the test can inspect, and `history.replaceState`
 * is recorded instead of navigating.
 *
 * Deliberately typed without DOM lib — the root tsconfig compiles these tests
 * with WebWorker lib only.
 */
interface BrowserStub {
  replaceState: ReturnType<typeof vi.fn>;
  local: Map<string, string>;
  session: Map<string, string>;
}

interface BrowserStubOptions {
  url: string;
  local?: Record<string, string>;
  session?: Record<string, string>;
  historyState?: unknown;
}

function storageStub(map: Map<string, string>) {
  return {
    getItem: (key: string): string | null => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

export function stubBrowser(options: BrowserStubOptions): BrowserStub {
  const local = new Map<string, string>(Object.entries(options.local ?? {}));
  const session = new Map<string, string>(Object.entries(options.session ?? {}));
  const replaceState = vi.fn();
  const windowStub = {
    location: new URL(options.url),
    history: { state: options.historyState ?? null, replaceState },
  };
  vi.stubGlobal("window", windowStub);
  // storage.ts 读取 globalThis（浏览器里与 window 同一对象；node 测试里需
  // 单独挂载），这里两个全局都指向同一组内存 map。
  vi.stubGlobal("localStorage", storageStub(local));
  vi.stubGlobal("sessionStorage", storageStub(session));
  return { replaceState, local, session };
}

/** Builds a `payload.signature` participant token like the server's
 * participant-session.service. The client pre-checks `exp` **and** the payload
 * version (a version bump is how outstanding tokens get revoked), so test
 * tokens must carry the current `v` to count as live. */
export function makeParticipantToken(expSeconds: number, profile?: { username?: string; firstName?: string }): string {
  const json = JSON.stringify({
    u: 7,
    exp: expSeconds,
    p: "participant",
    v: SURVEY_PARTICIPANT_TOKEN_VERSION,
    ...(profile?.username || profile?.firstName ? { n: { u: profile.username, f: profile.firstName } } : {}),
  });
  // 与服务端一致：payload 先 UTF-8 编码再 base64（btoa 只吃 Latin1，中文
  // 资料快照必须走 TextEncoder）。
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const payload = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return `${payload}.c2ln`;
}

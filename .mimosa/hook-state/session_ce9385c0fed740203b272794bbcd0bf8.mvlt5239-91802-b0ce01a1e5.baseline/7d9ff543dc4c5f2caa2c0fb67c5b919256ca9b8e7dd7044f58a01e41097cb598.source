import { safeGet, safeSet } from "./storage";

/**
 * How long the first request may wait for the fingerprint to be ready.
 *
 * The full FingerprintJS probe (canvas/WebGL/audio/font enumeration) costs
 * real CPU on low-end phones — hundreds of milliseconds — and it used to sit
 * *in front of* the very first survey request, because every API call awaited
 * `surveyDeviceHeaders()`. The fingerprint is abuse-analytics metadata, not
 * something a respondent waits on: it now computes in the background (module
 * init kicks it off, the vendor chunk loads dynamically) and the request path
 * only waits this bounded slice for it. Afterwards it is cached in
 * localStorage — a device's visitorId is stable — so repeat visits attach it
 * to every request for free, and the probe cost is paid once per device.
 */
const FINGERPRINT_WAIT_MS = 150;

const FINGERPRINT_STORAGE_KEY = "webDeviceFingerprint";

let fingerprintPromise: Promise<string> | null = null;
let fingerprint = "";

/**
 * Best-effort device fingerprint (FingerprintJS). The vendor chunk loads
 * dynamically so it stays out of the first-screen dependency graph; failures
 * fall back to an empty string so identity capture never blocks survey
 * filling. The visitorId is stable per device+browser, so it is cached in
 * localStorage and the probe runs at most once per device.
 */
export function getDeviceFingerprint(): Promise<string> {
  if (fingerprint) return Promise.resolve(fingerprint);
  if (!fingerprintPromise) {
    fingerprintPromise = (async () => {
      const stored = safeGet(FINGERPRINT_STORAGE_KEY);
      if (stored) {
        fingerprint = stored;
        return fingerprint;
      }
      try {
        const { default: FingerprintJS } = await import("@fingerprintjs/fingerprintjs");
        const agent = await FingerprintJS.load();
        const result = await agent.get();
        fingerprint = result.visitorId;
        safeSet(FINGERPRINT_STORAGE_KEY, fingerprint);
      } catch {
        fingerprint = "";
      }
      return fingerprint;
    })();
  }
  return fingerprintPromise;
}

/**
 * Starts the fingerprint computation in the background. Called once at app
 * bootstrap: by the time the participant answers the first question it is
 * ready, and every subsequent save carries it — without the first survey
 * request ever waiting on the full probe.
 */
export function warmDeviceFingerprint(): void {
  void getDeviceFingerprint();
}

/** Resolves to the fingerprint once ready, or to "" after the bounded wait. */
async function fingerprintBounded(): Promise<string> {
  if (fingerprint) return fingerprint;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(""), FINGERPRINT_WAIT_MS);
  });
  try {
    return await Promise.race([getDeviceFingerprint(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function surveyDeviceHeaders(): Promise<Record<string, string>> {
  const fingerprint = await fingerprintBounded();
  return {
    ...(fingerprint ? { "x-device-fingerprint": fingerprint } : {}),
    "x-browser-info": getBrowserInfo(),
  };
}

/** Sensitive query params that must never be recorded into browser info. */
const SENSITIVE_PARAMS = ["pt", "t", "token", "grant"];

function safeUrl(): string {
  try {
    const url = new URL(location.href);
    for (const key of SENSITIVE_PARAMS) url.searchParams.delete(key);
    return url.toString().slice(0, 500);
  } catch {
    return "";
  }
}

function safeQuery(): string {
  try {
    const params = new URLSearchParams(location.search);
    for (const key of SENSITIVE_PARAMS) params.delete(key);
    return params.toString().slice(0, 500);
  } catch {
    return "";
  }
}

let browserInfoCache: string | null = null;

/**
 * Compact, human-readable browser/device description for the admin.
 *
 * Computed once per session: the WebGL probe creates a canvas + GL context and
 * browsers cap live contexts (~16), so rebuilding it on every survey request
 * could silently drop the recorded snapshot. Sensitive URL query params (the
 * signed participant/report tokens) are stripped before recording.
 */
export function getBrowserInfo(): string {
  if (browserInfoCache !== null) return browserInfoCache;
  const nav = navigator as Navigator & {
    userAgentData?: { platform?: string; mobile?: boolean };
    hardwareConcurrency?: number;
    maxTouchPoints?: number;
    deviceMemory?: number;
    connection?: {
      effectiveType?: string;
      downlink?: number;
      rtt?: number;
      saveData?: boolean;
      type?: string;
    };
    doNotTrack?: string | null;
    cookieEnabled?: boolean;
  };
  const webgl = ((): { vendor: string; renderer: string; version: string; extensions: number } | null => {
    try {
      const canvas = document.createElement("canvas");
      const gl = (canvas.getContext("webgl") ||
        canvas.getContext("experimental-webgl")) as WebGLRenderingContext | null;
      if (!gl) return null;
      const debug = gl.getExtension("WEBGL_debug_renderer_info");
      return {
        vendor: debug ? String(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)) : String(gl.getParameter(gl.VENDOR)),
        renderer: debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER)),
        version: String(gl.getParameter(gl.VERSION)),
        extensions: (gl.getSupportedExtensions() ?? []).length,
      };
    } catch {
      return null;
    }
  })();
  const navigation = performance.getEntriesByType("navigation")[0] as { type?: string } | undefined;
  browserInfoCache = JSON.stringify({
    ua: navigator.userAgent,
    platform: nav.userAgentData?.platform ?? navigator.platform ?? "",
    mobile: nav.userAgentData?.mobile ?? /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent),
    screen: `${window.screen.width}x${window.screen.height}x${window.screen.colorDepth}`,
    screenAvailable: `${window.screen.availWidth}x${window.screen.availHeight}`,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    language: navigator.language,
    languages: navigator.languages ?? [],
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "",
    cores: nav.hardwareConcurrency ?? 0,
    memory: nav.deviceMemory ?? 0,
    dpr: window.devicePixelRatio || 1,
    touch: "ontouchstart" in window || (nav.maxTouchPoints ?? 0) > 0,
    touchPoints: nav.maxTouchPoints ?? 0,
    connection: nav.connection?.effectiveType ?? "",
    connectionType: nav.connection?.type ?? "",
    rtt: nav.connection?.rtt ?? 0,
    downlink: nav.connection?.downlink ?? 0,
    saveData: nav.connection?.saveData ?? false,
    online: navigator.onLine,
    doNotTrack: nav.doNotTrack ?? "",
    cookiesEnabled: navigator.cookieEnabled,
    plugins: navigator.plugins?.length ?? 0,
    webgl,
    navigationType: navigation?.type ?? "",
    referrer: document.referrer.slice(0, 500) || "",
    url: safeUrl(),
    query: safeQuery(),
  });
  return browserInfoCache;
}

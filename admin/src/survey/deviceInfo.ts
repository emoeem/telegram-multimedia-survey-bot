import FingerprintJS from "@fingerprintjs/fingerprintjs";

let fingerprintPromise: Promise<string> | null = null;
let fingerprint = "";

/**
 * Best-effort device fingerprint (FingerprintJS). Failures fall back to an
 * empty string so identity capture never blocks survey filling.
 */
export function getDeviceFingerprint(): Promise<string> {
  if (fingerprint) return Promise.resolve(fingerprint);
  if (!fingerprintPromise) {
    fingerprintPromise = (async () => {
      try {
        const agent = await FingerprintJS.load();
        const result = await agent.get();
        fingerprint = result.visitorId;
      } catch {
        fingerprint = "";
      }
      return fingerprint;
    })();
  }
  return fingerprintPromise;
}

/** Compact, human-readable browser/device description for the admin. */
export function getBrowserInfo(): string {
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
  return JSON.stringify({
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
    url: location.href.slice(0, 500),
    query: location.search.slice(0, 500),
  });
}

export async function surveyDeviceHeaders(): Promise<Record<string, string>> {
  const fingerprint = await getDeviceFingerprint();
  return {
    ...(fingerprint ? { "x-device-fingerprint": fingerprint } : {}),
    "x-browser-info": getBrowserInfo(),
  };
}

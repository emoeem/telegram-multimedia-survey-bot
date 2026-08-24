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
  };
  return JSON.stringify({
    ua: navigator.userAgent,
    platform: nav.userAgentData?.platform ?? navigator.platform ?? "",
    screen: `${window.screen.width}x${window.screen.height}x${window.screen.colorDepth}`,
    language: navigator.language,
    languages: navigator.languages ?? [],
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "",
    cores: nav.hardwareConcurrency ?? 0,
    touch: "ontouchstart" in window || (nav.maxTouchPoints ?? 0) > 0,
  });
}

export async function surveyDeviceHeaders(): Promise<Record<string, string>> {
  const fingerprint = await getDeviceFingerprint();
  return {
    ...(fingerprint ? { "x-device-fingerprint": fingerprint } : {}),
    "x-browser-info": getBrowserInfo(),
  };
}

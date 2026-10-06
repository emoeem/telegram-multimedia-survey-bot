import puppeteer, { type BrowserWorker } from "@cloudflare/puppeteer";

const ACQUISITION_MAX_WAIT_MS = 120_000;
const ACQUISITION_POLL_MS = 5_000;

/**
 * Browser Rendering rate-limits new session acquisitions account-wide
 * ("Unable to create new browser: 429 Rate limit exceeded"). A launch issued
 * during the cooldown still returns a browser handle, but the session never
 * materializes and its first CDP calls die with TargetCloseError — so gate
 * every launch on the binding's own limits view and only proceed once an
 * acquisition slot is actually available.
 */
export async function launchBrowser(
  binding: BrowserWorker,
  context: Record<string, unknown> = {},
): Promise<Awaited<ReturnType<typeof puppeteer.launch>>> {
  for (let waited = 0; waited < ACQUISITION_MAX_WAIT_MS; waited += ACQUISITION_POLL_MS) {
    try {
      const limits = await puppeteer.limits(binding);
      const cooldownMs = (limits.timeUntilNextAllowedBrowserAcquisition ?? 0) * 1000;
      const poolFull =
        limits.maxConcurrentSessions > 0 && limits.activeSessions.length >= limits.maxConcurrentSessions;
      if (limits.allowedBrowserAcquisitions >= 1 && cooldownMs === 0 && !poolFull) break;
      console.info("Browser acquisition gated; waiting", {
        ...context,
        activeSessions: limits.activeSessions.length,
        maxConcurrentSessions: limits.maxConcurrentSessions,
        allowedBrowserAcquisitions: limits.allowedBrowserAcquisitions,
        cooldownMs,
      });
    } catch (error) {
      console.warn("Browser limits unavailable; launching without gating", {
        ...context,
        error: error instanceof Error ? error.message : String(error),
      });
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, ACQUISITION_POLL_MS));
  }
  return puppeteer.launch(binding);
}

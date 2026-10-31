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
      const poolFull = limits.maxConcurrentSessions > 0 && limits.activeSessions.length >= limits.maxConcurrentSessions;
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

type RenderBrowser = Awaited<ReturnType<typeof puppeteer.launch>>;
export type SandboxedRenderPage = Awaited<ReturnType<RenderBrowser["newPage"]>>;

/**
 * Creates a render page with all remote network access cut off.
 *
 * Every report/poster/card renderer composes its HTML from escaped text and
 * inline `data:` resources (fonts ship as Data-rule blobs), so a correct
 * render never needs the network. Intercepting http/https requests closes the
 * gap where a single future escaping regression anywhere would otherwise turn
 * the headless browser into a server-side fetcher of attacker-chosen URLs —
 * the SSRF surface the 2026-10-31 probe payload tested for.
 *
 * Interception is defense in depth: if the runtime refuses it, rendering
 * proceeds exactly as before instead of failing the report.
 */
export async function newSandboxedPage(
  browser: RenderBrowser,
  options: { allowedOrigins?: string[] } = {},
): Promise<SandboxedRenderPage> {
  const page = await browser.newPage();
  const allowedOrigins = (options.allowedOrigins ?? [])
    .map((origin) => {
      try {
        return new URL(origin).origin;
      } catch {
        return null;
      }
    })
    .filter((origin): origin is string => origin !== null);
  try {
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const url = request.url();
      if (/^https?:/i.test(url)) {
        const origin = (() => {
          try {
            return new URL(url).origin;
          } catch {
            return null;
          }
        })();
        if (origin !== null && allowedOrigins.includes(origin)) {
          void request.continue().catch(() => {});
          return;
        }
        console.warn("Render sandbox blocked remote request", { url: url.slice(0, 300) });
        void request.abort("blockedbyclient").catch(() => {});
        return;
      }
      void request.continue().catch(() => {});
    });
  } catch (error) {
    console.warn("Render sandbox unavailable; continuing without network isolation", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return page;
}

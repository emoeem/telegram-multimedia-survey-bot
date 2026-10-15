/**
 * The origin used in every user-facing absolute URL: Telegram inline buttons,
 * the admin login deep link, "open in browser" fallbacks and the `og:` metadata
 * on public pages.
 *
 * A Worker answers on several hostnames at once — the
 * `<name>.<account>.workers.dev` hostname plus every custom domain bound to it —
 * so `new URL(request.url).origin` describes *how a request arrived*, not where
 * the user should be sent. Those two diverge exactly where it matters: the
 * Telegram webhook deliberately keeps arriving on the `workers.dev` hostname
 * (bot delivery must not depend on any custom domain's DNS state), so links
 * built from `request.url` would keep handing users the one hostname that is
 * SNI-blocked in mainland China.
 *
 * `PUBLIC_ORIGIN` pins the canonical origin, decoupling "where the webhook
 * lands" from "where users are sent". When it is unset the request origin is
 * used unchanged, so `wrangler dev` and single-hostname deployments behave
 * exactly as before.
 */
export function resolvePublicOrigin(env: { PUBLIC_ORIGIN?: string }, requestOrigin: string): string {
  const configured = env.PUBLIC_ORIGIN?.trim();
  if (!configured) return requestOrigin;
  // Call sites concatenate paths directly (`${origin}/admin`), so a trailing
  // slash in configuration would produce `https://host//admin`. Strip it
  // instead of trusting every deployment to remember.
  return configured.replace(/\/+$/, "");
}

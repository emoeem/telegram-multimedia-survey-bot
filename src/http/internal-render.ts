import { isWebhookSecretValid } from "../core/security";
import { publishPublicResponseReport } from "../services/public-report.service";
import type { Env } from "../index";

/**
 * Internal endpoints called by the worker's own queue consumers.
 *
 * Browser Rendering sessions acquired inside queue consumers die within their
 * first few CDP calls on this account, while request-context renders (OG
 * images, archive PDFs through their own flow) keep working — so the queue
 * hands the actual render+send to this HTTP endpoint, which runs in a request
 * context.
 */
export async function handleInternalRenderRequest(request: Request, env: Env): Promise<Response> {
  if (!isWebhookSecretValid(env.WEBHOOK_SECRET, request.headers.get("x-internal-token"))) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const renderMatch = url.pathname.match(/^\/internal\/render-public-report\/(\d+)$/);
  if (renderMatch && request.method === "POST") {
    const responseId = Number(matchId(renderMatch));
    try {
      const result = await publishPublicResponseReport(env, responseId);
      return Response.json({ ok: true, ...result });
    } catch (error) {
      console.error("Internal public report render failed", {
        responseId,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
      return Response.json(
        { ok: false, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) },
        { status: 500 },
      );
    }
  }

  return Response.json({ ok: false, error: "not_found" }, { status: 404 });
}

function matchId(match: RegExpMatchArray): string {
  return match[1] ?? "";
}

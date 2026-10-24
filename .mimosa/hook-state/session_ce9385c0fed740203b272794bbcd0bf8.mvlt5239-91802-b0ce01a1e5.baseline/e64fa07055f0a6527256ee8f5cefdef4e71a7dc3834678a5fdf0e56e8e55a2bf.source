/**
 * Shared JSON response helpers for the public (non-admin) HTTP APIs.
 *
 * Every one of these responses is user/session-specific, so the default is
 * always `Cache-Control: no-store`: an intermediary keeping a personalized
 * answer payload is both a correctness bug and a privacy leak.
 */
export function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export function fail(status: number, code: string, message: string): Response {
  return json({ ok: false, code, message }, status);
}

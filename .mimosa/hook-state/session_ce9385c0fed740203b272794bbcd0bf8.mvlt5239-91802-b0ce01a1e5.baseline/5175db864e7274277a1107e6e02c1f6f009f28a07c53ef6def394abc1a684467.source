/**
 * Test-only stand-in for the `cloudflare:workers` runtime module.
 *
 * Durable Object classes extend the runtime-provided `DurableObject` base, but
 * vitest has no workerd runtime. Only the base class needs to exist for the
 * import graph to load; no test instantiates a DO directly.
 */
export class DurableObject<Env = unknown> {
  constructor(
    readonly ctx: unknown,
    readonly env: Env,
  ) {}
}

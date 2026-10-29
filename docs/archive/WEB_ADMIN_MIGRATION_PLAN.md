# Web Admin Migration Plan

## Phase 0.5 (this document)

Compare mature projects and record license/runtime uncertainty. No code changes.

## Phase 1 — shell

Create `/admin/*` Static Assets with login handoff, responsive sidebar/topbar, Dashboard, Survey List, and Survey Detail tabs. Add Worker API endpoints that read existing D1 data and enforce the existing permission service. Do not build question editing, templates, Telegraph, or new schemas.

## Phase 2 — questions

Build a unified-schema adapter and autosaving question editor. Evaluate Form Library rendering separately from Creator licensing.

## Phase 3 — responses and analytics

Expose paginated response/answer reads, media previews from scoped R2 keys, and completion/choice/score aggregates.

## Phase 4 — Telegraph

Queue create/edit operations from published D1 surveys; keep tokens in Worker secrets and split pages below the API size limit.

## Phase 5+ — templates, identity, Telegram simplification

Prototype canvas editing in the browser, then identity-card workflows, then reduce Telegram admin to shortcuts and an authenticated Web Admin launch.

## Security and deployment invariants

The browser calls the same Worker over HTTPS; it never receives D1/R2 bindings or Cloudflare tokens. Production is one Worker and owns the Telegram webhook, D1, R2, Queue, Durable Objects, `/api/*`, and `/admin/*`. Staging is a separate Worker in the second Cloudflare account with independent test resources; it must never point at production bindings. Cross-account calls, if ever required, use signed server-to-server HTTPS requests. Promote only after Phase 1 browser/API checks pass in staging.

# Web Admin Open Source Research (Phase 0.5)

Date: 2026-08-21

## Scope and verification note

This phase is research only. No production code, schema, binding, queue, or deployment was changed. The execution environment could not reach GitHub (`curl` to `raw.githubusercontent.com` returned no repository content), so live star counts, latest commits, releases, and current license files remain **unverified**. Before copying any code or adding a dependency, run the repository checks in `scripts/research-web-admin.sh` from a network-enabled CI/workstation and attach the exact commit and license text.

## Candidate comparison

| Project | URL | License | Stars | Activity | Runtime | DB | UI | Cloudflare | Reuse |
|---|---|---|---|---|---|---|---|---|---|
| botmux | https://github.com/skrashevich/botmux | Apache-2.0 stated by request; verify `LICENSE` | Unverified | Unverified | Self-hosted | Unverified | Bot dashboard, resource navigation, analytics, audit/settings (inspect screens) | Not assumed | **A / UX reference** |
| Botgram | https://github.com/iebb/botgram | Unverified | Unverified | Unverified | Reported Worker/React direction; verify source | Unverified | Telegram admin/dashboard patterns | Candidate; verify Node APIs and build | **B / architecture candidate** |
| cf-workers-telebot | https://github.com/abduelmorsi/cf-workers-telebot | MIT stated by request; verify `LICENSE` | Unverified | Unverified | Workers | Unverified | Lightweight admin/API patterns | Candidate | **B / selective patterns** |
| kojoru/telegram-calendar | https://github.com/kojoru/telegram-calendar | Unverified | Unverified | Unverified | Workers + React/Vite reported by request | D1 reported by request | Mini App integration | Candidate | **Reference only** |
| Cloudflare React Router template | https://github.com/cloudflare/templates/tree/main/react-router-template | MIT/template terms; verify revision | n/a | Active template family | Workers Static Assets | D1 via API pattern | React shell | Native | **A / deployment reference** |
| Cloudflare D1 API template | https://github.com/cloudflare/templates/tree/main/d1-api-template | MIT/template terms; verify revision | n/a | Active template family | Workers | D1 | API only | Native | **A / API reference** |
| SurveyJS Form Library | https://github.com/surveyjs/survey-library | MIT packages; verify package notices | Unverified | Active project | Browser TypeScript | None | Question renderer/schema | Worker-safe browser bundle | **B / form reference** |

## Fit assessment

### botmux — Architecture/UI reference (A)

Use its conceptual information architecture: Dashboard → bots/resources → detail tabs → analytics/users/settings/audit, with persistent sidebar and contextual topbar. Do not import its backend or persistence until the exact revision and dependencies are audited; map Bot/Chat/Message to Survey/Response/Question/Answer through Worker API DTOs.

### Botgram — Cloudflare architecture candidate (B)

Inspect Worker entry, auth/session handling, static build, and Telegram API proxy. Reuse only fetch-compatible, browser-safe patterns. Any PostgreSQL, server process, Node-only module, or incompatible session store makes it reference-only.

### cf-workers-telebot — selective Worker patterns (B)

Potentially useful for menu/media/admin API boundaries. Keep existing D1/R2/Queue bindings and PermissionService; never adopt a second user or data model.

### kojoru/telegram-calendar — Mini App reference

Useful for Telegram-to-browser launch and React/Vite deployment ideas, not a general admin foundation. Validate WebApp authentication and do not expose Cloudflare secrets.

## Required repository audit

For each candidate, capture `README.md`, `LICENSE`, `package.json`, lockfile, `wrangler.toml`, source/routes/components, recent commits/releases, and all runtime dependencies. Reject direct use when GPL/AGPL/SSPL/commercial/unknown licensing, persistent server requirements, PostgreSQL/Redis coupling, or Node native APIs are present.


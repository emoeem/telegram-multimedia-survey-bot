# Open Source Reuse Report

> Phase 0 architecture research for the Telegram multimedia survey platform.  
> Repository and license facts were checked against the projects' public metadata and package manifests on 2026-08-21. Stars and release dates are intentionally recorded as approximate snapshots; verify them again before adding a dependency.

## Decision summary

The production runtime remains Cloudflare Workers + D1 + R2 + Queues. No candidate is a replacement for the existing survey, response, media, or result schema. Any adopted UI or form component must sit behind an adapter and persist the current unified schema.

## Candidate review

| Project | URL | License | Approx. stars | Recent activity | Cloudflare / TypeScript fit | Recommendation |
|---|---|---:|---:|---|---|---|
| SurveyJS Form Library | https://github.com/surveyjs/survey-library | MIT (library packages; verify package-level notices) | 4k+ | Active releases | Browser TypeScript; no server/native dependency | **Use selectively** for question rendering and schema concepts. Keep an adapter to our schema. |
| SurveyJS Creator | https://github.com/surveyjs/survey-creator | Commercial/dual licensing (not equivalent to Form Library) | 1k+ | Active | Browser TypeScript, but license is the blocker | **Reference only** until commercial terms are approved. Do not copy Creator code or bundle it by assumption. |
| OpenSurvey | https://github.com/opensurveyorg/OpenSurvey | GPL-family components (confirm repository files) | 1k+ | Intermittent | Django/PostgreSQL server architecture | **Reference only** for builder and analytics UX. Not Cloudflare-native and not compatible for direct integration. |
| cloudcore-cms | https://github.com/ArtemRybak/cloudcore-cms | MIT (confirm current revision) | <1k | Check before adoption | Cloudflare-oriented CMS patterns; React/TS portions vary | **Reference / extract patterns** only after validating D1/R2 bindings and bundle size. |
| Cloudflare React Worker starter | https://github.com/cloudflare/templates/tree/main/react-router-template | MIT/template terms | n/a | Maintained with Workers | React + TypeScript + Static Assets | **Use as shell reference** if a separate admin SPA is needed; prefer serving `/admin/*` from the existing Worker. |
| Cloudflare D1 examples | https://github.com/cloudflare/templates/tree/main/d1-api-template | MIT/template terms | n/a | Maintained | Native D1 bindings and Hono/Workers patterns | **Use patterns**, not a second API or database. |
| shadcn/ui | https://github.com/shadcn-ui/ui | MIT | 90k+ | Very active | Source-distributed React/Tailwind; browser-only | **Recommended UI foundation** for Admin cards, tables, tabs, dialogs. Copy only required components and retain notices. |
| React Router | https://github.com/remix-run/react-router | MIT | 55k+ | Very active | Browser-compatible; static SPA friendly | **Recommended** for `/admin/*` route structure. |
| dnd-kit | https://github.com/clauderic/dnd-kit | MIT | 14k+ | Active | Browser TypeScript, no native runtime | **Recommended** for question/template ordering and drag/drop. |
| Konva / react-konva | https://github.com/konvajs/konva | MIT | 12k+ | Active | Browser canvas; audit Worker build excludes server canvas | **Evaluate for template editor**; use only in Admin browser bundle. |
| GrapesJS | https://github.com/GrapesJS/grapesjs | BSD-3-Clause | 23k+ | Active | Browser editor; larger bundle | **Evaluate later** for rich templates; not required for initial Admin shell. |
| dcdunkan/telegraph | https://github.com/dcdunkan/telegraph | MIT (verify release) | <1k | Active enough for API wrapper | Fetch-based TypeScript; no server/native dependency | **Preferred wrapper** if package remains small and maintained; otherwise call official HTTPS API from a Worker service. |
| Telegram Mini Apps examples | https://github.com/Telegram-Mini-Apps/ | MIT varies by repo | varies | Active | Browser frontends; platform APIs only | **Reference only** for deep links and WebApp auth. Admin authentication must terminate at Worker, never in the browser with Cloudflare tokens. |

## Fit and security checks

- **Architecture:** only browser/static dependencies belong in the Admin bundle. Packages requiring `fs`, `net`, `tls`, `child_process`, Puppeteer, a persistent process, or PostgreSQL are excluded from production Worker code.
- **License:** MIT, Apache-2.0, and BSD are generally compatible with this private/commercial repository, subject to preserving notices. GPL/AGPL/SSPL and SurveyJS Creator commercial terms require legal approval and are reference-only for now.
- **Data model:** third-party form schemas are DTOs. Implement `adapter/third-party -> Unified Survey Schema` and validate before D1 writes. Never make a library's JSON the source of truth.
- **Security:** browser requests go to Worker API routes; D1/R2 bindings and Telegraph access tokens stay server-side. Use existing permission service (`admin`, `owner`, `editor`, `viewer`) rather than a second identity system.
- **Media:** editor uploads use existing R2 scopes (`survey`, `response`, `template`, `template_preview`, `identity`, `generated_result`) and are never inferred from a UI component.

## Phased adoption

1. **Admin shell:** React + TypeScript + Tailwind/shadcn/ui + React Router, served as Worker Static Assets under `/admin/*`.
2. **Survey list/detail:** Worker API reads existing D1 tables; add search, filters, pagination, and tabs without changing schema.
3. **Question editor:** start with native controls and a unified-schema adapter; selectively embed SurveyJS Form Library for rendering after license/package audit.
4. **Responses/analytics:** read existing response and answer tables; no duplicate persistence.
5. **Telegraph:** queue `TelegraphService` jobs on publish/public-index changes; edit existing pages and split before the 64 KB API limit.
6. **Template editor:** compare dnd-kit, Konva, and GrapesJS in an isolated browser prototype. Persist asset IDs, bindings, position, style, and layer—not rendered images.

## Rejected for direct production use

OpenSurvey's Django/PostgreSQL backend, any VPS/Docker deployment, SurveyJS Creator without a commercial license, and packages requiring Node native modules or a persistent renderer. They may inform UX or algorithms, but cannot become runtime dependencies.


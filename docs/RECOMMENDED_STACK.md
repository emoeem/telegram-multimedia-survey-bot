# Recommended Stack

## Decisions

- **Web Admin UX / IA:** botmux, as a visual and navigation reference only (A). Borrow the dashboard/sidebar/resource/detail/tabs/audit concepts; do not fork its backend.
- **Cloudflare runtime:** official Cloudflare React Router + Static Assets and D1 API templates (A), adapted into the existing Worker rather than a new service.
- **Telegram/Worker patterns:** Botgram and cf-workers-telebot (B), pending live source/license audit.
- **Form reference:** SurveyJS Form Library (B, MIT package audit required). SurveyJS Creator remains excluded because its commercial terms are separate.
- **Routing/UI:** React Router, Tailwind, and shadcn/ui; source-distributed components only.
- **Drag/drop:** dnd-kit for later question/option/layer ordering.
- **Template canvas:** Konva/react-konva first prototype; compare GrapesJS only in Phase 5.
- **Telegraph:** official HTTPS API or dcdunkan/telegraph after package/license/runtime verification.

All integrations use adapters and the current D1 schema. No second identity, database, media store, queue, or server is introduced.


# Web Admin

`admin/dist` is the deployable Static Assets bundle served by the main Worker at `/admin/*`.
There is no build step: `dist/index.html` (inline CSS, React 18 via CDN) and `dist/app.js`
(plain JS, `React.createElement`) are the source of truth and are committed to git.
`admin/src` contains the TypeScript React baseline for a future build-tool step.

The shell talks to the real read-only API (`/api/admin/dashboard`, `/api/admin/surveys`,
`/api/admin/surveys/:id`). Every request carries Telegram identity headers:

- `x-telegram-init-data` — `encodeURIComponent(Telegram.WebApp.initData)`, verified
  server-side via HMAC (fresh for 24h). Used when the page is opened from Telegram.
- `x-telegram-user-id` — development-only fallback accepted when the Worker runs with
  `ENVIRONMENT=development` (staging / local).

## Testing identities outside Telegram (staging test banner)

On staging and local dev (`/health` reports `environment=development`) and outside
Telegram, a yellow banner appears at the top of `/admin`. Enter any Telegram user ID
that exists in the `users` table, press 应用 (apply), and the page reloads its data as
that user. Admins see all surveys; regular users only see their own. The banner never
renders in production.

## Deploy

Staging (isolated bindings, see `wrangler.staging.toml`):

```sh
npx wrangler deploy -c wrangler.staging.toml
```

Production uses the existing command (assets ship with the Worker):

```sh
npm run deploy
```

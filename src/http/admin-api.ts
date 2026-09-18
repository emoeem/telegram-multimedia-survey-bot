/**
 * Backwards-compatible entry point. The admin API now lives in
 * `src/http/admin/`; this module stays so existing imports keep working.
 */
export { handleAdminApi, verifyTelegramWebAppProfile, verifyTelegramWebAppUser } from "./admin/index";
export type { TelegramWebAppProfile } from "./admin/index";

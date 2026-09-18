/**
 * Public contact links shown on the web surfaces (survey list and completion
 * page, plaza, challenge).
 *
 * Both are configurable so a customer deployment can point at its own groups
 * and bots. An unset variable falls back to the hosted default, while an
 * explicitly empty value hides the entry — that is how a deployment turns a
 * link off without a code change.
 */
const DEFAULT_SUBMISSION_BOT_URL = "https://t.me/tougaojiqirbot";

export function resolveSubmissionBotUrl(env: { SUBMISSION_BOT_URL?: string }): string | null {
  const configured = env.SUBMISSION_BOT_URL;
  if (configured === undefined) return DEFAULT_SUBMISSION_BOT_URL;
  const trimmed = configured.trim();
  return trimmed === "" ? null : trimmed;
}

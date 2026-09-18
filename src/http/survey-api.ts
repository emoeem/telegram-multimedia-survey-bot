/**
 * Public survey API entry point.
 *
 * The implementation lives in `./survey/*` (catalog, participant, answers,
 * media, definition, handler). This module stays as the stable import surface
 * for the router and for the plaza/trial/email-auth APIs that share the
 * response helpers and the participant resolver.
 */
export { fail, json } from "./api-response";
export { resolveParticipant, type Participant } from "./survey/participant";
export { handleSurveyApiRequest } from "./survey/handler";
export { handleSurveyMediaUpload } from "./survey/media";

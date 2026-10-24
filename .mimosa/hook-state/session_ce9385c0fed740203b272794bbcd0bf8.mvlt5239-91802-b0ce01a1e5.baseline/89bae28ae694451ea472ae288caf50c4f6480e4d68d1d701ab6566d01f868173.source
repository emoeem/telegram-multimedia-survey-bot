import fontData from "../assets/LXGWWenKaiScreen-subset.ttf";
import emojiFontData from "../assets/NotoColorEmoji-subset.ttf";

/**
 * A Worker-safe LXGW WenKai subset. The glyph set is intentionally versioned
 * with the project rather than fetched from external storage at runtime.
 */
export const RESULT_VISUAL_FONT = new Uint8Array(fontData);

/** A 109 KB color-font subset for common user-entered emoji.  It avoids a
 * runtime asset service and keeps the Worker bundle comfortably bounded. */
export const RESULT_VISUAL_EMOJI_FONT = new Uint8Array(emojiFontData);
export const RESULT_VISUAL_FONTS = [RESULT_VISUAL_FONT, RESULT_VISUAL_EMOJI_FONT];

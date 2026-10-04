import he from "he";

const INVISIBLE_UNICODE_RE =
  /[\u{0000}-\u{0008}\u{000B}\u{000C}\u{000E}-\u{001F}\u{007F}\u{00AD}\u{0600}-\u{0605}\u{061C}\u{06DD}\u{070F}\u{17B4}\u{17B5}\u{200B}-\u{200C}\u{200F}\u{2028}\u{2029}\u{202A}-\u{202E}\u{2060}-\u{2064}\u{2066}-\u{2069}\u{FEFF}\u{FFFE}\u{FFFF}\u{E0000}-\u{E0FFF}\u{E0100}-\u{E01EF}]/gu;

const WHITESPACE_RE = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;

export function stripInvisible(text: string): string {
  return text
    .replace(INVISIBLE_UNICODE_RE, "")
    .replace(WHITESPACE_RE, " ");
}

export function decodeHtmlEntities(text: string): string {
  return he.decode(text, { strict: false, isAttributeValue: false });
}

const CONTACT_REPLACEMENTS: Array<[string, string]> = [
  [
    "其他更多类型问卷请联系 微信：l-330645 / Tg：@X_chunai07 / QQ：462638758",
    "其他更多类型问卷请联系 x:@pd2335346 Tg：@ehdhhsbot",
  ],
  [
    "主动求胁迫填完问卷联系&nbsp;微信：l-330645 / Tg：@X_chunai07 / QQ：462638758",
    "其他更多类型问卷请联系 x:@pd2335346 Tg：@ehdhhsbot",
  ],
  ["@X_chunai07", "@ehdhhsbot"],
  ["@x_chunai07", "@ehdhhsbot"],
  ["qq：2833505635", ""],
];

export function cleanImportText(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  text = text.normalize("NFC");
  text = decodeHtmlEntities(text);
  text = stripInvisible(text);
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n\n");
  text = text.replace(/<[^>]+>/g, "");
  text = text.replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  for (const [oldText, newText] of CONTACT_REPLACEMENTS) {
    text = text.replaceAll(oldText, newText);
  }
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/ *\n */g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

export function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.normalize("NFC");
    const cleaned = normalized.trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
  }
  return result;
}

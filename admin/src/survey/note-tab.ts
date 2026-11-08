/**
 * 纸条页初始页签与会话深链（T2 · G4 深链修正）。
 *
 * 此前 `?thread=` 只在 ChatTab 挂载后才被读取，而页签默认 mine——CoinCenter
 * 抽中后的 `/notes?thread=X&tab=chat` 深链会先落在「我的纸条」页（页签参数
 * 在才侥幸能落对，`?thread=` 单独出现时彻底落空）。修正为「?thread= 存在
 * 即落 chat」，决策抽成纯函数（tests/unit/admin/note-tab.test.ts 锚点），
 * NoteScreen 与 ChatTab 共用同一套解析口径。
 */

export type NoteTab = "mine" | "chat";

/** 初始页签：?thread= 有值（合法会话 id）→ chat；否则退回 ?tab=chat，默认 mine。 */
export function initialNoteTab(search: string): NoteTab {
  if (threadIdFromSearch(search) !== null) return "chat";
  return new URLSearchParams(search).get("tab") === "chat" ? "chat" : "mine";
}

/** 深链里的会话 id：非正整数按缺失处理（与 ChatTab 原内联解析同一口径）。 */
export function threadIdFromSearch(search: string): number | null {
  const raw = Number(new URLSearchParams(search).get("thread"));
  return Number.isInteger(raw) && raw > 0 ? raw : null;
}

/** Best-effort clipboard write with a gracefully-degrading fallback chain.
 *
 * `navigator.clipboard.writeText` is only available in secure contexts and
 * requires transient user activation. `document.execCommand("copy")` works
 * in older WebViews but is deprecated. When neither works (e.g. HTTP or
 * revoked permissions) we fall back to a hidden prompt so the user can
 * still Ctrl+C the value manually — better than silently failing. */
export async function safeCopy(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext !== false) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
    return true;
  } catch {
    /* fall through to manual prompt */
  }
  // Final fallback: let the user select and copy manually.
  try {
    // eslint-disable-next-line no-alert
    window.prompt("请复制以下内容 (Ctrl+C)：", text);
    return true;
  } catch {
    return false;
  }
}

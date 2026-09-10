import { parse, type DefaultTreeAdapterTypes } from "parse5";
import type { ImportedQuestion, ImportedSurvey } from "./import.service";

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;

export const ZOHO_HOSTS = new Set([
  "forms.zohopublic.com",
  "forms.zoho.com",
  "forms.zoho.com.cn",
  "forms.zohopublic.com.cn",
]);

const ZOHO_HOST_SUFFIXES = [".zohopublic.com", ".zohopublic.com.cn", ".forms.zoho.com", ".forms.zoho.com.cn"];
const MAX_HTML_BYTES = 8 * 1024 * 1024;
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36";

export class ZohoImportError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ZohoImportError";
    this.code = code;
  }
}

export function isZohoUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return ZOHO_HOSTS.has(host) || ZOHO_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
  } catch {
    return false;
  }
}

function attributes(element: Element): Record<string, string> {
  return Object.fromEntries(element.attrs.map((attribute) => [attribute.name.toLowerCase(), attribute.value]));
}

function descendants(node: Node): Node[] {
  const children = "childNodes" in node && Array.isArray(node.childNodes) ? node.childNodes : [];
  return children.flatMap((child) => [child, ...descendants(child)]);
}

function elements(node: Node, tagName?: string): Element[] {
  return descendants(node).filter(
    (child): child is Element =>
      child.nodeName === tagName ||
      (child.nodeName !== "#text" && "attrs" in child && (!tagName || child.tagName === tagName)),
  );
}

function textContent(node: Node): string {
  return descendants(node)
    .filter((child) => child.nodeName === "#text" && "value" in child)
    .map((child) => String(child.value))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanText(value: string): string {
  return value.replace(/\*+/g, "").replace(/\s+/g, " ").trim();
}

function attribute(element: Element, name: string): string {
  return attributes(element)[name.toLowerCase()] ?? "";
}

function metaContent(document: Node, property: string): string {
  return (
    elements(document, "meta")
      .find((element) => attribute(element, "property") === property)
      ?.attrs.find((item) => item.name === "content")?.value ?? ""
  );
}

function fieldLabel(field: Element, number: number): string {
  const label = elements(field, "label").find((element) =>
    attribute(element, "class").split(/\s+/).includes("labelName"),
  );
  const fallback = textContent(field).split(/\n/)[0] ?? "";
  return cleanText(label ? textContent(label) : fallback) || `问题${number}`;
}

function option(label: string, id: string, order: number) {
  return { id: `${id}_o${order}`, label: String(order), value: label, text: label, order, media: [] };
}

function choiceOptions(field: Element, id: string): string[] {
  const selectOptions = elements(field, "option")
    .map((item) => cleanText(textContent(item)))
    .filter(Boolean);
  if (selectOptions.length) return [...new Set(selectOptions)];
  return elements(field, "input")
    .filter((input) => ["radio", "checkbox"].includes(attribute(input, "type")))
    .map((input) => {
      const value = cleanText(attribute(input, "value"));
      const label = elements(field, "label").find((candidate) => textContent(candidate).includes(value));
      return cleanText(label ? textContent(label) : value);
    })
    .filter(Boolean)
    .map((value) => (value.toLowerCase() === "zfs-others-zfs" ? "其他" : value));
}

function imageMedia(field: Element) {
  const image = elements(field, "img").find((candidate) => attribute(candidate, "src").startsWith("http"));
  const url = image ? attribute(image, "src") : "";
  return url
    ? [{ type: "photo" as const, source: "url" as const, url, caption: cleanText(attribute(image!, "alt")) }]
    : [];
}

function convertField(field: Element, index: number): ImportedQuestion {
  const typeCode = Number(attribute(field, "comptype"));
  const id = attribute(field, "compname") || `q_${index}`;
  const label = fieldLabel(field, index);
  const required = attribute(field, "mandatory").toLowerCase() === "true";
  const warnings: string[] = [];
  let type: ImportedQuestion["type"] = "text";
  let options: ReturnType<typeof option>[] = [];

  if (typeCode === 2) type = "long_text";
  else if ([13, 7, 17, 27].includes(typeCode)) type = typeCode === 27 ? "yes_no" : "single";
  else if (typeCode === 15) type = "multiple";
  else if (typeCode === 19) type = "file";
  else if (typeCode === 32) type = "image";
  else if (typeCode === 21) type = "rating";
  else if (![1, 3, 35, 36, 38].includes(typeCode))
    warnings.push(`未识别的 Zoho 题型 comptype=${typeCode}，已按文本题导入`);

  if (type === "single" || type === "multiple" || type === "yes_no" || type === "rating") {
    const values =
      type === "rating"
        ? Array.from(
            {
              length: Math.max(
                2,
                Math.min(20, Number(attribute(elements(field, "a")[0] ?? field, "rating_count")) || 5),
              ),
            },
            (_, item) => String(item + 1),
          )
        : choiceOptions(field, id);
    if (values.length < 2) {
      type = "text";
      warnings.push(values.length ? "选项不足两个，已按文本题导入" : "未解析到选项，已按文本题导入");
    } else {
      options = values.map((value, item) => option(value, id, item + 1));
    }
  }

  return {
    type,
    title: label,
    required,
    options,
    media: imageMedia(field),
    ...(warnings.length ? { warnings } : {}),
    confidence: { type: warnings.length ? 0.55 : 0.95, required: 0.9 },
  };
}

export function zohoHtmlToSurvey(html: string): ImportedSurvey {
  const document = parse(html);
  const formName = elements(document, "input").find((input) => attribute(input, "name") === "formName");
  const title =
    cleanText(metaContent(document, "og:title")) ||
    cleanText(formName ? attribute(formName, "value") : "") ||
    "Imported from Zoho Forms";
  const description = cleanText(metaContent(document, "og:description")) || "Imported from Zoho Forms";
  const fields = elements(document, "li").filter(
    (field) => attribute(field, "elname") === "livefield-elem" || attribute(field, "comptype"),
  );
  const questions = fields
    .filter((field) => Number(attribute(field, "comptype")) > 0)
    .map((field, index) => convertField(field, index + 1));
  if (!questions.length) throw new ZohoImportError("ZOHO_PARSE_FAILED", "未能在 Zoho Forms 页面中找到有效题目。");
  return {
    title,
    description,
    questions,
    importWarnings: questions.flatMap((question) => question.warnings ?? []),
    settings: { anonymous: false, allowMultipleResponses: false, maxResponsesPerUser: 1 },
  };
}

async function readResponseText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return response.text();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_HTML_BYTES) throw new ZohoImportError("DOCUMENT_TOO_LARGE", "Zoho Forms 页面超过 8MB，无法导入。");
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function fetchZohoFormsSurveyJson(url: string, timeoutMs = 25_000): Promise<string> {
  if (!isZohoUrl(url)) throw new ZohoImportError("INVALID_URL", "请输入公开的 Zoho Forms 链接。");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: { Accept: "text/html", "User-Agent": USER_AGENT },
      signal: controller.signal,
    });
    if (!isZohoUrl(response.url)) {
      throw new ZohoImportError("INVALID_REDIRECT", "Zoho Forms 链接重定向到了不受支持的域名。");
    }
    if (response.status === 401 || response.status === 403)
      throw new ZohoImportError("DOCUMENT_REQUIRES_AUTH", "该 Zoho Forms 问卷需要登录或不是公开问卷。");
    if (response.status === 404) throw new ZohoImportError("HTTP_404", "Zoho Forms 问卷链接返回 404，可能已失效。");
    if (!response.ok)
      throw new ZohoImportError("DOWNLOAD_FAILED", `Zoho Forms 页面请求失败（HTTP ${response.status}）。`);
    const html = await readResponseText(response);
    return JSON.stringify({ schema_version: 1, survey: zohoHtmlToSurvey(html) });
  } catch (error) {
    if (error instanceof ZohoImportError) throw error;
    if (error instanceof DOMException && error.name === "AbortError")
      throw new ZohoImportError("NETWORK_ERROR", "获取 Zoho Forms 问卷超时。");
    throw new ZohoImportError("NETWORK_ERROR", "获取 Zoho Forms 问卷失败，请稍后重试。");
  } finally {
    clearTimeout(timer);
  }
}

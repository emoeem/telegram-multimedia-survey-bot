import type { UnifiedSurveyImport } from "../survey/schema";

/**
 * Microsoft Forms import for the admin web app.
 *
 * Public Forms links are fetched directly from the Worker: the response page
 * embeds a `window.OfficeFormServerInfo` blob that points at the form's OData
 * definition API, which returns the complete form definition (title,
 * questions, choices, ratings, images) without authentication.
 *
 * This mirrors scripts/survey_import/microsoft.py so the CLI and the website
 * produce the same survey.json structure. PDF / Office document conversion
 * stays in the Python importer (Workers cannot run PyMuPDF or LibreOffice).
 */

export const FORMS_HOSTS = new Set([
  "forms.office.com",
  "forms.cloud.microsoft",
  "forms.microsoft.com",
  "forms.osi.office.net",
]);

const FORMS_HOST_SUFFIXES = [
  ".forms.office.com",
  ".forms.cloud.microsoft",
  ".forms.microsoft.com",
  ".forms.osi.office.net",
];

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const YES_NO_VALUES = new Set([
  "是",
  "否",
  "yes",
  "no",
  "可以",
  "不可以",
  "有",
  "没有",
]);

export class FormsImportError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "FormsImportError";
    this.code = code;
  }
}

export function isFormsUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      FORMS_HOSTS.has(host) ||
      FORMS_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
    );
  } catch {
    return false;
  }
}

function cleanText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/<[^>]+>/g, "")
    .trim();
}

function parseQuestionInfo(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function extractBalancedJsonObject(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function extractOfficeFormServerInfo(html: string): Record<string, unknown> {
  const marker = "window.OfficeFormServerInfo";
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) {
    throw new FormsImportError(
      "FORMS_PARSE_FAILED",
      "无法在 Microsoft Forms 页面中找到问卷信息（链接可能不是可公开访问的问卷）。",
    );
  }
  const brace = html.indexOf("{", markerIndex);
  if (brace < 0) {
    throw new FormsImportError(
      "FORMS_PARSE_FAILED",
      "Microsoft Forms 页面中的问卷信息格式异常。",
    );
  }
  const raw = extractBalancedJsonObject(html, brace);
  if (!raw) {
    throw new FormsImportError(
      "FORMS_PARSE_FAILED",
      "Microsoft Forms 页面中的问卷信息不完整。",
    );
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new FormsImportError(
      "FORMS_PARSE_FAILED",
      "Microsoft Forms 页面中的问卷信息不是有效 JSON。",
    );
  }
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ status: number; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT, Accept: "*/*", ...headers },
      signal: controller.signal,
    });
    const body = await response.text();
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

interface FormsDefinition {
  title?: unknown;
  description?: unknown;
  questions?: unknown[];
  descriptiveQuestions?: unknown[];
  predefinedResponses?: unknown;
}

interface RawQuestion {
  id?: unknown;
  type?: unknown;
  title?: unknown;
  formsProRTQuestionTitle?: unknown;
  subtitle?: unknown;
  formsProRTSubtitle?: unknown;
  required?: unknown;
  order?: unknown;
  groupId?: unknown;
  allowMultipleValues?: unknown;
  image?: {
    resourceUrl?: unknown;
    contentType?: unknown;
    width?: unknown;
    height?: unknown;
    originalFileName?: unknown;
    altText?: unknown;
  };
  questionInfo?: unknown;
}

function buildOptions(
  id: string,
  choices: string[],
): UnifiedSurveyImport["survey"]["questions"][number]["options"] {
  return choices.map((choice, index) => ({
    id: `${id}_o${index + 1}`,
    label: String(index + 1),
    text: choice,
    value: choice,
    order: index + 1,
    media: [],
  }));
}

function convertQuestion(
  question: RawQuestion,
  index: number,
  pageId: string,
): UnifiedSurveyImport["survey"]["questions"][number] {
  const id = String(question.id ?? `q_${index + 1}`);
  const title =
    cleanText(question.formsProRTQuestionTitle ?? question.title) ||
    `Question ${index + 1}`;
  const subtitle = cleanText(
    question.formsProRTSubtitle ?? question.subtitle,
  );
  const questionInfo = parseQuestionInfo(question.questionInfo);
  const warnings: string[] = [];

  let type: UnifiedSurveyImport["survey"]["questions"][number]["type"] = "text";
  let options: UnifiedSurveyImport["survey"]["questions"][number]["options"] = [];
  const validation: Record<string, unknown> = {};

  if (question.type === "Question.Choice") {
    const rawChoices = Array.isArray(questionInfo.Choices)
      ? (questionInfo.Choices as Array<Record<string, unknown> | string>)
      : [];
    const choices: string[] = [];
    for (const choice of rawChoices) {
      if (typeof choice === "string") {
        if (choice.trim()) choices.push(choice.trim());
      } else if (choice && typeof choice === "object") {
        const description = cleanText(
          choice.Description ?? choice.FormsProDisplayRTText,
        );
        if (description) choices.push(description);
      }
    }
    if (questionInfo.AllowOtherAnswer === true) choices.push("其他");

    const choiceType = questionInfo.ChoiceType;
    const multi =
      question.allowMultipleValues === true || choiceType === 3;
    if (!multi) {
      const normalized = new Set(
        choices.map((choice) => choice.trim().toLowerCase()),
      );
      const yesNoHits = choices.filter((choice) =>
        YES_NO_VALUES.has(choice.trim().toLowerCase()),
      );
      if (
        choices.length >= 2 &&
        yesNoHits.length === choices.length &&
        normalized.size >= 2
      ) {
        type = "yes_no";
      } else {
        type = "single";
      }
    } else {
      type = "multiple";
    }
    options = buildOptions(id, choices);

    if (type === "multiple") {
      const restriction = questionInfo.ChoiceRestrictionType;
      const minimum = questionInfo.ChoiceMinBoundary;
      const maximum = questionInfo.ChoiceMaxBoundary;
      if (restriction === "AtLeast" && typeof minimum === "number") {
        validation.min_selections = Math.floor(minimum);
      } else if (restriction === "AtMost" && typeof maximum === "number") {
        validation.max_selections = Math.floor(maximum);
      } else if (restriction === "Between") {
        if (typeof minimum === "number") {
          validation.min_selections = Math.floor(minimum);
        }
        if (typeof maximum === "number") {
          validation.max_selections = Math.floor(maximum);
        }
      }
    }
  } else if (question.type === "Question.Rating") {
    let length = Number(questionInfo.Length ?? 5);
    if (!Number.isFinite(length)) length = 5;
    length = Math.max(2, Math.min(Math.floor(length), 20));
    type = "rating";
    options = buildOptions(
      id,
      Array.from({ length }, (_, item) => String(item + 1)),
    );
  } else if (question.type === "Question.TextField") {
    type = questionInfo.Multiline === true ? "long_text" : "text";
  } else if (question.type === "Question.DateTime") {
    const hasDate = Boolean(questionInfo.date ?? questionInfo.Date);
    const hasTime = Boolean(questionInfo.time ?? questionInfo.Time);
    type = hasDate && !hasTime ? "date" : hasTime && !hasDate ? "time" : "date";
  } else if (question.type === "Question.FileUpload") {
    type = "file";
  } else {
    warnings.push(
      `未识别的 Forms 题型 ${String(question.type ?? "unknown")}，已按文本题导入`,
    );
  }

  const media: UnifiedSurveyImport["survey"]["questions"][number]["media"] = [];
  const image = question.image;
  if (image?.resourceUrl && String(image.resourceUrl).startsWith("http")) {
    media.push({
      id: `${id}_media_0`,
      type: "photo",
      source: "url",
      url: String(image.resourceUrl),
      ...(image.contentType ? { mime_type: String(image.contentType) } : {}),
      ...(typeof image.width === "number" ? { width: image.width } : {}),
      ...(typeof image.height === "number" ? { height: image.height } : {}),
      ...(image.originalFileName
        ? { file_name: String(image.originalFileName) }
        : {}),
      ...(image.altText ? { caption: String(image.altText) } : {}),
    });
  }

  const result: UnifiedSurveyImport["survey"]["questions"][number] = {
    id,
    type,
    title,
    required: question.required === true,
    order: index + 1,
    options,
    media,
    ...(subtitle ? { description: subtitle } : {}),
    ...(pageId ? { page_id: pageId } : {}),
    ...(Object.keys(validation).length ? { validation } : {}),
  };
  if (warnings.length) {
    (result as unknown as Record<string, unknown>).warnings = warnings;
  }
  return result;
}

function formsDefinitionToSurvey(data: FormsDefinition): UnifiedSurveyImport {
  const title = cleanText(data.title) || "Imported Survey";
  const description = cleanText(data.description) || "Imported from Microsoft Forms";

  const pages: UnifiedSurveyImport["survey"]["pages"] = [];
  const pageByDescriptive = new Map<string, string>();
  const descriptive = Array.isArray(data.descriptiveQuestions)
    ? [...data.descriptiveQuestions]
    : [];
  descriptive.sort((a, b) => {
    const left = (a as Record<string, unknown>).order;
    const right = (b as Record<string, unknown>).order;
    return Number(left ?? 0) - Number(right ?? 0);
  });

  descriptive.forEach((item, index) => {
    const record = item as Record<string, unknown>;
    const pageId = `page_${index + 1}`;
    const page: UnifiedSurveyImport["survey"]["pages"][number] = {
      id: pageId,
      order: index + 1,
    };
    const pageTitle = cleanText(record.title);
    const pageDescription = cleanText(record.subtitle);
    if (pageTitle) page.title = pageTitle;
    if (pageDescription) page.description = pageDescription;
    pages.push(page);
    if (record.id !== null && record.id !== undefined) {
      pageByDescriptive.set(String(record.id), pageId);
    }
  });

  if (pages.length === 0) {
    pages.push({ id: "page_1", order: 1 });
  }

  const questions = Array.isArray(data.questions) ? [...data.questions] : [];
  questions.sort((a, b) => {
    const left = (a as RawQuestion).order;
    const right = (b as RawQuestion).order;
    return Number(left ?? 0) - Number(right ?? 0);
  });

  let currentPage = pages[0]!.id;
  const surveyQuestions = questions.map((question, index) => {
    const raw = question as RawQuestion;
    if (
      raw.groupId !== null &&
      raw.groupId !== undefined &&
      pageByDescriptive.has(String(raw.groupId))
    ) {
      currentPage = pageByDescriptive.get(String(raw.groupId))!;
    }
    return convertQuestion(raw, index, currentPage);
  });

  const warnings = surveyQuestions.flatMap((question) =>
    Array.isArray((question as unknown as Record<string, unknown>).warnings)
      ? (((question as unknown as Record<string, unknown>).warnings as unknown[]) as string[])
      : [],
  );

  return {
    schema_version: 1,
    survey: {
      title,
      description,
      pages,
      questions: surveyQuestions,
      settings: {
        anonymous: false,
        allow_multiple: false,
        max_responses: 1,
        shuffle_questions: false,
        shuffle_options: false,
        show_progress: true,
        allow_back: true,
        allow_resume: true,
      },
      metadata: {
        source: "microsoft_forms",
        warnings,
      },
    },
  };
}

/**
 * Fetch a public Microsoft Forms URL and return the standard survey.json text.
 */
export async function fetchMicrosoftFormsSurveyJson(
  url: string,
  timeoutMs = 25_000,
): Promise<string> {
  const page = await fetchJson(url, {}, timeoutMs);
  if (page.status === 401 || page.status === 403) {
    throw new FormsImportError(
      "DOCUMENT_REQUIRES_AUTH",
      "This Microsoft form requires authentication or is not publicly accessible.",
    );
  }
  if (page.status === 404) {
    throw new FormsImportError("HTTP_404", "问卷链接返回 404，可能已失效。");
  }
  if (page.status !== 200) {
    throw new FormsImportError(
      "DOWNLOAD_FAILED",
      `Microsoft Forms 页面请求失败（HTTP ${page.status}）。`,
    );
  }

  const info = extractOfficeFormServerInfo(page.body);
  const apiUrl =
    info.prefetchFormUrl ?? info.prefetchFormWithResponsesUrl;
  if (typeof apiUrl !== "string" || !/^https?:\/\//.test(apiUrl)) {
    throw new FormsImportError(
      "FORMS_PARSE_FAILED",
      "Microsoft Forms 页面未提供问卷定义 API 地址，无法获取问卷内容。",
    );
  }

  const apiResponse = await fetchJson(
    apiUrl,
    {
      Accept: "application/json",
      "X-UserSessionId": String(info.serverSessionId ?? ""),
      __RequestVerificationToken: String(info.antiForgeryToken ?? ""),
    },
    timeoutMs,
  );
  if (apiResponse.status === 401 || apiResponse.status === 403) {
    throw new FormsImportError(
      "DOCUMENT_REQUIRES_AUTH",
      "This Microsoft form requires authentication or is not publicly accessible.",
    );
  }
  if (apiResponse.status !== 200) {
    throw new FormsImportError(
      "FORMS_PARSE_FAILED",
      `获取 Microsoft Forms 问卷定义失败（HTTP ${apiResponse.status}）。`,
    );
  }

  let definition: FormsDefinition;
  try {
    definition = JSON.parse(apiResponse.body) as FormsDefinition;
  } catch {
    throw new FormsImportError(
      "FORMS_PARSE_FAILED",
      "Microsoft Forms 问卷定义不是有效 JSON。",
    );
  }
  if (!definition || !Array.isArray(definition.questions)) {
    throw new FormsImportError(
      "FORMS_PARSE_FAILED",
      "Microsoft Forms 问卷定义缺少 questions 字段，可能不是可公开访问的问卷。",
    );
  }

  return JSON.stringify(formsDefinitionToSurvey(definition));
}

/**
 * survey-tool 的共享内核：解析、PDF 渲染、命名规则。
 *
 * 命令行（index.ts）和本地 Web 服务（server.ts）都从这里取函数，谁都不许再写
 * 一份。上一轮已经吃过一次亏——分页字段 `page_id` / `pageId` 两边各认一种，
 * 结果一边导出的 PDF 里题目全被静默丢掉。共享内核就是为了让这种分叉不可能发生。
 */

import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { fetchMicrosoftFormsSurveyJson, isFormsUrl } from "../../src/services/microsoft-forms.service";
import { fetchZohoFormsSurveyJson, isZohoUrl } from "../../src/services/zoho-forms.service";
import type { ExportSurvey } from "../../admin/src/lib/survey-export";

/**
 * 一个「待处理项」。
 *
 * - `url`       远程链接，走对应平台抓取器
 * - `json-path` 本地的 survey.json 文件路径
 * - `json-text` 直接给到 JSON 正文（Web 端粘贴用，不碰文件系统）
 */
export interface Source {
  kind: "url" | "json-path" | "json-text";
  value: string;
  label: string;
}

/**
 * 把 `UnifiedSurveyImport`（或任意含 survey.questions 的 JSON）转成导出结构。
 * 导入器和命令行共用同一份字段名，所以这里只做排序与类型收敛，不改语义。
 */
export function toExportSurvey(input: unknown, fallbackTitle: string): ExportSurvey {
  if (!input || typeof input !== "object") throw new Error("问卷 JSON 不是一个对象");
  const root = input as Record<string, unknown>;
  const survey = (root.survey ?? root) as Record<string, unknown>;
  const rawQuestions = survey.questions;
  if (!Array.isArray(rawQuestions)) {
    throw new Error("问卷 JSON 缺少 survey.questions 数组");
  }
  const rawPages = Array.isArray(survey.pages) ? (survey.pages as Array<Record<string, unknown>>) : [];

  const questions = rawQuestions.map((item, index) => {
    const question = (item ?? {}) as Record<string, unknown>;
    const options = Array.isArray(question.options)
      ? (question.options as Array<Record<string, unknown>>).map((option, optionIndex) => ({
          id: typeof option.id === "number" ? option.id : optionIndex + 1,
          label: typeof option.label === "string" ? option.label : String(option.label ?? ""),
          order: typeof option.order === "number" ? option.order : optionIndex + 1,
        }))
      : [];
    const settings = question.settings as Record<string, unknown> | null | undefined;
    const columns = Array.isArray(settings?.columns)
      ? (settings.columns as unknown[]).filter((column): column is string => typeof column === "string")
      : Array.isArray(question.columns)
        ? (question.columns as unknown[]).filter((column): column is string => typeof column === "string")
        : [];
    const rawValidation = question.validation as Record<string, unknown> | null | undefined;
    const validation: Record<string, number | boolean> = {};
    if (rawValidation) {
      for (const [key, value] of Object.entries(rawValidation)) {
        if (typeof value === "number" || typeof value === "boolean") validation[key] = value;
      }
    }
    return {
      id: typeof question.id === "number" ? question.id : index + 1,
      type: typeof question.type === "string" ? question.type : "text",
      title: typeof question.title === "string" ? question.title : "",
      description: typeof question.description === "string" ? question.description : null,
      required: question.required === true,
      order: typeof question.order === "number" ? question.order : index + 1,
      // 导入器产出的 survey.json 用 `page_id`（字符串 "p1"），编辑器接口用
      // `pageId`（数字）。两个都收，否则整卷题目会因为分页对不上而被丢掉。
      pageId:
        typeof question.pageId === "number" || typeof question.pageId === "string"
          ? question.pageId
          : typeof question.page_id === "number" || typeof question.page_id === "string"
            ? question.page_id
            : null,
      columns,
      validation,
      options,
    };
  });

  return {
    id: typeof survey.id === "number" ? (survey.id as number) : 0,
    title: typeof survey.title === "string" && survey.title.trim() ? survey.title.trim() : fallbackTitle,
    description: typeof survey.description === "string" ? survey.description : null,
    status: typeof survey.status === "string" ? survey.status : undefined,
    pages: rawPages.map((page, index) => ({
      id: typeof page.id === "number" || typeof page.id === "string" ? page.id : index + 1,
      title: typeof page.title === "string" ? page.title : null,
      description: typeof page.description === "string" ? page.description : null,
      order: typeof page.order === "number" ? page.order : index + 1,
    })),
    questions,
  };
}

/** 读一份问卷：远程链接走对应平台的抓取器，本地 .json 直接解析后走同一条收敛路径。 */
export async function loadSurvey(source: Source): Promise<ExportSurvey> {
  if (source.kind === "json-path") {
    return toExportSurvey(JSON.parse(readFileSync(source.value, "utf8")), source.label);
  }
  if (source.kind === "json-text") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(source.value);
    } catch (error) {
      throw new Error(`粘贴的 JSON 解析失败：${error instanceof Error ? error.message : String(error)}`);
    }
    return toExportSurvey(parsed, source.label);
  }
  const url = source.value;
  if (!isFormsUrl(url) && !isZohoUrl(url)) {
    throw new Error(`不支持的链接（只支持 Microsoft Forms / Zoho Forms）：${url}`);
  }
  const json = isFormsUrl(url) ? await fetchMicrosoftFormsSurveyJson(url) : await fetchZohoFormsSurveyJson(url);
  return toExportSurvey(JSON.parse(json), url);
}

/** 找一个能跑 `--headless --print-to-pdf` 的 Chromium：系统命令优先，其次 playwright 缓存。 */
export function findChromium(): string | null {
  const names = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "chrome"];
  for (const name of names) {
    // Windows 没有 `sh -c command -v`，用它自己的 `where`。
    const probe =
      process.platform === "win32"
        ? spawnSync("where", [name], { encoding: "utf8" })
        : spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
    if (probe.status === 0 && probe.stdout.trim()) return probe.stdout.trim().split(/\r?\n/)[0]!;
  }
  const cacheRoot = join(process.env.HOME ?? "", ".cache/ms-playwright");
  if (existsSync(cacheRoot)) {
    // playwright 的目录布局随版本变过（chrome-linux / chrome-linux64 / …），
    // 所以不写死子目录名，按「目录 → 子目录 → 可执行文件」逐层找。
    for (const entry of readdirSync(cacheRoot)) {
      if (!entry.startsWith("chromium")) continue;
      const base = join(cacheRoot, entry);
      try {
        if (!statSync(base).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const sub of readdirSync(base)) {
        for (const binary of ["chrome", "headless_shell"]) {
          const candidate = join(base, sub, binary);
          if (existsSync(candidate)) return candidate;
        }
      }
    }
  }
  return null;
}

/**
 * 用系统 Chromium 把导出 HTML 打成 PDF，返回字节。
 *
 * 不写文件也要走临时文件：`--print-to-pdf` 只接受路径，不接受 stdout。用完即删。
 */
export function renderPdfBytes(html: string, chromium: string): Uint8Array {
  const stamp = `${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const htmlPath = join(tmpdir(), `survey-tool-${stamp}.html`);
  const pdfPath = join(tmpdir(), `survey-tool-${stamp}.pdf`);
  writeFileSync(htmlPath, html, "utf8");
  try {
    const result = spawnSync(
      chromium,
      [
        "--headless",
        "--disable-gpu",
        "--no-sandbox",
        "--no-pdf-header-footer",
        `--print-to-pdf=${pdfPath}`,
        `file://${htmlPath}`,
      ],
      { encoding: "utf8", timeout: 120_000 },
    );
    if (result.status !== 0 || !existsSync(pdfPath)) {
      const detail = (result.stderr || result.stdout || "").split("\n").filter(Boolean).slice(-3).join(" ");
      throw new Error(`PDF 生成失败${detail ? `：${detail}` : ""}`);
    }
    return new Uint8Array(readFileSync(pdfPath));
  } finally {
    for (const path of [htmlPath, pdfPath]) {
      try {
        rmSync(path, { force: true });
      } catch {
        /* 临时文件清不掉不影响本次结果 */
      }
    }
  }
}

/** 文件名清洗：去掉路径分隔符与控制字符，限制长度，空标题给兜底名。 */
export function safeName(value: string, fallback: string): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return cleaned || fallback;
}

/** 链接可能很长，日志里截短；文件名/标题里也可能有换行，一并压平。 */
export function sanitizeLabel(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > 72 ? `${flat.slice(0, 69)}…` : flat;
}

/** 一次输入最多收多少条链接。上限是防误粘，不是性能限制。 */
export const MAX_INPUT_LINES = 200;

export interface ParsedInput {
  urls: string[];
  /** 被跳过的行数（空行、注释、非链接），只是给用户看的统计。 */
  skipped: number;
  /** 超出上限而没被收下的行数。 */
  overflow: number;
}

/**
 * 从一段纯文本里取出链接：一行一个，`#` 开头当注释，大小写不敏感去重。
 *
 * Web 端不碰文件系统，所以这里是「只认链接」的版本；命令行那份额外支持 .json
 * 与 .txt 路径，两者共用同一套去重与注释规则。
 */
export function collectUrlLines(text: string, limit = MAX_INPUT_LINES): ParsedInput {
  const seen = new Set<string>();
  const urls: string[] = [];
  let skipped = 0;
  let overflow = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      skipped += 1;
      continue;
    }
    if (!/^https?:\/\//i.test(line)) {
      skipped += 1;
      continue;
    }
    const key = line.toLowerCase();
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    if (urls.length >= limit) {
      overflow += 1;
      continue;
    }
    urls.push(line);
  }
  return { urls, skipped, overflow };
}

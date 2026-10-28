#!/usr/bin/env bun
/**
 * survey-tool 的本地 Web 界面。
 *
 * 定位：命令行那套能力换一个不需要记参数的入口。解析、导出、PDF 全部走
 * `core.ts`，和 CLI 是同一份实现——所以网页上导出的 ZIP 和命令行导出的目录，
 * 内容逐字节一致。
 *
 * 为什么是本地服务而不是纯静态页：抓取要绕 CORS（Microsoft Forms / Zoho 都不
 * 给跨域头），PDF 要调 Chromium。浏览器里两件事都做不了。
 *
 * 安全边界：只绑 127.0.0.1，校验 Host 头（防 DNS rebinding），限制请求体大小。
 * 抓取目标白名单来自 `isFormsUrl` / `isZohoUrl`，不是任意 URL——这是它和
 * 「开放代理」的区别。
 */

import {
  buildSurveyExportHtml,
  buildSurveyExportJson,
  buildSurveyExportMarkdown,
} from "../../admin/src/lib/survey-export";
import type { ExportSurvey } from "../../admin/src/lib/survey-export";
import {
  collectUrlLines,
  findChromium,
  loadSurvey,
  renderPdfBytes,
  safeName,
  sanitizeLabel,
  MAX_INPUT_LINES,
  type Source,
} from "./core";
import { buildZip, type ZipEntry } from "./zip";
import page from "./page.html" with { type: "text" };

type Format = "html" | "markdown" | "json" | "pdf";

const VALID_FORMATS: Format[] = ["html", "markdown", "json", "pdf"];
const MAX_BODY_BYTES = 1024 * 1024;
const EXTENSION: Record<Exclude<Format, "pdf">, string> = {
  html: "html",
  markdown: "md",
  json: "json",
};

interface ParseResult {
  label: string;
  ok: boolean;
  title?: string;
  questions?: number;
  pages?: number;
  error?: string;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) throw new Error("请求内容过大");
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new Error("请求内容过大");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("请求体不是合法 JSON");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("请求体格式不对");
  return parsed as Record<string, unknown>;
}

/**
 * 统一把 text 字段转成待抓取清单；顺带把「超出上限」的统计带上去。
 *
 * 除了逐行链接，也接受整段 survey.json：直接把 JSON 正文粘进来就当作一份问卷
 * 处理。这条路径不经任何网络请求，所以既能用来验证渲染链路，也是用户手上已有
 * survey.json 时的最短路径。
 */
function sourcesFrom(value: unknown): { sources: Source[]; overflow: number; skipped: number } {
  if (typeof value !== "string") throw new Error("缺少 text 字段");
  const trimmed = value.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return {
      sources: [{ kind: "json-text", value: trimmed, label: "粘贴的 survey.json" }],
      overflow: 0,
      skipped: 0,
    };
  }
  const { urls, overflow, skipped } = collectUrlLines(value);
  return {
    sources: urls.map((url) => ({ kind: "url" as const, value: url, label: url })),
    overflow,
    skipped,
  };
}

async function handleParse(request: Request): Promise<Response> {
  const body = await readBody(request);
  const { sources, overflow, skipped } = sourcesFrom(body.text);
  if (!sources.length) return json({ error: "没有识别到链接（每行一个 http/https 地址）" }, 400);

  const results: ParseResult[] = [];
  for (const source of sources) {
    try {
      const survey = await loadSurvey(source);
      results.push({
        label: sanitizeLabel(source.label),
        ok: true,
        title: survey.title,
        questions: survey.questions.length,
        pages: survey.pages.length,
      });
    } catch (error) {
      results.push({
        label: sanitizeLabel(source.label),
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return json({ results, overflow, skipped, limit: MAX_INPUT_LINES });
}

interface RenderedFile {
  name: string;
  bytes: Uint8Array;
}

function renderFormats(
  batch: ExportSurvey[],
  base: string,
  formats: Format[],
  chromium: string | null,
  generatedAt: Date,
  warnings: string[],
): RenderedFile[] {
  const files: RenderedFile[] = [];
  for (const format of formats) {
    if (format === "pdf") {
      if (!chromium) {
        warnings.push("没找到 Chromium，PDF 已跳过（可用导出的 HTML 在浏览器里打印）");
        continue;
      }
      try {
        const html = buildSurveyExportHtml(batch, { generatedAt });
        files.push({ name: `${base}.pdf`, bytes: renderPdfBytes(html, chromium) });
      } catch (error) {
        warnings.push(`${base}.pdf 生成失败：${error instanceof Error ? error.message : String(error)}`);
      }
      continue;
    }
    const content =
      format === "json"
        ? buildSurveyExportJson(batch, { generatedAt })
        : format === "markdown"
          ? buildSurveyExportMarkdown(batch, { generatedAt })
          : buildSurveyExportHtml(batch, { generatedAt });
    files.push({ name: `${base}.${EXTENSION[format]}`, bytes: new TextEncoder().encode(content) });
  }
  return files;
}

async function handleExport(request: Request): Promise<Response> {
  const body = await readBody(request);
  const { sources } = sourcesFrom(body.text);
  if (!sources.length) return json({ error: "没有识别到链接" }, 400);

  const rawFormats = Array.isArray(body.formats) ? body.formats : [];
  const formats = rawFormats
    .map((item) => String(item).toLowerCase())
    .filter((item): item is Format => (VALID_FORMATS as string[]).includes(item));
  if (!formats.length) return json({ error: "没有选择导出格式" }, 400);
  const merge = body.merge === true;

  const surveys: ExportSurvey[] = [];
  const failures: Array<{ label: string; reason: string }> = [];
  for (const source of sources) {
    try {
      surveys.push(await loadSurvey(source));
    } catch (error) {
      failures.push({
        label: sanitizeLabel(source.label),
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (!surveys.length) {
    return json(
      {
        error: "所有链接都解析失败，未生成文件",
        failures,
      },
      422,
    );
  }

  const chromium = formats.includes("pdf") ? findChromium() : null;
  const warnings: string[] = [];
  const generatedAt = new Date();
  const files: RenderedFile[] = [];

  if (merge) {
    files.push(...renderFormats(surveys, `surveys-${surveys.length}`, formats, chromium, generatedAt, warnings));
  } else {
    const used = new Set<string>();
    surveys.forEach((survey, index) => {
      const fallback = `survey-${index + 1}`;
      let base = safeName(survey.title, fallback);
      let suffix = 2;
      while (used.has(base)) base = `${safeName(survey.title, fallback)}-${suffix++}`;
      used.add(base);
      files.push(...renderFormats([survey], base, formats, chromium, generatedAt, warnings));
    });
  }

  if (!files.length) return json({ error: warnings[0] ?? "没有生成任何文件", warnings }, 422);

  // 失败清单落一份进 ZIP：用户下载后才知道哪几条没成功，而不是只在前端一闪而过。
  if (failures.length || warnings.length) {
    const lines = [
      "# survey-tool 导出报告",
      `生成时间：${generatedAt.toISOString()}`,
      `成功：${surveys.length} 份 · 失败：${failures.length} 条`,
      "",
      ...(failures.length ? ["## 解析失败", ...failures.map((f) => `- ${f.label}\n  ${f.reason}`), ""] : []),
      ...(warnings.length ? ["## 导出警告", ...warnings.map((w) => `- ${w}`), ""] : []),
    ];
    files.push({ name: "导出报告.md", bytes: new TextEncoder().encode(lines.join("\n")) });
  }

  const entries: ZipEntry[] = files.map((file) => ({ name: file.name, bytes: file.bytes }));
  const archive = buildZip(entries, generatedAt);
  // 用本地时间而不是 UTC：文件名里的时间戳是给人看的，差 8 小时会让人以为
  // 下载到的是旧文件。
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp =
    `${generatedAt.getFullYear()}${pad(generatedAt.getMonth() + 1)}${pad(generatedAt.getDate())}` +
    `-${pad(generatedAt.getHours())}${pad(generatedAt.getMinutes())}`;
  const filename = `surveys-${stamp}.zip`;

  return new Response(archive as unknown as BodyInit, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${filename}"`,
      "content-length": String(archive.byteLength),
      "cache-control": "no-store",
      "x-generated-files": String(files.length),
    },
  });
}

/**
 * Host 头白名单：只接受 loopback 名字。
 *
 * 没有这一条，一个恶意网页可以把域名解析到 127.0.0.1（DNS rebinding），然后
 * 同源地打这个服务——本地服务默认没有任何鉴权。
 */
function hostAllowed(hostHeader: string | null): boolean {
  if (!hostHeader) return false;
  const hostname = hostHeader.replace(/:\d+$/, "").toLowerCase();
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}

function parseArgs(argv: string[]): { port: number; open: boolean } {
  let port = 8799;
  let open = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--port" || token === "-p") {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value) || value <= 0 || value > 65535) throw new Error("--port 需要一个 1-65535 的端口");
      port = value;
      index += 1;
    } else if (token === "--open") {
      open = true;
    } else if (token === "-h" || token === "--help") {
      console.log(`survey-tool Web 界面

用法:
  survey-tool-web [选项]

选项:
  --port <n>   监听端口（默认 8799）
  --open       启动后用默认浏览器打开
  -h, --help   显示这段说明

只监听 127.0.0.1，不对外网开放。`);
      process.exit(0);
    } else {
      throw new Error(`未知选项：${token}`);
    }
  }
  return { port, open };
}

let options: { port: number; open: boolean };
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(`✗ ${error instanceof Error ? error.message : error}`);
  process.exit(2);
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: options.port,
  idleTimeout: 255,
  async fetch(request) {
    if (!hostAllowed(request.headers.get("host"))) {
      return new Response("Forbidden", { status: 403 });
    }
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return new Response(page, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }
    if (request.method === "POST" && url.pathname === "/api/parse") {
      try {
        return await handleParse(request);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
    }
    if (request.method === "POST" && url.pathname === "/api/export") {
      try {
        return await handleExport(request);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
    }
    if (url.pathname === "/health") {
      return json({ ok: true, chromium: findChromium() !== null });
    }
    return json({ error: "Not Found" }, 404);
  },
});

const address = `http://127.0.0.1:${server.port}/`;
console.log(`survey-tool Web 已启动：${address}`);
console.log(`PDF 引擎：${findChromium() ? "已找到 Chromium" : "未找到 Chromium（PDF 会跳过）"}`);
console.log("按 Ctrl+C 停止");

if (options.open) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  Bun.spawn([opener, address], { stdio: ["ignore", "ignore", "ignore"] });
}

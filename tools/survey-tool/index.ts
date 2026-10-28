#!/usr/bin/env bun
/**
 * survey-tool — 批量问卷解析与导出的独立命令行程序。
 *
 * 为什么能直接复用 `src/services/*` 与 `admin/src/lib/survey-export.ts`：
 * 那两个抓取器只依赖 `fetch` 与 `parse5`，没有任何 Workers/D1 绑定；
 * 导出库是纯函数。所以独立程序不需要第二套解析逻辑——同一份代码，网页端
 * 和命令行导出的结果逐字节一致，改了网页端不会让命令行偷偷漂移。
 *
 * PDF 不在进程内生成：没有内嵌字体的情况下 JS PDF 库写不出可读的中文。
 * 这里调用系统 Chromium 的 `--print-to-pdf`，排版由同一个 HTML 决定，
 * 与网页端「打印→另存为 PDF」是同一份输入。
 *
 * 解析、渲染、命名规则全部在 `core.ts` 里，Web 服务（server.ts）用同一份。
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";

import {
  buildSurveyExportHtml,
  buildSurveyExportJson,
  buildSurveyExportMarkdown,
  type ExportFormat,
  type ExportSurvey,
} from "../../admin/src/lib/survey-export";
import { findChromium, loadSurvey, renderPdfBytes, safeName, sanitizeLabel, type Source } from "./core";

const FORMATS: ExportFormat[] = ["html", "markdown", "json"];
const USAGE = `survey-tool — 批量解析问卷并导出 HTML / Markdown / JSON / PDF

用法:
  survey-tool <链接或文件> [更多...] [选项]
  survey-tool --stdin [选项]          # 从标准输入逐行读取（适合粘贴一堆链接）

输入:
  链接            Microsoft Forms 或 Zoho Forms 的公开地址
  .json 文件      标准 survey.json（含 survey.questions 结构即可）
  .txt 文件       每行一个链接；# 开头的行当注释跳过

选项:
  --out <目录>    输出目录（默认 ./survey-out）
  --format <列表> html,md,json,pdf 的任意组合（默认 html,md,json）
  --merge         合并成一份「问卷合集」（PDF 场景通常想要这个）
  --stdin         从标准输入读取链接/路径，每行一个
  --json          把解析结果打到标准输出，不落盘
  -h, --help      显示这段说明

示例:
  survey-tool --stdin --format pdf --merge < urls.txt
  survey-tool https://forms.office.com/r/xxxx --out ./out
  survey-tool ./survey.json --format html,md

图形界面:
  用 survey-tool-web 启动本地网页版（同一个内核，不用记参数）。`;

interface Args {
  inputs: string[];
  out: string;
  formats: Array<ExportFormat | "pdf">;
  merge: boolean;
  stdin: boolean;
  printJson: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    inputs: [],
    out: "survey-out",
    formats: ["html", "markdown", "json"],
    merge: false,
    stdin: false,
    printJson: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "-h" || token === "--help") args.help = true;
    else if (token === "--merge") args.merge = true;
    else if (token === "--stdin") args.stdin = true;
    else if (token === "--json") args.printJson = true;
    else if (token === "--out") {
      const value = argv[index + 1];
      if (!value) throw new Error("--out 需要一个目录参数");
      args.out = value;
      index += 1;
    } else if (token === "--format") {
      const value = argv[index + 1];
      if (!value) throw new Error("--format 需要一个列表参数");
      const parsed = value
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);
      const invalid = parsed.filter((item) => item !== "pdf" && !FORMATS.includes(item as ExportFormat));
      if (invalid.length) {
        throw new Error(`未知格式：${invalid.join(", ")}（可用：html,md,markdown,json,pdf）`);
      }
      args.formats = parsed.map((item) => (item === "md" ? "markdown" : item)) as Array<ExportFormat | "pdf">;
      index += 1;
    } else if (token.startsWith("--")) {
      throw new Error(`未知选项：${token}`);
    } else {
      args.inputs.push(token);
    }
  }
  return args;
}

function collectSources(args: Args): Source[] {
  const raw: string[] = [...args.inputs];
  if (args.stdin) {
    const piped = readFileSync(0, "utf8");
    raw.push(...piped.split(/\r?\n/));
  }

  const sources: Source[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const value = item.trim();
    if (!value || value.startsWith("#")) continue;

    if (/^https?:\/\//i.test(value)) {
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push({ kind: "url", value, label: value });
      continue;
    }

    // 文件路径：.json 当问卷，其它文本当「每行一个链接」的清单。
    const path = resolve(value);
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new Error(`既不是 http(s) 链接也不是存在的文件：${value}`);
    }
    if (extname(path).toLowerCase() === ".json") {
      if (seen.has(path)) continue;
      seen.add(path);
      sources.push({ kind: "json-path", value: path, label: path });
    } else {
      const lines = readFileSync(path, "utf8").split(/\r?\n/);
      for (const line of lines) {
        const link = line.trim();
        if (!link || link.startsWith("#") || !/^https?:\/\//i.test(link)) continue;
        const key = link.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        sources.push({ kind: "url", value: link, label: link });
      }
    }
  }
  return sources;
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`✗ ${error instanceof Error ? error.message : error}`);
    console.error(`\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  let sources: Source[];
  try {
    sources = collectSources(args);
  } catch (error) {
    console.error(`✗ ${error instanceof Error ? error.message : error}`);
    console.error(`\n${USAGE}`);
    return 2;
  }
  if (!sources.length) {
    console.error("✗ 没有可处理的输入。用 --stdin 粘贴链接，或直接给出链接/文件。");
    console.error(`\n${USAGE}`);
    return 2;
  }

  const wantsPdf = args.formats.includes("pdf");
  const chromium = wantsPdf ? findChromium() : null;
  if (wantsPdf && !chromium) {
    console.error("! 没找到 Chromium，本次跳过 PDF（HTML 仍然生成，可用浏览器打印成 PDF）");
  }

  console.error(`→ 共 ${sources.length} 个输入，开始解析…`);
  const surveys: ExportSurvey[] = [];
  const failures: Array<{ label: string; reason: string }> = [];
  for (const source of sources) {
    try {
      const survey = await loadSurvey(source);
      surveys.push(survey);
      console.error(`  ✓ ${sanitizeLabel(source.label)} → ${survey.title}（${survey.questions.length} 题）`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failures.push({ label: source.label, reason });
      console.error(`  ✗ ${sanitizeLabel(source.label)} — ${reason}`);
    }
  }

  if (!surveys.length) {
    console.error("\n✗ 没有任何一份解析成功，未生成文件。");
    return 1;
  }

  if (args.printJson) {
    console.log(buildSurveyExportJson(surveys));
    return failures.length ? 1 : 0;
  }

  mkdirSync(args.out, { recursive: true });
  const stamp = new Date();

  if (args.merge) {
    writeFormats(surveys, `surveys-${surveys.length}`);
  } else {
    const used = new Set<string>();
    surveys.forEach((survey, index) => {
      const fallback = `survey-${index + 1}`;
      let base = safeName(survey.title, fallback);
      let suffix = 2;
      while (used.has(base)) base = `${safeName(survey.title, fallback)}-${suffix++}`;
      used.add(base);
      writeFormats([survey], base);
    });
  }

  function writeFormats(batch: ExportSurvey[], base: string) {
    for (const format of args.formats) {
      if (format === "pdf") {
        if (!chromium) continue;
        const html = buildSurveyExportHtml(batch, { generatedAt: stamp });
        const target = join(args.out, `${base}.pdf`);
        try {
          writeFileSync(target, renderPdfBytes(html, chromium));
          console.error(`  → ${target}`);
        } catch (error) {
          console.error(`  ✗ PDF 失败：${error instanceof Error ? error.message : error}`);
        }
        continue;
      }
      const content =
        format === "json"
          ? buildSurveyExportJson(batch, { generatedAt: stamp })
          : format === "markdown"
            ? buildSurveyExportMarkdown(batch, { generatedAt: stamp })
            : buildSurveyExportHtml(batch, { generatedAt: stamp });
      const extension = format === "json" ? "json" : format === "markdown" ? "md" : "html";
      const target = join(args.out, `${base}.${extension}`);
      writeFileSync(target, content, "utf8");
      console.error(`  → ${target}`);
    }
  }

  const total = surveys.reduce((count, survey) => count + survey.questions.length, 0);
  console.error(
    `\n完成：${surveys.length} 份问卷 / ${total} 题${failures.length ? `，${failures.length} 个输入失败` : ""}`,
  );
  if (failures.length) {
    console.error("失败清单：");
    for (const failure of failures) console.error(`  - ${sanitizeLabel(failure.label)}：${failure.reason}`);
    return 1;
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`✗ 未处理的错误：${error instanceof Error ? (error.stack ?? error.message) : error}`);
    process.exit(1);
  });

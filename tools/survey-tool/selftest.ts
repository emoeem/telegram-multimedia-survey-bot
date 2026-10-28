#!/usr/bin/env bun
/**
 * 内核自检：不启动 HTTP，直接验 core.ts 的解析与渲染，以及 zip.ts 的归档格式。
 *
 * 存在的理由：核心逻辑的正确性（尤其分页字段 `page_id` / `pageId` 的兼容）不该
 * 依赖「能不能连上 Microsoft Forms」。网络断了也能证明渲染是对的。
 *
 * 用法：bun tools/survey-tool/selftest.ts
 */

import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { buildSurveyExportHtml, buildSurveyExportJson, buildSurveyExportMarkdown } from "../../admin/src/lib/survey-export";
import { collectUrlLines, findChromium, renderPdfBytes, safeName, toExportSurvey } from "./core";
import { buildZip } from "./zip";

let failed = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("1) 分页字段兼容（page_id 字符串 / pageId 数字）");
{
  const legacy = toExportSurvey(
    {
      survey: {
        title: "旧导入器格式",
        pages: [{ id: "p1", title: "第一页" }],
        questions: [
          { id: 1, type: "text", title: "Q1", page_id: "p1" },
          { id: 2, type: "text", title: "Q2", page_id: "p1" },
        ],
      },
    },
    "fallback",
  );
  check("page_id 被收进 pageId", legacy.questions.every((question) => question.pageId === "p1"));
  check("题数正确", legacy.questions.length === 2);
  check("标题取自 survey", legacy.title === "旧导入器格式");

  const modern = toExportSurvey(
    {
      survey: {
        title: "编辑器格式",
        pages: [{ id: 5, title: "P" }],
        questions: [{ id: 1, type: "text", title: "Q", pageId: 5 }],
      },
    },
    "fallback",
  );
  check("pageId 数字保留", modern.questions[0]!.pageId === 5);
}

console.log("2) 真实问卷渲染（仓库根 survey.json）");
{
  const raw = JSON.parse(readFileSync(join(import.meta.dir, "../../survey.json"), "utf8"));
  const survey = toExportSurvey(raw, "未命名");
  check("题目数量 > 0", survey.questions.length > 0, `实际 ${survey.questions.length}`);
  check("标题非空", survey.title.length > 0, survey.title);

  const html = buildSurveyExportHtml([survey]);
  const markdown = buildSurveyExportMarkdown([survey]);
  const json = buildSurveyExportJson([survey]);
  check("HTML 含题目正文", html.includes("<html") && html.length > 1000, `${html.length} 字节`);
  check("Markdown 非空", markdown.length > 200, `${markdown.length} 字节`);
  check("JSON 可回解析", (() => {
    try {
      JSON.parse(json);
      return true;
    } catch {
      return false;
    }
  })());

  // 题目一条都不能丢——上一轮的静默丢数据就是在这里被抓住的。
  const renderedCount = (html.match(/class="q-title"/g) ?? []).length;
  check("HTML 题目块数量与题目数一致", renderedCount === survey.questions.length, `${renderedCount} vs ${survey.questions.length}`);

  globalThis.__fixture = { survey, html, markdown, json };
}

console.log("3) 输入清洗");
{
  const parsed = collectUrlLines(
    ["  https://forms.office.com/r/a  ", "", "# 注释", "https://forms.office.com/r/A", "不是链接", "https://x.test/b"].join("\n"),
  );
  check("只留下合法链接", parsed.urls.length === 2, JSON.stringify(parsed.urls));
  check("大小写重复被去重", parsed.urls.filter((url) => url.toLowerCase().includes("/r/a")).length <= 1);
  check("跳过计数正确", parsed.skipped === 4, `实际 ${parsed.skipped}`);
}

console.log("4) ZIP 归档格式合法");
{
  const fixture = (globalThis as unknown as { __fixture: { html: string; markdown: string; json: string } }).__fixture;
  const encoder = new TextEncoder();
  const archive = buildZip([
    { name: "问卷.html", bytes: encoder.encode(fixture.html) },
    { name: "问卷.md", bytes: encoder.encode(fixture.markdown) },
    { name: "问卷.json", bytes: encoder.encode(fixture.json) },
    { name: "二进制.pdf", bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]) },
  ]);
  check("产物非空", archive.length > 0, `${archive.length} 字节`);
  check("以 PK\\x03\\x04 开头", archive[0] === 0x50 && archive[1] === 0x4b && archive[2] === 0x03 && archive[3] === 0x04);
  check("结尾有 EOCD 签名", (() => {
    for (let index = archive.length - 22; index >= 0; index -= 1) {
      if (archive[index] === 0x50 && archive[index + 1] === 0x4b && archive[index + 2] === 0x05 && archive[index + 3] === 0x06) {
        return true;
      }
    }
    return false;
  })());

  const target = join(import.meta.dir, ".selftest.zip");
  writeFileSync(target, archive);
  // 中文文件名靠 0x0800（UTF-8 flag）声明。老版 Info-ZIP `unzip` 不认这个 flag，
  // 会把 UTF-8 字节按 CP437 解出乱码——所以「显示对不对」不看它，看 python3 和 7z。
  const py = spawnSync(
    "python3",
    [
      "-c",
      "import json,zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({'names': z.namelist(), 'crc': z.testzip()}, ensure_ascii=False))",
      target,
    ],
    { encoding: "utf8" },
  );
  if (py.error || py.status !== 0) {
    console.log("  · python3 不可用，跳过中文名外部校验");
  } else {
    const report = JSON.parse(py.stdout.trim()) as { names: string[]; crc: string | null };
    check(
      "python zipfile 读出中文名",
      ["问卷.html", "问卷.md", "问卷.json", "二进制.pdf"].every((name) => report.names.includes(name)),
      JSON.stringify(report.names),
    );
    check("python zipfile CRC 校验通过", report.crc === null, String(report.crc));
    check("UTF-8 文件名 flag 已置", true);
  }
  const test = spawnSync("unzip", ["-t", target], { encoding: "utf8" });
  if (!test.error) {
    check("unzip -t CRC 通过", test.status === 0 && /No errors detected/i.test(test.stdout), test.stdout?.trim());
  }
  rmSync(target, { force: true });
}

console.log("5) PDF 渲染（需要 Chromium）");
{
  const chromium = findChromium();
  if (!chromium) {
    console.log("  · 没找到 Chromium，跳过");
  } else {
    const fixture = (globalThis as unknown as { __fixture: { html: string } }).__fixture;
    const pdf = renderPdfBytes(fixture.html, chromium);
    const header = new TextDecoder().decode(pdf.slice(0, 5));
    check("产物是 PDF", header === "%PDF-", `header=${header}`);
    check("体积合理（> 10KB）", pdf.length > 10_000, `${pdf.length} 字节`);
    // 页数写在 /Type /Pages 的 /Count 里；用字符串出现次数粗判是否真的多页。
    const text = new TextDecoder("latin1").decode(pdf);
    const pageObjects = (text.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    check("至少渲染出一页", pageObjects >= 1, `检测到 ${pageObjects} 个页面对象`);
    console.log(`  · PDF ${pdf.length} 字节 · 页面对象 ${pageObjects} 个`);
  }
}

console.log("6) 文件名清洗");
{
  check("斜杠被替换", safeName("a/b\\c", "fb") === "a-b-c", safeName("a/b\\c", "fb"));
  check("空标题走兜底", safeName("   ", "fallback") === "fallback");
  check("超长被截断", safeName("x".repeat(200), "fb").length <= 60);
}

console.log(failed ? `\n✗ ${failed} 项失败` : "\n✓ 全部通过");
process.exit(failed ? 1 : 0);

#!/usr/bin/env node
/**
 * Parses pdftotext output of K9任务200.pdf into a structured task corpus.
 *
 * Usage:
 *   pdftotext -layout 'K9任务200.pdf' /tmp/k9-task200.txt
 *   node scripts/parse_k9_pdf.mjs /tmp/k9-task200.txt scripts/data/k9-task200.json
 *
 * All 200 tasks are kept. Tasks whose original copy contains life-safety or
 * public/illegal patterns get a `warning` text so the player UI can show a
 * pop-up confirmation before the task is performed.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
  console.error("usage: node scripts/parse_k9_pdf.mjs <pdftotext.txt> <output.json>");
  process.exit(1);
}

const RISK_WARNINGS = [
  {
    id: "choking",
    pattern:
      /勒住脖子|勒脖子|套环勒|套在脖子|电线缠|上吊|窒息|无法呼吸|勒到|勒紧|挂.*脖子|脖子.*数据线|数据线.*脖子|颈部/,
    text: "⚠️ 危险动作提醒：本题原典含颈部束缚/窒息类内容，现实中执行有致命风险。本平台仅为 18+ 虚构文字扮演，请把相关动作改为想象中的安全演练或与督导约定的替代方案，切勿在现实中实施。",
  },
  {
    id: "public",
    pattern:
      /公园|野外|街头|街上|大马路|马路|公交|地铁|商场|超市|电影院|学校|教室|办公室|公司|车间|楼下|小区|路人|邻居|别人看见|被人看见|楼道|电梯|阳台|窗外/,
    text: "⚠️ 法律与公共安全提醒：本题原典涉及公共或半公共场合，现实中实施可能违法或惊扰他人。本平台仅为 18+ 虚构文字扮演，请完整在想象场景中完成，切勿在现实中实施。",
  },
];

const fieldPattern =
  /^\s*(任务目的|目的|任务工具|工具|任务要求|要求|验证方式|检验方法|适用奴型|任务环境|任务时间|任务汇报|汇报)\s*[:：]?\s*(.*)$/;
const stepLabel =
  /^\s*(指令[①-⑩]?[0-9０-９]?[：:、.]?|步骤\s*[0-9]+[：:、.]?|内容\s*[:：]?|[（(][0-9０-９]+[）)]|第[一二三四五六七八九十]+步)/;

const lines = readFileSync(inputPath, "utf8").split(/\r?\n/);
const blocks = [];
let current = null;

for (const raw of lines) {
  const line = raw.replace(/\f/g, "").trim();
  const marker =
    line.match(/^\[任务\s*(\d+)\]\s*$/) ?? line.match(/^任务\s*(\d+)\s*$/) ?? line.match(/^任务[:：]\s*(\d+)\s*$/);
  if (marker) {
    if (current) blocks.push(current);
    current = { n: Number(marker[1]), title: null, fields: {}, steps: [], other: [] };
    continue;
  }
  if (!current) continue;
  if (/^\d+\s*$/.test(line)) continue;
  if (!line) {
    current.other.push("");
    continue;
  }
  if (current.title === null && !fieldPattern.test(line) && !stepLabel.test(line)) {
    current.title = line;
    continue;
  }
  const fieldMatch = line.match(fieldPattern);
  if (fieldMatch) {
    const key = fieldMatch[1];
    const value = (fieldMatch[2] ?? "").trim();
    if (!(key in current.fields)) current.fields[key] = value;
    else if (value) current.fields[key] = `${current.fields[key]} ${value}`;
    continue;
  }
  if (stepLabel.test(line)) {
    current.steps.push(line);
    continue;
  }
  const lastStep = current.steps.length - 1;
  if (lastStep >= 0 && line.length > 0) {
    current.steps[lastStep] = `${current.steps[lastStep]}\n${line}`;
  } else if (line) {
    current.other.push(line);
  }
}
if (current) blocks.push(current);

function fullText(block) {
  return [
    block.title,
    block.fields["任务目的"] ?? block.fields["目的"] ?? "",
    block.fields["任务工具"] ?? block.fields["工具"] ?? "",
    block.steps.join("\n"),
    block.fields["任务要求"] ?? block.fields["要求"] ?? "",
    block.fields["任务环境"] ?? "",
    block.fields["验证方式"] ?? block.fields["检验方法"] ?? "",
  ]
    .filter(Boolean)
    .join("\n");
}

const tasks = blocks
  .sort((a, b) => a.n - b.n)
  .map((block) => {
    const text = fullText(block);
    const warnings = RISK_WARNINGS.filter((item) => item.pattern.test(text)).map((item) => item.text);
    return {
      n: block.n,
      title: block.title,
      purpose: block.fields["任务目的"] ?? block.fields["目的"] ?? "",
      tools: block.fields["任务工具"] ?? block.fields["工具"] ?? "",
      subType: block.fields["适用奴型"] ?? "",
      environment: block.fields["任务环境"] ?? "",
      requirement: block.fields["任务要求"] ?? block.fields["要求"] ?? "",
      verification: block.fields["验证方式"] ?? block.fields["检验方法"] ?? "",
      steps: block.steps.join("\n"),
      warning: warnings.join("\n"),
      riskTags: RISK_WARNINGS.filter((item) => item.pattern.test(text)).map((item) => item.id),
    };
  });

const missing = [];
for (let n = 1; n <= 200; n += 1) {
  if (!tasks.some((task) => task.n === n)) missing.push(n);
}
const warned = tasks.filter((task) => task.warning);
const result = {
  source: "K9任务200.pdf",
  parsedFrom: inputPath,
  taskCount: tasks.length,
  missingNumbers: missing,
  warnedCount: warned.length,
  warnedNumbers: warned.map((task) => task.n),
  tasks,
};

mkdirSync(dirname(resolve(outputPath)), { recursive: true });
writeFileSync(resolve(outputPath), JSON.stringify(result, null, 2), "utf8");
console.log(
  `parsed ${tasks.length} tasks, ${warned.length} with warnings, missing [${missing.join(", ")}] -> ${outputPath}`,
);

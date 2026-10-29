#!/usr/bin/env node
/**
 * docs 链接检查：把「文档里的路径必须能点开」变成可执行的门禁。
 *
 * 检查两类引用：
 *   1. `docs/<路径>.md` 形式的绝对引用（README、代码注释、脚本里的写法）；
 *   2. markdown 相对链接 `](路径)`（同目录/../ 都算）。
 *
 * 刻意跳过的（不是坏链接）：
 *   - http(s)/mailto/#锚点/以 / 开头的站内路由；
 *   - `path/to/file.ts:123` 这种「文件:行号」的代码定位写法（审计文档常用）；
 *   - `<https://...>` 尖括号包裹的 URL。
 *
 * 用法：node scripts/check-docs-links.mjs [--quiet]
 * 退出码：0 = 全部通过；1 = 有断链（可直接放进 CI）。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";

const ROOT = process.cwd();
const DOCS = join(ROOT, "docs");

/** 不参与检查的目录：依赖、构建产物、子模块与本机工具状态。 */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "test-results",
  ".wrangler",
  "build",
  ".pdf-tools-venv",
  ".zcode",
  ".mimosa",
  "blog-source-migrate", // 独立子模块（Hugo/Hexo 博客），有自己的 docs 体系
]);
/** 会写文档路径的文本文件类型。 */
const TEXT_EXT = [".md", ".ts", ".tsx", ".js", ".mjs", ".sh", ".py", ".json", ".toml", ".yml", ".yaml"];
/** 额外扫描的目录（docs 之外的引用源）：仓库根与这几处。 */
const SCAN_BASES = [".", "docs", "scripts", "src", "admin", "cn-relay", "tg-archive"];

function walk(base) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(base);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(base, name);
    let info;
    try {
      info = statSync(full);
    } catch {
      continue;
    }
    if (info.isDirectory()) out.push(...walk(full));
    else if (TEXT_EXT.some((ext) => name.endsWith(ext))) out.push(full);
  }
  return out;
}

/** docs 下所有文件的 basename → 现路径（用于给出「应该指向哪」的建议）。 */
function docsIndex() {
  const index = new Map();
  for (const file of walk(DOCS)) {
    index.set(file.slice(file.lastIndexOf("/") + 1), file);
  }
  return index;
}

const ABS_REF = /docs\/[A-Za-z0-9_.\-/]+\.md/g;
const MD_LINK = /\]\(([^)\s]+)\)/g;

const index = docsIndex();
const problems = [];
let checked = 0;

for (const base of SCAN_BASES) {
  for (const file of walk(join(ROOT, base))) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const match of text.matchAll(ABS_REF)) {
      const ref = match[0];
      checked += 1;
      if (!statExists(join(ROOT, ref))) {
        const suggestion = index.get(ref.slice(ref.lastIndexOf("/") + 1));
        problems.push({ file, ref, suggestion });
      }
    }
    if (!file.endsWith(".md")) continue;
    for (const match of text.matchAll(MD_LINK)) {
      const target = match[1];
      if (/^(https?:|mailto:|#|\/|<)/.test(target)) continue;
      if (/:\d+$/.test(target)) continue; // 文件:行号，不是链接
      // 模板里的占位符（如 RELEASE_<日期>.md）：规范要求占位符用 <> 包裹，
      // 这类路径本来就不指向真实文件，跳过而不是报断链。
      if (target.includes("<") || target.includes(">")) continue;
      const pathPart = target.split("#")[0];
      if (!pathPart) continue;
      checked += 1;
      if (!statExists(normalize(join(dirname(file), pathPart)))) {
        problems.push({ file, ref: target, suggestion: undefined });
      }
    }
  }
}

function statExists(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

const quiet = process.argv.includes("--quiet");
if (problems.length === 0) {
  if (!quiet) console.log(`✅ 文档链接检查通过（${checked} 处引用）`);
  process.exit(0);
}

console.error(`❌ 发现 ${problems.length} 处断链（共检查 ${checked} 处引用）：`);
for (const { file, ref, suggestion } of problems) {
  const where = relative(ROOT, file);
  console.error(`  ${where}\n    → ${ref}${suggestion ? `\n    ? 是否应为 ${relative(ROOT, suggestion)}` : ""}`);
}
process.exit(1);

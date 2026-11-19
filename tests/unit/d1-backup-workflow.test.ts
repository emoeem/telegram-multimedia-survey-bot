// d1-backup.yml 的 R2 权限判别逻辑钉在这里:
// 2026-11-19 run 44429772644 的教训是 info 的失败原因被 >/dev/null 2>&1 吞掉,
// 「桶不存在」和「权限缺失(code 10000)」不可区分,守卫通过后拖到建桶步才炸。
// 测试分两层:静态断言(步骤顺序/判别分支存在)+ 行为断言(把 run 块抽出来,
// 用假的 pnpm 模拟 wrangler 各种报错,在 bash -e 下跑,和 Actions 默认 shell 一致)。
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../../.github/workflows/d1-backup.yml", import.meta.url), "utf8");
const runbook = readFileSync(new URL("../../docs/ops/ops-runbook.md", import.meta.url), "utf8");

// 从 YAML 里抽取某个步骤的 run 块(块标量内容固定缩进 10 空格)。
function stepRunBlock(stepName: string): string {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  if (start < 0) throw new Error(`找不到步骤: ${stepName}`);
  const runIdx = lines.findIndex((line, i) => i > start && line.trim() === "run: |");
  if (runIdx < 0) throw new Error(`步骤没有 run 块: ${stepName}`);
  const out: string[] = [];
  for (let i = runIdx + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.startsWith("          ") || line.trim() === "") break;
    out.push(line.slice(10));
  }
  return out.join("\n");
}

// 假 pnpm:按环境变量配置每个 wrangler 子命令的退出码与输出,调用记录进 CALL_LOG。
const STUB_PNPM = [
  "#!/usr/bin/env bash",
  'printf \'%s\\n\' "$*" >> "$CALL_LOG"',
  'case "$*" in',
  '  *"r2 bucket list"*) printf \'%s\\n\' "$LIST_OUT"; exit "$LIST_RC" ;;',
  '  *"r2 bucket info"*) printf \'%s\\n\' "$INFO_OUT"; exit "$INFO_RC" ;;',
  '  *"r2 bucket create"*) printf \'%s\\n\' "$CREATE_OUT"; exit "$CREATE_RC" ;;',
  "esac",
  'echo "unexpected pnpm call: $*" >&2',
  "exit 97",
].join("\n");

interface StepRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  calls: string[];
}

// 用 bash -e 跑抽取出的 run 块(Actions 在 Linux 上默认就是 bash -e),返回结果与调用记录。
function runStepScript(script: string, env: Record<string, string>): StepRunResult {
  const dir = mkdtempSync(join(tmpdir(), "d1-backup-workflow-test-"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  const stub = join(binDir, "pnpm");
  writeFileSync(stub, STUB_PNPM);
  chmodSync(stub, 0o755);
  const callLog = join(dir, "calls.log");
  const scriptPath = join(dir, "step.sh");
  writeFileSync(scriptPath, script);
  const result = spawnSync("bash", ["-e", scriptPath], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, CALL_LOG: callLog, ...env },
  });
  const calls = readFileSync(callLog, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", calls };
}

const AUTH_10000 = "✘ [ERROR] Authentication error [code: 10000]\n\n  GET /accounts/abc123/r2/buckets";

describe("d1-backup 工作流步骤编排", () => {
  it("顺序为 变量守卫 → R2 权限自检 → 建桶 → 导出 → 上传 → 校验", () => {
    const order = [
      "Guard R2_BACKUP_BUCKET",
      "R2 permission preflight",
      "Ensure the backup bucket exists",
      "Export D1 database",
      "Upload to R2",
      "Verify the object landed",
    ];
    const positions = order.map((name) => workflow.indexOf(`- name: ${name}`));
    expect(positions).not.toContain(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("前置自检与建桶步都显式带上 Cloudflare 凭据 env", () => {
    for (const name of ["R2 permission preflight", "Ensure the backup bucket exists"]) {
      const block = workflow.slice(workflow.indexOf(`- name: ${name}`));
      const step = block.slice(0, block.indexOf("\n      - name:"));
      expect(step).toContain("CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}");
      expect(step).toContain("CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}");
    }
  });
});

describe("建桶步的 10000 判别", () => {
  const script = stepRunBlock("Ensure the backup bucket exists");
  // 只看可执行行:注释里提到旧反模式 >/dev/null 2>&1 不算数
  const codeOnly = script
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");

  it("不再用 >/dev/null 2>&1 吞掉 info 的失败原因,而是捕获退出码与 stderr", () => {
    expect(codeOnly).not.toContain(">/dev/null 2>&1");
    expect(script).toContain('info_out="$(pnpm exec wrangler r2 bucket info "$bucket" 2>&1)" || info_rc=$?');
    expect(script).toContain('if [ "$info_rc" -eq 0 ]');
    // 原始输出必须进日志
    expect(script).toContain('echo "$info_out"');
  });

  it("桶已存在:直接继续,不触发建桶", () => {
    const result = runStepScript(script, {
      bucket: "backup-bkt",
      LIST_RC: "0",
      LIST_OUT: "[]",
      INFO_RC: "0",
      INFO_OUT: "bucket: backup-bkt",
      CREATE_RC: "0",
      CREATE_OUT: "",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("桶已存在,继续");
    expect(result.calls.filter((call) => call.includes("bucket create"))).toEqual([]);
  });

  it("info 报 Authentication error [code: 10000]:fail-fast、不尝试建桶、提示所需权限名与被跳过的步骤", () => {
    const result = runStepScript(script, {
      bucket: "backup-bkt",
      LIST_RC: "0",
      LIST_OUT: "[]",
      INFO_RC: "1",
      INFO_OUT: AUTH_10000,
      CREATE_RC: "0",
      CREATE_OUT: "",
    });
    expect(result.status).toBe(1);
    // 失败原因进日志 + 判别提示
    expect(result.stdout).toContain("Authentication error [code: 10000]");
    expect(result.stdout).toContain("Account | Workers R2 Storage | Edit");
    expect(result.stdout).toContain("以下步骤已跳过:导出/上传/校验");
    expect(result.calls.filter((call) => call.includes("bucket create"))).toEqual([]);
  });

  it("非权限类失败(桶不存在):照旧幂等建桶", () => {
    const result = runStepScript(script, {
      bucket: "backup-bkt",
      LIST_RC: "0",
      LIST_OUT: "[]",
      INFO_RC: "1",
      INFO_OUT: "✘ [ERROR] bucket not found",
      CREATE_RC: "0",
      CREATE_OUT: "created",
    });
    expect(result.status).toBe(0);
    expect(result.calls.filter((call) => call.includes("bucket create"))).toHaveLength(1);
  });
});

describe("前置权限自检步(R2 permission preflight)", () => {
  const script = stepRunBlock("R2 permission preflight");

  it("用 wrangler r2 bucket list 探测,失败即 exit 1", () => {
    expect(script).toContain("pnpm exec wrangler r2 bucket list 2>&1");
    expect(script).toContain("exit 1");
  });

  it("list 报 Authentication error [code: 10000]:输出 token 有效/缺 R2 权限的判别提示", () => {
    const result = runStepScript(script, {
      bucket: "backup-bkt",
      LIST_RC: "1",
      LIST_OUT: AUTH_10000,
      INFO_RC: "0",
      INFO_OUT: "",
      CREATE_RC: "0",
      CREATE_OUT: "",
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Authentication error [code: 10000]");
    expect(result.stdout).toContain("R2 权限缺失而非密钥无效");
    expect(result.stdout).toContain("Account | Workers R2 Storage | Edit");
    expect(result.stdout).toContain("以下步骤已跳过:建桶/导出/上传/校验");
  });

  it("list 成功:自检通过,继续后续步骤", () => {
    const result = runStepScript(script, {
      bucket: "backup-bkt",
      LIST_RC: "0",
      LIST_OUT: "[]",
      INFO_RC: "0",
      INFO_OUT: "",
      CREATE_RC: "0",
      CREATE_OUT: "",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("R2 权限自检通过");
  });
});

describe("ops-runbook 的 R2 权限排障章节", () => {
  // 只检查新增章节,既有段落的历史破折号不动(dash guard 只拦新增文本)。
  const section = runbook.slice(runbook.indexOf("**R2 权限排障"), runbook.indexOf("**恢复流程**"));

  it("含精确权限名与 10000 报错特征", () => {
    expect(section).toContain("Account | Workers R2 Storage | Edit");
    expect(section).toContain("Authentication error [code: 10000]");
    expect(section).toContain("GET /accounts/{account_id}/r2/buckets");
  });

  it("含完整手动步骤清单与 workflow_dispatch 重跑入口", () => {
    for (const needle of ["My Profile", "API Tokens", "Permissions", "Save", "Run workflow", "workflow_dispatch"]) {
      expect(section).toContain(needle);
    }
    expect(section).toContain("只建桶不够");
  });

  it("新增章节遵守 dash guard(无 em/en dash)", () => {
    expect(section).not.toMatch(/[—–]/);
  });

  it("不含任何凭据值(只有 secret 名,没有疑似 token 赋值)", () => {
    // 疑似把真实 token 值写进文档的形状:CLOUDFLARE_API_TOKEN = 长串无空白值
    expect(runbook).not.toMatch(/CLOUDFLARE_API_TOKEN\s*[:=]\s*"?[A-Za-z0-9_-]{20,}/);
  });
});

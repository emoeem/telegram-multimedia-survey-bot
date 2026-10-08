#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { adminPasswordHashSql, hashAdminPassword } from "./lib/admin-password.mjs";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface as createCallbackInterface } from "node:readline";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { stdin as input, stdout as output } from "node:process";

const ROOT_DIR = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_LICENSE_SERVER_URL = "https://telegram-multimedia-survey-bot.pd2335346.workers.dev";
const APP_VERSION = "0.3.0";
const COMPATIBILITY_DATE = "2026-08-14";
const WRANGLER = process.platform === "win32" ? "npx.cmd" : "npx";
const BOT_COMMANDS = [
  { command: "start", description: "打开主菜单" },
  { command: "surveys", description: "浏览可填写问卷" },
  { command: "create", description: "新建问卷" },
  { command: "my_surveys", description: "管理我的问卷" },
  { command: "passwords", description: "管理问卷访问密码" },
  { command: "admin", description: "打开管理员中心" },
];

class DeploymentError extends Error {
  constructor(message, details = "") {
    super(message);
    this.name = "DeploymentError";
    this.details = details;
  }
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    projectDir: ROOT_DIR,
    outputRoot: path.join(ROOT_DIR, "customer-deployments"),
    values: {},
  };

  const valueFlags = new Set([
    "customer-name",
    "bot-token",
    "admin-id",
    "license-key",
    "license-server-url",
    "worker-name",
    "account-id",
    "api-token",
    "webhook-secret",
    "admin-password",
    "remote-access-secret",
    "installation-id",
    "deployment-dir",
    "update-existing",
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (arg === "--no-license-center-binding") {
      // Required when the customer lives in its OWN Cloudflare account: a
      // service binding to a Worker in another account cannot resolve, and
      // wrangler would refuse the deploy. Such a customer reaches the center
      // over LICENSE_SERVER_URL instead.
      args.noLicenseCenterBinding = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (!valueFlags.has(key)) {
        throw new DeploymentError(`不支持的参数：${arg}`);
      }
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new DeploymentError(`参数 ${arg} 需要一个值`);
      }
      args.values[key] = value;
      index += 1;
      continue;
    }
    throw new DeploymentError(`不支持的位置参数：${arg}`);
  }
  return args;
}

function printHelp() {
  console.log(`
Windows 客户部署工具

用法：
  scripts\\deploy-customer.cmd
  node scripts/deploy-customer.mjs [参数]

常用参数：
  --customer-name <名称>       客户名称
  --bot-token <Token>          Telegram Bot Token
  --admin-id <ID[,ID...]>      管理员 Telegram 数字 ID
  --license-key <密钥>         厂商发放的软件授权密钥
  --license-server-url <URL>   授权中心地址
  --worker-name <名称>         Cloudflare Worker 名称
  --account-id <ID>            Cloudflare Account ID
  --api-token <Token>          Cloudflare API Token（建议使用环境变量）
  --webhook-secret <密钥>      自定义 Webhook Secret
  --installation-id <ID>       稳定安装 ID
  --deployment-dir <目录>      指定部署目录，便于失败后继续
  --dry-run                    只生成计划，不创建远程资源
  --help                       显示帮助

也可以使用环境变量提供敏感值：
  TELEGRAM_BOT_TOKEN
  LICENSE_KEY
  CLOUDFLARE_API_TOKEN
  CLOUDFLARE_ACCOUNT_ID
`);
}

function normalizeName(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function makeSlug(customerName) {
  const base = normalizeName(customerName) || "customer";
  const suffix = createHash("sha256").update(customerName).digest("hex").slice(0, 8);
  return `survey-${base.slice(0, 32)}-${suffix}`;
}

function validateWorkerName(workerName) {
  if (!workerName || workerName.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(workerName)) {
    throw new DeploymentError("Worker 名称只能使用小写字母、数字和连字符，长度不能超过 63。");
  }
}

function validateAdminIds(value) {
  const ids = String(value ?? "")
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (ids.length === 0 || ids.some((item) => !/^[1-9]\d*$/.test(item))) {
    throw new DeploymentError("管理员 ID 必须是 Telegram 数字 ID，例如 123456789。");
  }
  return [...new Set(ids)].join(",");
}

function validateRequired(value, label) {
  const result = String(value ?? "").trim();
  if (!result) throw new DeploymentError(`${label}不能为空。`);
  return result;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function redact(text, secrets) {
  let result = String(text ?? "");
  for (const secret of secrets) {
    if (secret && secret.length >= 4) {
      result = result.split(secret).join("***");
    }
  }
  return result;
}

async function promptValues(args) {
  const values = args.values;
  let reuseExistingLicense = false;
  const rl = createInterface({ input, output });
  const ask = async (key, label, fallback = "") => {
    if (values[key]) return values[key];
    const answer = await rl.question(fallback ? `${label} [${fallback}]: ` : `${label}: `);
    return answer.trim() || fallback;
  };

  try {
    values["customer-name"] = await ask("customer-name", "客户名称");
    const workerName = values["worker-name"]?.trim() || makeSlug(values["customer-name"]);
    const deploymentDir = path.resolve(
      values["deployment-dir"] || path.join(args.outputRoot, normalizeName(workerName)),
    );
    const existingDeploymentManifest = await readJsonIfExists(path.join(deploymentDir, "deployment-manifest.json"));
    reuseExistingLicense = existingDeploymentManifest?.licenseConfigured === true;
    values["admin-id"] = await ask("admin-id", "管理员 Telegram ID");
    values["license-key"] = values["license-key"] ?? process.env.LICENSE_KEY ?? "";
    if (reuseExistingLicense) {
      values["reuse-existing-license"] = "true";
    }
    values["license-server-url"] =
      values["license-server-url"] ?? process.env.LICENSE_SERVER_URL ?? DEFAULT_LICENSE_SERVER_URL;
    values["account-id"] = await ask(
      "account-id",
      "Cloudflare Account ID（已登录可留空）",
      process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    );
  } finally {
    rl.close();
  }

  if (!values["license-key"] && !reuseExistingLicense) {
    values["license-key"] = await promptSecret("项目所有者提供的授权密钥");
  }
  if (!values["bot-token"]) {
    values["bot-token"] = await promptSecret("Telegram Bot Token", process.env.TELEGRAM_BOT_TOKEN ?? "");
  }
  values["api-token"] = values["api-token"] ?? process.env.CLOUDFLARE_API_TOKEN ?? "";
  if (!values["api-token"] && !process.env.CLOUDFLARE_API_TOKEN) {
    values["api-token"] = await promptSecret("Cloudflare API Token（已执行 wrangler login 可留空）");
  }
  return values;
}

async function promptSecret(label, fallback = "") {
  if (!input.isTTY || !output.isTTY) {
    const rl = createInterface({ input, output });
    try {
      const answer = await rl.question(fallback ? `${label}（已设置，直接回车使用）: ` : `${label}: `);
      return answer.trim() || fallback;
    } finally {
      rl.close();
    }
  }

  let muted = false;
  const hiddenOutput = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) output.write(chunk, encoding);
      callback();
    },
  });
  const rl = createCallbackInterface({
    input,
    output: hiddenOutput,
    terminal: true,
  });
  output.write(fallback ? `${label}（已设置，直接回车使用）: ` : `${label}: `);
  muted = true;
  return new Promise((resolve) => {
    rl.question("", (answer) => {
      muted = false;
      rl.close();
      output.write("\n");
      resolve(answer.trim() || fallback);
    });
  });
}

function commandText(args) {
  return [WRANGLER, ...args].map((value) => (/\s/.test(value) ? JSON.stringify(value) : value)).join(" ");
}

function runCommand(args, { cwd, secrets = [], dryRun = false, allowFailure = false, quiet = false } = {}) {
  const rendered = commandText(args);
  console.log(`\n> ${redact(rendered, secrets)}`);
  if (dryRun) {
    return Promise.resolve({ stdout: "", stderr: "", code: 0 });
  }

  return new Promise((resolve, reject) => {
    const child = spawn(WRANGLER, args, {
      cwd,
      env: { ...process.env, WRANGLER_WRITE_LOGS: "false" },
      stdio: ["inherit", "pipe", "pipe"],
      windowsHide: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (!quiet) process.stdout.write(redact(text, secrets));
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (!quiet) process.stderr.write(redact(text, secrets));
    });
    child.on("error", (error) => {
      reject(new DeploymentError(`无法执行 ${WRANGLER}。请确认已安装 Node.js 和 Wrangler。`, error.message));
    });
    child.on("close", (code) => {
      if (code === 0 || allowFailure) {
        resolve({ stdout, stderr, code });
        return;
      }
      reject(
        new DeploymentError(
          `命令执行失败，退出码：${code ?? "unknown"}`,
          redact(`${stdout}\n${stderr}`, secrets).trim(),
        ),
      );
    });
  });
}

function parseJsonOutput(text, label) {
  const normalized = String(text)
    .replace(/\u001b\[[0-9;]*m/g, "")
    .trim();
  const arrayStart = normalized.indexOf("[");
  const objectStart = normalized.indexOf("{");
  const starts = [arrayStart, objectStart].filter((index) => index >= 0);
  const start = starts.length > 0 ? Math.min(...starts) : -1;
  if (start < 0) {
    throw new DeploymentError(`${label} 没有返回 JSON 数据。`);
  }
  try {
    return JSON.parse(normalized.slice(start));
  } catch (error) {
    throw new DeploymentError(`${label} 返回的数据无法解析。`, error instanceof Error ? error.message : String(error));
  }
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function resourceNames(workerName) {
  const withSuffix = (suffix) => {
    const maxBaseLength = 63 - suffix.length - 1;
    return `${workerName.slice(0, maxBaseLength).replace(/-+$/, "")}-${suffix}`;
  };
  return {
    d1: withSuffix("db"),
    kv: withSuffix("cache"),
    // `MEDIA_KV` is a required binding (answer photo upload/read), not an
    // optional extra: the customer instance needs its own namespace.
    mediaKv: withSuffix("media"),
    queue: withSuffix("export"),
  };
}

async function createResources({ workerName, deploymentDir, dryRun, manifest }) {
  const names = resourceNames(workerName);
  const state = {
    ...(manifest ?? {}),
    workerName,
    resources: {
      ...(manifest?.resources ?? {}),
      names,
    },
  };
  const manifestPath = path.join(deploymentDir, "deployment-manifest.json");
  const save = async () => writeJson(manifestPath, state);

  if (!state.resources.d1?.id) {
    let d1Id = "<created-d1-id>";
    if (!dryRun) {
      const listResult = await runCommand(["wrangler", "d1", "list", "--json"], { cwd: ROOT_DIR, quiet: true });
      const databases = parseJsonOutput(listResult.stdout, "D1 列表");
      let database = Array.isArray(databases) ? databases.find((item) => item?.name === names.d1) : null;
      if (!database) {
        await runCommand(["wrangler", "d1", "create", names.d1], {
          cwd: ROOT_DIR,
        });
        const refreshedResult = await runCommand(["wrangler", "d1", "list", "--json"], { cwd: ROOT_DIR, quiet: true });
        const refreshed = parseJsonOutput(refreshedResult.stdout, "D1 列表");
        database = Array.isArray(refreshed) ? refreshed.find((item) => item?.name === names.d1) : null;
      } else {
        console.log(`复用现有 D1：${names.d1}`);
      }
      d1Id = database?.uuid ?? database?.id ?? null;
    } else {
      await runCommand(["wrangler", "d1", "create", names.d1], {
        cwd: ROOT_DIR,
        dryRun: true,
      });
    }
    state.resources.d1 = {
      name: names.d1,
      id: d1Id,
    };
    if (!state.resources.d1.id) {
      throw new DeploymentError("D1 已执行创建命令，但未能从资源列表中读取 database_id。");
    }
    if (!dryRun) await save();
  }

  if (!state.resources.kv?.id) {
    let kvId = "<created-kv-id>";
    if (!dryRun) {
      const listResult = await runCommand(["wrangler", "kv", "namespace", "list"], { cwd: ROOT_DIR, quiet: true });
      const namespaces = parseJsonOutput(listResult.stdout, "KV 列表");
      let namespace = Array.isArray(namespaces) ? namespaces.find((item) => item?.title === names.kv) : null;
      if (!namespace) {
        await runCommand(["wrangler", "kv", "namespace", "create", names.kv], { cwd: ROOT_DIR });
        const refreshedResult = await runCommand(["wrangler", "kv", "namespace", "list"], {
          cwd: ROOT_DIR,
          quiet: true,
        });
        const refreshed = parseJsonOutput(refreshedResult.stdout, "KV 列表");
        namespace = Array.isArray(refreshed) ? refreshed.find((item) => item?.title === names.kv) : null;
      } else {
        console.log(`复用现有 KV：${names.kv}`);
      }
      kvId = namespace?.id ?? null;
    } else {
      await runCommand(["wrangler", "kv", "namespace", "create", names.kv], { cwd: ROOT_DIR, dryRun: true });
    }
    state.resources.kv = {
      name: names.kv,
      id: kvId,
    };
    if (!state.resources.kv.id) {
      throw new DeploymentError("KV 已执行创建命令，但未能从资源列表中读取 namespace ID。");
    }
    if (!dryRun) await save();
  }

  if (!state.resources.mediaKv?.id) {
    let mediaKvId = "<created-media-kv-id>";
    if (!dryRun) {
      const listResult = await runCommand(["wrangler", "kv", "namespace", "list"], { cwd: ROOT_DIR, quiet: true });
      const namespaces = parseJsonOutput(listResult.stdout, "KV 列表");
      let namespace = Array.isArray(namespaces) ? namespaces.find((item) => item?.title === names.mediaKv) : null;
      if (!namespace) {
        await runCommand(["wrangler", "kv", "namespace", "create", names.mediaKv], { cwd: ROOT_DIR });
        const refreshedResult = await runCommand(["wrangler", "kv", "namespace", "list"], {
          cwd: ROOT_DIR,
          quiet: true,
        });
        const refreshed = parseJsonOutput(refreshedResult.stdout, "KV 列表");
        namespace = Array.isArray(refreshed) ? refreshed.find((item) => item?.title === names.mediaKv) : null;
      } else {
        console.log(`复用现有 KV：${names.mediaKv}`);
      }
      mediaKvId = namespace?.id ?? null;
    } else {
      await runCommand(["wrangler", "kv", "namespace", "create", names.mediaKv], { cwd: ROOT_DIR, dryRun: true });
    }
    state.resources.mediaKv = {
      name: names.mediaKv,
      id: mediaKvId,
    };
    if (!state.resources.mediaKv.id) {
      throw new DeploymentError("MEDIA_KV 已执行创建命令，但未能从资源列表中读取 namespace ID。");
    }
    if (!dryRun) await save();
  }

  state.resources.queue ??= { name: names.queue };
  if (!state.resources.queue.created) {
    if (dryRun) {
      await runCommand(["wrangler", "queues", "create", names.queue], {
        cwd: ROOT_DIR,
        dryRun: true,
      });
    } else {
      const queueInfo = await runCommand(["wrangler", "queues", "info", names.queue], {
        cwd: ROOT_DIR,
        allowFailure: true,
        quiet: true,
      });
      if (queueInfo.code === 0) {
        console.log(`复用现有 Queue：${names.queue}`);
      } else {
        await runCommand(["wrangler", "queues", "create", names.queue], {
          cwd: ROOT_DIR,
        });
      }
    }
    state.resources.queue.created = true;
    if (!dryRun) await save();
  }

  return state;
}

/**
 * The authorization center's Worker name, used for the service binding.
 *
 * A Worker cannot reach another Worker in the same Cloudflare account over
 * `*.workers.dev` — the edge answers `error code: 1042` with a 404 and the call
 * never arrives, which silently disables licensing (the webhook starts
 * answering 503) and the heartbeat. A service binding bypasses the network.
 */
function licenseCenterServiceName(licenseServerUrl) {
  try {
    const host = new URL(licenseServerUrl).hostname;
    if (!host.endsWith(".workers.dev")) return "";
    const label = host.slice(0, -".workers.dev".length).split(".")[0];
    return /^[a-z0-9][a-z0-9-]*$/i.test(label) ? label : "";
  } catch {
    return "";
  }
}

/**
 * Decides whether to emit the `LICENSE_CENTER` service binding.
 *
 * The binding only resolves inside the center's own Cloudflare account, so a
 * customer deployed into ITS OWN account would make `wrangler deploy` fail
 * outright ("service not found"). The choice therefore has to be automatic
 * rather than something the operator remembers to pass.
 *
 * The account's `workers.dev` subdomain is the discriminator: the center lives
 * at `<subdomain>.workers.dev`, so a different subdomain is a different
 * account. Without an API token the operator is on their own `wrangler login`,
 * i.e. the vendor's account — same-account by definition.
 */
async function resolveLicenseCenterService({ accountId, apiToken, licenseServerUrl }) {
  const name = licenseCenterServiceName(licenseServerUrl);
  if (!name) return "";
  if (!apiToken) return name;
  const centerSubdomain = new URL(licenseServerUrl).hostname.split(".")[1] ?? "";
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/subdomain`,
      { headers: { Authorization: `Bearer ${apiToken}`, Accept: "application/json" } },
    );
    if (!response.ok) {
      // Cannot confirm. Emitting the binding fails the deploy loudly, which
      // beats omitting it and silently breaking licensing: a Worker cannot
      // fetch a same-account Worker over workers.dev (error 1042).
      console.warn(`⚠️ 无法确认账户 ${accountId} 的 workers.dev 子域（HTTP ${response.status}），按同账户处理。`);
      return name;
    }
    const body = await response.json();
    const subdomain = typeof body?.result?.subdomain === "string" ? body.result.subdomain : "";
    if (!subdomain || subdomain === centerSubdomain) return name;
    console.log(`ℹ️ 目标账户是客户自有账户（${subdomain} ≠ ${centerSubdomain}），改用 HTTPS 与授权中心通信。`);
    return "";
  } catch (error) {
    console.warn(`⚠️ 检查账户子域失败（${error instanceof Error ? error.message : "网络错误"}），按同账户处理。`);
    return name;
  }
}

function buildWranglerConfig({
  projectDir,
  workerName,
  adminIds,
  licenseServerUrl,
  installationId,
  resources,
  accountId,
  licenseCenterService = "",
}) {
  const sourcePath = (value) => path.resolve(projectDir, value).replaceAll("\\", "/");
  const lines = [
    `name = ${tomlString(workerName)}`,
    `main = ${tomlString(sourcePath("src/index.ts"))}`,
    `compatibility_date = ${tomlString(COMPATIBILITY_DATE)}`,
    "minify = true",
    "workers_dev = true",
    "preview_urls = true",
    ...(accountId ? [`account_id = ${tomlString(accountId)}`] : []),
    // The admin SPA is served by the same Worker through the ASSETS binding;
    // `env.ASSETS` is non-optional, so omitting this ships a customer instance
    // whose /admin is a 404. Must sit at top level, i.e. ABOVE the first
    // `[[table]]` header — TOML attaches later keys to the preceding table.
    `assets = { directory = ${tomlString(sourcePath("admin/dist"))}, binding = "ASSETS", run_worker_first = true, not_found_handling = "none", html_handling = "none" }`,
    "",
    // result-visual-font.ts imports two .ttf subsets as raw bytes. Without this
    // rule esbuild aborts the whole build with
    // `No loader is configured for ".ttf" files` — i.e. no customer instance
    // could ever be deployed.
    "[[rules]]",
    `type = "Data"`,
    `globs = ["**/*.ttf"]`,
    "fallthrough = false",
    "",
    "[vars]",
    `ENVIRONMENT = ${tomlString("production")}`,
    `APP_VERSION = ${tomlString(APP_VERSION)}`,
    `LICENSE_ENFORCEMENT = ${tomlString("required")}`,
    `LICENSE_SERVER_URL = ${tomlString(licenseServerUrl)}`,
    `INSTALLATION_ID = ${tomlString(installationId)}`,
    `WORKER_NAME = ${tomlString(workerName)}`,
    `LICENSE_GRACE_SECONDS = ${tomlString("86400")}`,
    // Licensed customer instance: may use the bot, but must never issue
    // licenses, publish releases or hand out trial accounts (no re-authorizing
    // third parties with a product the customer only licensed).
    `DEPLOYMENT_ROLE = ${tomlString("customer")}`,
    `ADMIN_IDS = ${tomlString(adminIds)}`,
    "",
    "[[d1_databases]]",
    `binding = ${tomlString("DB")}`,
    `database_name = ${tomlString(resources.d1.name)}`,
    `database_id = ${tomlString(resources.d1.id)}`,
    `migrations_dir = ${tomlString(sourcePath("db/migrations"))}`,
    "",
    "[[kv_namespaces]]",
    `binding = ${tomlString("MEDIA_KV")}`,
    `id = ${tomlString(resources.mediaKv.id)}`,
    `preview_id = ${tomlString(resources.mediaKv.id)}`,
    "",
    "[[kv_namespaces]]",
    `binding = ${tomlString("CACHE")}`,
    `id = ${tomlString(resources.kv.id)}`,
    `preview_id = ${tomlString(resources.kv.id)}`,
    "",
    // Same-account customers call the authorization center through this
    // binding; `fetch()` on its workers.dev URL would fail with error 1042.
    ...(licenseCenterService
      ? [
          "[[services]]",
          `binding = ${tomlString("LICENSE_CENTER")}`,
          `service = ${tomlString(licenseCenterService)}`,
          "",
        ]
      : []),
    "[[queues.producers]]",
    `binding = ${tomlString("EXPORT_QUEUE")}`,
    `queue = ${tomlString(resources.queue.name)}`,
    "",
    "[[queues.consumers]]",
    `queue = ${tomlString(resources.queue.name)}`,
    // Matches the vendor instance, which is the configuration exports have
    // actually been exercised against.
    "max_batch_size = 1",
    "max_batch_timeout = 5",
    "max_concurrency = 3",
    "",
    "[browser]",
    `binding = ${tomlString("BROWSER")}`,
    "",
    // Report-delivery retries + heartbeat (`*/30`) and media retention +
    // database maintenance (`15 1`). Without them a customer never retries a
    // failed report and never runs any maintenance.
    //
    // The vendor's third trigger (`30 9 * * 1`, the weekly operations digest)
    // is deliberately NOT emitted here: it only posts to a report channel,
    // which a customer configures for themselves (often never), so it would
    // burn a cron slot on a no-op. That matters because Workers **Free allows
    // only 5 cron triggers per ACCOUNT** and the authorization center already
    // holds 3 — onboarding a second customer in this account requires Workers
    // Paid (1,000 triggers) or deploying it into its own account.
    "[triggers]",
    `crons = ["*/30 * * * *", "15 1 * * *"]`,
    "",
    "[[durable_objects.bindings]]",
    `name = ${tomlString("SESSION")}`,
    `class_name = ${tomlString("SurveySessionDO")}`,
    "",
    "[[durable_objects.bindings]]",
    `name = ${tomlString("BUILDER")}`,
    `class_name = ${tomlString("SurveyBuilderDO")}`,
    "",
    // `env.UI` is a non-optional binding: the export queue consumer uses it to
    // drive the UI session, so a customer instance without it cannot export.
    "[[durable_objects.bindings]]",
    `name = ${tomlString("UI")}`,
    `class_name = ${tomlString("UiSessionDO")}`,
    "",
    "[[migrations]]",
    `tag = ${tomlString("v1")}`,
    `new_sqlite_classes = [${tomlString("SurveySessionDO")}, ${tomlString("SurveyBuilderDO")}]`,
    "",
    "[[migrations]]",
    `tag = ${tomlString("v2")}`,
    `new_sqlite_classes = [${tomlString("UiSessionDO")}]`,
    "",
  ];
  return lines.join("\n");
}

async function writeSecretsFile(filePath, values) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${String(value).replace(/\r?\n/g, "")}`);
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function setWebhook(botToken, webhookUrl, webhookSecret, dryRun) {
  console.log(`\n> Telegram setWebhook ${webhookUrl}`);
  if (dryRun) return;
  const response = await fetch(`https://api.telegram.org/bot${encodeURIComponent(botToken)}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: webhookSecret,
      drop_pending_updates: false,
      allowed_updates: ["message", "callback_query", "channel_post"],
    }),
  });
  let body;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok || !body?.ok) {
    throw new DeploymentError(`Telegram setWebhook 失败（HTTP ${response.status}）。`, JSON.stringify(body));
  }
}

async function setBotCommands(botToken, dryRun) {
  console.log("\n> Telegram 同步精简命令菜单");
  if (dryRun) return;
  const response = await fetch(`https://api.telegram.org/bot${encodeURIComponent(botToken)}/setMyCommands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commands: BOT_COMMANDS }),
  });
  let body;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok || !body?.ok) {
    throw new DeploymentError(`Telegram setMyCommands 失败（HTTP ${response.status}）。`, JSON.stringify(body));
  }
}

async function registerCustomerDeployment({ licenseServerUrl, licenseKey, installationId, workerName, workerUrl, remoteAccessSecret, dryRun }) {
  if (dryRun || !licenseKey) return;
  const response = await fetch(`${licenseServerUrl.replace(/\/+$/, "")}/api/control/customer/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      licenseKey,
      installationId,
      appVersion: APP_VERSION,
      workerName,
      workerUrl,
      // The center stores this encrypted and uses it to sign the short-lived
      // read-only tokens the vendor console presents to /api/remote/*.
      ...(remoteAccessSecret ? { remoteAccessSecret } : {}),
      metadata: { source: "deploy-customer.mjs" },
    }),
  });
  if (!response.ok) {
    throw new DeploymentError(`Customer Deployment 注册失败（HTTP ${response.status}）。`);
  }
}

async function deploy(args, values) {
  const customerName = validateRequired(values["customer-name"], "客户名称");
  const botToken = validateRequired(values["bot-token"], "Bot Token");
  const adminIds = validateAdminIds(values["admin-id"]);
  const licenseServerUrl = values["license-server-url"]?.trim() || DEFAULT_LICENSE_SERVER_URL;
  if (!/^https?:\/\//i.test(licenseServerUrl)) {
    throw new DeploymentError("授权中心地址必须以 http:// 或 https:// 开头。");
  }

  const workerName = values["worker-name"]?.trim() || makeSlug(customerName);
  validateWorkerName(workerName);
  const installationId =
    values["installation-id"]?.trim() ||
    `install-${createHash("sha256").update(`${workerName}:${customerName}`).digest("hex").slice(0, 24)}`;
  const webhookSecret = values["webhook-secret"]?.trim() || randomBytes(24).toString("base64url");
  const accountId = values["account-id"]?.trim() || process.env.CLOUDFLARE_ACCOUNT_ID || "";
  const apiToken = values["api-token"]?.trim() || process.env.CLOUDFLARE_API_TOKEN || "";
  if (apiToken) process.env.CLOUDFLARE_API_TOKEN = apiToken;
  if (accountId) process.env.CLOUDFLARE_ACCOUNT_ID = accountId;

  const deploymentDir = path.resolve(values["deployment-dir"] || path.join(args.outputRoot, normalizeName(workerName)));
  await fs.mkdir(deploymentDir, { recursive: true });
  const manifestPath = path.join(deploymentDir, "deployment-manifest.json");
  const existingManifest = await readJsonIfExists(manifestPath);
  const surveyCodePepper = existingManifest?.surveyCodePepperConfigured ? "" : randomBytes(32).toString("hex");
  const pendingLicensePath = path.join(deploymentDir, ".pending-license.json");
  const pendingLicense = await readJsonIfExists(pendingLicensePath);
  let licenseKey =
    values["license-key"]?.trim() || (typeof pendingLicense?.licenseKey === "string" ? pendingLicense.licenseKey : "");
  let licensePublicId = typeof pendingLicense?.publicId === "string" ? pendingLicense.publicId : null;
  const reuseExistingLicense =
    !licenseKey && (existingManifest?.licenseConfigured === true || values["reuse-existing-license"] === "true");
  if (!licenseKey && !reuseExistingLicense) {
    throw new DeploymentError("缺少授权密钥。请向项目所有者索取密钥，然后重新运行部署脚本。");
  }

  // The admin login fails closed until `admin_password_hash` exists, so a
  // deployment that skips this ships an instance nobody can log into
  // (/api/admin/auth/password answers 503 admin_password_not_configured).
  // Reuse the previously generated password on re-runs — regenerating it would
  // silently lock the customer out of the panel they already have.
  const adminPassword =
    values["admin-password"]?.trim() ||
    (typeof existingManifest?.adminPassword === "string" ? existingManifest.adminPassword : "") ||
    randomBytes(12).toString("base64url");
  const adminPasswordGenerated = values["admin-password"]?.trim() ? false : !existingManifest?.adminPassword;

  // Shared with the center so it can sign read-only tokens. Reused across runs
  // for the same reason as the admin password: rotating it would silently stop
  // the vendor console from reading this instance.
  const remoteAccessSecret =
    values["remote-access-secret"]?.trim() ||
    (typeof existingManifest?.remoteAccessSecret === "string" ? existingManifest.remoteAccessSecret : "") ||
    randomBytes(24).toString("base64url");

  const plan = {
    customerName,
    workerName,
    installationId,
    adminIds,
    licenseServerUrl,
    licensePublicId: licensePublicId ?? "existing",
    licenseMode: reuseExistingLicense ? "reuse-cloudflare-secret" : "set",
    deploymentDir,
    resources: resourceNames(workerName),
  };
  console.log("\n部署计划：");
  console.log(JSON.stringify(plan, null, 2));
  if (existingManifest && existingManifest.workerName && existingManifest.workerName !== workerName) {
    throw new DeploymentError(`部署目录已绑定 Worker ${existingManifest.workerName}，不能改用 ${workerName}。`);
  }

  const resourceState = await createResources({
    workerName,
    deploymentDir,
    dryRun: args.dryRun,
    manifest: existingManifest,
  });
  const resources = resourceState.resources;
  const configPath = path.join(deploymentDir, "wrangler.toml");
  const licenseCenterService = args.noLicenseCenterBinding
    ? ""
    : await resolveLicenseCenterService({ accountId, apiToken, licenseServerUrl });
  const config = buildWranglerConfig({
    projectDir: args.projectDir,
    workerName,
    adminIds,
    licenseServerUrl,
    installationId,
    resources,
    accountId,
    licenseCenterService,
  });
  await fs.writeFile(configPath, config, "utf8");

  const secretsPath = path.join(deploymentDir, ".customer-secrets.tmp");
  const secrets = [botToken, licenseKey, webhookSecret, apiToken, surveyCodePepper].filter(Boolean);
  try {
    await writeSecretsFile(secretsPath, {
      BOT_TOKEN: botToken,
      WEBHOOK_SECRET: webhookSecret,
      REMOTE_ACCESS_SECRET: remoteAccessSecret,
      ...(licenseKey ? { LICENSE_KEY: licenseKey } : {}),
      ...(surveyCodePepper ? { SURVEY_CODE_PEPPER: surveyCodePepper } : {}),
    });

    await runCommand(["wrangler", "d1", "migrations", "apply", "DB", "--remote", "--config", configPath], {
      cwd: args.projectDir,
      secrets,
      dryRun: args.dryRun,
    });
    // Runs against the customer's own database via --config: without it wrangler
    // would write into the authorization center's system_settings.
    await runCommand(
      [
        "wrangler",
        "d1",
        "execute",
        "DB",
        "--remote",
        "--config",
        configPath,
        "--command",
        adminPasswordHashSql(await hashAdminPassword(adminPassword)),
      ],
      { cwd: args.projectDir, secrets: [adminPassword, ...secrets], dryRun: args.dryRun },
    );
    const deployResult = await runCommand(
      ["wrangler", "deploy", "--config", configPath, "--secrets-file", secretsPath, "--keep-vars"],
      { cwd: args.projectDir, secrets, dryRun: args.dryRun },
    );

    const workerUrl = deployResult.stdout.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0] ?? null;
    if (!workerUrl && !args.dryRun) {
      throw new DeploymentError("Worker 已部署，但未能从 Wrangler 输出中识别 workers.dev 地址。");
    }
    const resolvedWorkerUrl = workerUrl ?? `https://${workerName}.example.workers.dev`;
    const webhookUrl = `${resolvedWorkerUrl}/telegram/webhook`;
    await setBotCommands(botToken, args.dryRun);
    await setWebhook(botToken, webhookUrl, webhookSecret, args.dryRun);
    await registerCustomerDeployment({
      licenseServerUrl,
      licenseKey,
      installationId,
      workerName,
      workerUrl: resolvedWorkerUrl,
      remoteAccessSecret,
      dryRun: args.dryRun,
    });

    if (args.dryRun) {
      console.log(`
预演完成：未创建远程资源、未部署 Worker、未设置 Webhook。
生成配置：${configPath}
`);
      return;
    }
    await writeJson(manifestPath, {
      ...resourceState,
      customerName,
      installationId,
      deployedAt: new Date().toISOString(),
      workerUrl: resolvedWorkerUrl,
      webhookUrl,
      appVersion: APP_VERSION,
      licensePublicId,
      licenseConfigured: true,
      // Needed by `--update-existing`: without it an update falls back to the
      // runner's own account and redeploys a cross-account customer into the
      // vendor's account.
      accountId,
      // Kept so re-running the deploy does not rotate the customer's password
      // out from under them. Lives in customer-deployments/, which is
      // gitignored — this file is the operator's local deployment record.
      adminPassword,
      remoteAccessSecret,
      surveyCodePepperConfigured: true,
    });
    try {
      await fs.unlink(pendingLicensePath);
    } catch {
      // Existing-license deployments do not create a pending file.
    }
    console.log(`
部署完成：
Worker：${resolvedWorkerUrl}
Webhook：${webhookUrl}
管理员：${adminIds}
安装 ID：${installationId}
后台地址：${resolvedWorkerUrl}/admin
后台密码：${adminPassword}${adminPasswordGenerated ? "   ← 新生成，仅此处显示；已存入 deployment-manifest.json" : ""}

交付给客户前必须完成：
1. 【必需】用管理员 Telegram 账号（${adminIds}）向客户 Bot 发送 /start。
   这一步会创建管理员账号记录；在此之前后台密码登录会返回
   403「当前没有可用于管理后台登录的管理员账号」。
2. 访问 ${resolvedWorkerUrl}/admin，用上面的后台密码登录。
3. 在「设置」中填写报告归档频道（report_channel_id）等客户自己的配置。

首次测试：
4. 管理员发送 /create，确认可以创建问卷。
5. 普通用户发送 /surveys，确认只能填写问卷。
6. 可访问 ${resolvedWorkerUrl}/health 检查版本与授权状态。

说明：本实例已写入 DEPLOYMENT_ROLE=customer，无法签发授权、发布版本或
发放体验账号（这些仅限厂商授权中心）。
`);
  } finally {
    try {
      await fs.unlink(secretsPath);
    } catch {
      // The file may not exist when dry-run or an early validation fails.
    }
  }
}

function readTomlValue(contents, key) {
  return contents.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m"))?.[1] ?? "";
}

async function updateDeployment(args, values) {
  const deploymentDir = path.resolve(values["update-existing"]);
  const manifestPath = path.join(deploymentDir, "deployment-manifest.json");
  const manifest = await readJsonIfExists(manifestPath);
  if (!manifest?.workerName || !manifest?.resources?.d1?.id) {
    throw new DeploymentError(`部署目录没有有效的 deployment-manifest.json：${deploymentDir}`);
  }
  const configPath = path.join(deploymentDir, "wrangler.toml");
  let existingConfig = "";
  try {
    existingConfig = await fs.readFile(configPath, "utf8");
  } catch {
    existingConfig = "";
  }
  const adminIds = readTomlValue(existingConfig, "ADMIN_IDS");
  const licenseServerUrl = readTomlValue(existingConfig, "LICENSE_SERVER_URL") || DEFAULT_LICENSE_SERVER_URL;
  const installationId = readTomlValue(existingConfig, "INSTALLATION_ID") || manifest.installationId || "";
  // Prefer explicit flags, then the account recorded at deploy time. Reading
  // only the environment meant a runner updating a cross-account customer
  // silently deployed it into the VENDOR's account instead.
  const accountId =
    values["account-id"]?.trim() || manifest.accountId || process.env.CLOUDFLARE_ACCOUNT_ID || "";
  const apiToken = values["api-token"]?.trim() || process.env.CLOUDFLARE_API_TOKEN || "";
  if (apiToken) process.env.CLOUDFLARE_API_TOKEN = apiToken;
  if (accountId) process.env.CLOUDFLARE_ACCOUNT_ID = accountId;

  const licenseCenterService = args.noLicenseCenterBinding
    ? ""
    : await resolveLicenseCenterService({ accountId, apiToken, licenseServerUrl });
  const config = buildWranglerConfig({
    projectDir: args.projectDir,
    workerName: manifest.workerName,
    adminIds,
    licenseServerUrl,
    installationId,
    resources: manifest.resources,
    accountId,
    licenseCenterService,
  });
  await fs.writeFile(configPath, config, "utf8");
  const surveyCodePepper = manifest.surveyCodePepperConfigured ? "" : randomBytes(32).toString("hex");
  const secretsPath = path.join(deploymentDir, ".customer-secrets.tmp");

  console.log(`\n> 更新客户实例：${manifest.workerName}`);
  await runCommand(["wrangler", "d1", "migrations", "apply", "DB", "--remote", "--config", configPath], {
    cwd: args.projectDir,
    dryRun: args.dryRun,
  });
  if (surveyCodePepper) {
    await writeSecretsFile(secretsPath, { SURVEY_CODE_PEPPER: surveyCodePepper });
  }
  const deployArgs = ["wrangler", "deploy", "--config", configPath, "--keep-vars"];
  if (surveyCodePepper) deployArgs.push("--secrets-file", secretsPath);
  try {
    await runCommand(deployArgs, {
      cwd: args.projectDir,
      dryRun: args.dryRun,
    });
    if (!args.dryRun) {
      await writeJson(manifestPath, {
        ...manifest,
        appVersion: APP_VERSION,
        updatedAt: new Date().toISOString(),
        surveyCodePepperConfigured: true,
      });
    }
  } finally {
    if (surveyCodePepper) {
      try {
        await fs.unlink(secretsPath);
      } catch {
        // The temporary secret file may already have been removed.
      }
    }
  }
  console.log(`✅ ${manifest.workerName} 已更新到 ${APP_VERSION}（${manifest.workerUrl ?? "地址不变"}）`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (args.values["update-existing"]) {
    await updateDeployment(args, args.values);
    return;
  }
  const values = await promptValues(args);
  await deploy(args, values);
}

try {
  await main();
} catch (error) {
  if (error instanceof DeploymentError) {
    console.error(`\n部署未完成：${error.message}`);
    if (error.details) console.error(error.details);
  } else {
    console.error(`\n部署未完成：${error instanceof Error ? error.message : String(error)}`);
  }
  process.exitCode = 1;
}

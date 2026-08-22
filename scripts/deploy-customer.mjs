#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
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
const DEFAULT_LICENSE_SERVER_URL =
  "https://telegram-multimedia-survey-bot.pd2335346.workers.dev";
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
    "installation-id",
    "deployment-dir",
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
  const suffix = createHash("sha256")
    .update(customerName)
    .digest("hex")
    .slice(0, 8);
  return `survey-${base.slice(0, 32)}-${suffix}`;
}

function validateWorkerName(workerName) {
  if (
    !workerName ||
    workerName.length > 63 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(workerName)
  ) {
    throw new DeploymentError(
      "Worker 名称只能使用小写字母、数字和连字符，长度不能超过 63。",
    );
  }
}

function validateAdminIds(value) {
  const ids = String(value ?? "")
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (
    ids.length === 0 ||
    ids.some((item) => !/^[1-9]\d*$/.test(item))
  ) {
    throw new DeploymentError(
      "管理员 ID 必须是 Telegram 数字 ID，例如 123456789。",
    );
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
    const answer = await rl.question(
      fallback ? `${label} [${fallback}]: ` : `${label}: `,
    );
    return answer.trim() || fallback;
  };

  try {
    values["customer-name"] = await ask("customer-name", "客户名称");
    const workerName =
      values["worker-name"]?.trim() || makeSlug(values["customer-name"]);
    const deploymentDir = path.resolve(
      values["deployment-dir"] ||
        path.join(args.outputRoot, normalizeName(workerName)),
    );
    const existingDeploymentManifest = await readJsonIfExists(
      path.join(deploymentDir, "deployment-manifest.json"),
    );
    reuseExistingLicense = existingDeploymentManifest?.licenseConfigured === true;
    values["admin-id"] = await ask("admin-id", "管理员 Telegram ID");
    values["license-key"] =
      values["license-key"] ?? process.env.LICENSE_KEY ?? "";
    if (reuseExistingLicense) {
      values["reuse-existing-license"] = "true";
    }
    values["license-server-url"] =
      values["license-server-url"] ??
      process.env.LICENSE_SERVER_URL ??
      DEFAULT_LICENSE_SERVER_URL;
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
    values["bot-token"] = await promptSecret(
      "Telegram Bot Token",
      process.env.TELEGRAM_BOT_TOKEN ?? "",
    );
  }
  values["api-token"] =
    values["api-token"] ?? process.env.CLOUDFLARE_API_TOKEN ?? "";
  if (!values["api-token"] && !process.env.CLOUDFLARE_API_TOKEN) {
    values["api-token"] = await promptSecret(
      "Cloudflare API Token（已执行 wrangler login 可留空）",
    );
  }
  return values;
}

async function promptSecret(label, fallback = "") {
  if (!input.isTTY || !output.isTTY) {
    const rl = createInterface({ input, output });
    try {
      const answer = await rl.question(
        fallback ? `${label}（已设置，直接回车使用）: ` : `${label}: `,
      );
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
  output.write(
    fallback ? `${label}（已设置，直接回车使用）: ` : `${label}: `,
  );
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
  return [WRANGLER, ...args]
    .map((value) => (/\s/.test(value) ? JSON.stringify(value) : value))
    .join(" ");
}

function runCommand(
  args,
  {
    cwd,
    secrets = [],
    dryRun = false,
    allowFailure = false,
    quiet = false,
  } = {},
) {
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
      reject(
        new DeploymentError(
          `无法执行 ${WRANGLER}。请确认已安装 Node.js 和 Wrangler。`,
          error.message,
        ),
      );
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
    throw new DeploymentError(
      `${label} 返回的数据无法解析。`,
      error instanceof Error ? error.message : String(error),
    );
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
    queue: withSuffix("export"),
  };
}

async function createResources({
  workerName,
  deploymentDir,
  dryRun,
  manifest,
}) {
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
      const listResult = await runCommand(
        ["wrangler", "d1", "list", "--json"],
        { cwd: ROOT_DIR, quiet: true },
      );
      const databases = parseJsonOutput(listResult.stdout, "D1 列表");
      let database = Array.isArray(databases)
        ? databases.find((item) => item?.name === names.d1)
        : null;
      if (!database) {
        await runCommand(["wrangler", "d1", "create", names.d1], {
          cwd: ROOT_DIR,
        });
        const refreshedResult = await runCommand(
          ["wrangler", "d1", "list", "--json"],
          { cwd: ROOT_DIR, quiet: true },
        );
        const refreshed = parseJsonOutput(
          refreshedResult.stdout,
          "D1 列表",
        );
        database = Array.isArray(refreshed)
          ? refreshed.find((item) => item?.name === names.d1)
          : null;
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
      throw new DeploymentError(
        "D1 已执行创建命令，但未能从资源列表中读取 database_id。",
      );
    }
    if (!dryRun) await save();
  }

  if (!state.resources.kv?.id) {
    let kvId = "<created-kv-id>";
    if (!dryRun) {
      const listResult = await runCommand(
        ["wrangler", "kv", "namespace", "list"],
        { cwd: ROOT_DIR, quiet: true },
      );
      const namespaces = parseJsonOutput(listResult.stdout, "KV 列表");
      let namespace = Array.isArray(namespaces)
        ? namespaces.find((item) => item?.title === names.kv)
        : null;
      if (!namespace) {
        await runCommand(
          ["wrangler", "kv", "namespace", "create", names.kv],
          { cwd: ROOT_DIR },
        );
        const refreshedResult = await runCommand(
          ["wrangler", "kv", "namespace", "list"],
          { cwd: ROOT_DIR, quiet: true },
        );
        const refreshed = parseJsonOutput(
          refreshedResult.stdout,
          "KV 列表",
        );
        namespace = Array.isArray(refreshed)
          ? refreshed.find((item) => item?.title === names.kv)
          : null;
      } else {
        console.log(`复用现有 KV：${names.kv}`);
      }
      kvId = namespace?.id ?? null;
    } else {
      await runCommand(
        ["wrangler", "kv", "namespace", "create", names.kv],
        { cwd: ROOT_DIR, dryRun: true },
      );
    }
    state.resources.kv = {
      name: names.kv,
      id: kvId,
    };
    if (!state.resources.kv.id) {
      throw new DeploymentError(
        "KV 已执行创建命令，但未能从资源列表中读取 namespace ID。",
      );
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
      const queueInfo = await runCommand(
        ["wrangler", "queues", "info", names.queue],
        {
          cwd: ROOT_DIR,
          allowFailure: true,
          quiet: true,
        },
      );
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

function buildWranglerConfig({
  projectDir,
  workerName,
  adminIds,
  licenseServerUrl,
  installationId,
  resources,
  accountId,
}) {
  const sourcePath = (value) =>
    path.resolve(projectDir, value).replaceAll("\\", "/");
  const lines = [
    `name = ${tomlString(workerName)}`,
    `main = ${tomlString(sourcePath("src/index.ts"))}`,
    `compatibility_date = ${tomlString(COMPATIBILITY_DATE)}`,
    "workers_dev = true",
    "preview_urls = true",
    ...(accountId ? [`account_id = ${tomlString(accountId)}`] : []),
    "",
    "[vars]",
    `ENVIRONMENT = ${tomlString("production")}`,
    `APP_VERSION = ${tomlString(APP_VERSION)}`,
    `LICENSE_ENFORCEMENT = ${tomlString("required")}`,
    `LICENSE_SERVER_URL = ${tomlString(licenseServerUrl)}`,
    `INSTALLATION_ID = ${tomlString(installationId)}`,
    `LICENSE_GRACE_SECONDS = ${tomlString("86400")}`,
    `ADMIN_IDS = ${tomlString(adminIds)}`,
    "",
    "[[d1_databases]]",
    `binding = ${tomlString("DB")}`,
    `database_name = ${tomlString(resources.d1.name)}`,
    `database_id = ${tomlString(resources.d1.id)}`,
    `migrations_dir = ${tomlString(sourcePath("db/migrations"))}`,
    "",
    "[[kv_namespaces]]",
    `binding = ${tomlString("CACHE")}`,
    `id = ${tomlString(resources.kv.id)}`,
    `preview_id = ${tomlString(resources.kv.id)}`,
    "",
    "[[queues.producers]]",
    `binding = ${tomlString("EXPORT_QUEUE")}`,
    `queue = ${tomlString(resources.queue.name)}`,
    "",
    "[[queues.consumers]]",
    `queue = ${tomlString(resources.queue.name)}`,
    "max_batch_size = 5",
    "max_batch_timeout = 5",
    "",
    "[browser]",
    `binding = ${tomlString("BROWSER")}`,
    "",
    "[[durable_objects.bindings]]",
    `name = ${tomlString("SESSION")}`,
    `class_name = ${tomlString("SurveySessionDO")}`,
    "",
    "[[durable_objects.bindings]]",
    `name = ${tomlString("BUILDER")}`,
    `class_name = ${tomlString("SurveyBuilderDO")}`,
    "",
    "[[migrations]]",
    `tag = ${tomlString("v1")}`,
    `new_sqlite_classes = [${tomlString("SurveySessionDO")}, ${tomlString("SurveyBuilderDO")}]`,
    "",
  ];
  return lines.join("\n");
}

async function writeSecretsFile(filePath, values) {
  const lines = Object.entries(values).map(
    ([key, value]) => `${key}=${String(value).replace(/\r?\n/g, "")}`,
  );
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function setWebhook(botToken, webhookUrl, webhookSecret, dryRun) {
  console.log(`\n> Telegram setWebhook ${webhookUrl}`);
  if (dryRun) return;
  const response = await fetch(
    `https://api.telegram.org/bot${encodeURIComponent(botToken)}/setWebhook`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: webhookSecret,
        drop_pending_updates: false,
        allowed_updates: ["message", "callback_query", "channel_post"],
      }),
    },
  );
  let body;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok || !body?.ok) {
    throw new DeploymentError(
      `Telegram setWebhook 失败（HTTP ${response.status}）。`,
      JSON.stringify(body),
    );
  }
}

async function setBotCommands(botToken, dryRun) {
  console.log("\n> Telegram 同步精简命令菜单");
  if (dryRun) return;
  const response = await fetch(
    `https://api.telegram.org/bot${encodeURIComponent(botToken)}/setMyCommands`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands: BOT_COMMANDS }),
    },
  );
  let body;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok || !body?.ok) {
    throw new DeploymentError(
      `Telegram setMyCommands 失败（HTTP ${response.status}）。`,
      JSON.stringify(body),
    );
  }
}

async function deploy(args, values) {
  const customerName = validateRequired(values["customer-name"], "客户名称");
  const botToken = validateRequired(values["bot-token"], "Bot Token");
  const adminIds = validateAdminIds(values["admin-id"]);
  const licenseServerUrl =
    values["license-server-url"]?.trim() || DEFAULT_LICENSE_SERVER_URL;
  if (!/^https?:\/\//i.test(licenseServerUrl)) {
    throw new DeploymentError("授权中心地址必须以 http:// 或 https:// 开头。");
  }

  const workerName = values["worker-name"]?.trim() || makeSlug(customerName);
  validateWorkerName(workerName);
  const installationId =
    values["installation-id"]?.trim() ||
    `install-${createHash("sha256")
      .update(`${workerName}:${customerName}`)
      .digest("hex")
      .slice(0, 24)}`;
  const webhookSecret =
    values["webhook-secret"]?.trim() || randomBytes(24).toString("base64url");
  const accountId =
    values["account-id"]?.trim() || process.env.CLOUDFLARE_ACCOUNT_ID || "";
  const apiToken =
    values["api-token"]?.trim() || process.env.CLOUDFLARE_API_TOKEN || "";
  if (apiToken) process.env.CLOUDFLARE_API_TOKEN = apiToken;
  if (accountId) process.env.CLOUDFLARE_ACCOUNT_ID = accountId;

  const deploymentDir = path.resolve(
    values["deployment-dir"] ||
      path.join(args.outputRoot, normalizeName(workerName)),
  );
  await fs.mkdir(deploymentDir, { recursive: true });
  const manifestPath = path.join(deploymentDir, "deployment-manifest.json");
  const existingManifest = await readJsonIfExists(manifestPath);
  const pendingLicensePath = path.join(
    deploymentDir,
    ".pending-license.json",
  );
  const pendingLicense = await readJsonIfExists(pendingLicensePath);
  let licenseKey =
    values["license-key"]?.trim() ||
    (typeof pendingLicense?.licenseKey === "string"
      ? pendingLicense.licenseKey
      : "");
  let licensePublicId =
    typeof pendingLicense?.publicId === "string"
      ? pendingLicense.publicId
      : null;
  const reuseExistingLicense =
    !licenseKey &&
    (existingManifest?.licenseConfigured === true ||
      values["reuse-existing-license"] === "true");
  if (!licenseKey && !reuseExistingLicense) {
    throw new DeploymentError(
      "缺少授权密钥。请向项目所有者索取密钥，然后重新运行部署脚本。",
    );
  }

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
  if (
    existingManifest &&
    existingManifest.workerName &&
    existingManifest.workerName !== workerName
  ) {
    throw new DeploymentError(
      `部署目录已绑定 Worker ${existingManifest.workerName}，不能改用 ${workerName}。`,
    );
  }

  const resourceState = await createResources({
    workerName,
    deploymentDir,
    dryRun: args.dryRun,
    manifest: existingManifest,
  });
  const resources = resourceState.resources;
  const configPath = path.join(deploymentDir, "wrangler.toml");
  const config = buildWranglerConfig({
    projectDir: args.projectDir,
    workerName,
    adminIds,
    licenseServerUrl,
    installationId,
    resources,
    accountId,
  });
  await fs.writeFile(configPath, config, "utf8");

  const secretsPath = path.join(deploymentDir, ".customer-secrets.tmp");
  const secrets = [
    botToken,
    licenseKey,
    webhookSecret,
    apiToken,
  ].filter(Boolean);
  try {
    await writeSecretsFile(secretsPath, {
      BOT_TOKEN: botToken,
      WEBHOOK_SECRET: webhookSecret,
      ...(licenseKey ? { LICENSE_KEY: licenseKey } : {}),
    });

    await runCommand(
      [
        "wrangler",
        "d1",
        "migrations",
        "apply",
        "DB",
        "--remote",
        "--config",
        configPath,
      ],
      { cwd: args.projectDir, secrets, dryRun: args.dryRun },
    );
    const deployResult = await runCommand(
      [
        "wrangler",
        "deploy",
        "--config",
        configPath,
        "--secrets-file",
        secretsPath,
        "--keep-vars",
      ],
      { cwd: args.projectDir, secrets, dryRun: args.dryRun },
    );

    const workerUrl =
      deployResult.stdout.match(
        /https:\/\/[a-z0-9.-]+\.workers\.dev/i,
      )?.[0] ?? null;
    if (!workerUrl && !args.dryRun) {
      throw new DeploymentError(
        "Worker 已部署，但未能从 Wrangler 输出中识别 workers.dev 地址。",
      );
    }
    const resolvedWorkerUrl =
      workerUrl ?? `https://${workerName}.example.workers.dev`;
    const webhookUrl = `${resolvedWorkerUrl}/telegram/webhook`;
    await setBotCommands(botToken, args.dryRun);
    await setWebhook(botToken, webhookUrl, webhookSecret, args.dryRun);

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

首次测试：
1. 在 Telegram 中向客户 Bot 发送 /start。
2. 管理员发送 /create，确认可以创建问卷。
3. 普通用户发送 /surveys，确认只能填写问卷。
4. 管理员发送 /health 以外的命令前，可先访问 Worker 的 /health 检查版本和授权状态。
`);
  } finally {
    try {
      await fs.unlink(secretsPath);
    } catch {
      // The file may not exist when dry-run or an early validation fails.
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
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
    console.error(
      `\n部署未完成：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  process.exitCode = 1;
}

import { activateLicense, createLicense, validateLicense } from "../services/license.service";
import { signRemoteAccessToken } from "../services/remote-access-token.service";
import { createAuditLog } from "../db/repositories/audit.repository";
import { encryptDeploymentTaskPayload, decryptDeploymentTaskPayload } from "../services/deployment-task-secret.service";
import {
  getSoftwareLicenseById,
  getSoftwareLicenseByPublicId,
  updateSoftwareLicenseDates,
} from "../db/repositories/license.repository";
import {
  claimDeploymentTask,
  createDeploymentTask,
  finishDeploymentTask,
  getCustomerDeployment,
  getCustomerDeploymentCredentials,
  getCustomerDeploymentRemoteSecret,
  setCustomerDeploymentRemoteSecret,
  listCustomerDeployments,
  listDeploymentTasks,
  setCustomerDeploymentCredentials,
  setDeploymentStatus,
  upsertCustomerDeployment,
} from "../db/repositories/deployment.repository";
import {
  createPublicationTarget,
  deletePublicationTarget,
  getDefaultPublicationTarget,
  listPublicationTargets,
  updatePublicationTarget,
  upsertDefaultPublicationTarget,
} from "../db/repositories/publication-target.repository";
import { isLicenseCenter } from "../services/deployment-role.service";
import { resolveReportChannel } from "../services/report-delivery.service";
import { saveSystemSetting } from "../services/system-settings.service";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const text = (v: unknown, name: string, min = 1, max = 256) => {
  if (typeof v !== "string") throw new Error(name + " 必须是字符串");
  const s = v.trim();
  if (s.length < min || s.length > max) throw new Error(name + " 长度无效");
  return s;
};
async function body(request: Request): Promise<Record<string, unknown>> {
  const value = await request.json().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求必须是 JSON 对象");
  return value as Record<string, unknown>;
}
function bearer(request: Request) {
  const v = request.headers.get("Authorization") ?? "";
  return v.startsWith("Bearer ") ? v.slice(7).trim() : "";
}
async function customerAuth(db: D1Database, b: Record<string, unknown>) {
  const licenseKey = text(b.licenseKey, "licenseKey", 20, 128);
  const installationId = text(b.installationId, "installationId", 6, 128);
  const appVersion = text(b.appVersion, "appVersion", 1, 64);
  const metadata =
    b.metadata && typeof b.metadata === "object" && !Array.isArray(b.metadata)
      ? (b.metadata as Record<string, unknown>)
      : {};
  let decision = await validateLicense(db, { licenseKey, installationId, appVersion, metadata });
  if (!decision.valid) decision = await activateLicense(db, { licenseKey, installationId, appVersion, metadata });
  if (!decision.valid || !decision.license) throw new Error("授权无效：" + decision.message);
  const license = await getSoftwareLicenseByPublicId(db, decision.license.publicId);
  if (!license) throw new Error("授权不存在");
  return { license, licenseKey, installationId, appVersion };
}

export async function handleControlApiRequest(
  request: Request,
  env: {
    DB: D1Database;
    LICENSE_ADMIN_TOKEN?: string;
    CONTROL_PLANE_RUNNER_TOKEN?: string;
    CONTROL_PLANE_RUNNER_SECRET?: string;
    DEPLOYMENT_ROLE?: string;
    CACHE?: KVNamespace | null;
    REPORT_CHANNEL_ID?: string | null;
  },
  auth: { isAdmin: boolean; userId: number | null },
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/control/")) return null;
  try {
    const b = request.method === "GET" ? {} : await body(request);
    const runnerToken = env.CONTROL_PLANE_RUNNER_TOKEN?.trim();
    const runnerAuth = Boolean(runnerToken && bearer(request) === runnerToken);
    if (url.pathname.startsWith("/api/control/runner/") && !runnerAuth)
      return json({ ok: false, error: "unauthorized" }, 401);
    const customerRoute = url.pathname.startsWith("/api/control/customer/");
    if (!url.pathname.startsWith("/api/control/runner/") && !customerRoute && !auth.isAdmin)
      return json({ ok: false, error: "forbidden" }, 403);
    if (url.pathname === "/api/control/provision" && request.method === "POST") {
      if (!isLicenseCenter(env)) return json({ ok: false, error: "vendor_only" }, 403);
      const runnerSecret = env.CONTROL_PLANE_RUNNER_SECRET?.trim() || env.CONTROL_PLANE_RUNNER_TOKEN?.trim();
      if (!runnerSecret)
        return json(
          {
            ok: false,
            error: "runner_secret_not_configured",
            message: "请先配置 CONTROL_PLANE_RUNNER_TOKEN（或 CONTROL_PLANE_RUNNER_SECRET）",
          },
          503,
        );
      const customerName = text(b.customerName, "customerName", 1, 200);
      const adminIds = text(b.adminIds, "adminIds", 1, 1000);
      if (adminIds.split(/[,\\s]+/).some((id) => !/^[1-9]\\d*$/.test(id)))
        return json({ ok: false, error: "invalid_admin_ids" }, 400);
      const botToken = text(b.botToken, "botToken", 20, 256);
      const usageDays = Number(b.usageDays ?? 30);
      if (!Number.isInteger(usageDays) || usageDays < 1 || usageDays > 36500)
        return json({ ok: false, error: "invalid_usage_days" }, 400);
      const maxActivations = Number(b.maxActivations ?? 1);
      if (!Number.isInteger(maxActivations) || maxActivations < 1 || maxActivations > 100)
        return json({ ok: false, error: "invalid_max_activations" }, 400);
      const workerNameRaw = typeof b.workerName === "string" ? b.workerName.trim() : "";
      const workerName =
        workerNameRaw ||
        "survey-" +
          customerName
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 32) +
          "-" +
          crypto.randomUUID().slice(0, 8);
      if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(workerName))
        return json({ ok: false, error: "invalid_worker_name" }, 400);
      const existingWorker = await env.DB.prepare("SELECT id FROM customer_deployments WHERE worker_name=? LIMIT 1")
        .bind(workerName)
        .first<{ id: number }>();
      if (existingWorker) return json({ ok: false, error: "worker_name_in_use" }, 409);
      const installationId = "install-" + crypto.randomUUID().replaceAll("-", "").slice(0, 24);
      const license = await createLicense(env.DB, {
        licenseType: "timed",
        usageDays,
        maxActivations,
        customerName,
        customerContact: typeof b.customerContact === "string" ? b.customerContact.trim().slice(0, 200) : null,
        notes: typeof b.notes === "string" ? b.notes.trim().slice(0, 1000) : "Web 控制中心一键部署",
        actorUserId: auth.userId,
      });
      const deployment = await upsertCustomerDeployment(env.DB, {
        licenseId: license.license.id,
        installationId,
        workerName,
        status: "pending" as never,
      });
      const accountId = typeof b.accountId === "string" ? b.accountId.trim() : "";
      const apiToken = typeof b.apiToken === "string" ? b.apiToken.trim() : "";
      const payloadJson = await encryptDeploymentTaskPayload(runnerSecret, {
        customerName,
        adminIds,
        botToken,
        licenseKey: license.licenseKey,
        licenseServerUrl: new URL(request.url).origin,
        workerName,
        installationId,
        accountId,
        apiToken,
        webhookSecret: typeof b.webhookSecret === "string" ? b.webhookSecret.trim() : "",
      });
      // Keep the account credentials for follow-up tasks. Without this an
      // `update` carried no payload, so the runner used its own wrangler login
      // and pushed a cross-account customer into the vendor's account.
      if (accountId && apiToken) {
        await setCustomerDeploymentCredentials(
          env.DB,
          deployment.id,
          await encryptDeploymentTaskPayload(runnerSecret, { accountId, apiToken }),
        );
      }
      const task = await createDeploymentTask(env.DB, {
        deploymentId: deployment.id,
        type: "deploy",
        requestedBy: auth.userId,
        payloadJson,
      });
      return json(
        {
          ok: true,
          license: {
            publicId: license.license.publicId,
            licenseKey: license.licenseKey,
            startsAt: license.license.startsAt,
            expiresAt: license.license.expiresAt,
          },
          deployment,
          task,
        },
        201,
      );
    }
    if (url.pathname === "/api/control/deployments" && request.method === "GET") {
      if (!isLicenseCenter(env)) return json({ ok: false, error: "vendor_only" }, 403);
      const publicId = typeof b.licensePublicId === "string" ? b.licensePublicId.trim() : undefined;
      const license = publicId ? await getSoftwareLicenseByPublicId(env.DB, publicId) : undefined;
      return json({ ok: true, items: await listCustomerDeployments(env.DB, license?.id) });
    }
    if (url.pathname === "/api/control/deployments" && request.method === "POST") {
      if (!isLicenseCenter(env)) return json({ ok: false, error: "vendor_only" }, 403);
      const license = await getSoftwareLicenseByPublicId(env.DB, text(b.licensePublicId, "licensePublicId", 6, 100));
      if (!license) return json({ ok: false, error: "license_not_found" }, 404);
      const workerName = text(b.workerName, "workerName", 1, 63);
      if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(workerName)) {
        return json({ ok: false, error: "invalid_worker_name" }, 400);
      }
      const deployment = await upsertCustomerDeployment(env.DB, {
        licenseId: license.id,
        installationId: text(b.installationId, "installationId", 6, 128),
        workerName,
        workerUrl: typeof b.workerUrl === "string" ? b.workerUrl.trim() : null,
        currentVersion: typeof b.currentVersion === "string" ? b.currentVersion.trim() : null,
      });
      return json({ ok: true, deployment }, 201);
    }
    const match = url.pathname.match(/^\/api\/control\/deployments\/(\d+)(?:\/(tasks|status|renew|remote-token))?$/);
    if (match) {
      if (!isLicenseCenter(env)) return json({ ok: false, error: "vendor_only" }, 403);
      const deploymentId = Number(match[1]);
      const deployment = await getCustomerDeployment(env.DB, deploymentId);
      if (!deployment) return json({ ok: false, error: "deployment_not_found" }, 404);
      if (!match[2] && request.method === "GET") return json({ ok: true, deployment });
      if (match[2] === "renew" && request.method === "POST") {
        const days = Number(b.days ?? 30);
        if (!Number.isInteger(days) || days < 1 || days > 36500)
          return json({ ok: false, error: "invalid_renew_days" }, 400);
        const license = await getSoftwareLicenseById(env.DB, deployment.licenseId);
        if (!license) return json({ ok: false, error: "license_not_found" }, 404);
        if (license.licenseType !== "timed") return json({ ok: false, error: "license_not_timed" }, 400);
        const nowMs = Date.now();
        const baseMs = Math.max(license.expiresAt ? new Date(license.expiresAt).getTime() : nowMs, nowMs);
        const expiresAt = new Date(baseMs + days * 86_400_000).toISOString();
        await updateSoftwareLicenseDates(env.DB, license.publicId, { expiresAt, updatesUntil: expiresAt });
        return json({ ok: true, expiresAt });
      }
      if (match[2] === "tasks" && request.method === "GET")
        return json({ ok: true, items: await listDeploymentTasks(env.DB, deploymentId) });
      if (match[2] === "remote-token" && request.method === "POST") {
        const runnerSecret = env.CONTROL_PLANE_RUNNER_SECRET?.trim() || env.CONTROL_PLANE_RUNNER_TOKEN?.trim();
        if (!runnerSecret) return json({ ok: false, error: "runner_secret_not_configured" }, 503);
        const stored = await getCustomerDeploymentRemoteSecret(env.DB, deploymentId);
        if (!stored)
          return json(
            {
              ok: false,
              error: "remote_access_not_configured",
              message: "该实例尚未上报只读访问密钥，请先完成一次心跳。",
            },
            409,
          );
        let secret = "";
        try {
          secret = String((await decryptDeploymentTaskPayload(runnerSecret, stored)).remoteAccessSecret ?? "");
        } catch (error) {
          console.error("Remote access secret decrypt failed", error);
          return json({ ok: false, error: "remote_secret_invalid" }, 500);
        }
        if (!secret) return json({ ok: false, error: "remote_access_not_configured" }, 409);
        const { token, expiresAt } = await signRemoteAccessToken(secret, { installationId: deployment.installationId });
        // Every mint is an audited access grant: who, which instance, until when.
        try {
          await createAuditLog(env.DB, {
            actorUserId: auth.userId,
            action: "customer_remote_access_granted",
            entityType: "customer_deployment",
            entityId: String(deploymentId),
            after: { installationId: deployment.installationId, workerName: deployment.workerName, expiresAt },
          });
        } catch (error) {
          console.error("Remote access audit log failed", error);
        }
        return json({
          ok: true,
          token,
          expiresAt,
          workerUrl: deployment.workerUrl,
          installationId: deployment.installationId,
        });
      }
      if (match[2] === "status" && request.method === "PATCH") {
        const status = b.status;
        if (!["pending", "deploying", "online", "offline", "disabled", "failed"].includes(String(status)))
          return json({ ok: false, error: "invalid_status" }, 400);
        return json({
          ok: true,
          deployment: await setDeploymentStatus(
            env.DB,
            deploymentId,
            status as never,
            typeof b.currentVersion === "string" ? b.currentVersion : null,
          ),
        });
      }
      if (!match[2] && request.method === "POST") {
        const type = String(b.type);
        if (!["deploy", "update", "rollback", "disable", "enable"].includes(type))
          return json({ ok: false, error: "invalid_task_type" }, 400);
        // Re-attach the stored (already encrypted) account credentials to any
        // task that redeploys the Worker, so the runner targets the customer's
        // own account instead of falling back to its wrangler login.
        const needsCredentials = type === "update" || type === "rollback" || type === "deploy";
        const storedCredentials = needsCredentials
          ? await getCustomerDeploymentCredentials(env.DB, deploymentId)
          : null;
        const task = await createDeploymentTask(env.DB, {
          deploymentId,
          type: type as never,
          targetVersion: typeof b.targetVersion === "string" ? b.targetVersion.trim() : null,
          requestedBy: auth.userId,
          payloadJson: storedCredentials,
        });
        return json({ ok: true, task }, 201);
      }
    }
    if (url.pathname === "/api/control/publication-targets" && request.method === "GET") {
      if (!isLicenseCenter(env)) return json({ ok: false, error: "vendor_only" }, 403);
      // 一个列表装两种用途：items 是「公开群 · 相册」（fan-out 到所有启用项），
      // archive 是「归档频道 · ZIP」（数据源仍是 report_channel_id / KV / 环境变量）。
      const archive = await resolveReportChannel(env);
      return json({
        ok: true,
        items: await listPublicationTargets(env.DB),
        defaultTarget: await getDefaultPublicationTarget(env.DB),
        archive: archive ? { name: "报告归档频道", chatId: String(archive.chatId), source: archive.source } : null,
      });
    }
    if (
      url.pathname === "/api/control/publication-targets/archive" &&
      (request.method === "PUT" || request.method === "POST")
    ) {
      if (!isLicenseCenter(env)) return json({ ok: false, error: "vendor_only" }, 403);
      const raw = typeof b.chatId === "string" || typeof b.chatId === "number" ? String(b.chatId).trim() : "";
      const chatId = Number(raw);
      if (!Number.isInteger(chatId) || chatId === 0) return json({ ok: false, error: "invalid_chat_id" }, 400);
      await saveSystemSetting(env.DB, "report_channel_id", String(chatId), auth.userId);
      return json({ ok: true, archive: { name: "报告归档频道", chatId: String(chatId), source: "settings" } });
    }
    if (
      url.pathname === "/api/control/publication-targets/default" &&
      (request.method === "PUT" || request.method === "POST")
    ) {
      if (!isLicenseCenter(env)) return json({ ok: false, error: "vendor_only" }, 403);
      const chatId = text(b.chatId, "chatId", 1, 64);
      const threadId = b.threadId === null || b.threadId === undefined ? null : Number(b.threadId);
      if (threadId !== null && (!Number.isInteger(threadId) || threadId <= 0))
        return json({ ok: false, error: "invalid_thread_id" }, 400);
      const target = await upsertDefaultPublicationTarget(env.DB, {
        name: text(b.name, "name", 1, 120),
        chatId,
        threadId,
      });
      return json({ ok: true, target });
    }
    const targetMatch = url.pathname.match(/^\/api\/control\/publication-targets\/(\d+)$/);
    if (targetMatch && request.method === "PATCH") {
      if (!isLicenseCenter(env)) return json({ ok: false, error: "vendor_only" }, 403);
      const id = Number(targetMatch[1]);
      const name = text(b.name, "name", 1, 120);
      const chatId = text(b.chatId, "chatId", 1, 64);
      const threadId = b.threadId === null || b.threadId === undefined ? null : Number(b.threadId);
      const enabled = b.enabled !== false;
      const isDefault = enabled && b.isDefault === true;
      if (threadId !== null && (!Number.isInteger(threadId) || threadId <= 0))
        return json({ ok: false, error: "invalid_thread_id" }, 400);
      const target = await updatePublicationTarget(env.DB, id, { name, chatId, threadId, enabled, isDefault });
      return target ? json({ ok: true, target }) : json({ ok: false, error: "target_not_found" }, 404);
    }
    if (targetMatch && request.method === "DELETE") {
      if (!isLicenseCenter(env)) return json({ ok: false, error: "vendor_only" }, 403);
      await deletePublicationTarget(env.DB, Number(targetMatch[1]));
      return json({ ok: true });
    }
    if (url.pathname === "/api/control/publication-targets" && request.method === "POST") {
      if (!isLicenseCenter(env)) return json({ ok: false, error: "vendor_only" }, 403);
      const chatId = text(b.chatId, "chatId", 1, 64);
      const threadId = b.threadId === null || b.threadId === undefined ? null : Number(b.threadId);
      if (threadId !== null && (!Number.isInteger(threadId) || threadId <= 0))
        return json({ ok: false, error: "invalid_thread_id" }, 400);
      const target = await createPublicationTarget(env.DB, {
        name: text(b.name, "name", 1, 120),
        chatId,
        threadId,
        enabled: b.enabled !== false,
        isDefault: b.isDefault === true,
      });
      return target ? json({ ok: true, target }, 201) : json({ ok: false, error: "target_create_failed" }, 500);
    }

    if (url.pathname === "/api/control/runner/tasks/claim" && request.method === "POST") {
      const task = await claimDeploymentTask(env.DB);
      if (!task) return json({ ok: true, task: null });
      let input: null | Record<string, unknown> = null;
      if (task.payloadJson) {
        try {
          input = await decryptDeploymentTaskPayload(
            env.CONTROL_PLANE_RUNNER_SECRET?.trim() || env.CONTROL_PLANE_RUNNER_TOKEN?.trim(),
            task.payloadJson,
          );
        } catch (error) {
          console.error("Deployment task payload decrypt failed", error);
          await finishDeploymentTask(env.DB, {
            taskId: task.id,
            status: "failed",
            errorMessage: "部署任务凭据解密失败",
          });
          return json({ ok: false, error: "deployment_task_secret_invalid" }, 500);
        }
      }
      return json({ ok: true, task: { ...task, payloadJson: undefined, input } });
    }
    const resultMatch = url.pathname.match(/^\/api\/control\/runner\/tasks\/(\d+)\/result$/);
    if (resultMatch && request.method === "POST") {
      const taskId = Number(resultMatch[1]);
      const status = b.status === "failed" ? "failed" : "succeeded";
      const result =
        b.result && typeof b.result === "object" && !Array.isArray(b.result)
          ? (b.result as Record<string, unknown>)
          : null;
      const task = await finishDeploymentTask(env.DB, {
        taskId,
        status,
        logText: typeof b.logText === "string" ? b.logText.slice(0, 20000) : null,
        result,
        errorMessage: typeof b.errorMessage === "string" ? b.errorMessage.slice(0, 2000) : null,
        currentVersion: typeof b.currentVersion === "string" ? b.currentVersion.trim() : null,
      });
      return task ? json({ ok: true, task }) : json({ ok: false, error: "task_not_found" }, 404);
    }

    if (url.pathname === "/api/control/customer/heartbeat" && request.method === "POST") {
      const a = await customerAuth(env.DB, b);
      const workerName = text(b.workerName, "workerName", 1, 63);
      if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(workerName)) {
        return json({ ok: false, error: "invalid_worker_name" }, 400);
      }
      const deployment = await upsertCustomerDeployment(env.DB, {
        licenseId: a.license.id,
        installationId: a.installationId,
        workerName,
        workerUrl: typeof b.workerUrl === "string" ? b.workerUrl.trim() : null,
        currentVersion: a.appVersion,
        metadata:
          b.metadata && typeof b.metadata === "object" && !Array.isArray(b.metadata)
            ? (b.metadata as Record<string, unknown>)
            : null,
      });
      // The instance reports the secret that signs its read-only tokens. Kept
      // encrypted; the vendor console never sees it, only tokens minted from it.
      const remoteAccessSecret = typeof b.remoteAccessSecret === "string" ? b.remoteAccessSecret.trim() : "";
      if (remoteAccessSecret.length >= 16 && remoteAccessSecret.length <= 256) {
        const runnerSecret = env.CONTROL_PLANE_RUNNER_SECRET?.trim() || env.CONTROL_PLANE_RUNNER_TOKEN?.trim();
        if (runnerSecret) {
          await setCustomerDeploymentRemoteSecret(
            env.DB,
            deployment.id,
            await encryptDeploymentTaskPayload(runnerSecret, { remoteAccessSecret }),
          );
        }
      }
      return json({ ok: true, deployment });
    }
    if (url.pathname === "/api/control/customer/publication-target" && request.method === "POST") {
      const a = await customerAuth(env.DB, b);
      const target = await getDefaultPublicationTarget(env.DB);
      if (!target) return json({ ok: false, error: "publication_target_not_configured" }, 503);
      return json({ ok: true, target: { id: target.id, chatId: target.chatId, threadId: target.threadId } });
    }
    return json({ ok: false, error: "not_found" }, 404);
  } catch (error) {
    console.error("Control API failed", error);
    return json(
      { ok: false, error: "invalid_request", message: error instanceof Error ? error.message : "请求处理失败" },
      400,
    );
  }
}

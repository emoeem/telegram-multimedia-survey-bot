import { createLicense } from "../../services/license.service";
import { WriteContext, readString, writeAudit } from "./helpers";
import { Env } from "../../index";
import {
  listLicenseActivations,
  listSoftwareLicenses,
  listSoftwareReleases,
} from "../../db/repositories/license.repository";
import {
  createSoftwareRelease,
  updateSoftwareLicenseDates,
  updateSoftwareLicenseStatus,
} from "../../db/repositories/license.repository";
import {
  grantCreatorTrial,
  listActiveCreatorTrials,
  revokeCreatorTrial,
} from "../../db/repositories/creator-trial.repository";

export async function handleAdminLicensesWrite(
  request: Request,
  url: URL,
  env: Env,
  ctx: WriteContext,
  body: Record<string, unknown>,
): Promise<Response | null> {
  const { user, isAdmin, fail, json } = ctx;
  const db = env.DB;

  // ---- 授权管理（仅管理员） --------------------------------------------
  if (url.pathname === "/api/admin/licenses" && request.method === "GET") {
    if (!isAdmin) return fail(403, "forbidden", "仅管理员可管理授权");
    const licenses = await listSoftwareLicenses(db, 100);
    const items = await Promise.all(
      licenses.map(async (license) => {
        const activations = await listLicenseActivations(db, license.id);
        return {
          publicId: license.publicId,
          customerName: license.customerName,
          customerContact: license.customerContact,
          licenseType: license.licenseType,
          status: license.status,
          startsAt: license.startsAt,
          expiresAt: license.expiresAt,
          updatesUntil: license.updatesUntil,
          maxActivations: license.maxActivations,
          notes: license.notes,
          createdAt: license.createdAt,
          revokedAt: license.revokedAt,
          activationCount: activations.filter((item) => !item.deactivatedAt).length,
          activations: activations.slice(0, 20).map((item) => ({
            installationId: item.installationId,
            installationName: item.installationName,
            appVersion: item.appVersion,
            firstSeenAt: item.firstSeenAt,
            lastSeenAt: item.lastSeenAt,
            deactivatedAt: item.deactivatedAt,
          })),
        };
      }),
    );
    return json({ items });
  }

  if (url.pathname === "/api/admin/licenses" && request.method === "POST") {
    if (!isAdmin) return fail(403, "forbidden", "仅管理员可管理授权");
    const customerNameError =
      body.customerName === undefined || body.customerName === null
        ? null
        : readString(body.customerName, "客户名称", 200);
    if (customerNameError) return fail(400, "validation_failed", customerNameError);
    const customerContactError =
      body.customerContact === undefined || body.customerContact === null
        ? null
        : readString(body.customerContact, "客户联系方式", 200);
    if (customerContactError) return fail(400, "validation_failed", customerContactError);
    const notesError =
      body.notes === undefined || body.notes === null ? null : readString(body.notes, "授权备注", 1000);
    if (notesError) return fail(400, "validation_failed", notesError);
    const licenseType = body.licenseType === "perpetual" ? "perpetual" : "timed";
    const maxActivations = Number(body.maxActivations ?? 1);
    if (!Number.isInteger(maxActivations) || maxActivations < 1 || maxActivations > 100) {
      return fail(400, "validation_failed", "激活数上限必须是 1-100 的整数");
    }
    const toDays = (value: unknown, label: string): number | undefined => {
      if (value === undefined || value === null || value === "") return undefined;
      const days = Number(value);
      if (!Number.isInteger(days) || days < 1 || days > 36_500) {
        throw new Error(`${label}必须是 1-36500 的整数`);
      }
      return days;
    };
    try {
      const licenseInput: Parameters<typeof createLicense>[1] = {
        licenseType,
        maxActivations,
        customerName:
          body.customerName === undefined || body.customerName === null ? null : String(body.customerName).trim(),
        customerContact:
          body.customerContact === undefined || body.customerContact === null
            ? null
            : String(body.customerContact).trim(),
        notes: body.notes === undefined || body.notes === null ? null : String(body.notes).trim(),
        actorUserId: user.id,
      };
      if (licenseType === "timed") {
        licenseInput.usageDays = toDays(body.usageDays, "使用天数") ?? 365;
      } else {
        licenseInput.updateDays = toDays(body.updateDays, "升级天数") ?? null;
      }
      const created = await createLicense(db, licenseInput);
      await writeAudit(db, {
        actorUserId: user.id,
        action: "license.create",
        entityType: "license",
        entityId: created.license.publicId,
        after: { customerName: created.license.customerName, licenseType },
      });
      return Response.json(
        { license: created.license, licenseKey: created.licenseKey },
        { status: 201, headers: { "Cache-Control": "no-store" } },
      );
    } catch (error) {
      return fail(400, "validation_failed", error instanceof Error ? error.message : "签发授权失败");
    }
  }

  const licenseDetailMatch = url.pathname.match(/^\/api\/admin\/licenses\/([A-Za-z0-9-]+)$/);
  if (request.method === "PATCH" && licenseDetailMatch) {
    if (!isAdmin) return fail(403, "forbidden", "仅管理员可管理授权");
    const publicId = licenseDetailMatch[1] ?? "";
    const current = await listSoftwareLicenses(db, 100);
    const license = current.find((item) => item.publicId === publicId);
    if (!license) return fail(404, "not_found", "授权不存在");
    if (body.status !== undefined) {
      if (!["active", "suspended", "revoked"].includes(String(body.status))) {
        return fail(400, "validation_failed", "授权状态无效");
      }
      await updateSoftwareLicenseStatus(db, publicId, String(body.status) as "active" | "suspended" | "revoked");
    }
    if (body.extendUsageDays !== undefined || body.extendUpdateDays !== undefined) {
      const extendUsage = body.extendUsageDays === undefined ? 0 : Number(body.extendUsageDays);
      const extendUpdates = body.extendUpdateDays === undefined ? 0 : Number(body.extendUpdateDays);
      if (
        !Number.isInteger(extendUsage) ||
        extendUsage < 0 ||
        extendUsage > 36_500 ||
        !Number.isInteger(extendUpdates) ||
        extendUpdates < 0 ||
        extendUpdates > 36_500
      ) {
        return fail(400, "validation_failed", "延期天数必须是 0-36500 的整数");
      }
      const addDays = (value: string | null, days: number): string | null => {
        if (days <= 0) return value;
        const base = value ? new Date(value).getTime() : Date.now();
        return new Date(base + days * 86_400_000).toISOString();
      };
      await updateSoftwareLicenseDates(db, publicId, {
        expiresAt: addDays(license.expiresAt, extendUsage),
        updatesUntil: addDays(license.updatesUntil, extendUpdates),
      });
    }
    await writeAudit(db, {
      actorUserId: user.id,
      action: "license.update",
      entityType: "license",
      entityId: publicId,
      after: { status: body.status, extendUsageDays: body.extendUsageDays, extendUpdateDays: body.extendUpdateDays },
    });
    return json({ ok: true });
  }

  if (url.pathname === "/api/admin/releases" && request.method === "GET") {
    if (!isAdmin) return fail(403, "forbidden", "仅管理员可管理版本");
    return json({ items: await listSoftwareReleases(db, 50) });
  }

  if (url.pathname === "/api/admin/releases" && request.method === "POST") {
    if (!isAdmin) return fail(403, "forbidden", "仅管理员可管理版本");
    const version = body.version === undefined ? "" : String(body.version).trim();
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) {
      return fail(400, "validation_failed", "版本号格式无效（应为 x.y.z）");
    }
    const notes = body.notes === undefined || body.notes === null ? null : String(body.notes).trim();
    const release = await createSoftwareRelease(db, {
      version,
      releasedAt: new Date().toISOString(),
      channel: body.channel === undefined ? "stable" : String(body.channel).trim(),
      ...(notes ? { notes } : {}),
    });
    await writeAudit(db, {
      actorUserId: user.id,
      action: "release.register",
      entityType: "release",
      entityId: release.version,
      after: { channel: release.channel },
    });
    return Response.json({ release }, { status: 201, headers: { "Cache-Control": "no-store" } });
  }

  // ---- 体验创作者试用管理（仅管理员） ----------------------------------
  if (url.pathname === "/api/admin/trials" && request.method === "GET") {
    if (!isAdmin) return fail(403, "forbidden", "仅管理员可管理试用");
    const trials = await listActiveCreatorTrials(db, 100);
    return json({
      items: trials.map((trial) => ({
        userId: trial.userId,
        telegramUserId: trial.user.telegramUserId,
        username: trial.user.username,
        firstName: trial.user.firstName,
        lastName: trial.user.lastName,
        expiresAt: trial.expiresAt,
        grantedAt: trial.createdAt,
      })),
    });
  }

  const trialMatch = url.pathname.match(/^\/api\/admin\/users\/(\d+)\/trial$/);
  if (trialMatch) {
    if (!isAdmin) return fail(403, "forbidden", "仅管理员可管理试用");
    const targetUserId = Number(trialMatch[1]);
    if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
      return fail(400, "validation_failed", "用户 ID 无效");
    }
    if (request.method === "POST") {
      const days = Number(body.days ?? 30);
      if (!Number.isInteger(days) || days < 1 || days > 36_500) {
        return fail(400, "validation_failed", "试用天数必须是 1-36500 的整数");
      }
      const grant = await grantCreatorTrial(db, {
        userId: targetUserId,
        grantedBy: user.id,
        days,
      });
      await writeAudit(db, {
        actorUserId: user.id,
        action: "trial.grant",
        entityType: "user",
        entityId: String(targetUserId),
        after: { expiresAt: grant.expiresAt },
      });
      return json({ expiresAt: grant.expiresAt });
    }
    if (request.method === "DELETE") {
      await revokeCreatorTrial(db, targetUserId);
      await writeAudit(db, {
        actorUserId: user.id,
        action: "trial.revoke",
        entityType: "user",
        entityId: String(targetUserId),
      });
      return json({ ok: true });
    }
  }

  return null;
}

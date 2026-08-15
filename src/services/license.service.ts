import type {
  SoftwareLicense,
  SoftwareLicenseStatus,
  SoftwareLicenseType,
  SoftwareRelease,
} from "../db/schema";
import { createAuditLog } from "../db/repositories/audit.repository";
import {
  claimLicenseActivation,
  createSoftwareLicense,
  createSoftwareRelease,
  deactivateLicenseActivation,
  getLicenseActivation,
  getSoftwareLicenseByKeyHash,
  getSoftwareLicenseByPublicId,
  getSoftwareReleaseByVersion,
  listLicenseActivations,
  listSoftwareLicenses,
  listSoftwareReleases,
  touchLicenseActivation,
  updateSoftwareLicenseDates,
  updateSoftwareLicenseStatus,
} from "../db/repositories/license.repository";

const LICENSE_KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export type LicenseDecisionCode =
  | "valid"
  | "license_not_found"
  | "license_not_started"
  | "license_expired"
  | "license_suspended"
  | "license_revoked"
  | "version_invalid"
  | "version_not_registered"
  | "updates_expired"
  | "activation_limit_reached"
  | "activation_not_found"
  | "activation_deactivated";

export interface PublicLicenseInfo {
  publicId: string;
  licenseType: SoftwareLicenseType;
  status: SoftwareLicenseStatus;
  startsAt: string;
  expiresAt: string | null;
  updatesUntil: string | null;
  maxActivations: number;
}

export interface LicenseDecision {
  valid: boolean;
  code: LicenseDecisionCode;
  message: string;
  checkedAt: string;
  license: PublicLicenseInfo | null;
  release: {
    version: string;
    releasedAt: string;
  } | null;
}

export interface LicenseActivationDecision extends LicenseDecision {
  activation: {
    installationId: string;
    active: boolean;
    firstSeenAt: string;
    lastSeenAt: string;
  } | null;
}

function randomCharacters(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(
    bytes,
    (byte) => LICENSE_KEY_ALPHABET[byte % LICENSE_KEY_ALPHABET.length],
  ).join("");
}

function parseDate(value: string | null): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

function assertPositiveDays(days: number, field: string): void {
  if (!Number.isInteger(days) || days <= 0 || days > 36_500) {
    throw new Error(`${field}必须是 1 到 36500 之间的整数`);
  }
}

function assertMaxActivations(value: number): void {
  if (!Number.isInteger(value) || value <= 0 || value > 1000) {
    throw new Error("激活数量必须是 1 到 1000 之间的整数");
  }
}

export function normalizeSoftwareVersion(version: string): string | null {
  const normalized = version.trim().replace(/^v/i, "");
  return VERSION_PATTERN.test(normalized) ? normalized : null;
}

export function generateLicenseKey(): string {
  return `TSB-${randomCharacters(5)}-${randomCharacters(5)}-${randomCharacters(5)}-${randomCharacters(5)}`;
}

export function generateLicensePublicId(now = new Date()): string {
  const date = [
    String(now.getUTCFullYear()).slice(-2),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
  ].join("");
  return `LIC-${date}-${randomCharacters(8)}`;
}

export async function hashLicenseKey(licenseKey: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(licenseKey.trim().toUpperCase()),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function toPublicLicense(license: SoftwareLicense): PublicLicenseInfo {
  return {
    publicId: license.publicId,
    licenseType: license.licenseType,
    status: license.status,
    startsAt: license.startsAt,
    expiresAt: license.expiresAt,
    updatesUntil: license.updatesUntil,
    maxActivations: license.maxActivations,
  };
}

function auditLicense(license: SoftwareLicense): Record<string, unknown> {
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
  };
}

function invalidDecision(
  code: LicenseDecisionCode,
  message: string,
  checkedAt: string,
  license: SoftwareLicense | null,
  release: LicenseDecision["release"] = null,
): LicenseDecision {
  return {
    valid: false,
    code,
    message,
    checkedAt,
    license: license ? toPublicLicense(license) : null,
    release,
  };
}

export async function evaluateSoftwareLicense(
  db: D1Database,
  license: SoftwareLicense | null,
  appVersion: string,
  now = new Date(),
): Promise<LicenseDecision> {
  const checkedAt = now.toISOString();
  if (!license) {
    return invalidDecision(
      "license_not_found",
      "授权密钥不存在",
      checkedAt,
      null,
    );
  }
  if (license.status === "revoked") {
    return invalidDecision(
      "license_revoked",
      "授权已被永久吊销",
      checkedAt,
      license,
    );
  }
  if (license.status === "suspended") {
    return invalidDecision(
      "license_suspended",
      "授权已暂停",
      checkedAt,
      license,
    );
  }

  const nowTimestamp = now.getTime();
  const startsAt = parseDate(license.startsAt);
  if (startsAt === null || startsAt > nowTimestamp) {
    return invalidDecision(
      "license_not_started",
      "授权尚未生效",
      checkedAt,
      license,
    );
  }
  const expiresAt = parseDate(license.expiresAt);
  if (
    license.licenseType === "timed" &&
    (expiresAt === null || expiresAt <= nowTimestamp)
  ) {
    return invalidDecision(
      "license_expired",
      "授权使用期限已到期",
      checkedAt,
      license,
    );
  }

  const version = normalizeSoftwareVersion(appVersion);
  if (!version) {
    return invalidDecision(
      "version_invalid",
      "软件版本号格式无效",
      checkedAt,
      license,
    );
  }
  const release = await getSoftwareReleaseByVersion(db, version);
  if (!release) {
    return invalidDecision(
      "version_not_registered",
      `版本 ${version} 尚未在授权中心登记`,
      checkedAt,
      license,
    );
  }

  const updatesUntil = parseDate(license.updatesUntil);
  const releasedAt = parseDate(release.releasedAt);
  if (
    updatesUntil !== null &&
    (releasedAt === null || releasedAt > updatesUntil)
  ) {
    return invalidDecision(
      "updates_expired",
      `当前授权不包含版本 ${version} 的升级权益`,
      checkedAt,
      license,
      release,
    );
  }

  return {
    valid: true,
    code: "valid",
    message: "授权有效",
    checkedAt,
    license: toPublicLicense(license),
    release: { version: release.version, releasedAt: release.releasedAt },
  };
}

export async function createLicense(
  db: D1Database,
  input: {
    licenseType: SoftwareLicenseType;
    usageDays?: number;
    updateDays?: number | null;
    maxActivations: number;
    customerName?: string | null;
    customerContact?: string | null;
    notes?: string | null;
    actorUserId?: number | null;
    now?: Date;
  },
): Promise<{ license: SoftwareLicense; licenseKey: string }> {
  assertMaxActivations(input.maxActivations);
  if ((input.customerName?.length ?? 0) > 200) {
    throw new Error("客户名称不能超过 200 个字符");
  }
  if ((input.customerContact?.length ?? 0) > 200) {
    throw new Error("客户联系方式不能超过 200 个字符");
  }
  if ((input.notes?.length ?? 0) > 1000) {
    throw new Error("授权备注不能超过 1000 个字符");
  }
  const now = input.now ?? new Date();
  let expiresAt: string | null = null;
  let updatesUntil: string | null = null;

  if (input.licenseType === "timed") {
    if (input.usageDays === undefined) {
      throw new Error("限时授权必须提供使用天数");
    }
    assertPositiveDays(input.usageDays, "使用天数");
    expiresAt = addDays(now, input.usageDays).toISOString();
    updatesUntil = expiresAt;
  } else if (input.updateDays !== null) {
    if (input.updateDays === undefined) {
      throw new Error("永久授权必须提供升级天数或 forever");
    }
    assertPositiveDays(input.updateDays, "升级天数");
    updatesUntil = addDays(now, input.updateDays).toISOString();
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const licenseKey = generateLicenseKey();
    const licenseKeyHash = await hashLicenseKey(licenseKey);
    const publicId = generateLicensePublicId(now);
    const existingPublicId = await getSoftwareLicenseByPublicId(db, publicId);
    const existingKey = await getSoftwareLicenseByKeyHash(db, licenseKeyHash);
    if (existingPublicId || existingKey) continue;

    const license = await createSoftwareLicense(db, {
      publicId,
      licenseKeyHash,
      customerName: input.customerName ?? null,
      customerContact: input.customerContact ?? null,
      licenseType: input.licenseType,
      startsAt: now.toISOString(),
      expiresAt,
      updatesUntil,
      maxActivations: input.maxActivations,
      notes: input.notes ?? null,
      createdBy: input.actorUserId ?? null,
    });
    await createAuditLog(db, {
      actorUserId: input.actorUserId ?? null,
      action: "software_license.created",
      entityType: "software_license",
      entityId: license.publicId,
      after: auditLicense(license),
    });
    return { license, licenseKey };
  }

  throw new Error("生成唯一授权编号失败，请重试");
}

async function getLicenseByKey(
  db: D1Database,
  licenseKey: string,
): Promise<SoftwareLicense | null> {
  if (!licenseKey.trim()) return null;
  return getSoftwareLicenseByKeyHash(db, await hashLicenseKey(licenseKey));
}

function withActivation(
  decision: LicenseDecision,
  activation: LicenseActivationDecision["activation"],
): LicenseActivationDecision {
  return { ...decision, activation };
}

export async function activateLicense(
  db: D1Database,
  input: {
    licenseKey: string;
    installationId: string;
    installationName?: string | null;
    appVersion: string;
    metadata?: unknown;
    now?: Date;
  },
): Promise<LicenseActivationDecision> {
  const license = await getLicenseByKey(db, input.licenseKey);
  const decision = await evaluateSoftwareLicense(
    db,
    license,
    input.appVersion,
    input.now,
  );
  if (!decision.valid || !license) {
    return withActivation(decision, null);
  }

  const existing = await getLicenseActivation(
    db,
    license.id,
    input.installationId,
  );
  const metadataJson =
    input.metadata === undefined ? null : JSON.stringify(input.metadata);
  const activation = await claimLicenseActivation(db, {
    licenseId: license.id,
    installationId: input.installationId,
    installationName: input.installationName ?? null,
    appVersion: normalizeSoftwareVersion(input.appVersion),
    metadataJson,
  });
  if (!activation) {
    return withActivation(
      invalidDecision(
        "activation_limit_reached",
        `激活数量已达到上限 ${license.maxActivations}`,
        decision.checkedAt,
        license,
        decision.release,
      ),
      null,
    );
  }
  if (!existing || existing.deactivatedAt) {
    await createAuditLog(db, {
      action: existing
        ? "software_license.activation_reactivated"
        : "software_license.activation_created",
      entityType: "software_license",
      entityId: license.publicId,
      after: {
        installationId: input.installationId,
        installationName: input.installationName ?? null,
        appVersion: normalizeSoftwareVersion(input.appVersion),
      },
    });
  }
  return withActivation(decision, {
    installationId: activation.installationId,
    active: activation.deactivatedAt === null,
    firstSeenAt: activation.firstSeenAt,
    lastSeenAt: activation.lastSeenAt,
  });
}

export async function validateLicense(
  db: D1Database,
  input: {
    licenseKey: string;
    installationId: string;
    installationName?: string | null;
    appVersion: string;
    metadata?: unknown;
    now?: Date;
  },
): Promise<LicenseActivationDecision> {
  const license = await getLicenseByKey(db, input.licenseKey);
  const decision = await evaluateSoftwareLicense(
    db,
    license,
    input.appVersion,
    input.now,
  );
  if (!decision.valid || !license) {
    return withActivation(decision, null);
  }
  const activation = await getLicenseActivation(
    db,
    license.id,
    input.installationId,
  );
  if (!activation) {
    return withActivation(
      invalidDecision(
        "activation_not_found",
        "当前安装尚未激活",
        decision.checkedAt,
        license,
      ),
      null,
    );
  }
  if (activation.deactivatedAt) {
    return withActivation(
      invalidDecision(
        "activation_deactivated",
        "当前安装已停用",
        decision.checkedAt,
        license,
      ),
      {
        installationId: activation.installationId,
        active: false,
        firstSeenAt: activation.firstSeenAt,
        lastSeenAt: activation.lastSeenAt,
      },
    );
  }

  const touched = await touchLicenseActivation(db, {
    licenseId: license.id,
    installationId: input.installationId,
    installationName: input.installationName ?? null,
    appVersion: normalizeSoftwareVersion(input.appVersion),
    metadataJson:
      input.metadata === undefined ? null : JSON.stringify(input.metadata),
  });
  return withActivation(decision, {
    installationId: activation.installationId,
    active: true,
    firstSeenAt: activation.firstSeenAt,
    lastSeenAt: touched?.lastSeenAt ?? activation.lastSeenAt,
  });
}

export async function deactivateLicense(
  db: D1Database,
  input: {
    licenseKey: string;
    installationId: string;
  },
): Promise<boolean> {
  const license = await getLicenseByKey(db, input.licenseKey);
  if (!license) return false;
  const activation = await getLicenseActivation(
    db,
    license.id,
    input.installationId,
  );
  if (!activation || activation.deactivatedAt) return false;
  await deactivateLicenseActivation(db, license.id, input.installationId);
  await createAuditLog(db, {
    action: "software_license.activation_deactivated",
    entityType: "software_license",
    entityId: license.publicId,
    before: {
      installationId: input.installationId,
      active: true,
    },
    after: {
      installationId: input.installationId,
      active: false,
    },
  });
  return true;
}

export async function deactivateLicenseInstallation(
  db: D1Database,
  publicId: string,
  installationId: string,
  actorUserId?: number | null,
): Promise<void> {
  const license = await getSoftwareLicenseByPublicId(db, publicId);
  if (!license) throw new Error("授权不存在");
  const activation = await getLicenseActivation(
    db,
    license.id,
    installationId,
  );
  if (!activation) throw new Error("激活设备不存在");
  if (activation.deactivatedAt) throw new Error("该设备已经停用");
  await deactivateLicenseActivation(db, license.id, installationId);
  await createAuditLog(db, {
    actorUserId: actorUserId ?? null,
    action: "software_license.activation_deactivated_by_admin",
    entityType: "software_license",
    entityId: license.publicId,
    before: {
      installationId,
      active: true,
    },
    after: {
      installationId,
      active: false,
    },
  });
}

export async function setLicenseStatus(
  db: D1Database,
  publicId: string,
  status: SoftwareLicenseStatus,
  actorUserId?: number | null,
): Promise<SoftwareLicense> {
  const before = await getSoftwareLicenseByPublicId(db, publicId);
  if (!before) throw new Error("授权不存在");
  if (before.status === "revoked" && status !== "revoked") {
    throw new Error("已吊销的授权不能恢复");
  }
  const after = await updateSoftwareLicenseStatus(db, publicId, status);
  if (!after) throw new Error("更新授权状态失败");
  await createAuditLog(db, {
    actorUserId: actorUserId ?? null,
    action: `software_license.${status}`,
    entityType: "software_license",
    entityId: publicId,
    before: auditLicense(before),
    after: auditLicense(after),
  });
  return after;
}

export async function extendTimedLicense(
  db: D1Database,
  publicId: string,
  days: number,
  actorUserId?: number | null,
  now = new Date(),
): Promise<SoftwareLicense> {
  assertPositiveDays(days, "延期天数");
  const before = await getSoftwareLicenseByPublicId(db, publicId);
  if (!before) throw new Error("授权不存在");
  if (before.licenseType !== "timed") {
    throw new Error("只有限时授权可以延长使用期限");
  }
  const currentExpires = parseDate(before.expiresAt) ?? now.getTime();
  const base = Math.max(currentExpires, now.getTime());
  const expiresAt = addDays(new Date(base), days).toISOString();
  const currentUpdates = parseDate(before.updatesUntil);
  const updatesUntil =
    before.updatesUntil === null
      ? null
      : addDays(
          new Date(Math.max(currentUpdates ?? base, now.getTime())),
          days,
        ).toISOString();
  const after = await updateSoftwareLicenseDates(db, publicId, {
    expiresAt,
    updatesUntil,
  });
  if (!after) throw new Error("延期失败");
  await createAuditLog(db, {
    actorUserId: actorUserId ?? null,
    action: "software_license.extended",
    entityType: "software_license",
    entityId: publicId,
    before: auditLicense(before),
    after: auditLicense(after),
  });
  return after;
}

export async function extendLicenseUpdates(
  db: D1Database,
  publicId: string,
  days: number | null,
  actorUserId?: number | null,
  now = new Date(),
): Promise<SoftwareLicense> {
  if (days !== null) assertPositiveDays(days, "升级天数");
  const before = await getSoftwareLicenseByPublicId(db, publicId);
  if (!before) throw new Error("授权不存在");
  const currentUpdates = parseDate(before.updatesUntil) ?? now.getTime();
  const updatesUntil =
    days === null || before.updatesUntil === null
      ? null
      : addDays(
          new Date(Math.max(currentUpdates, now.getTime())),
          days,
        ).toISOString();
  const after = await updateSoftwareLicenseDates(db, publicId, {
    expiresAt: before.expiresAt,
    updatesUntil,
  });
  if (!after) throw new Error("更新升级权益失败");
  await createAuditLog(db, {
    actorUserId: actorUserId ?? null,
    action: "software_license.updates_extended",
    entityType: "software_license",
    entityId: publicId,
    before: auditLicense(before),
    after: auditLicense(after),
  });
  return after;
}

export async function registerSoftwareRelease(
  db: D1Database,
  input: {
    version: string;
    releasedAt: string;
    actorUserId?: number | null;
  },
): Promise<SoftwareRelease> {
  const version = normalizeSoftwareVersion(input.version);
  if (!version) throw new Error("版本号必须是 SemVer，例如 0.2.0");
  const releasedAt = new Date(input.releasedAt);
  if (!Number.isFinite(releasedAt.getTime())) {
    throw new Error("发布日期无效");
  }
  const release = await createSoftwareRelease(db, {
    version,
    releasedAt: releasedAt.toISOString(),
  });
  await createAuditLog(db, {
    actorUserId: input.actorUserId ?? null,
    action: "software_release.registered",
    entityType: "software_release",
    entityId: version,
    after: {
      version: release.version,
      releasedAt: release.releasedAt,
      channel: release.channel,
    },
  });
  return release;
}

export {
  getSoftwareLicenseByPublicId,
  listLicenseActivations,
  listSoftwareLicenses,
  listSoftwareReleases,
};

import type {
  SoftwareLicense,
  SoftwareLicenseActivation,
  SoftwareLicenseStatus,
  SoftwareLicenseType,
  SoftwareRelease,
} from "../schema";

interface LicenseRow {
  id: number;
  public_id: string;
  license_key_hash: string;
  customer_name: string | null;
  customer_contact: string | null;
  license_type: SoftwareLicenseType;
  status: SoftwareLicenseStatus;
  starts_at: string;
  expires_at: string | null;
  updates_until: string | null;
  max_activations: number;
  notes: string | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
}

interface ActivationRow {
  id: number;
  license_id: number;
  installation_id: string;
  installation_name: string | null;
  app_version: string | null;
  metadata_json: string | null;
  first_seen_at: string;
  last_seen_at: string;
  deactivated_at: string | null;
}

interface ReleaseRow {
  id: number;
  version: string;
  channel: string;
  released_at: string;
  minimum_version: string | null;
  download_url: string | null;
  checksum_sha256: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

function mapLicense(row: LicenseRow): SoftwareLicense {
  return {
    id: row.id,
    publicId: row.public_id,
    licenseKeyHash: row.license_key_hash,
    customerName: row.customer_name,
    customerContact: row.customer_contact,
    licenseType: row.license_type,
    status: row.status,
    startsAt: row.starts_at,
    expiresAt: row.expires_at,
    updatesUntil: row.updates_until,
    maxActivations: row.max_activations,
    notes: row.notes,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at,
  };
}

function mapActivation(row: ActivationRow): SoftwareLicenseActivation {
  return {
    id: row.id,
    licenseId: row.license_id,
    installationId: row.installation_id,
    installationName: row.installation_name,
    appVersion: row.app_version,
    metadataJson: row.metadata_json,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    deactivatedAt: row.deactivated_at,
  };
}

function mapRelease(row: ReleaseRow): SoftwareRelease {
  return {
    id: row.id,
    version: row.version,
    channel: row.channel,
    releasedAt: row.released_at,
    minimumVersion: row.minimum_version,
    downloadUrl: row.download_url,
    checksumSha256: row.checksum_sha256,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createSoftwareLicense(
  db: D1Database,
  input: {
    publicId: string;
    licenseKeyHash: string;
    customerName?: string | null;
    customerContact?: string | null;
    licenseType: SoftwareLicenseType;
    startsAt: string;
    expiresAt?: string | null;
    updatesUntil?: string | null;
    maxActivations: number;
    notes?: string | null;
    createdBy?: number | null;
  },
): Promise<SoftwareLicense> {
  const timestamp = new Date().toISOString();
  const result = await db
    .prepare(
      `INSERT INTO software_licenses (
        public_id, license_key_hash, customer_name, customer_contact,
        license_type, status, starts_at, expires_at, updates_until,
        max_activations, notes, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.publicId,
      input.licenseKeyHash,
      input.customerName ?? null,
      input.customerContact ?? null,
      input.licenseType,
      input.startsAt,
      input.expiresAt ?? null,
      input.updatesUntil ?? null,
      input.maxActivations,
      input.notes ?? null,
      input.createdBy ?? null,
      timestamp,
      timestamp,
    )
    .run();

  const id = result.meta?.last_row_id;
  if (typeof id !== "number") {
    throw new Error("创建许可证失败");
  }
  const license = await getSoftwareLicenseById(db, id);
  if (!license) {
    throw new Error("读取新许可证失败");
  }
  return license;
}

export async function getSoftwareLicenseById(
  db: D1Database,
  id: number,
): Promise<SoftwareLicense | null> {
  const row = await db
    .prepare("SELECT * FROM software_licenses WHERE id = ? LIMIT 1")
    .bind(id)
    .first<LicenseRow>();
  return row ? mapLicense(row) : null;
}

export async function getSoftwareLicenseByPublicId(
  db: D1Database,
  publicId: string,
): Promise<SoftwareLicense | null> {
  const row = await db
    .prepare("SELECT * FROM software_licenses WHERE public_id = ? LIMIT 1")
    .bind(publicId)
    .first<LicenseRow>();
  return row ? mapLicense(row) : null;
}

export async function getSoftwareLicenseByKeyHash(
  db: D1Database,
  licenseKeyHash: string,
): Promise<SoftwareLicense | null> {
  const row = await db
    .prepare(
      "SELECT * FROM software_licenses WHERE license_key_hash = ? LIMIT 1",
    )
    .bind(licenseKeyHash)
    .first<LicenseRow>();
  return row ? mapLicense(row) : null;
}

export async function listSoftwareLicenses(
  db: D1Database,
  limit = 30,
): Promise<SoftwareLicense[]> {
  const result = await db
    .prepare(
      `SELECT * FROM software_licenses
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .bind(Math.max(1, Math.min(100, Math.floor(limit))))
    .all<LicenseRow>();
  return (result.results ?? []).map(mapLicense);
}

export async function updateSoftwareLicenseStatus(
  db: D1Database,
  publicId: string,
  status: SoftwareLicenseStatus,
): Promise<SoftwareLicense | null> {
  const timestamp = new Date().toISOString();
  await db
    .prepare(
      `UPDATE software_licenses
       SET status = ?, updated_at = ?,
           revoked_at = CASE WHEN ? = 'revoked' THEN ? ELSE revoked_at END
       WHERE public_id = ?`,
    )
    .bind(status, timestamp, status, timestamp, publicId)
    .run();
  return getSoftwareLicenseByPublicId(db, publicId);
}

export async function updateSoftwareLicenseDates(
  db: D1Database,
  publicId: string,
  input: {
    expiresAt: string | null;
    updatesUntil: string | null;
  },
): Promise<SoftwareLicense | null> {
  await db
    .prepare(
      `UPDATE software_licenses
       SET expires_at = ?, updates_until = ?, updated_at = ?
       WHERE public_id = ?`,
    )
    .bind(
      input.expiresAt,
      input.updatesUntil,
      new Date().toISOString(),
      publicId,
    )
    .run();
  return getSoftwareLicenseByPublicId(db, publicId);
}

export async function getLicenseActivation(
  db: D1Database,
  licenseId: number,
  installationId: string,
): Promise<SoftwareLicenseActivation | null> {
  const row = await db
    .prepare(
      `SELECT * FROM software_license_activations
       WHERE license_id = ? AND installation_id = ?
       LIMIT 1`,
    )
    .bind(licenseId, installationId)
    .first<ActivationRow>();
  return row ? mapActivation(row) : null;
}

export async function countActiveLicenseActivations(
  db: D1Database,
  licenseId: number,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM software_license_activations
       WHERE license_id = ? AND deactivated_at IS NULL`,
    )
    .bind(licenseId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function upsertLicenseActivation(
  db: D1Database,
  input: {
    licenseId: number;
    installationId: string;
    installationName?: string | null;
    appVersion?: string | null;
    metadataJson?: string | null;
  },
): Promise<SoftwareLicenseActivation> {
  const timestamp = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO software_license_activations (
        license_id, installation_id, installation_name, app_version,
        metadata_json, first_seen_at, last_seen_at, deactivated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(license_id, installation_id) DO UPDATE SET
        installation_name = excluded.installation_name,
        app_version = excluded.app_version,
        metadata_json = excluded.metadata_json,
        last_seen_at = excluded.last_seen_at,
        deactivated_at = NULL`,
    )
    .bind(
      input.licenseId,
      input.installationId,
      input.installationName ?? null,
      input.appVersion ?? null,
      input.metadataJson ?? null,
      timestamp,
      timestamp,
    )
    .run();

  const activation = await getLicenseActivation(
    db,
    input.licenseId,
    input.installationId,
  );
  if (!activation) {
    throw new Error("保存激活记录失败");
  }
  return activation;
}

export async function claimLicenseActivation(
  db: D1Database,
  input: {
    licenseId: number;
    installationId: string;
    installationName?: string | null;
    appVersion?: string | null;
    metadataJson?: string | null;
  },
): Promise<SoftwareLicenseActivation | null> {
  const timestamp = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO software_license_activations (
        license_id, installation_id, installation_name, app_version,
        metadata_json, first_seen_at, last_seen_at, deactivated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, NULL
      WHERE EXISTS (
        SELECT 1
        FROM software_licenses license
        WHERE license.id = ?
          AND (
            EXISTS (
              SELECT 1
              FROM software_license_activations current_activation
              WHERE current_activation.license_id = ?
                AND current_activation.installation_id = ?
                AND current_activation.deactivated_at IS NULL
            )
            OR (
              SELECT COUNT(*)
              FROM software_license_activations active_activation
              WHERE active_activation.license_id = ?
                AND active_activation.deactivated_at IS NULL
            ) < license.max_activations
          )
      )
      ON CONFLICT(license_id, installation_id) DO UPDATE SET
        installation_name = excluded.installation_name,
        app_version = excluded.app_version,
        metadata_json = excluded.metadata_json,
        last_seen_at = excluded.last_seen_at,
        deactivated_at = NULL`,
    )
    .bind(
      input.licenseId,
      input.installationId,
      input.installationName ?? null,
      input.appVersion ?? null,
      input.metadataJson ?? null,
      timestamp,
      timestamp,
      input.licenseId,
      input.licenseId,
      input.installationId,
      input.licenseId,
    )
    .run();

  const activation = await getLicenseActivation(
    db,
    input.licenseId,
    input.installationId,
  );
  return activation && activation.deactivatedAt === null ? activation : null;
}

export async function touchLicenseActivation(
  db: D1Database,
  input: {
    licenseId: number;
    installationId: string;
    installationName?: string | null;
    appVersion?: string | null;
    metadataJson?: string | null;
  },
): Promise<SoftwareLicenseActivation | null> {
  await db
    .prepare(
      `UPDATE software_license_activations
       SET installation_name = ?, app_version = ?, metadata_json = ?,
           last_seen_at = ?
       WHERE license_id = ? AND installation_id = ?
         AND deactivated_at IS NULL`,
    )
    .bind(
      input.installationName ?? null,
      input.appVersion ?? null,
      input.metadataJson ?? null,
      new Date().toISOString(),
      input.licenseId,
      input.installationId,
    )
    .run();
  return getLicenseActivation(db, input.licenseId, input.installationId);
}

export async function deactivateLicenseActivation(
  db: D1Database,
  licenseId: number,
  installationId: string,
): Promise<void> {
  const timestamp = new Date().toISOString();
  await db
    .prepare(
      `UPDATE software_license_activations
       SET deactivated_at = ?, last_seen_at = ?
       WHERE license_id = ? AND installation_id = ?`,
    )
    .bind(timestamp, timestamp, licenseId, installationId)
    .run();
}

export async function listLicenseActivations(
  db: D1Database,
  licenseId: number,
): Promise<SoftwareLicenseActivation[]> {
  const result = await db
    .prepare(
      `SELECT * FROM software_license_activations
       WHERE license_id = ?
       ORDER BY first_seen_at ASC, id ASC`,
    )
    .bind(licenseId)
    .all<ActivationRow>();
  return (result.results ?? []).map(mapActivation);
}

export async function createSoftwareRelease(
  db: D1Database,
  input: {
    version: string;
    releasedAt: string;
    channel?: string;
    minimumVersion?: string | null;
    downloadUrl?: string | null;
    checksumSha256?: string | null;
    notes?: string | null;
  },
): Promise<SoftwareRelease> {
  const timestamp = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO software_releases (
        version, channel, released_at, minimum_version, download_url,
        checksum_sha256, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(version) DO UPDATE SET
        channel = excluded.channel,
        released_at = excluded.released_at,
        minimum_version = excluded.minimum_version,
        download_url = excluded.download_url,
        checksum_sha256 = excluded.checksum_sha256,
        notes = excluded.notes,
        updated_at = excluded.updated_at`,
    )
    .bind(
      input.version,
      input.channel ?? "stable",
      input.releasedAt,
      input.minimumVersion ?? null,
      input.downloadUrl ?? null,
      input.checksumSha256 ?? null,
      input.notes ?? null,
      timestamp,
      timestamp,
    )
    .run();

  const release = await getSoftwareReleaseByVersion(db, input.version);
  if (!release) {
    throw new Error("保存版本记录失败");
  }
  return release;
}

export async function getSoftwareReleaseByVersion(
  db: D1Database,
  version: string,
): Promise<SoftwareRelease | null> {
  const row = await db
    .prepare("SELECT * FROM software_releases WHERE version = ? LIMIT 1")
    .bind(version)
    .first<ReleaseRow>();
  return row ? mapRelease(row) : null;
}

export async function listSoftwareReleases(
  db: D1Database,
  limit = 30,
): Promise<SoftwareRelease[]> {
  const result = await db
    .prepare(
      `SELECT * FROM software_releases
       ORDER BY released_at DESC, id DESC
       LIMIT ?`,
    )
    .bind(Math.max(1, Math.min(100, Math.floor(limit))))
    .all<ReleaseRow>();
  return (result.results ?? []).map(mapRelease);
}

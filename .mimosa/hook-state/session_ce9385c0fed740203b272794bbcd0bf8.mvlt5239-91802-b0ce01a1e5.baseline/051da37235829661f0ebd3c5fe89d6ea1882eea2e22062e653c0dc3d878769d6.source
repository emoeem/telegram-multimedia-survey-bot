/**
 * Deployment role: is this Worker the vendor's authorization center, or a
 * licensed customer instance?
 *
 * Commercial deployments ship the same code twice with different roles. The
 * center may issue licenses and hand out trial accounts; a customer instance
 * must never be able to do either — otherwise a customer could re-authorize
 * third parties with the product they bought.
 *
 * The bot already drew this line (`licenseAdminEnabled = Boolean(
 * LICENSE_ADMIN_TOKEN)`, see `src/index.ts`), but the web admin API only
 * checked `isAdmin` — and a customer IS the admin of their own instance, so
 * they could still mint licenses from the browser. This module is the single
 * source of truth for both surfaces.
 */

export type DeploymentRole = "vendor" | "customer";

export interface DeploymentRoleEnv {
  /** Explicit role from wrangler `[vars]`. Unset on legacy deployments. */
  DEPLOYMENT_ROLE?: string;
  /** Vendor-only secret; customer deployments are never provisioned with it. */
  LICENSE_ADMIN_TOKEN?: string;
}

function normalizeRole(value: string | undefined): DeploymentRole | null {
  const role = value?.trim().toLowerCase();
  if (role === "vendor") return "vendor";
  if (role === "customer") return "customer";
  return null;
}

/**
 * Whether this deployment may use vendor-only surfaces (sign licenses, grant
 * trial accounts, publish releases, list other customers).
 *
 * Two independent conditions, both required:
 *
 *  1. `DEPLOYMENT_ROLE` must not be `customer`. This is an unconditional block,
 *     so a leaked or copied `LICENSE_ADMIN_TOKEN` cannot re-enable vendor
 *     features on a customer's own server.
 *  2. The vendor-only `LICENSE_ADMIN_TOKEN` must be provisioned. Customer
 *     deployments never receive it, so flipping `DEPLOYMENT_ROLE` back to
 *     `vendor` in a local config is not enough to mint licenses.
 */
export function isLicenseCenter(env: DeploymentRoleEnv): boolean {
  if (normalizeRole(env.DEPLOYMENT_ROLE) === "customer") return false;
  return Boolean(env.LICENSE_ADMIN_TOKEN?.trim());
}

/** Explicitly configured role, or null when the deployment predates the flag. */
export function configuredDeploymentRole(env: DeploymentRoleEnv): DeploymentRole | null {
  return normalizeRole(env.DEPLOYMENT_ROLE);
}

export function hasVendorAdminToken(env: DeploymentRoleEnv): boolean {
  return Boolean(env.LICENSE_ADMIN_TOKEN?.trim());
}

/** Effective role, for display and telemetry only (never the security check). */
export function resolveDeploymentRole(env: DeploymentRoleEnv): DeploymentRole {
  return isLicenseCenter(env) ? "vendor" : "customer";
}

/**
 * Actionable hint when vendor capabilities are unavailable for a reason the
 * operator can fix, so a misconfigured center shows an instruction instead of a
 * bare 403.
 */
export function describeDeploymentRoleIssue(env: DeploymentRoleEnv): string | null {
  if (configuredDeploymentRole(env) === "customer") {
    return "当前实例是已授权的客户部署，只能使用被授权的机器人功能；签发授权、发布版本与发放体验账号仅在厂商授权中心进行。";
  }
  if (!hasVendorAdminToken(env)) {
    return "本实例未配置 LICENSE_ADMIN_TOKEN，无法启用授权中心能力。请运行 pnpm license-admin:setup 后重新部署。";
  }
  return null;
}

/**
 * Vendor-only HTTP surfaces. Kept as one list so a new endpoint can't be added
 * without passing the gate.
 */
const VENDOR_ADMIN_PATHS = new Set(["/api/admin/licenses", "/api/admin/releases", "/api/admin/trials"]);

export function isVendorOnlyAdminPath(pathname: string): boolean {
  if (VENDOR_ADMIN_PATHS.has(pathname)) return true;
  if (pathname.startsWith("/api/admin/licenses/")) return true;
  if (/^\/api\/admin\/users\/\d+\/trial$/.test(pathname)) return true;
  return false;
}

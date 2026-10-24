import { describe, expect, it } from "vitest";

import {
  configuredDeploymentRole,
  describeDeploymentRoleIssue,
  isLicenseCenter,
  isVendorOnlyAdminPath,
  resolveDeploymentRole,
} from "../../../src/services/deployment-role.service";

describe("deployment role service", () => {
  it("treats an explicit customer role as an unconditional block", () => {
    // Even holding the vendor-only admin token must not re-enable vendor
    // features on a customer's own server.
    expect(isLicenseCenter({ DEPLOYMENT_ROLE: "customer", LICENSE_ADMIN_TOKEN: "leaked-secret" })).toBe(false);
    expect(resolveDeploymentRole({ DEPLOYMENT_ROLE: "customer", LICENSE_ADMIN_TOKEN: "leaked-secret" })).toBe(
      "customer",
    );
  });

  it("requires the vendor admin token even for an explicit vendor role", () => {
    // Flipping DEPLOYMENT_ROLE back to "vendor" in a local config must not be
    // enough to mint licenses: the vendor-only secret is the second lock.
    expect(isLicenseCenter({ DEPLOYMENT_ROLE: "vendor", LICENSE_ADMIN_TOKEN: "vendor-secret" })).toBe(true);
    expect(isLicenseCenter({ DEPLOYMENT_ROLE: "vendor" })).toBe(false);
    expect(isLicenseCenter({ DEPLOYMENT_ROLE: "vendor", LICENSE_ADMIN_TOKEN: "  " })).toBe(false);
  });

  it("falls back to the admin token for legacy deployments without a role", () => {
    expect(isLicenseCenter({ LICENSE_ADMIN_TOKEN: "vendor-secret" })).toBe(true);
    expect(isLicenseCenter({ LICENSE_ADMIN_TOKEN: "" })).toBe(false);
    expect(isLicenseCenter({})).toBe(false);
    expect(isLicenseCenter({ LICENSE_ADMIN_TOKEN: "   " })).toBe(false);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(isLicenseCenter({ DEPLOYMENT_ROLE: "  CUSTOMER  ", LICENSE_ADMIN_TOKEN: "x" })).toBe(false);
    expect(isLicenseCenter({ DEPLOYMENT_ROLE: " Vendor ", LICENSE_ADMIN_TOKEN: "x" })).toBe(true);
    expect(configuredDeploymentRole({ DEPLOYMENT_ROLE: " Customer " })).toBe("customer");
    expect(configuredDeploymentRole({})).toBeNull();
  });

  it("explains why vendor features are unavailable", () => {
    // A customer sees the polite isolation message.
    expect(describeDeploymentRoleIssue({ DEPLOYMENT_ROLE: "customer" })).toContain("客户部署");
    // A misconfigured center gets an actionable instruction instead of a bare 403.
    expect(describeDeploymentRoleIssue({ DEPLOYMENT_ROLE: "vendor" })).toContain("license-admin:setup");
    // A correctly provisioned center has nothing to report.
    expect(describeDeploymentRoleIssue({ DEPLOYMENT_ROLE: "vendor", LICENSE_ADMIN_TOKEN: "x" })).toBeNull();
    expect(describeDeploymentRoleIssue({ LICENSE_ADMIN_TOKEN: "x" })).toBeNull();
  });

  it("recognises every vendor-only admin path", () => {
    for (const path of [
      "/api/admin/licenses",
      "/api/admin/licenses/lic-abc",
      "/api/admin/releases",
      "/api/admin/trials",
      "/api/admin/users/42/trial",
      // 邀请码 = 发放体验权限，和 /users/:id/trial 同类
      "/api/admin/creator-invites",
      "/api/admin/creator-invites/revoke",
    ]) {
      expect(isVendorOnlyAdminPath(path)).toBe(true);
    }
    // Customer-safe admin surfaces must stay reachable.
    for (const path of ["/api/admin/surveys", "/api/admin/users", "/api/admin/settings", "/api/admin/trialsX"]) {
      expect(isVendorOnlyAdminPath(path)).toBe(false);
    }
  });
});

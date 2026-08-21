import { describe, expect, it } from "vitest";

import type {
  RenderJob,
  ResultField,
  ResultProfile,
  VisualTemplate,
  VisualTemplateVersion,
} from "../../../src/db/schema";

describe("result visual domain schema", () => {
  it("supports arbitrary typed result fields without RPG-specific keys", () => {
    const field: ResultField = {
      id: "relationship",
      type: "enum",
      value: "ally",
      label: "关系类型",
    };

    expect(field).toMatchObject({ id: "relationship", type: "enum" });
  });

  it("keeps result snapshots and template versions independently addressable", () => {
    const profile: Pick<ResultProfile, "responseId" | "schemaVersion"> = {
      responseId: 21,
      schemaVersion: 1,
    };
    const template: Pick<VisualTemplate, "id" | "status"> = {
      id: 7,
      status: "published",
    };
    const version: Pick<VisualTemplateVersion, "templateId" | "version"> = {
      templateId: template.id,
      version: 3,
    };
    const job: Pick<RenderJob, "resultProfileId" | "templateId" | "templateVersion" | "status" | "forceRegenerate"> = {
      resultProfileId: profile.responseId,
      templateId: version.templateId,
      templateVersion: version.version,
      status: "queued",
      forceRegenerate: false,
    };

    expect(job).toMatchObject({ resultProfileId: 21, templateId: 7, templateVersion: 3 });
    expect(job.status).toBe("queued");
  });
});

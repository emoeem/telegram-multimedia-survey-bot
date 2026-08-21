import { describe, expect, it } from "vitest";
import type { MediaAsset } from "../../../src/db/schema";

describe("media asset scope contract", () => {
  it("keeps survey, response, template and generated assets distinct", () => {
    const scopes: MediaAsset["scope"][] = ["survey", "response", "template", "generated_result", "template_preview", "identity_card"];
    expect(new Set(scopes).size).toBe(scopes.length);
  });
});

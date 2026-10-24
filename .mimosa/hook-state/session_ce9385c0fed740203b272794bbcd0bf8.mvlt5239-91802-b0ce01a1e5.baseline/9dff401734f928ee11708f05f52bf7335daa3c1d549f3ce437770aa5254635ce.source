import { describe, expect, it } from "vitest";

import { resolveSubmissionBotUrl } from "../../../src/services/contact-links.service";

describe("contact links", () => {
  it("falls back to the hosted submission bot when unset", () => {
    expect(resolveSubmissionBotUrl({})).toBe("https://t.me/tougaojiqirbot");
  });

  it("lets a deployment point at its own bot", () => {
    expect(resolveSubmissionBotUrl({ SUBMISSION_BOT_URL: " https://t.me/other_bot " })).toBe("https://t.me/other_bot");
  });

  it("treats an explicitly empty value as hidden", () => {
    expect(resolveSubmissionBotUrl({ SUBMISSION_BOT_URL: "   " })).toBeNull();
  });
});

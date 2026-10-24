import { describe, expect, it } from "vitest";

import { resolvePublicOrigin } from "../../../src/services/public-origin.service";

describe("public origin", () => {
  it("falls back to how the request arrived when unset", () => {
    expect(resolvePublicOrigin({}, "https://bot.account.workers.dev")).toBe("https://bot.account.workers.dev");
  });

  it("treats a blank value as unset", () => {
    expect(resolvePublicOrigin({ PUBLIC_ORIGIN: "   " }, "https://bot.account.workers.dev")).toBe(
      "https://bot.account.workers.dev",
    );
  });

  it("pins the user-facing origin independently of the request origin", () => {
    // The webhook keeps arriving on workers.dev while users must be sent to the
    // custom domain; that divergence is the whole point of the variable.
    expect(resolvePublicOrigin({ PUBLIC_ORIGIN: "https://emoe.eu.cc" }, "https://bot.account.workers.dev")).toBe(
      "https://emoe.eu.cc",
    );
  });

  it("strips trailing slashes so path concatenation stays single-slashed", () => {
    expect(resolvePublicOrigin({ PUBLIC_ORIGIN: "https://emoe.eu.cc/" }, "https://x.workers.dev")).toBe(
      "https://emoe.eu.cc",
    );
    expect(resolvePublicOrigin({ PUBLIC_ORIGIN: "https://emoe.eu.cc///" }, "https://x.workers.dev")).toBe(
      "https://emoe.eu.cc",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(resolvePublicOrigin({ PUBLIC_ORIGIN: "  https://emoe.eu.cc  " }, "https://x.workers.dev")).toBe(
      "https://emoe.eu.cc",
    );
  });
});

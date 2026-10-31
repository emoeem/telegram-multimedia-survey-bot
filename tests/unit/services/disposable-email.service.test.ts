import { describe, expect, it } from "vitest";

import {
  emailDomainOf,
  isAggregateProviderDomain,
  isBlockedEmailAddress,
  isDisposableEmailDomain,
  parseBlockedEmailDomains,
} from "../../../src/services/disposable-email.service";

describe("disposable email domains", () => {
  it("extracts and normalizes the domain part", () => {
    expect(emailDomainOf("User@Example.COM")).toBe("example.com");
    expect(emailDomainOf("a.b+c@sub.example.co.uk")).toBe("sub.example.co.uk");
    expect(emailDomainOf("no-at-sign")).toBe(null);
    expect(emailDomainOf("x@")).toBe(null);
    expect(emailDomainOf("x@localhost")).toBe(null);
    expect(emailDomainOf("x@bad_domain!.com")).toBe(null);
  });

  it("parses the admin blocklist setting", () => {
    expect(parseBlockedEmailDomains("fldubai.com, @mailinator.com;  spam.example\nTEMPMAIL.NET")).toEqual([
      "fldubai.com",
      "mailinator.com",
      "spam.example",
      "tempmail.net",
    ]);
    expect(parseBlockedEmailDomains("")).toEqual([]);
    expect(parseBlockedEmailDomains(null)).toEqual([]);
    expect(parseBlockedEmailDomains("notadomain")).toEqual([]);
  });

  it("flags known disposable domains from the dataset", () => {
    expect(isDisposableEmailDomain("mailinator.com")).toBe(true);
    expect(isDisposableEmailDomain("10minutemail.com")).toBe(true);
    expect(isDisposableEmailDomain("gmail.com")).toBe(false);
  });

  it("blocks the 2026-10-31 incident domain without any admin configuration", () => {
    // fldubai.com is NOT in the upstream dataset, so it is seeded in code:
    // a fresh deployment blocks it before anyone opens the admin panel.
    expect(isDisposableEmailDomain("fldubai.com")).toBe(true);
    expect(isBlockedEmailAddress("pfoxhcu0nhbb@fldubai.com", "")).toBe(true);
    expect(isBlockedEmailAddress("pfoxhcu0nhbb@fldubai.com", null)).toBe(true);
  });

  it("blocks an arbitrary domain once an admin adds it to the setting", () => {
    expect(isDisposableEmailDomain("probe-domain.example")).toBe(false);
    expect(isBlockedEmailAddress("someone@probe-domain.example", "probe-domain.example")).toBe(true);
    expect(isBlockedEmailAddress("someone@gmail.com", "probe-domain.example")).toBe(false);
    expect(isBlockedEmailAddress("garbage", "probe-domain.example")).toBe(false);
  });

  it("classifies aggregate provider domains for throttling", () => {
    expect(isAggregateProviderDomain("gmail.com")).toBe(true);
    expect(isAggregateProviderDomain("QQ.com")).toBe(true);
    expect(isAggregateProviderDomain("outlook.com")).toBe(true);
    expect(isAggregateProviderDomain("fldubai.com")).toBe(false);
    expect(isAggregateProviderDomain("example.com")).toBe(false);
  });
});

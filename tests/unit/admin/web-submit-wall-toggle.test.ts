import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { DEFAULT_WEB_SUBMIT_FORM, mergeWebSubmitForm } from "../../../src/services/submit/form-config";

describe("投稿墙开关配置（web_submit_form showcase 双闸）", () => {
  it("默认不出网：总开关与字段白名单默认都是关的", () => {
    expect(DEFAULT_WEB_SUBMIT_FORM.showcaseEnabled).toBe(false);
    expect(DEFAULT_WEB_SUBMIT_FORM.showcaseFields).toEqual([]);
  });

  it("showcaseEnabled 可经配置打开", () => {
    const { config, problems } = mergeWebSubmitForm(JSON.stringify({ showcaseEnabled: true }));
    expect(problems).toEqual([]);
    expect(config.showcaseEnabled).toBe(true);
  });

  it("showcaseFields 与 steps 求交集：残留旧 step id 与内部键带不出网", () => {
    const { config } = mergeWebSubmitForm(
      JSON.stringify({ showcaseEnabled: true, showcaseFields: ["title", "ghost_step", "__nickname", ""] }),
    );
    expect(config.showcaseEnabled).toBe(true);
    expect(config.showcaseFields).toEqual(["title"]);
    expect(config.showcaseFields).not.toContain("__nickname");
    expect(config.showcaseFields).not.toContain("ghost_step");
  });

  it("fs 守卫：管理路由注册 form-config 读写，页面有投稿墙开关卡片", () => {
    const route = readFileSync("src/http/admin/web-submission.ts", "utf8");
    expect(route).toContain('"/form-config"');
    expect(route).toContain("saveWebSubmitShowcaseSetting");
    expect(route).toContain("web_submit_form.update");
    const page = readFileSync("admin/src/routes/WebSubmissionsPage.tsx", "utf8");
    expect(page).toContain("WallSettingsCard");
    expect(page).toContain("/api/admin/web-submissions/form-config");
    expect(page).toContain("contact");
  });
});

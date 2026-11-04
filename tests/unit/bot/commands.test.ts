import { describe, expect, it } from "vitest";

import { COMMANDS, MOVED_TO_WEB_MESSAGE, helpText, menuFor, parseCommand, renameHint } from "../../../src/bot/commands";

describe("命令解析", () => {
  it("剥离群里的 @机器人名 后缀", () => {
    // Telegram 在群里把命令写成 /cmd@bot_username；此前只有 3 条命令处理过。
    expect(parseCommand("/surveys@hnhgggfj_bot")).toEqual({ name: "surveys", args: "", text: "/surveys" });
    expect(parseCommand("/redeem@hnhgggfj_bot AB-1234")).toEqual({
      name: "redeem",
      args: "AB-1234",
      text: "/redeem AB-1234",
    });
  });

  it("解析参数并忽略大小写", () => {
    expect(parseCommand("/LicEnse list")).toEqual({ name: "license", args: "list", text: "/license list" });
  });

  it("非命令与空输入返回 null", () => {
    expect(parseCommand("你好")).toBeNull();
    expect(parseCommand("")).toBeNull();
    expect(parseCommand(undefined)).toBeNull();
    // 裸斜杠、纯数字命令名都不是 Telegram 命令。
    expect(parseCommand("/")).toBeNull();
    expect(parseCommand("/ /")).toBeNull();
  });
});

describe("命令集合", () => {
  it("名称符合 Telegram 规则（小写字母/数字/下划线）", () => {
    for (const command of COMMANDS) {
      expect(command.name).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(command.description.length).toBeLessThanOrEqual(256);
    }
  });

  it("没有重复命令名", () => {
    const names = COMMANDS.map((command) => command.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("公共私聊菜单只有 6 条，且不含管理与厂商命令", () => {
    expect(menuFor("private", "public").map((item) => item.command)).toEqual([
      "start",
      "surveys",
      "me",
      "codes",
      "redeem",
      "help",
    ]);
  });

  it("群菜单只放行群安全命令", () => {
    expect(menuFor("group", "public").map((item) => item.command)).toEqual(["surveys", "help", "publish_here"]);
    // 管理员身份也不改变群菜单：群里不该出现管理命令。
    expect(menuFor("group", "admin").map((item) => item.command)).toEqual(["surveys", "help", "publish_here"]);
  });

  it("管理员菜单逐步叠加，厂商命令默认不出现", () => {
    const admin = menuFor("private", "admin").map((item) => item.command);
    expect(admin).toContain("admin");
    expect(admin).toContain("review");
    expect(admin).toContain("users");
    expect(admin).not.toContain("license");

    const vendor = menuFor("private", "vendor").map((item) => item.command);
    expect(vendor).toEqual(expect.arrayContaining(["license", "release", "trial"]));
  });
});

describe("旧命令指引", () => {
  it("重命名命令指向新名字", () => {
    expect(renameHint("my_surveys")).toBe("命令已更新：请用 /me");
    expect(renameHint("passwords")).toBe("命令已更新：请用 /codes");
    expect(renameHint("invite")).toBe("命令已更新：请用 /redeem");
    expect(renameHint("set_publish_target")).toBe("命令已更新：请用 /publish_here");
    expect(renameHint("trials")).toBe("命令已更新：请用 /trial");
  });

  it("迁移到网页的命令给出统一说明", () => {
    for (const name of ["create", "import", "export", "preview", "duplicate"]) {
      expect(renameHint(name)).toBe(MOVED_TO_WEB_MESSAGE);
    }
    expect(MOVED_TO_WEB_MESSAGE).toContain("网页管理后台");
  });

  it("现行命令与高级授权子命令没有指引", () => {
    for (const name of ["start", "surveys", "me", "codes", "redeem", "help", "admin", "license_create"]) {
      expect(renameHint(name)).toBeNull();
    }
  });
});

describe("help 文本", () => {
  it("普通用户私聊只看到公共命令", () => {
    const text = helpText("public");
    expect(text).toContain("/surveys");
    expect(text).not.toContain("/admin");
    expect(text).not.toContain("/license");
  });

  it("群里说明填卷要私聊", () => {
    const text = helpText("public", "group");
    expect(text).toContain("/surveys");
    expect(text).toContain("私聊");
  });
});

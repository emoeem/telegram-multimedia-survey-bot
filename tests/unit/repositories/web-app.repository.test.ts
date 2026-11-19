import { describe, expect, it } from "vitest";

import { fullMigrationSchema } from "../../helpers/full-schema";
import { createSqliteD1, sqliteD1Available } from "../../helpers/sqlite-d1";
import {
  createWebApp,
  deleteWebApp,
  getWebAppById,
  listWebApps,
  normalizeAllowedDomains,
  normalizeHttpsUrl,
  normalizeOpenMode,
  reorderWebApps,
  updateWebApp,
} from "../../../src/db/repositories/web-app.repository";

/**
 * web_apps 仓储（0104）的仓库层验证：真实 SQLite（全迁移链 schema）上过
 * CRUD、enabledOnly 过滤、reorder、硬删与三个纯归一化函数（https URL /
 * allowed_domains / open_mode）。web_apps 无级联子表，删除是硬删——
 * 验证「删后不存在、重复删返回 false」。
 */
describe.skipIf(!sqliteD1Available)("web app repository (0104)", () => {
  it("create 默认值与回读：open_mode 回退 browser、sort_order 固定 append、enabled 默认开", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    const first = await createWebApp(db, { name: "工具站", url: "https://a.example.com" });
    expect(first.sortOrder).toBe(1);
    expect(first.enabled).toBe(true);
    expect(first.openMode).toBe("browser");
    expect(first.allowedDomains).toBeNull();

    const second = await createWebApp(db, {
      name: "资源站",
      url: "https://b.example.com/path?q=1",
      description: "一句话简介",
      iconUrl: "https://cdn.example.com/i.png",
      category: "资源",
      openMode: "miniapp",
      allowedDomains: ["b.example.com"],
      enabled: false,
    });
    expect(second.sortOrder).toBe(2);
    expect(second.description).toBe("一句话简介");
    expect(second.category).toBe("资源");
    expect(second.openMode).toBe("miniapp");
    expect(second.allowedDomains).toEqual(["b.example.com"]);
    expect(second.enabled).toBe(false);

    const fetched = await getWebAppById(db, second.id);
    expect(fetched?.url).toBe("https://b.example.com/path?q=1");
    expect(await getWebAppById(db, 99999)).toBeNull();
  });

  it("enabledOnly 只返回启用项，且按 sort_order, id 稳定有序", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    const a = await createWebApp(db, { name: "甲", url: "https://a.example.com" });
    const b = await createWebApp(db, { name: "乙", url: "https://b.example.com" });
    const c = await createWebApp(db, { name: "丙", url: "https://c.example.com", enabled: false });
    // 定位走 updateWebApp（create 固定 append，与 task-pack 先例一致）。
    await updateWebApp(db, a.id, { sortOrder: 30 });
    await updateWebApp(db, c.id, { sortOrder: 10 });

    const all = await listWebApps(db);
    expect(all.map((app) => app.id)).toEqual([b.id, c.id, a.id]);
    const enabled = await listWebApps(db, { enabledOnly: true });
    expect(enabled.map((app) => app.id)).toEqual([b.id, a.id]);
    expect(enabled.some((app) => app.id === c.id)).toBe(false);
  });

  it("update 部分字段：未传字段保持原值；allowedDomains 传 null 清空、传数组归一化", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    const created = await createWebApp(db, {
      name: "原名",
      url: "https://a.example.com",
      description: "原简介",
      category: "工具",
      allowedDomains: ["a.example.com"],
      openMode: "miniapp",
    });

    const updated = await updateWebApp(db, created.id, {
      name: "新名",
      enabled: false,
      allowedDomains: ["B.Example.com.", "b.example.com", "not a domain"],
    });
    expect(updated?.name).toBe("新名");
    expect(updated?.url).toBe("https://a.example.com");
    expect(updated?.description).toBe("原简介");
    expect(updated?.category).toBe("工具");
    expect(updated?.openMode).toBe("miniapp");
    expect(updated?.enabled).toBe(false);
    expect(updated?.allowedDomains).toEqual(["b.example.com"]);

    const cleared = await updateWebApp(db, created.id, { allowedDomains: null });
    expect(cleared?.allowedDomains).toBeNull();
    // 不传 allowedDomains 时保持原值（undefined ≠ null）。
    const kept = await updateWebApp(db, created.id, { description: "改简介" });
    expect(kept?.description).toBe("改简介");
    expect(await updateWebApp(db, 99999, { name: "幽灵" })).toBeNull();
  });

  it("reorder 按给定顺序写 1..N；delete 硬删且重复删返回 false", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    const a = await createWebApp(db, { name: "甲", url: "https://a.example.com" });
    const b = await createWebApp(db, { name: "乙", url: "https://b.example.com" });
    const c = await createWebApp(db, { name: "丙", url: "https://c.example.com" });

    await reorderWebApps(db, [c.id, a.id, b.id]);
    expect((await listWebApps(db)).map((app) => app.id)).toEqual([c.id, a.id, b.id]);
    expect((await listWebApps(db)).map((app) => app.sortOrder)).toEqual([1, 2, 3]);
    // 非 id 项被过滤，不抛错。
    await reorderWebApps(db, [b.id, 0, -1]);
    expect((await listWebApps(db)).map((app) => app.sortOrder)).toEqual([1, 1, 2]);

    expect(await deleteWebApp(db, a.id)).toBe(true);
    expect(await getWebAppById(db, a.id)).toBeNull();
    expect(await deleteWebApp(db, a.id)).toBe(false);
  });

  it("纯归一化：https URL 强校验、域名白名单过滤脏项、open_mode 回退", () => {
    expect(normalizeHttpsUrl("https://a.example.com/x")).toBe("https://a.example.com/x");
    expect(normalizeHttpsUrl("http://a.example.com")).toBeNull();
    expect(normalizeHttpsUrl("ftp://a.example.com")).toBeNull();
    expect(normalizeHttpsUrl("not a url")).toBeNull();
    expect(normalizeHttpsUrl("")).toBeNull();
    expect(normalizeHttpsUrl(null)).toBeNull();

    expect(normalizeAllowedDomains(["A.Example.com", "b.example.com.", "https://c.com/x", "", "d..e", 42])).toEqual([
      "a.example.com",
      "b.example.com",
    ]);
    expect(normalizeAllowedDomains([])).toBeNull();
    expect(normalizeAllowedDomains("not json")).toBeNull();
    expect(normalizeAllowedDomains('["x.example.com"]')).toEqual(["x.example.com"]);
    expect(normalizeAllowedDomains(null)).toBeNull();

    expect(normalizeOpenMode("miniapp")).toBe("miniapp");
    expect(normalizeOpenMode("browser")).toBe("browser");
    expect(normalizeOpenMode("popup")).toBe("browser");
    expect(normalizeOpenMode(undefined)).toBe("browser");
  });
});

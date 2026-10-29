import { describe, expect, it } from "vitest";

import {
  PUBLIC_REPORT_CAPTION_MAX,
  PUBLIC_REPORT_MESSAGE_MAX,
  buildPublicReportBatchCaption,
  buildPublicReportCaption,
  clampPublicReportCaption,
  formatPublicReportPageMarker,
  normalizePublishMessage,
} from "../../../src/services/public-report-caption";

/**
 * 公开发布的 caption：频道里那条消息是答卷者唯一"被看见"的东西，也是唯一
 * 会把身份泄漏出去的地方。
 *
 * 三条约束各自都是"错了也不报错"的类型：漏了问卷名/时间 → 频道里分不清是哪份；
 * 匿名没剥干净 → 一个 `@username` 或 Telegram ID 永久留在公开频道；超长 →
 * Telegram 直接 400，整条消息发不出去（而且队列重试三次后标记失败）。
 */
const base = {
  surveyTitle: "深夜问卷",
  anonymous: true,
  startedAt: "2026/10/29 10:00:00",
  completedAt: "2026/10/29 10:07:31",
  message: null,
};

describe("公开发布 caption", () => {
  it("带问卷名称与填写时间（频道里靠这两项区分同名的多次填写）", () => {
    const caption = buildPublicReportCaption(base);
    expect(caption).toContain("问卷：深夜问卷");
    expect(caption).toContain("填写时间：2026/10/29 10:00:00 至 2026/10/29 10:07:31（北京时间）");
  });

  it("只有完成时间时用完成时间，什么都没有也不留空行", () => {
    const onlyDone = buildPublicReportCaption({ ...base, startedAt: null });
    expect(onlyDone).toContain("填写时间：2026/10/29 10:07:31（北京时间）");
    const nothing = buildPublicReportCaption({ ...base, startedAt: null, completedAt: null });
    expect(nothing).toContain("填写时间：未知");
    expect(nothing).not.toContain("填写时间：\n");
  });

  it("匿名时彻底不出现填写者：即使调用方误传了真名/@用户名/Telegram ID", () => {
    const caption = buildPublicReportCaption({
      ...base,
      anonymous: true,
      // 模拟"上游忘了遮盖"：三种身份都塞进去，输出里一个都不许有。
      respondent: "张三 / @zhangsan / Telegram ID: 8804863918",
    });
    expect(caption).toContain("填写者：匿名");
    expect(caption).not.toContain("张三");
    expect(caption).not.toContain("zhangsan");
    expect(caption).not.toContain("8804863918");
    expect(caption).not.toContain("Telegram ID");
  });

  it("非匿名时填上填写者（这是答卷者主动选择公开身份的唯一出口）", () => {
    const caption = buildPublicReportCaption({ ...base, anonymous: false, respondent: "@zhangsan" });
    expect(caption).toContain("填写者：@zhangsan");
    expect(caption).not.toContain("填写者：匿名");
  });

  it("有留言时作为配文附上，没有时不留空段落", () => {
    const withMessage = buildPublicReportCaption({ ...base, message: "这次的第 3 题我纠结了很久" });
    expect(withMessage).toContain("💬 想说的话：");
    expect(withMessage).toContain("这次的第 3 题我纠结了很久");

    const without = buildPublicReportCaption({ ...base, message: "   " });
    expect(without).not.toContain("想说的话");
    expect(without.endsWith("\n")).toBe(false);
  });

  it("留言里的换行保留（多段配文），但连续空行收敛成一行", () => {
    const caption = buildPublicReportCaption({ ...base, message: "第一段\n\n\n\n第二段" });
    expect(caption).toContain("第一段\n\n第二段");
    expect(caption).not.toContain("\n\n\n");
  });

  it("留言按码点截断：不会把 emoji 切成半个字符", () => {
    const long = "🖤".repeat(PUBLIC_REPORT_MESSAGE_MAX + 20);
    const normalized = normalizePublishMessage(long);
    expect(normalized).not.toBeNull();
    expect(Array.from(normalized!)).toHaveLength(PUBLIC_REPORT_MESSAGE_MAX);
    // 代理对被切开时会出现孤立代理项（渲染为 �）——这里必须没有。
    expect(normalized).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(normalized).not.toMatch(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it("即使各项都被塞满，整体也在 Telegram 的 1024 字符以内（超了整条消息被 400 拒绝）", () => {
    const caption = buildPublicReportCaption({
      ...base,
      surveyTitle: "长".repeat(2000),
      respondent: "@".repeat(2000),
      message: "话".repeat(2000),
    });
    expect(Array.from(caption).length).toBeLessThanOrEqual(PUBLIC_REPORT_CAPTION_MAX);
    // 各项内部截断已足够，不该走到整体兜底截断（否则说明限额之间不匹配）。
    expect(caption.endsWith("…")).toBe(false);
    expect(caption).toContain("问卷：");
    expect(caption).toContain("填写时间：");
  });

  it("问卷名为空时退回「问卷」，不会出现「问卷：」后面什么都没有", () => {
    expect(buildPublicReportCaption({ ...base, surveyTitle: "   " })).toContain("问卷：问卷");
    expect(buildPublicReportCaption({ ...base, surveyTitle: null })).toContain("问卷：问卷");
  });

  it("控制字符被清掉（\u0000 之类会破坏消息与日志）", () => {
    expect(normalizePublishMessage("a\u0000b\u0007c")).toBe("abc");
    expect(normalizePublishMessage(null)).toBeNull();
    expect(normalizePublishMessage("   \n\n ")).toBeNull();
  });

  it("clampPublicReportCaption 在超长时截断并加省略号，未超长时原样返回", () => {
    expect(clampPublicReportCaption("短文案")).toBe("短文案");
    const clamped = clampPublicReportCaption("字".repeat(PUBLIC_REPORT_CAPTION_MAX + 5));
    expect(Array.from(clamped)).toHaveLength(PUBLIC_REPORT_CAPTION_MAX);
  });
});

/**
 * 分批 caption：相册一批最多 10 张，一份报告可能二十几页。
 *
 * 旧实现只在第一批挂 caption，第 11 页起的消息在频道里没有问卷名、没有填写
 * 时间——读者不知道自己在看哪份问卷的第几页，出了问题也没法和前半截对上。
 */
describe("分批 caption", () => {
  it("第一批：完整文案 + 页码范围 + 「后续分批补发」提示", () => {
    const caption = buildPublicReportBatchCaption(base, { pageStart: 1, pageEnd: 10, totalPages: 24 });
    expect(caption).toContain("问卷：深夜问卷");
    expect(caption).toContain("填写时间：2026/10/29 10:00:00 至 2026/10/29 10:07:31（北京时间）");
    expect(caption).toContain("第 1–10 页，共 24 页");
    expect(caption).toContain("后续分批补发");
  });

  it("后续批次也带 caption：问卷名 + 填写时间 + 页码，但不重复留言", () => {
    const caption = buildPublicReportBatchCaption(
      { ...base, message: "想说的话也要出现" },
      { pageStart: 11, pageEnd: 20, totalPages: 24 },
    );
    expect(caption).toContain("第 11–20 页，共 24 页");
    expect(caption).toContain("问卷：深夜问卷");
    expect(caption).toContain("填写时间：");
    expect(caption).not.toContain("想说的话也要出现");
    // 匿名仍然匿名：分批不是绕过身份剥离的理由。
    expect(caption).toContain("填写者：匿名");
  });

  it("页面范围是「第 N/M 页」；单页报告不加页码", () => {
    expect(formatPublicReportPageMarker({ pageStart: 1, pageEnd: 10, totalPages: 24 })).toBe("第 1–10 页，共 24 页");
    expect(formatPublicReportPageMarker({ pageStart: 24, pageEnd: 24, totalPages: 24 })).toBe("第 24 页，共 24 页");
    expect(formatPublicReportPageMarker({ pageStart: 1, pageEnd: 1, totalPages: 1 })).toBe("");
    expect(buildPublicReportBatchCaption(base, { pageStart: 1, pageEnd: 1, totalPages: 1 })).toBe(
      buildPublicReportCaption(base),
    );
  });

  it("超长留言也不会把分批 caption 顶过 1024", () => {
    const caption = buildPublicReportBatchCaption(
      { ...base, message: "话".repeat(2000), surveyTitle: "长".repeat(2000) },
      { pageStart: 1, pageEnd: 10, totalPages: 24 },
    );
    expect(Array.from(caption).length).toBeLessThanOrEqual(PUBLIC_REPORT_CAPTION_MAX);
  });
});

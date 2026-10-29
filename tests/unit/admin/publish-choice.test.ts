import { describe, expect, it } from "vitest";

import {
  DEFAULT_PUBLISH_CHOICE,
  PUBLISH_MESSAGE_MAX,
  clampPublishMessage,
  describePublishChoice,
  fromPublishDraft,
  publishChoiceRequestFields,
  publishMessageLength,
  toPublishDraft,
} from "../../../admin/src/survey/publish-choice";

/**
 * 发布三项选择的前端模型：弹窗（收集）→ 请求体（字段名）→ 频道文案（摘要）。
 *
 * 这里最容易出错的两件事都不报错：
 *   1. 字段名/默认值和后端不一致 → 用户以为匿名了，后端收不到 `publishAnonymous`，
 *      名字照样印进公开频道；
 *   2. 「仅自己可见」被存成 true → 报告发到了它不该去的地方。
 */
describe("发布三项选择模型", () => {
  it("默认不发布且匿名（不匿名必须是用户主动点出来的选择）", () => {
    expect(DEFAULT_PUBLISH_CHOICE.publishToTelegram).toBe(false);
    expect(DEFAULT_PUBLISH_CHOICE.anonymous).toBe(true);
    expect(DEFAULT_PUBLISH_CHOICE.message).toBe("");
  });

  it("草稿往返不丢选择", () => {
    const choice = { publishToTelegram: true, anonymous: false, message: "  想说一句  " };
    const draft = toPublishDraft(choice);
    expect(draft).toEqual({ visibility: "public", anonymous: false, message: "  想说一句  " });
    expect(fromPublishDraft(draft)).toEqual({ publishToTelegram: true, anonymous: false, message: "想说一句" });
  });

  it("选「仅自己可见」= 不发布，但留言仍然保留在草稿里", () => {
    const draft = { visibility: "private" as const, anonymous: true, message: "写了一半的话" };
    const choice = fromPublishDraft(draft);
    expect(choice.publishToTelegram).toBe(false);
    expect(choice.message).toBe("写了一半的话");
    // 切回公开时话还在：用户不该发现自己的输入被悄悄清空。
    expect(fromPublishDraft({ ...draft, visibility: "public" }).message).toBe("写了一半的话");
  });

  it("请求体字段名与后端一致（后端读 publishToTelegram / publishAnonymous / publishMessage）", () => {
    const fields = publishChoiceRequestFields({
      publishToTelegram: true,
      anonymous: true,
      message: " 附带的话 ",
    });
    expect(fields).toEqual({
      publishToTelegram: true,
      publishAnonymous: true,
      publishMessage: "附带的话",
    });
    expect(Object.keys(fields).sort()).toEqual(["publishAnonymous", "publishMessage", "publishToTelegram"]);
  });

  it("留言按码点限长，emoji 不会被切成半个字符", () => {
    const normalized = clampPublishMessage("🖤".repeat(PUBLISH_MESSAGE_MAX + 30));
    expect(Array.from(normalized)).toHaveLength(PUBLISH_MESSAGE_MAX);
    expect(normalized).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("编辑中不 trim：否则在词间打空格会被立刻吃掉（a b 变成 ab）", () => {
    // 归一化只做"去控制字符 + 收敛空行"，首尾空白留到提交时再裁。
    expect(clampPublishMessage("a\u0000b")).toBe("ab");
    expect(clampPublishMessage("\r\n第一行\r\n\r\n\r\n第二行\r\n")).toBe("\n第一行\n\n第二行\n");
    expect(clampPublishMessage("a ")).toBe("a ");
    // 提交那一刻才裁：请求体里没有首尾空白（服务端规则一致）。
    expect(
      publishChoiceRequestFields({ publishToTelegram: true, anonymous: true, message: " a " }).publishMessage,
    ).toBe("a");
  });

  it("摘要能说明当前选择（提交前不用再点开弹窗确认）", () => {
    expect(describePublishChoice(DEFAULT_PUBLISH_CHOICE)).toContain("仅自己可见");
    expect(describePublishChoice({ publishToTelegram: true, anonymous: true, message: "" })).toContain("匿名");
    expect(describePublishChoice({ publishToTelegram: true, anonymous: true, message: "" })).toContain("无留言");
    expect(describePublishChoice({ publishToTelegram: true, anonymous: false, message: "三个字" })).toContain(
      "显示 Telegram 身份",
    );
    expect(describePublishChoice({ publishToTelegram: true, anonymous: true, message: "三个字" })).toContain(
      "留言 3 字",
    );
  });

  it("publishMessageLength 按码点计数（界面上显示 200/200 就是真的 200 个字）", () => {
    expect(publishMessageLength("🖤🖤")).toBe(2);
    expect(publishMessageLength("🖤".repeat(PUBLISH_MESSAGE_MAX + 5))).toBe(PUBLISH_MESSAGE_MAX);
  });
});

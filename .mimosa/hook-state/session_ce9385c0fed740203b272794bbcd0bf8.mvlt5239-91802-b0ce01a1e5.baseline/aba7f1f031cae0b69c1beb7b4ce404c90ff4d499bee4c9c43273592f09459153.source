import { describe, expect, it } from "vitest";

import type { Env } from "../../../src/index";
import { planWebAnswer } from "../../../src/http/survey/answers";

/**
 * 文本答案的长度上限。
 *
 * 这层曾经完全不存在:text/long_text 的答案只要「是字符串」就原样入库,
 * 不读题目配置的 validationJson,也没有绝对上限——注册用户可以一发请求
 * 写入几 MB 的文本,撑爆 D1 行(>1MB 直接 500)或吃掉平台共享的行数预算。
 *
 * 语义:先执行题目配置的 min_length/max_length(作者设置的规则必须生效),
 * 再用绝对上限兜底「没配置 validation 的题」。长度按 Unicode 码点数
 * (Array.from),与前端 maxLength 计数一致,emoji 不算两个字符。
 */

function makeQuestion(validationJson: string | null) {
  return {
    id: 7,
    surveyId: 1,
    type: "long_text",
    title: "文本题",
    description: null,
    required: false,
    order: 0,
    pageId: null,
    validationJson,
    settingsJson: null,
    parentQuestionId: null,
    conditionJson: null,
    skipToQuestionId: null,
    createdAt: "",
    updatedAt: "",
    options: [],
  } as unknown as Parameters<typeof planWebAnswer>[2];
}

/** planWebAnswer 的 text 分支合法时最多规划一条 upsert,桩 db 只需接住它。 */
const STUB_ENV = {
  DB: {
    prepare: () => ({
      bind: () => ({}),
    }),
  },
} as unknown as Env;

async function expectStatements(question: ReturnType<typeof makeQuestion>, value: string) {
  const plan = await planWebAnswer(STUB_ENV, 1, question, value);
  expect(plan).toHaveProperty("statements");
}

async function expectError(question: ReturnType<typeof makeQuestion>, value: string, code: string) {
  const plan = await planWebAnswer(STUB_ENV, 1, question, value);
  if (!("error" in plan)) throw new Error(`expected error for length ${Array.from(value).length}`);
  expect(plan.error.status).toBe(400);
  const body = (await plan.error.json()) as { code: string };
  expect(body.code).toBe(code);
}

describe("文本答案长度上限", () => {
  it("执行题目配置的 max_length", async () => {
    const question = makeQuestion(JSON.stringify({ max_length: 10 }));
    await expectStatements(question, "深".repeat(10));
    await expectError(question, "深".repeat(11), "answer_too_long");
  });

  it("执行题目配置的 min_length", async () => {
    const question = makeQuestion(JSON.stringify({ min_length: 5 }));
    await expectError(question, "深".repeat(4), "answer_too_short");
    await expectStatements(question, "深".repeat(5));
  });

  it("validation JSON 损坏时回落到绝对上限而不是报 500", async () => {
    const question = makeQuestion("{not json");
    await expectStatements(question, "深".repeat(50_000));
  });

  it("没有配置 validation 的题也有绝对上限(默认 100000 码点)", async () => {
    const question = makeQuestion(null);
    await expectStatements(question, "深".repeat(100_000));
    await expectError(question, "深".repeat(100_001), "answer_too_long");
  });

  it("配置的 max_length 超过绝对上限时被压到绝对上限", async () => {
    const question = makeQuestion(JSON.stringify({ max_length: 5_000_000 }));
    await expectError(question, "深".repeat(100_001), "answer_too_long");
  });

  it("长度按 Unicode 码点计,emoji 一个算一个", async () => {
    const question = makeQuestion(JSON.stringify({ max_length: 3 }));
    await expectStatements(question, "😀😀😀");
    await expectError(question, "😀😀😀😀", "answer_too_long");
  });
});

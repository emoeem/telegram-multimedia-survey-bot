import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchMicrosoftFormsCover,
  fetchMicrosoftFormsSurveyJson,
  isFormsUrl,
} from "../../../src/services/microsoft-forms.service";

const FORM_DEFINITION = {
  id: "form-1",
  title: "测试问卷",
  description: "描述",
  background: {
    resourceUrl: "https://hive.forms.usercontent.microsoft/images/x/bg.jpg",
    contentType: "image/jpeg",
    width: 1600,
    height: 900,
    originalFileName: "bg.jpg",
  },
  questions: [
    {
      id: "q1",
      type: "Question.Choice",
      title: "您的性别？",
      required: true,
      order: 1000500,
      questionInfo: JSON.stringify({
        Choices: [{ Description: "男" }, { Description: "女" }],
        ChoiceType: 1,
        AllowOtherAnswer: false,
      }),
      image: {
        resourceUrl: "https://example.invalid/img.png",
        contentType: "image/png",
        width: 100,
        height: 50,
      },
    },
    {
      id: "q2",
      type: "Question.Choice",
      title: "喜欢的颜色（多选）",
      required: false,
      order: 2000500,
      allowMultipleValues: true,
      questionInfo: JSON.stringify({
        Choices: [{ Description: "红" }, { Description: "蓝" }],
        ChoiceType: 3,
        AllowOtherAnswer: true,
      }),
    },
    {
      id: "q3",
      type: "Question.Choice",
      title: "是否满意？",
      required: true,
      order: 3000500,
      questionInfo: JSON.stringify({
        Choices: [{ Description: "是" }, { Description: "否" }],
        ChoiceType: 1,
        AllowOtherAnswer: false,
      }),
    },
    {
      id: "q4",
      type: "Question.TextField",
      title: "建议",
      subtitle: "选填",
      required: false,
      order: 4000500,
      questionInfo: JSON.stringify({ Multiline: true }),
    },
    {
      id: "q5",
      type: "Question.Rating",
      title: "打分",
      required: true,
      order: 5000500,
      questionInfo: JSON.stringify({ Length: 5 }),
    },
  ],
};

function formsPage(apiUrl: string): string {
  return `<html><head><title>Microsoft Forms</title></head><body>
<script>
window.OfficeFormServerInfo = {"antiForgeryToken":"tok","serverSessionId":"sess","prefetchFormUrl":"${apiUrl}"};
</script>
</body></html>`;
}

function stubFetch(routes: Record<string, { status: number; body: string }>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const route = routes[url];
      if (!route) {
        return new Response("not found", { status: 404 });
      }
      return new Response(route.body, { status: route.status });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isFormsUrl", () => {
  it("recognizes Microsoft Forms hosts", () => {
    expect(isFormsUrl("https://forms.office.com/r/abc")).toBe(true);
    expect(isFormsUrl("https://forms.cloud.microsoft/pages/responsepage.aspx?id=x")).toBe(true);
    expect(isFormsUrl("https://forms.microsoft.com/Pages/ResponsePage.aspx?id=x")).toBe(true);
    expect(isFormsUrl("https://example.com/form")).toBe(false);
    expect(isFormsUrl("not a url")).toBe(false);
  });
});

describe("fetchMicrosoftFormsSurveyJson", () => {
  it("converts a public form into the standard survey JSON", async () => {
    const page = formsPage("https://forms.cloud.microsoft/formapi/api/form");
    stubFetch({
      "https://forms.office.com/r/abc": { status: 200, body: page },
      "https://forms.cloud.microsoft/formapi/api/form": {
        status: 200,
        body: JSON.stringify(FORM_DEFINITION),
      },
    });

    const content = await fetchMicrosoftFormsSurveyJson("https://forms.office.com/r/abc");
    const survey = JSON.parse(content) as {
      schema_version: number;
      survey: {
        title: string;
        metadata: { source: string };
        cover?: { url: string };
        questions: Array<{
          id: string;
          type: string;
          title: string;
          required: boolean;
          options: Array<{ value: string }>;
          media: Array<{ url: string }>;
          description?: string;
        }>;
      };
    };

    expect(survey.schema_version).toBe(1);
    expect(survey.survey.title).toBe("测试问卷");
    expect(survey.survey.metadata.source).toBe("microsoft_forms");
    expect(survey.survey.cover?.url).toBe("https://hive.forms.usercontent.microsoft/images/x/bg.jpg");

    const byId = new Map(survey.survey.questions.map((q) => [q.id, q]));
    expect(byId.get("q1")?.type).toBe("single");
    expect(byId.get("q1")?.options.map((option) => option.value)).toEqual(["男", "女"]);
    expect(byId.get("q1")?.media[0]?.url).toBe("https://example.invalid/img.png");

    expect(byId.get("q2")?.type).toBe("multiple");
    expect(byId.get("q2")?.options.map((option) => option.value)).toEqual(["红", "蓝", "其他"]);

    expect(byId.get("q3")?.type).toBe("yes_no");
    expect(byId.get("q4")?.type).toBe("long_text");
    expect(byId.get("q4")?.description).toBe("选填");
    expect(byId.get("q5")?.type).toBe("rating");
    expect(byId.get("q5")?.options).toHaveLength(5);
  });

  it("reports auth-required forms clearly", async () => {
    stubFetch({
      "https://forms.office.com/r/private": {
        status: 403,
        body: "<html>sign in</html>",
      },
    });
    await expect(fetchMicrosoftFormsSurveyJson("https://forms.office.com/r/private")).rejects.toMatchObject({
      code: "DOCUMENT_REQUIRES_AUTH",
    });
  });

  it("reports pages without embedded form info", async () => {
    stubFetch({
      "https://forms.office.com/r/empty": { status: 200, body: "<html></html>" },
    });
    await expect(fetchMicrosoftFormsSurveyJson("https://forms.office.com/r/empty")).rejects.toMatchObject({
      code: "FORMS_PARSE_FAILED",
    });
  });

  it("fetches only the cover image for backfill", async () => {
    const page = formsPage("https://forms.cloud.microsoft/formapi/api/form");
    stubFetch({
      "https://forms.office.com/r/cover": { status: 200, body: page },
      "https://forms.cloud.microsoft/formapi/api/form": {
        status: 200,
        body: JSON.stringify(FORM_DEFINITION),
      },
    });

    const cover = await fetchMicrosoftFormsCover("https://forms.office.com/r/cover");
    expect(cover?.url).toBe("https://hive.forms.usercontent.microsoft/images/x/bg.jpg");
    expect(cover?.mimeType).toBe("image/jpeg");
    expect(cover?.width).toBe(1600);
  });
});

/**
 * Multi-select detection mirrors real public forms: allowMultipleValues stays
 * null there and questionInfo.ChoiceType 2 marks multi-select (ChoiceType 1 is
 * single). Branching (mfpBranchingData) is best-effort — see
 * convertFormsBranching for the exact contract.
 */
describe("fetchMicrosoftFormsSurveyJson · choice types and branching", () => {
  interface ConvertedQuestion {
    id: string;
    type: string;
    options: Array<{ value: string }>;
    condition?: { kind: string; rules: Array<{ optionId: string; targetQuestionId: string }> };
  }
  interface ConvertedSurvey {
    survey: { questions: ConvertedQuestion[]; metadata: { warnings?: string[] } };
  }

  async function convert(definition: Record<string, unknown>): Promise<ConvertedSurvey> {
    const page = formsPage("https://forms.cloud.microsoft/formapi/api/form");
    stubFetch({
      "https://forms.office.com/r/convert": { status: 200, body: page },
      "https://forms.cloud.microsoft/formapi/api/form": { status: 200, body: JSON.stringify(definition) },
    });
    return JSON.parse(await fetchMicrosoftFormsSurveyJson("https://forms.office.com/r/convert")) as ConvertedSurvey;
  }

  const choiceQuestion = (id: string, title: string, choiceType: number, descriptions: string[]) => ({
    id,
    type: "Question.Choice",
    title,
    required: false,
    order: 1000500,
    questionInfo: JSON.stringify({
      Choices: descriptions.map((description) => ({ Description: description })),
      ChoiceType: choiceType,
      AllowOtherAnswer: false,
    }),
  });

  it("imports real-form multi-select (ChoiceType 2, allowMultipleValues null) as multiple", async () => {
    const survey = await convert({
      id: "form-real",
      title: "真实表单",
      questions: [
        choiceQuestion("rq1", "多选题", 2, ["A", "B", "C"]),
        choiceQuestion("rq2", "单选题", 1, ["红", "蓝"]),
      ],
    });
    const byId = new Map(survey.survey.questions.map((question) => [question.id, question]));
    expect(byId.get("rq1")?.type).toBe("multiple");
    expect(byId.get("rq1")?.options).toHaveLength(3);
    expect(byId.get("rq2")?.type).toBe("single");
  });

  it("imports forms without branching without conditions or warnings", async () => {
    const survey = await convert({
      id: "form-nobranch",
      title: "无跳转",
      mfpBranchingData: null,
      questions: [choiceQuestion("nq1", "单选", 1, ["是", "否"])],
    });
    expect(survey.survey.questions[0]?.condition).toBeUndefined();
    expect(survey.survey.metadata.warnings ?? []).toEqual([]);
  });

  it("converts branching rules into option jump conditions", async () => {
    const survey = await convert({
      id: "form-branch",
      title: "带跳转",
      mfpBranchingData: JSON.stringify({ bq1: { "1": "bq3", "2": "bq2" } }),
      questions: [
        choiceQuestion("bq1", "第一题", 1, ["走A线", "走B线"]),
        choiceQuestion("bq2", "B线", 1, ["继续", "算了"]),
        choiceQuestion("bq3", "A线", 1, ["继续", "算了"]),
      ],
    });
    const byId = new Map(survey.survey.questions.map((question) => [question.id, question]));
    expect(byId.get("bq1")?.condition).toEqual({
      kind: "option_equals",
      rules: [
        { optionId: "bq1_o1", targetQuestionId: "bq3" },
        { optionId: "bq1_o2", targetQuestionId: "bq2" },
      ],
    });
    expect(survey.survey.metadata.warnings ?? []).toEqual([]);
  });

  it("warns instead of guessing when branching cannot be mapped", async () => {
    const survey = await convert({
      id: "form-branch-warn",
      title: "跳转告警",
      // "end" targets are not expressible, "0" is out of range, "bq1" is a
      // backward target the runtime cannot honour.
      mfpBranchingData: JSON.stringify({
        wq1: { "1": "end", "2": "wq2", "0": "wq2" },
        wq2: { "1": "wq1" },
      }),
      questions: [
        choiceQuestion("wq1", "第一题", 1, ["结束", "继续"]),
        choiceQuestion("wq2", "第二题", 1, ["回头", "继续"]),
      ],
    });
    const byId = new Map(survey.survey.questions.map((question) => [question.id, question]));
    expect(byId.get("wq1")?.condition).toEqual({
      kind: "option_equals",
      rules: [{ optionId: "wq1_o2", targetQuestionId: "wq2" }],
    });
    expect(byId.get("wq2")?.condition).toBeUndefined();
    const warnings = survey.survey.metadata.warnings ?? [];
    expect(warnings.join("\n")).toContain("结束表单");
    expect(warnings.join("\n")).toContain("向后跳转");
    expect(warnings.join("\n")).toContain("无法对应的选项");
  });

  it("warns when the branching payload cannot be parsed", async () => {
    const survey = await convert({
      id: "form-branch-bad",
      title: "坏跳转数据",
      mfpBranchingData: "{not-json",
      questions: [choiceQuestion("pq1", "单选", 1, ["是", "否"])],
    });
    expect(survey.survey.questions[0]?.condition).toBeUndefined();
    expect((survey.survey.metadata.warnings ?? []).join("\n")).toContain("无法解析");
  });
});

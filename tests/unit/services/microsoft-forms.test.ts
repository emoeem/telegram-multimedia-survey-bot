import { afterEach, describe, expect, it, vi } from "vitest";

import {
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

function stubFetch(
  routes: Record<string, { status: number; body: string }>,
): void {
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
    expect(
      isFormsUrl(
        "https://forms.cloud.microsoft/pages/responsepage.aspx?id=x",
      ),
    ).toBe(true);
    expect(isFormsUrl("https://forms.microsoft.com/Pages/ResponsePage.aspx?id=x")).toBe(
      true,
    );
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

    const content = await fetchMicrosoftFormsSurveyJson(
      "https://forms.office.com/r/abc",
    );
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
    expect(survey.survey.cover?.url).toBe(
      "https://hive.forms.usercontent.microsoft/images/x/bg.jpg",
    );

    const byId = new Map(survey.survey.questions.map((q) => [q.id, q]));
    expect(byId.get("q1")?.type).toBe("single");
    expect(byId.get("q1")?.options.map((option) => option.value)).toEqual([
      "男",
      "女",
    ]);
    expect(byId.get("q1")?.media[0]?.url).toBe("https://example.invalid/img.png");

    expect(byId.get("q2")?.type).toBe("multiple");
    expect(byId.get("q2")?.options.map((option) => option.value)).toEqual([
      "红",
      "蓝",
      "其他",
    ]);

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
    await expect(
      fetchMicrosoftFormsSurveyJson("https://forms.office.com/r/private"),
    ).rejects.toMatchObject({
      code: "DOCUMENT_REQUIRES_AUTH",
    });
  });

  it("reports pages without embedded form info", async () => {
    stubFetch({
      "https://forms.office.com/r/empty": { status: 200, body: "<html></html>" },
    });
    await expect(
      fetchMicrosoftFormsSurveyJson("https://forms.office.com/r/empty"),
    ).rejects.toMatchObject({
      code: "FORMS_PARSE_FAILED",
    });
  });
});

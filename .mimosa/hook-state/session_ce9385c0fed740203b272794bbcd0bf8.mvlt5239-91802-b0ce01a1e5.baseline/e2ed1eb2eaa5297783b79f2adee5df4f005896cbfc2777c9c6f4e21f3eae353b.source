import { describe, expect, it } from "vitest";
import { isZohoUrl, zohoHtmlToSurvey } from "../../../src/services/zoho-forms.service";

describe("Zoho Forms importer", () => {
  it("accepts public Zoho hosts only", () => {
    expect(isZohoUrl("https://forms.zohopublic.com/example/form/abc")).toBe(true);
    expect(isZohoUrl("https://forms.zoho.com.cn/example/form/abc")).toBe(true);
    expect(isZohoUrl("https://example.com/forms/abc")).toBe(false);
  });

  it("maps server-rendered fields to the unified survey shape", () => {
    const survey = zohoHtmlToSurvey(`
      <html><head>
        <meta property="og:title" content="我的 Zoho 问卷">
        <meta property="og:description" content="公开介绍">
      </head><body>
        <ul>
          <li elname="livefield-elem" comptype="13" compname="role" mandatory="true">
            <label class="labelName"><span>你的角色 *</span></label>
            <input type="radio" value="学生"><label>学生</label>
            <input type="radio" value="教师"><label>教师</label>
          </li>
          <li elname="livefield-elem" comptype="15" compname="topics">
            <label class="labelName"><span>感兴趣的主题</span></label>
            <select multiple><option>设计</option><option>工程</option></select>
          </li>
          <li elname="livefield-elem" comptype="21" compname="score">
            <label class="labelName"><span>评分</span></label>
            <div><a role="radio" rating_count="7"></a></div>
          </li>
          <li elname="livefield-elem" comptype="999" compname="other">
            <label class="labelName"><span>其他内容</span></label>
          </li>
        </ul>
      </body></html>
    `);

    expect(survey.title).toBe("我的 Zoho 问卷");
    expect(survey.description).toBe("公开介绍");
    expect(survey.questions.map((question) => question.type)).toEqual(["single", "multiple", "rating", "text"]);
    expect(survey.questions[0]).toMatchObject({ title: "你的角色", required: true });
    expect(survey.questions[0]?.options?.map((option) => option.value)).toEqual(["学生", "教师"]);
    expect(survey.questions[1]?.options).toHaveLength(2);
    expect(survey.questions[2]?.options).toHaveLength(7);
    expect(survey.questions[3]?.warnings).toContain("未识别的 Zoho 题型 comptype=999，已按文本题导入");
  });
});

import { describe, expect, it } from "vitest";

import { convertPdfDetectedSurveyToUnified } from "../../../../src/import/pdf/survey-converter";
import type { PdfDetectedSurvey } from "../../../../src/import/pdf/document-model";

describe("pdf survey converter", () => {
  it("converts detected PDF questions to unified schema", () => {
    const detected: PdfDetectedSurvey = {
      title: "Sample Survey",
      pages: [{ id: "page_1", order: 1 }],
      questions: [
        {
          id: "q1",
          type: "single",
          title: "Question 1",
          required: true,
          page_id: "page_1",
          options: [
            { id: "a", label: "A", value: "a", order: 1 },
          ],
          media: [],
          warnings: [],
        },
      ],
      warnings: [],
    };

    const unified = convertPdfDetectedSurveyToUnified(detected);

    expect(unified.schema_version).toBe(1);
    expect(unified.survey.title).toBe("Sample Survey");
    expect(unified.survey.questions[0]?.id).toBe("q1");
    expect(unified.survey.questions[0]?.page_id).toBe("page_1");
  });
});

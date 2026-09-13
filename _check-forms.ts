import { fetchMicrosoftFormsSurveyJson } from "./src/services/microsoft-forms.service.ts";

const url = "https://forms.cloud.microsoft/pages/responsepage.aspx?id=DQSIkWdsW0yxEjajBLZtrQAAAAAAAAAAAANAATdkaMNUNUowMUgzRFNZSjI5UzRLSjc4MEgyRUlDQi4u&route=shorturl";

try {
  const result = await fetchMicrosoftFormsSurveyJson(url);
  console.log("Title:", result.title);
  console.log("Questions:", result.questions.length);
  for (const q of result.questions) {
    const opts = q.options ? q.options.length : 0;
    const cols = q.settings?.columns ? q.settings.columns.length : 0;
    console.log(
      `  [${q.type}] order=${q.order} title="${(q.title || "").substring(0, 60)}" opts=${opts} cols=${cols}`,
    );
  }
} catch (e) {
  console.error("Error:", (e as Error).message);
}

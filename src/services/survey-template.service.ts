import type { QuestionType, Survey } from "../db/schema";
import { createSurvey } from "../db/repositories/survey.repository";
import { createQuestion, createQuestionOption } from "../db/repositories/question.repository";

export interface SurveyTemplate {
  id: "feedback" | "registration" | "satisfaction";
  title: string;
  description: string;
  questions: Array<{ type: QuestionType; title: string; required?: boolean; options?: string[] }>;
}

const templates: SurveyTemplate[] = [
  {
    id: "feedback", title: "活动反馈", description: "收集活动参与者的体验和建议。",
    questions: [
      { type: "rating", title: "你对本次活动的整体满意度如何？", required: true },
      { type: "single", title: "你最喜欢哪个环节？", required: true, options: ["内容", "互动", "组织", "场地"] },
      { type: "long_text", title: "你希望我们下次改进什么？" },
    ],
  },
  {
    id: "registration", title: "活动报名", description: "收集报名信息并确认参与意愿。",
    questions: [
      { type: "text", title: "你的姓名", required: true },
      { type: "text", title: "联系方式", required: true },
      { type: "single", title: "你是否确认参加？", required: true, options: ["确认参加", "暂不确定"] },
      { type: "long_text", title: "备注或特殊需求" },
    ],
  },
  {
    id: "satisfaction", title: "服务满意度", description: "快速了解客户对服务的满意程度。",
    questions: [
      { type: "rating", title: "你对服务质量的评分", required: true },
      { type: "rating", title: "你对响应速度的评分", required: true },
      { type: "yes_no", title: "你愿意推荐给朋友吗？", required: true },
      { type: "long_text", title: "其他建议" },
    ],
  },
];

export function listSurveyTemplates(): SurveyTemplate[] { return templates; }

export async function createSurveyFromTemplate(
  db: D1Database,
  ownerId: number,
  templateId: SurveyTemplate["id"],
): Promise<Survey> {
  const template = templates.find((item) => item.id === templateId);
  if (!template) throw new Error("问卷模板不存在");
  const survey = await createSurvey(db, { ownerId, title: template.title, description: template.description });
  for (const [index, item] of template.questions.entries()) {
    const questionId = await createQuestion(db, {
      surveyId: survey.id, type: item.type, title: item.title, required: item.required ?? false, order: index,
    });
    for (const [optionIndex, label] of (item.options ?? []).entries()) {
      await createQuestionOption(db, { questionId, label, value: label, order: optionIndex });
    }
  }
  return survey;
}

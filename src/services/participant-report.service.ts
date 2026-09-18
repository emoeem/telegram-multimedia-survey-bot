import type { SurveyQuestion } from "../db/schema";

export type ParticipantReportKind =
  | "personal_profile"
  | "assessment"
  | "preference"
  | "survey"
  | "form";

export interface ParticipantReportClassification {
  kind: ParticipantReportKind;
  label: string;
  resultTitle: string;
  answerSectionTitle: string;
  summaryTitle: string;
  hasScores: boolean;
  hasGallery: boolean;
  confidence: number;
}

const profileSignals = /姓名|昵称|头像|照片|职业|身份|城市|地区|年龄|生日|身高|体重|兴趣|爱好|个人简介|自我介绍/;
const preferenceSignals = /喜欢|偏好|最爱|选择|风格|口味|音乐|电影|阅读|品牌|类型/;
const assessmentSignals = /评分|满意度|能力|倾向|指数|测评|测试|量表|程度|表现|得分/;

export function classifyParticipantReport(
  questions: Array<Pick<SurveyQuestion, "type" | "title">>,
  hasExplicitResultRules: boolean,
): ParticipantReportClassification {
  const titles = questions.map((question) => question.title || "");
  const joined = titles.join(" ");
  const profileHits = titles.filter((title) => profileSignals.test(title)).length;
  const preferenceHits = titles.filter((title) => preferenceSignals.test(title)).length;
  const assessmentHits = titles.filter((title) => assessmentSignals.test(title)).length;
  const scoreTypes = questions.filter((question) => question.type === "rating").length;
  const mediaCount = questions.filter((question) => ["image", "video", "audio", "file"].includes(question.type)).length;
  const longTextCount = questions.filter((question) => question.type === "long_text").length;

  if (hasExplicitResultRules || scoreTypes >= 2 || assessmentHits >= 2) {
    return {
      kind: "assessment",
      label: "测评结果",
      resultTitle: "我的测评结果",
      answerSectionTitle: "我的回答",
      summaryTitle: "结果解读",
      hasScores: hasExplicitResultRules || scoreTypes > 0,
      hasGallery: mediaCount > 0,
      confidence: hasExplicitResultRules ? 1 : 0.86,
    };
  }

  if (profileHits >= 3) {
    return {
      kind: "personal_profile",
      label: "个人档案",
      resultTitle: "我的个人档案",
      answerSectionTitle: "我的资料",
      summaryTitle: "关于我",
      hasScores: false,
      hasGallery: mediaCount > 0,
      confidence: Math.min(0.99, 0.7 + profileHits * 0.05),
    };
  }

  if (preferenceHits >= 2 || /偏好|喜好|推荐/.test(joined)) {
    return {
      kind: "preference",
      label: "偏好画像",
      resultTitle: "我的偏好",
      answerSectionTitle: "我的选择",
      summaryTitle: "我的偏好画像",
      hasScores: false,
      hasGallery: mediaCount > 0,
      confidence: 0.8,
    };
  }

  if (questions.some((question) => question.type === "rating" || question.type === "matrix")) {
    return {
      kind: "survey",
      label: "问卷结果",
      resultTitle: "我的问卷结果",
      answerSectionTitle: "我的回答",
      summaryTitle: "我的回答概览",
      hasScores: scoreTypes > 0,
      hasGallery: mediaCount > 0,
      confidence: 0.72,
    };
  }

  return {
    kind: "form",
    label: longTextCount > 0 ? "问卷回答" : "提交结果",
    resultTitle: "我的回答",
    answerSectionTitle: "我的回答",
    summaryTitle: "填写内容",
    hasScores: false,
    hasGallery: mediaCount > 0,
    confidence: 0.9,
  };
}

export function defaultParticipantReportTemplate(reportKind: unknown, resultType: unknown): string | null {
  const kind = reportKind === "personal_profile" || resultType === "identity_card" ? "personal_profile" : reportKind;
  switch (kind) {
    case "personal_profile": return "identity";
    case "assessment": return "data";
    case "preference": return "magazine";
    case "survey": return "classic";
    case "form": return "transcript";
    default: return null;
  }
}

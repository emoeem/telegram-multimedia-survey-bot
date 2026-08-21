import type { PreparedReportContent, ReportAnswerItem, ReportTextItem, ReportViewModel } from "../model";
import { reportDensityMode } from "./page-planner";

export function normalizeReportText(value: string): string {
  return value.normalize("NFKC").replace(/[“”‘’'"`]/g, "").replace(/[\s，。！？、；：,.!?;:（）()【】\[\]]+/g, "").toLowerCase();
}

function excerpt(value: string, length: number): string {
  const clean = value.trim().replace(/\s+/g, " ");
  if (clean.length <= length) return clean;
  const boundary = Math.max(clean.lastIndexOf("。", length), clean.lastIndexOf("！", length), clean.lastIndexOf("？", length));
  return `${clean.slice(0, boundary > length * .55 ? boundary + 1 : length).trim()}…`;
}

function uniqueTextItems(items: ReportTextItem[]): ReportTextItem[] {
  const seenSources = new Set<string>();
  const seenText = new Set<string>();
  return items.filter((item) => {
    const fingerprint = normalizeReportText(item.text);
    if (!fingerprint || seenSources.has(item.sourceId) || seenText.has(fingerprint)) return false;
    seenSources.add(item.sourceId);
    seenText.add(fingerprint);
    return true;
  });
}

function isConsumed(answer: ReportAnswerItem, consumedSources: Set<string>, consumedText: string[]): boolean {
  if (consumedSources.has(answer.sourceId)) return true;
  const candidate = normalizeReportText(answer.value);
  return consumedText.some((value) => candidate === value || candidate.length > 60 && (value.includes(candidate) || candidate.includes(value)));
}

function verdictTitle(view: ReportViewModel): string {
  const title = view.hero.subtitle && !/问卷完成|自动整理|根据本次问卷/.test(view.hero.subtitle)
    ? view.hero.subtitle
    : view.hero.title;
  return excerpt(title || "保持清醒，也保留真实的自我", 40);
}

export function prepareReportContent(view: ReportViewModel): PreparedReportContent {
  const densityMode = reportDensityMode(view.contentStats.answerCount);
  const insights = uniqueTextItems(view.insights);
  const featuredSource = insights[0];
  const featuredInsight = featuredSource ? {
    ...featuredSource,
    id: `featured-${featuredSource.id}`,
    text: excerpt(featuredSource.text, 220),
  } : undefined;
  const analysisTitles = ["Core Personality", "Behavior Pattern", "Relationship Pattern", "Contradiction", "Final Insight"];
  const analysisSource = featuredSource && featuredSource.text.length <= 220 ? insights.slice(1) : insights;
  const analysis = analysisSource.map((item, index) => ({ ...item, title: analysisTitles[index] ?? item.title }));
  const consumedSources = new Set(analysis.map((item) => item.sourceId));
  const consumedText = analysis.map((item) => normalizeReportText(item.text));
  if (featuredSource) {
    consumedSources.add(featuredSource.sourceId);
    consumedText.push(normalizeReportText(featuredSource.text));
  }
  const quotes = uniqueTextItems(view.quotes)
    .filter((item) => !consumedSources.has(item.sourceId))
    .slice(0, 3);
  for (const quote of quotes) {
    consumedSources.add(quote.sourceId);
    consumedText.push(normalizeReportText(quote.text));
  }
  const remainingAnswers = view.profile.filter((answer) => !isConsumed(answer, consumedSources, consumedText));
  const ranked = [...remainingAnswers].sort((left, right) => right.value.length - left.value.length);
  const featuredAnswer = ranked.find((item) => item.value.length >= 120 && item.value.length <= 2400);
  const afterFeatured = ranked.filter((item) => item.id !== featuredAnswer?.id);
  const editorialLimit = densityMode === "compact" ? 4 : densityMode === "standard" ? 3 : 2;
  const compactLimit = densityMode === "compact" ? 8 : densityMode === "standard" ? 10 : densityMode === "extended" ? 8 : 6;
  const editorialAnswers = afterFeatured.filter((item) => item.value.length >= 55 && item.value.length <= 2400).slice(0, editorialLimit);
  const editorialIds = new Set(editorialAnswers.map((item) => item.id));
  const compactAnswers = remainingAnswers.filter((item) => item.id !== featuredAnswer?.id && !editorialIds.has(item.id)).slice(0, compactLimit).map((item) => ({
    ...item,
    value: item.value.length > 320 ? `${item.value.slice(0, 319)}…` : item.value,
  }));
  const summaryCandidate = view.summary && !analysis.some((item) => normalizeReportText(view.summary).includes(normalizeReportText(item.text)))
    ? view.summary
    : "这份画像不试图用单一标签定义你，而是呈现你稳定的驱动力、关系选择与内在张力。";
  const pillarSources = analysis.slice(0, 3).map((item) => excerpt(item.text, 34));
  const fallbackPillars = [view.tags[0] ?? "自主判断", view.tags[1] ?? "选择性亲密", view.tags[2] ?? "内在平衡"];
  return {
    densityMode,
    ...(featuredInsight ? { featuredInsight } : {}),
    analysis,
    quotes,
    ...(featuredAnswer ? { featuredAnswer } : {}),
    editorialAnswers,
    compactAnswers,
    verdict: {
      title: verdictTitle(view),
      summary: excerpt(summaryCandidate, 180),
      closing: "真正重要的不是被归类，而是看清自己如何选择。",
      pillars: ["CORE DRIVE", "RELATIONSHIP NEED", "INNER TENSION"].map((label, index) => ({ label, value: pillarSources[index] ?? fallbackPillars[index]! })),
    },
  };
}

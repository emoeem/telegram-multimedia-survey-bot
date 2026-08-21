import type { ResponseReport, ResponseReportPage } from "./model";

function allMediaIds(report: ResponseReport): Array<number | undefined> {
  return report.items.flatMap((item) => [
    ...item.questionMedia,
    ...item.answerMedia,
    ...item.options.flatMap((option) => option.media),
  ]).map((media) => media.id);
}

export function validateResponseReportSource(report: ResponseReport): void {
  const questionIds = report.items.map((item) => item.questionId);
  if (new Set(questionIds).size !== questionIds.length) throw new Error("Question coverage validation failed: duplicate question ID");
  for (let index = 0; index < report.items.length; index += 1) {
    const item = report.items[index]!;
    if (item.number !== index + 1) throw new Error(`Question order validation failed at question ${item.questionId}`);
    const optionIds = item.options.map((option) => option.id);
    if (new Set(optionIds).size !== optionIds.length) throw new Error(`Option coverage validation failed at question ${item.questionId}`);
    if (item.rawAnswer !== null && !item.answer.includes(item.rawAnswer) && !["single", "multiple", "yes_no", "rating", "matrix", "image", "video", "audio", "file"].includes(item.type)) throw new Error(`Answer integrity validation failed at question ${item.questionId}`);
    if (item.answered !== (item.answerId !== null)) throw new Error(`Answer coverage validation failed at question ${item.questionId}`);
    if (!item.answered && item.answer !== "未作答") throw new Error(`Unanswered state validation failed at question ${item.questionId}`);
    for (const media of [...item.questionMedia, ...item.answerMedia, ...item.options.flatMap((option) => option.media)]) {
      if (!media.label) throw new Error(`Media coverage validation failed at question ${item.questionId}`);
    }
    if (item.questionMedia.some((media) => media.role !== "question") || item.answerMedia.some((media) => media.role !== "answer") || item.options.some((option) => option.media.some((media) => media.role !== "option"))) throw new Error(`Media association validation failed at question ${item.questionId}`);
  }
  const definedMediaIds = allMediaIds(report).filter((id): id is number => id !== undefined);
  if (new Set(definedMediaIds).size !== definedMediaIds.length) throw new Error("Media association validation failed: duplicate media ID");
}

export function validateResponseReportPages(report: ResponseReport, pages: ResponseReportPage[]): void {
  const fragments = pages.flatMap((page) => page.fragments);
  const firstOccurrences = fragments.filter((fragment) => !fragment.continuation).map((fragment) => fragment.item.questionId);
  const sourceIds = report.items.map((item) => item.questionId);
  if (JSON.stringify(firstOccurrences) !== JSON.stringify(sourceIds)) throw new Error("Question coverage validation failed: rendered order differs from source");
  for (const item of report.items) {
    const itemFragments = fragments.filter((fragment) => fragment.item.questionId === item.questionId);
    if (!itemFragments.length) throw new Error(`Question coverage validation failed: missing question ${item.questionId}`);
    const renderedTitle = itemFragments.map((fragment) => fragment.title).filter((value): value is string => value !== undefined && value !== "").join("");
    const renderedDescription = itemFragments.map((fragment) => fragment.description).filter((value): value is string => value !== undefined && value !== "").join("");
    if (renderedTitle !== item.title || renderedDescription !== (item.description ?? "")) throw new Error(`Question text integrity validation failed at question ${item.questionId}`);
    const renderedOptionIds = itemFragments.flatMap((fragment) => item.options.slice(fragment.optionStart ?? 0, fragment.optionEnd ?? item.options.length).map((option) => option.id));
    const uniqueRenderedOptionIds = [...new Set(renderedOptionIds)];
    if (JSON.stringify(uniqueRenderedOptionIds) !== JSON.stringify(item.options.map((option) => option.id))) throw new Error(`Option coverage validation failed at question ${item.questionId}`);
    const answerParts = itemFragments.filter((fragment) => fragment.answer !== undefined).map((fragment) => fragment.answer).join("");
    if (answerParts && answerParts !== item.answer) throw new Error(`Answer integrity validation failed at question ${item.questionId}`);
    const renderedQuestionMedia = itemFragments.flatMap((fragment) => fragment.questionMedia ?? []);
    const renderedAnswerMedia = itemFragments.flatMap((fragment) => fragment.answerMedia ?? []);
    if (renderedQuestionMedia.length !== item.questionMedia.length || renderedAnswerMedia.length !== item.answerMedia.length) throw new Error(`Media coverage validation failed at question ${item.questionId}`);
    const renderedOptionMedia = item.options.flatMap((option) => {
      const explicitChunks = itemFragments.flatMap((fragment) => fragment.optionMediaById?.[String(option.id)] ?? []);
      return explicitChunks.length ? explicitChunks : option.media;
    });
    if (renderedOptionMedia.length !== item.options.reduce((sum, option) => sum + option.media.length, 0)) throw new Error(`Option media coverage validation failed at question ${item.questionId}`);
    if (item.type === "matrix") {
      const renderedColumnOrders = [...new Set(itemFragments.flatMap((fragment) => Array.from({ length: (fragment.matrixColumnEnd ?? item.matrixColumns?.length ?? 0) - (fragment.matrixColumnStart ?? 0) }, (_, index) => (fragment.matrixColumnStart ?? 0) + index)))];
      if (JSON.stringify(renderedColumnOrders) !== JSON.stringify((item.matrixColumns ?? []).map((_, index) => index))) throw new Error(`Matrix column coverage validation failed at question ${item.questionId}`);
    }
  }
}

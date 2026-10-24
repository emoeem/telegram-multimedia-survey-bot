export interface OrderedEntity {
  id: number;
  order: number;
}

export function isCompleteQuestionOrder(currentIds: number[], requestedIds: number[]): boolean {
  const currentIdSet = new Set(currentIds);
  return (
    requestedIds.length === currentIds.length &&
    new Set(requestedIds).size === currentIds.length &&
    requestedIds.every((id) => Number.isInteger(id) && currentIdSet.has(id))
  );
}

export function reorderByQuestionIds<T extends OrderedEntity>(questions: T[], questionIds: number[]): T[] | null {
  const currentIds = questions.map((question) => question.id);
  if (!isCompleteQuestionOrder(currentIds, questionIds)) return null;

  const questionsById = new Map(questions.map((question) => [question.id, question]));
  return questionIds.map((id, order) => ({ ...questionsById.get(id)!, order }));
}

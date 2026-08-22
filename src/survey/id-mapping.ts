/**
 * Stable ID conventions for the UnifiedSurvey exchange format.
 *
 * Database rows own numeric ids; the JSON exchange format derives stable
 * string ids from positions so export -> import round-trips are deterministic
 * and independent of any particular database sequence.
 */
export function surveyPageId(index: number): string {
  return `p${index + 1}`;
}

export function surveyQuestionId(index: number): string {
  return `q${index + 1}`;
}

export function surveyOptionId(questionIndex: number, optionIndex: number): string {
  return `q${questionIndex + 1}_o${optionIndex + 1}`;
}

export function surveyMediaId(mediaAssetId: number): string {
  return `m${mediaAssetId}`;
}

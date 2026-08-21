import type { Answer, ResultField, ResultStat } from "../db/schema";

export const RESULT_SCHEMA_VERSION = 1;

export type ResultJsonPrimitive = string | number | boolean | null;
export type ResultJsonValue =
  | ResultJsonPrimitive
  | ResultJsonValue[]
  | { [key: string]: ResultJsonValue };

export interface ResultProfileSnapshot {
  resultType: string;
  title: string | null;
  subtitle: string | null;
  fields: Record<string, ResultField>;
  stats: ResultStat[];
  tags: string[];
  images: Record<string, ResultJsonValue>;
  metadata: Record<string, ResultJsonValue>;
  schemaVersion: number;
}

export type ResultConditionOperator =
  | "equals"
  | "not_equals"
  | "exists"
  | "not_exists"
  | "greater_than"
  | "less_than"
  | "greater_or_equal"
  | "less_or_equal"
  | "contains"
  | "not_contains"
  | "in"
  | "not_in";

export interface ResultPathExpression {
  $from: string;
}

export interface ResultSumExpression {
  $sum: string[];
}

export type ResultValueExpression =
  | ResultJsonValue
  | ResultPathExpression
  | ResultSumExpression;

export interface ResultCondition {
  path: string;
  operator: ResultConditionOperator;
  value?: ResultValueExpression;
}

export interface ResultConditionGroup {
  all?: Array<ResultCondition | ResultConditionGroup>;
  any?: Array<ResultCondition | ResultConditionGroup>;
}

export interface ResultRule {
  when?: ResultCondition | ResultConditionGroup;
  set: Record<string, ResultValueExpression>;
}

export interface ResultProfileDefaults {
  resultType?: string;
  title?: string | null;
  subtitle?: string | null;
  fields?: Record<string, ResultField>;
  stats?: ResultStat[];
  tags?: string[];
  images?: Record<string, ResultJsonValue>;
  metadata?: Record<string, ResultJsonValue>;
}

export interface ResultRuleSetDefinition {
  schemaVersion: number;
  defaults?: ResultProfileDefaults;
  rules: ResultRule[];
}

export interface ResultEngineInput {
  answers: Answer[];
  ruleSet: ResultRuleSetDefinition;
}

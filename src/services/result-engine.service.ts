import type { Answer, ResultField, ResultStat } from "../db/schema";
import { normalizeAnswer } from "./answer-value-adapter.service";
import {
  RESULT_SCHEMA_VERSION,
  type ResultCondition,
  type ResultConditionGroup,
  type ResultEngineInput,
  type ResultJsonValue,
  type ResultProfileSnapshot,
  type ResultRule,
  type ResultRuleSetDefinition,
  type ResultValueExpression,
} from "../result/schema";

type ResultContextValue = ResultJsonValue | undefined;
type ResultContext = Record<string, unknown>;

const forbiddenPathSegments = new Set(["__proto__", "constructor", "prototype"]);
const conditionOperators = new Set<ResultCondition["operator"]>([
  "equals",
  "not_equals",
  "exists",
  "not_exists",
  "greater_than",
  "less_than",
  "greater_or_equal",
  "less_or_equal",
  "contains",
  "not_contains",
  "in",
  "not_in",
]);

function assertSafePath(path: string): string[] {
  const segments = path.split(".");
  if (
    segments.length === 0 ||
    segments.some((segment) =>
      !/^[A-Za-z0-9_-]+$/.test(segment) || forbiddenPathSegments.has(segment)
    )
  ) {
    throw new Error(`Invalid result rule path: ${path}`);
  }
  return segments;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function assertRuleTarget(path: string): void {
  const segments = assertSafePath(path);
  const valid = segments.length === 1 &&
    ["result_type", "title", "subtitle", "tags", "stats"].includes(segments[0] ?? "") ||
    segments.length === 2 && ["fields", "images", "metadata"].includes(segments[0] ?? "");
  if (!valid) throw new Error(`Unsupported result rule target: ${path}`);
}

function assertExpression(value: unknown, label: string): void {
  if (!isRecord(value)) {
    if (!isResultJsonValue(value)) throw new Error(`Invalid result expression: ${label}`);
    return;
  }
  const keys = Object.keys(value);
  if (keys.length === 1 && typeof value.$from === "string") {
    assertSafePath(value.$from);
    return;
  }
  if (keys.length === 1 && Array.isArray(value.$sum) && value.$sum.every((entry) => typeof entry === "string")) {
    value.$sum.forEach((path) => assertSafePath(path));
    return;
  }
  if (keys.some((key) => key.startsWith("$"))) {
    throw new Error(`Invalid result expression: ${label}`);
  }
  if (!isResultJsonValue(value)) throw new Error(`Invalid result expression: ${label}`);
}

function assertCondition(condition: unknown): void {
  if (!isRecord(condition)) throw new Error("Invalid result condition");
  if (typeof condition.path === "string") {
    assertSafePath(condition.path);
    if (typeof condition.operator !== "string" || !conditionOperators.has(condition.operator as ResultCondition["operator"])) {
      throw new Error("Invalid result condition operator");
    }
    if ("value" in condition) assertExpression(condition.value, "condition.value");
    return;
  }
  const all = Array.isArray(condition.all) ? condition.all : null;
  const any = Array.isArray(condition.any) ? condition.any : null;
  const hasAll = all !== null;
  const hasAny = any !== null;
  if (!hasAll && !hasAny) throw new Error("Invalid result condition group");
  if (all) all.forEach(assertCondition);
  if (any) any.forEach(assertCondition);
  if ((all?.length ?? 0) === 0 && (any?.length ?? 0) === 0) {
    throw new Error("Result condition group cannot be empty");
  }
}

export function parseResultRuleSet(input: string): ResultRuleSetDefinition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error("Result rule set must be valid JSON");
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== RESULT_SCHEMA_VERSION || !Array.isArray(parsed.rules)) {
    throw new Error("Unsupported result rule set schema");
  }
  for (const rule of parsed.rules) {
    if (!isRecord(rule) || !isRecord(rule.set)) throw new Error("Invalid result rule");
    if (rule.when !== undefined) assertCondition(rule.when);
    for (const [path, expression] of Object.entries(rule.set)) {
      assertRuleTarget(path);
      assertExpression(expression, `rule.set.${path}`);
    }
  }
  return parsed as unknown as ResultRuleSetDefinition;
}

function answerValue(answer: Answer): ResultJsonValue {
  return normalizeAnswer(answer).value;
}

function buildAnswerContext(answers: Answer[]): ResultContext {
  const answerContext: Record<string, unknown> = {};
  for (const answer of answers) {
    answerContext[String(answer.questionId)] = {
      value: answerValue(answer),
      text: answer.textValue,
      number: answer.numberValue,
      boolean: answer.booleanValue,
      rating: answer.ratingValue,
      date: answer.dateValue,
      time: answer.timeValue,
      json: answer.jsonValue,
    };
  }
  return { answers: answerContext };
}

function resolvePath(context: ResultContext, path: string): ResultContextValue {
  let value: unknown = context;
  for (const segment of assertSafePath(path)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return isResultJsonValue(value) ? value : undefined;
}

function isResultJsonValue(value: unknown): value is ResultJsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return true;
  }
  if (Array.isArray(value)) return value.every(isResultJsonValue);
  return Boolean(value && typeof value === "object" &&
    Object.values(value).every(isResultJsonValue));
}

function isPathExpression(value: ResultValueExpression): value is { $from: string } {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === 1 && typeof (value as { $from?: unknown }).$from === "string";
}

function isSumExpression(value: ResultValueExpression): value is { $sum: string[] } {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === 1 && Array.isArray((value as { $sum?: unknown }).$sum) &&
    (value as { $sum: unknown[] }).$sum.every((entry) => typeof entry === "string");
}

function resolveValue(context: ResultContext, expression: ResultValueExpression): ResultContextValue {
  if (isPathExpression(expression)) return resolvePath(context, expression.$from);
  if (isSumExpression(expression)) {
    return expression.$sum.reduce<number>((sum, path) => {
      const value = resolvePath(context, path);
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`Result sum requires a numeric value: ${path}`);
      }
      return sum + value;
    }, 0);
  }
  return expression;
}

function valuesEqual(left: ResultContextValue, right: ResultContextValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function evaluateCondition(
  context: ResultContext,
  condition: ResultCondition,
): boolean {
  const actual = resolvePath(context, condition.path);
  const expected = condition.value === undefined ? undefined : resolveValue(context, condition.value);
  switch (condition.operator) {
    case "exists": return actual !== undefined && actual !== null;
    case "not_exists": return actual === undefined || actual === null;
    case "equals": return valuesEqual(actual, expected);
    case "not_equals": return !valuesEqual(actual, expected);
    case "greater_than": return typeof actual === "number" && typeof expected === "number" && actual > expected;
    case "less_than": return typeof actual === "number" && typeof expected === "number" && actual < expected;
    case "greater_or_equal": return typeof actual === "number" && typeof expected === "number" && actual >= expected;
    case "less_or_equal": return typeof actual === "number" && typeof expected === "number" && actual <= expected;
    case "contains": return Array.isArray(actual)
      ? actual.some((entry) => valuesEqual(entry, expected))
      : typeof actual === "string" && typeof expected === "string" && actual.includes(expected);
    case "not_contains": return Array.isArray(actual)
      ? !actual.some((entry) => valuesEqual(entry, expected))
      : !(typeof actual === "string" && typeof expected === "string" && actual.includes(expected));
    case "in": return Array.isArray(expected) && expected.some((entry) => valuesEqual(actual, entry));
    case "not_in": return Array.isArray(expected) && !expected.some((entry) => valuesEqual(actual, entry));
  }
}

function matchesCondition(
  context: ResultContext,
  condition: ResultCondition | ResultConditionGroup,
): boolean {
  if ("path" in condition) return evaluateCondition(context, condition);
  const all = condition.all ?? [];
  const any = condition.any ?? [];
  if (all.length === 0 && any.length === 0) throw new Error("Result condition group cannot be empty");
  return (all.length === 0 || all.every((entry) => matchesCondition(context, entry))) &&
    (any.length === 0 || any.some((entry) => matchesCondition(context, entry)));
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function inferFieldType(value: ResultContextValue): ResultField["type"] {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (Array.isArray(value)) return "list";
  if (value && typeof value === "object") return "object";
  return "text";
}

function isResultField(value: unknown): value is ResultField {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { type?: unknown }).type === "string" &&
    "value" in value);
}

function setRuleValue(
  profile: ResultProfileSnapshot,
  path: string,
  value: ResultContextValue,
): void {
  const segments = assertSafePath(path);
  if (segments.length === 1) {
    if (segments[0] === "result_type") {
      if (typeof value !== "string") throw new Error("result_type must be text");
      profile.resultType = value;
      return;
    }
    if (segments[0] === "title" || segments[0] === "subtitle") {
      if (value !== null && typeof value !== "string") throw new Error(`${segments[0]} must be text or null`);
      profile[segments[0]] = value;
      return;
    }
    if (segments[0] === "tags") {
      if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) throw new Error("tags must be a text list");
      profile.tags = [...value];
      return;
    }
    if (segments[0] === "stats") {
      if (!Array.isArray(value) || !value.every((entry) => isStat(entry))) throw new Error("stats must be a stat list");
      profile.stats = cloneJson(value) as ResultStat[];
      return;
    }
  }
  if (segments.length === 2 && segments[0] === "fields") {
    const fieldId = segments[1];
    if (!fieldId) throw new Error("Result field id is required");
    if (isResultField(value)) {
      const field = value as ResultField;
      profile.fields[fieldId] = {
        id: fieldId,
        type: field.type,
        value: field.value,
        ...(field.label !== undefined ? { label: field.label } : {}),
        ...(field.max !== undefined ? { max: field.max } : {}),
      };
    } else {
      profile.fields[fieldId] = { id: fieldId, type: inferFieldType(value), value: cloneJson(value) };
    }
    return;
  }
  if (segments.length === 2 && (segments[0] === "images" || segments[0] === "metadata")) {
    const key = segments[1];
    if (!key || value === undefined) throw new Error(`${segments[0]} value is required`);
    profile[segments[0]][key] = cloneJson(value);
    return;
  }
  throw new Error(`Unsupported result rule target: ${path}`);
}

function isStat(value: unknown): value is ResultStat {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { label?: unknown }).label === "string" &&
    typeof (value as { value?: unknown }).value === "number" &&
    typeof (value as { max?: unknown }).max === "number");
}

function emptyProfile(ruleSet: ResultRuleSetDefinition): ResultProfileSnapshot {
  const defaults = ruleSet.defaults;
  return {
    resultType: defaults?.resultType ?? "custom",
    title: defaults?.title ?? null,
    subtitle: defaults?.subtitle ?? null,
    fields: cloneJson(defaults?.fields ?? {}),
    stats: cloneJson(defaults?.stats ?? []),
    tags: cloneJson(defaults?.tags ?? []),
    images: cloneJson(defaults?.images ?? {}),
    metadata: cloneJson(defaults?.metadata ?? {}),
    schemaVersion: RESULT_SCHEMA_VERSION,
  };
}

function applyRule(context: ResultContext, profile: ResultProfileSnapshot, rule: ResultRule): void {
  if (rule.when && !matchesCondition(context, rule.when)) return;
  for (const [path, expression] of Object.entries(rule.set)) {
    setRuleValue(profile, path, resolveValue(context, expression));
  }
}

export function calculateResultProfile(input: ResultEngineInput): ResultProfileSnapshot {
  if (input.ruleSet.schemaVersion !== RESULT_SCHEMA_VERSION) {
    throw new Error(`Unsupported result rule schema version: ${input.ruleSet.schemaVersion}`);
  }
  const profile = emptyProfile(input.ruleSet);
  const context = buildAnswerContext(input.answers);
  for (const rule of input.ruleSet.rules) applyRule(context, profile, rule);
  return profile;
}

export function serializeResultProfile(profile: ResultProfileSnapshot): {
  resultType: string;
  schemaVersion: number;
  title: string | null;
  subtitle: string | null;
  fieldsJson: string;
  statsJson: string;
  tagsJson: string;
  imagesJson: string;
  metadataJson: string;
} {
  return {
    resultType: profile.resultType,
    schemaVersion: profile.schemaVersion,
    title: profile.title,
    subtitle: profile.subtitle,
    fieldsJson: JSON.stringify(profile.fields),
    statsJson: JSON.stringify(profile.stats),
    tagsJson: JSON.stringify(profile.tags),
    imagesJson: JSON.stringify(profile.images),
    metadataJson: JSON.stringify(profile.metadata),
  };
}

function parseRecord(value: string, field: string): Record<string, ResultJsonValue> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Stored ResultProfile ${field} must be an object`);
  }
  return parsed as Record<string, ResultJsonValue>;
}

export function deserializeResultProfile(input: {
  resultType: string;
  schemaVersion: number;
  title: string | null;
  subtitle: string | null;
  fieldsJson: string;
  statsJson: string;
  tagsJson: string;
  imagesJson: string;
  metadataJson: string;
}): ResultProfileSnapshot {
  const fields = parseRecord(input.fieldsJson, "fields_json") as unknown as Record<string, ResultField>;
  const stats = JSON.parse(input.statsJson) as unknown;
  const tags = JSON.parse(input.tagsJson) as unknown;
  if (!Array.isArray(stats) || !stats.every(isStat)) {
    throw new Error("Stored ResultProfile stats_json must be a stat list");
  }
  if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === "string")) {
    throw new Error("Stored ResultProfile tags_json must be a text list");
  }
  return {
    resultType: input.resultType,
    schemaVersion: input.schemaVersion,
    title: input.title,
    subtitle: input.subtitle,
    fields,
    stats,
    tags,
    images: parseRecord(input.imagesJson, "images_json"),
    metadata: parseRecord(input.metadataJson, "metadata_json"),
  };
}

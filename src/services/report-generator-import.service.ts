import { parseImportedSurvey } from "./import.service";
import type { GeneratorQuestionSettings, GeneratorQuestionType } from "../db/repositories/image-generator.repository";

export interface ImportedReportQuestion {
  variableName: string;
  prompt: string;
  type: GeneratorQuestionType;
  required: boolean;
  options: string[];
  settings: GeneratorQuestionSettings;
}

export interface ImportedReportGenerator {
  name: string;
  description: string;
  questions: ImportedReportQuestion[];
  skippedCount: number;
}

function normalizePrompt(value: string): string {
  return value.replaceAll(/\s+/g, " ").replaceAll("*", "").trim().slice(0, 500);
}

function questionType(type: string): GeneratorQuestionType {
  if (type === "long_text" || type === "number" || type === "single" || type === "multiple" || type === "rating" || type === "image" || type === "date") return type;
  if (type === "yes_no") return "boolean";
  return "text";
}

export function parseReportGeneratorImport(input: string): ImportedReportGenerator {
  const survey = parseImportedSurvey(input);
  const questions: ImportedReportQuestion[] = [];
  let skippedCount = 0;

  for (const [index, source] of survey.questions.entries()) {
    const prompt = normalizePrompt(source.title);
    if (!prompt) {
      skippedCount += 1;
      continue;
    }
    const type = questionType(source.type);
    if (!["text", "long_text", "number", "single", "multiple", "rating", "image", "boolean", "date"].includes(type)) {
      skippedCount += 1;
      continue;
    }
    const options = (source.options ?? []).map((option) => option.label.trim()).filter(Boolean).slice(0, 50);
    if ((type === "single" || type === "multiple") && options.length < 2) {
      skippedCount += 1;
      continue;
    }
    questions.push({
      variableName: `imported_${index + 1}`,
      prompt,
      type,
      required: source.required !== false,
      options,
      settings: type === "rating" ? { min: 1, max: 10, step: 1 } : type === "image" ? { maxImages: 1 } : {},
    });
  }

  if (!questions.length) throw new Error("导入文件没有可使用的问题");
  return {
    name: `${survey.title}（导入草稿）`.slice(0, 80),
    description: `从 JSON 导入 ${questions.length} 道题；因格式不兼容跳过 ${skippedCount} 道题。`,
    questions,
    skippedCount,
  };
}

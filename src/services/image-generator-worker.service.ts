import { sendPhoto } from "../bot/telegram";
import { getGenerator, listGeneratorQuestions, type GeneratorQuestion } from "../db/repositories/image-generator.repository";
import { createReportResult } from "../db/repositories/image-generator.repository";
import { getVisualTemplateVersion } from "../db/repositories/visual-template.repository";
import { resolveResultVisualImages } from "./result-visual-image.service";
import { parseVisualTemplateDefinition } from "./visual-template-validator.service";
import type { ResultJsonValue, ResultProfileSnapshot } from "../result/schema";
import type { VisualReportSection } from "../visual-template/schema";
import { applyReportPresentation, type ReportContrastMode } from "./report-presentation.service";

export interface ImageGeneratorJobMessage { kind: "image_generator"; jobId: number; }
export function isImageGeneratorJobMessage(value: unknown): value is ImageGeneratorJobMessage { return Boolean(value && typeof value === "object" && (value as Record<string,unknown>).kind === "image_generator" && Number.isSafeInteger((value as Record<string,unknown>).jobId)); }

export type GeneratorInputValue = ResultJsonValue;

function generatorProfile(
  input: Record<string, GeneratorInputValue>,
  questions: GeneratorQuestion[],
  title: string,
): ResultProfileSnapshot {
  const fields: ResultProfileSnapshot["fields"] = {};
  const images: ResultProfileSnapshot["images"] = {};
  const stats: ResultProfileSnapshot["stats"] = [];
  const tags: string[] = [];
  const profile: ResultJsonValue[] = [];
  const status: ResultJsonValue[] = [];
  const summaries: string[] = [];
  const gallery: ResultJsonValue[] = [];
  for (const question of questions) {
    const value = input[question.variableName];
    if (value === undefined || value === null) continue;
    if (question.type === "image") {
      images[question.variableName] = value;
      if (Array.isArray(value)) gallery.push(...value);
      else gallery.push(value);
      continue;
    }
    if (question.type === "multiple" && Array.isArray(value)) tags.push(...value.filter((item): item is string => typeof item === "string"));
    if (question.type === "rating" && typeof value === "number") {
      stats.push({ id: question.variableName, label: question.prompt, value, max: question.settings.max ?? 10 });
    }
    if (question.type === "boolean") status.push({ name: question.prompt, passed: value === true });
    if (question.type === "long_text" && typeof value === "string") summaries.push(value);
    profile.push({ label: question.prompt, value });
    fields[question.variableName] = {
      id: question.variableName,
      label: question.prompt,
      type: question.type === "long_text" ? "long_text" : question.type === "number" || question.type === "rating" ? "number" : question.type === "boolean" ? "boolean" : question.type === "multiple" ? "tags" : question.type === "date" ? "date" : "text",
      value,
      ...(question.type === "rating" ? { max: question.settings.max ?? 10 } : {}),
    };
  }
  return { resultType:"report_generator", title, subtitle:null, fields, stats, tags, images, metadata:{ profile, status, summary: summaries.join("\n\n"), gallery }, schemaVersion:1 };
}

function adaptTemplate(input: string, questions: GeneratorQuestion[], backgroundAssetId: number | null, contrastMode: ReportContrastMode) {
  const template = parseVisualTemplateDefinition(input);
  const paths = new Set(template.variables.map((item) => item.path));
  const questionMap = new Map(questions.map((question) => [question.variableName, question]));
  const replace = (value?: string): string | undefined => value?.replace(/\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g, (_m,key:string) => {
    const question = questionMap.get(key);
    if (!question) return `{{${key}}}`;
    const image = question.type === "image";
    const path = image ? `result.images.${key}` : `result.fields.${key}`;
    if (!paths.has(path)) { template.variables.push({path,label:question.prompt,type: image ? "image" : question.type === "multiple" ? "tags" : question.type === "number" || question.type === "rating" ? "number" : question.type === "boolean" ? "boolean" : question.type === "date" ? "date" : "text"}); paths.add(path); }
    return `{{${path}}}`;
  });
  template.elements = template.elements.map((element) => {
    const next = { ...element };
    if (element.value) next.value = replace(element.value)!;
    if (element.source) next.source = replace(element.source)!;
    return next;
  });
  if (template.sections) {
    template.sections = template.sections.map((section) => ({
      ...section,
      ...(section.title ? { title: replace(section.title) } : {}),
      ...(section.subtitle ? { subtitle: replace(section.subtitle) } : {}),
      ...(section.source ? { source: replace(section.source) } : {}),
      ...(section.label ? { label: replace(section.label) } : {}),
      ...(section.value ? { value: replace(section.value) } : {}),
      ...(typeof section.max === "string" ? { max: replace(section.max) } : {}),
    }) as VisualReportSection);
  }
  return parseVisualTemplateDefinition(JSON.stringify(applyReportPresentation(template, backgroundAssetId, contrastMode)));
}
export async function enqueueImageGeneratorJob(db:D1Database,queue:Queue,input:{generatorId:number;templateId:number;templateVersion:number;values:Record<string,GeneratorInputValue>;backgroundAssetId:number|null;chatId:number;userId:number}):Promise<number>{
  const [questions, now] = await Promise.all([listGeneratorQuestions(db, input.generatorId), Promise.resolve(new Date().toISOString())]);
  const imageVariables = new Set(questions.filter((question) => question.type === "image").map((question) => question.variableName));
  const answers = Object.fromEntries(Object.entries(input.values).filter(([key]) => !imageVariables.has(key)));
  const media = Object.fromEntries(Object.entries(input.values).filter(([key]) => imageVariables.has(key)));
  const reportResultId = await createReportResult(db, { generatorId: input.generatorId, userId: input.userId, answers, media });
  const r=await db.prepare("INSERT INTO image_generator_jobs(generator_id,template_id,template_version,input_json,background_asset_id,chat_id,user_id,report_result_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)").bind(input.generatorId,input.templateId,input.templateVersion,JSON.stringify(input.values),input.backgroundAssetId,input.chatId,input.userId,reportResultId,now).run();const id=Number(r.meta?.last_row_id);await queue.send({kind:"image_generator",jobId:id} satisfies ImageGeneratorJobMessage);return id;
}
export async function processImageGeneratorMessage(env:{DB:D1Database;BOT_TOKEN:string}, body:unknown):Promise<void>{if(!isImageGeneratorJobMessage(body))return;const job=await env.DB.prepare("SELECT * FROM image_generator_jobs WHERE id=?").bind(body.jobId).first<Record<string,unknown>>();if(!job)return;const claim=await env.DB.prepare("UPDATE image_generator_jobs SET status='processing',attempts=attempts+1,error_message=NULL WHERE id=? AND status='queued'").bind(body.jobId).run();if(!(claim.meta?.changes))return;const [version,generator,questions]=await Promise.all([getVisualTemplateVersion(env.DB,Number(job.template_id),Number(job.template_version)),getGenerator(env.DB,Number(job.generator_id)),listGeneratorQuestions(env.DB,Number(job.generator_id))]);if(!version)throw new Error("generator template version not found");if(!generator)throw new Error("report generator not found");const values=JSON.parse(String(job.input_json)) as Record<string,GeneratorInputValue>;const profile=generatorProfile(values,questions,generator.name);const requestedBackground=typeof job.background_asset_id === "number" ? job.background_asset_id : null;const backgroundAssetId=requestedBackground??generator.reportBackgroundAssetId;const template=adaptTemplate(version.definitionJson,questions,backgroundAssetId,generator.reportContrastMode);const images=await resolveResultVisualImages(env.DB,env.BOT_TOKEN,template,profile);const[{renderResultVisualPng},{RESULT_VISUAL_FONTS},{RESULT_VISUAL_WASM}]=await Promise.all([import("./result-visual-renderer.service"),import("./result-visual-font"),import("./result-visual-wasm")]);const png=await renderResultVisualPng(template,profile,{wasmModule:RESULT_VISUAL_WASM,fontBuffers:RESULT_VISUAL_FONTS,images});await sendPhoto(env.BOT_TOKEN,Number(job.chat_id),png,`🎉 ${generator.name} 已生成`);await env.DB.prepare("UPDATE image_generator_jobs SET status='completed',completed_at=? WHERE id=?").bind(new Date().toISOString(),body.jobId).run();}
export async function retryImageGeneratorJob(db:D1Database,id:number,error:string,terminal:boolean):Promise<void>{await db.prepare("UPDATE image_generator_jobs SET status=?,error_message=?,completed_at=? WHERE id=?").bind(terminal?"failed":"queued",error.slice(0,500),terminal?new Date().toISOString():null,id).run();}

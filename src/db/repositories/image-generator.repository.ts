export type GeneratorStatus = "draft" | "published" | "archived";
export type GeneratorQuestionType = "text" | "long_text" | "number" | "single" | "multiple" | "rating" | "image" | "boolean" | "date";
export type GeneratorBackgroundMode = "preset" | "upload" | "both";
export type GeneratorContrastMode = "auto" | "light" | "dark";

export interface GeneratorQuestionSettings {
  minImages?: number;
  maxImages?: number;
  min?: number;
  max?: number;
  step?: number;
}

export interface ImageGenerator { id: number; ownerId: number; name: string; description: string | null; templateId: number; status: GeneratorStatus; backgroundMode: GeneratorBackgroundMode; reportBackgroundAssetId: number | null; reportContrastMode: GeneratorContrastMode; }
export interface GeneratorQuestion { id: number; generatorId: number; variableName: string; prompt: string; type: GeneratorQuestionType; required: boolean; options: string[]; settings: GeneratorQuestionSettings; sortOrder: number; }
export interface GeneratorBackground { id: number; generatorId: number; assetId: number; label: string; sortOrder: number; }

function mapGenerator(row: Record<string, unknown>): ImageGenerator { return { id: Number(row.id), ownerId: Number(row.owner_id), name: String(row.name), description: typeof row.description === "string" ? row.description : null, templateId: Number(row.template_id), status: row.status as GeneratorStatus, backgroundMode: row.background_mode as GeneratorBackgroundMode, reportBackgroundAssetId: typeof row.report_background_asset_id === "number" ? row.report_background_asset_id : null, reportContrastMode: row.report_contrast_mode === "light" || row.report_contrast_mode === "dark" ? row.report_contrast_mode : "auto" }; }
function jsonStringArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(typeof value === "string" ? value : "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string").slice(0, 50) : [];
  } catch { return []; }
}
function jsonSettings(value: unknown): GeneratorQuestionSettings {
  try {
    const parsed = JSON.parse(typeof value === "string" ? value : "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    const number = (key: string): number | undefined => typeof record[key] === "number" && Number.isFinite(record[key]) ? record[key] : undefined;
    const entries = ["minImages", "maxImages", "min", "max", "step"].flatMap((key) => {
      const parsedNumber = number(key);
      return parsedNumber === undefined ? [] : [[key, parsedNumber] as const];
    });
    return Object.fromEntries(entries) as GeneratorQuestionSettings;
  } catch { return {}; }
}
function mapQuestion(row: Record<string, unknown>): GeneratorQuestion { return { id: Number(row.id), generatorId: Number(row.generator_id), variableName: String(row.variable_name), prompt: String(row.prompt), type: row.type as GeneratorQuestionType, required: Number(row.required) === 1, options: jsonStringArray(row.options_json), settings: jsonSettings(row.settings_json), sortOrder: Number(row.sort_order) }; }
function mapBackground(row: Record<string, unknown>): GeneratorBackground { return { id: Number(row.id), generatorId: Number(row.generator_id), assetId: Number(row.asset_id), label: String(row.label), sortOrder: Number(row.sort_order) }; }
export async function listPublishedGenerators(db: D1Database): Promise<ImageGenerator[]> { const r = await db.prepare("SELECT * FROM image_generators WHERE status = 'published' ORDER BY id DESC").all<Record<string, unknown>>(); return (r.results ?? []).map(mapGenerator); }
export async function listGenerators(db: D1Database): Promise<ImageGenerator[]> { const r = await db.prepare("SELECT * FROM image_generators ORDER BY id DESC").all<Record<string, unknown>>(); return (r.results ?? []).map(mapGenerator); }
export async function getGenerator(db: D1Database, id: number): Promise<ImageGenerator | null> { const r = await db.prepare("SELECT * FROM image_generators WHERE id = ?").bind(id).first<Record<string, unknown>>(); return r ? mapGenerator(r) : null; }
export async function createGenerator(db: D1Database, input: { ownerId: number; name: string; description?: string; templateId: number }): Promise<ImageGenerator> { const now = new Date().toISOString(); const r = await db.prepare("INSERT INTO image_generators (owner_id,name,description,template_id,created_at,updated_at) VALUES (?,?,?,?,?,?)").bind(input.ownerId,input.name,input.description ?? null,input.templateId,now,now).run(); return (await getGenerator(db, Number(r.meta?.last_row_id)))!; }
export async function updateGenerator(db: D1Database, id: number, input: Partial<Pick<ImageGenerator,"status"|"backgroundMode"|"templateId"|"reportBackgroundAssetId"|"reportContrastMode">>): Promise<void> { await db.prepare("UPDATE image_generators SET status=COALESCE(?,status), background_mode=COALESCE(?,background_mode), template_id=COALESCE(?,template_id), report_background_asset_id=CASE WHEN ? THEN ? ELSE report_background_asset_id END, report_contrast_mode=COALESCE(?,report_contrast_mode), updated_at=? WHERE id=?").bind(input.status ?? null,input.backgroundMode ?? null,input.templateId ?? null,Object.prototype.hasOwnProperty.call(input,"reportBackgroundAssetId") ? 1 : 0,input.reportBackgroundAssetId ?? null,input.reportContrastMode ?? null,new Date().toISOString(),id).run(); }
export async function deleteGenerator(db: D1Database, id: number): Promise<void> { await db.prepare("DELETE FROM image_generators WHERE id=?").bind(id).run(); }
export async function listGeneratorQuestions(db: D1Database, id: number): Promise<GeneratorQuestion[]> { const r=await db.prepare("SELECT * FROM image_generator_questions WHERE generator_id=? ORDER BY sort_order,id").bind(id).all<Record<string,unknown>>(); return (r.results??[]).map(mapQuestion); }
export async function addGeneratorQuestion(db: D1Database, input:{generatorId:number;variableName:string;prompt:string;type:GeneratorQuestionType;required:boolean;options?:string[];settings?:GeneratorQuestionSettings}):Promise<void>{const row=await db.prepare("SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM image_generator_questions WHERE generator_id=?").bind(input.generatorId).first<{n:number}>();await db.prepare("INSERT INTO image_generator_questions(generator_id,variable_name,prompt,type,required,options_json,settings_json,sort_order,created_at) VALUES(?,?,?,?,?,?,?,?,?)").bind(input.generatorId,input.variableName,input.prompt,input.type,input.required?1:0,JSON.stringify(input.options??[]),JSON.stringify(input.settings??{}),row?.n??1,new Date().toISOString()).run();}
export async function deleteGeneratorQuestion(db: D1Database, id: number): Promise<void> { await db.prepare("DELETE FROM image_generator_questions WHERE id=?").bind(id).run(); }
export async function moveGeneratorQuestion(db: D1Database, generatorId: number, id: number, direction: "up" | "down"): Promise<void> {
  const questions = await listGeneratorQuestions(db, generatorId); const index = questions.findIndex((question) => question.id === id); const target = index + (direction === "up" ? -1 : 1);
  if (index < 0 || target < 0 || target >= questions.length) return;
  const current = questions[index]!; const adjacent = questions[target]!;
  await db.batch([
    db.prepare("UPDATE image_generator_questions SET sort_order=? WHERE id=?").bind(adjacent.sortOrder, current.id),
    db.prepare("UPDATE image_generator_questions SET sort_order=? WHERE id=?").bind(current.sortOrder, adjacent.id),
  ]);
}
export async function createReportResult(db: D1Database, input: { generatorId: number; userId: number; answers: Record<string, unknown>; media: Record<string, unknown> }): Promise<number> {
  const result = await db.prepare("INSERT INTO report_results(generator_id,user_id,answers_json,media_json,created_at) VALUES(?,?,?,?,?)").bind(input.generatorId,input.userId,JSON.stringify(input.answers),JSON.stringify(input.media),new Date().toISOString()).run();
  return Number(result.meta?.last_row_id);
}
export async function listGeneratorBackgrounds(db:D1Database,id:number):Promise<GeneratorBackground[]>{const r=await db.prepare("SELECT * FROM image_generator_backgrounds WHERE generator_id=? ORDER BY sort_order,id").bind(id).all<Record<string,unknown>>();return(r.results??[]).map(mapBackground)}
export async function addGeneratorBackground(db:D1Database,input:{generatorId:number;assetId:number;label:string}):Promise<void>{const row=await db.prepare("SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM image_generator_backgrounds WHERE generator_id=?").bind(input.generatorId).first<{n:number}>();await db.prepare("INSERT INTO image_generator_backgrounds(generator_id,asset_id,label,sort_order,created_at) VALUES(?,?,?,?,?)").bind(input.generatorId,input.assetId,input.label,row?.n??1,new Date().toISOString()).run();}

import { getCustomReportTemplate } from "../../db/repositories/report-template.repository";
import {
  REPORT_TEMPLATES,
  validateReportTemplateSpec,
  type ReportTemplateSpec,
} from "./template";

/**
 * Resolves a template by id from the system registry first, then from
 * user-defined custom templates. Custom specs are re-validated on load so a
 * corrupt row never reaches a renderer.
 */
export async function resolveReportTemplate(
  db: D1Database,
  id: string | null | undefined,
): Promise<ReportTemplateSpec | undefined> {
  if (!id) return undefined;
  const system = REPORT_TEMPLATES[id];
  if (system) return system;
  const custom = await getCustomReportTemplate(db, id);
  if (!custom) return undefined;
  const parsed = validateReportTemplateSpec(custom.spec);
  return parsed.template;
}

import type { PreparedReportContent, ReportBlockSpec, ReportComposition, ReportCompositionRegion, ReportViewModel } from "../model";
import { reportLayouts, type ReportLayout } from "../layouts";

const block = (
  kind: ReportBlockSpec["kind"],
  presentation: ReportBlockSpec["presentation"],
  columnSpan = 12,
  readingWidth: ReportBlockSpec["readingWidth"] = "full",
  emphasis: ReportBlockSpec["emphasis"] = "standard",
): ReportBlockSpec => ({ id: kind, kind, presentation, columnSpan, readingWidth, emphasis, breakPolicy: presentation === "editorial" ? "auto" : "avoid" });

function region(id: ReportCompositionRegion["id"], role: ReportCompositionRegion["role"], blocks: ReportBlockSpec[]): ReportCompositionRegion {
  return { id, role, blocks };
}

function available(view: ReportViewModel, content: PreparedReportContent): Record<ReportBlockSpec["kind"], boolean> {
  return {
    hero: true,
    overview: view.scores.length > 0 || view.tags.length > 0,
    featured: Boolean(content.featuredInsight),
    analysis: content.analysis.length > 0,
    quotes: content.quotes.length > 0,
    responses: Boolean(content.featuredAnswer || content.editorialAnswers.length || content.compactAnswers.length),
    gallery: view.gallery.some((item) => item.url !== view.hero.avatar),
    verdict: true,
  };
}

export function composeReport(view: ReportViewModel, content: PreparedReportContent, layout: ReportLayout): ReportComposition {
  const has = available(view, content);
  const hero = region("opening", "hero", [block("hero", "editorial", 12, "full", "primary")]);
  const overview = region("overview", "overview", has.overview ? [block("overview", "data", 12, "full", "featured")] : []);
  const featured = region("featured", "featured", has.featured ? [block("featured", "quote", 12, "wide", "featured")] : []);
  const analysis = region("analysis", "analysis", has.analysis ? [block("analysis", "editorial", 12, "wide")] : []);
  const evidence = region("evidence", "evidence", [
    ...(has.quotes ? [block("quotes", "quote", 12, "wide")] : []),
    ...(has.responses ? [block("responses", "editorial", 12, "full")] : []),
  ]);
  const gallery = region("gallery", "gallery", has.gallery ? [block("gallery", "image", 12, "full")] : []);
  const finale = region("finale", "finale", [block("verdict", "editorial", 12, "full", "primary")]);
  const regionMap = new Map([hero, overview, featured, analysis, evidence, gallery, finale].map((item) => [item.role, item]));
  const regions = reportLayouts[layout].regionOrder.map((role) => regionMap.get(role)!).filter((item) => item.blocks.length > 0);
  const textVolume = content.analysis.reduce((sum, item) => sum + item.text.length, 0);
  const density = textVolume > 2400 ? "airy" : view.profile.length > 12 ? "compact" : reportLayouts[layout].density;
  return { layout, density, regions };
}

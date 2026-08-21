export type ReportLayout = "editorial" | "bento" | "magazine" | "data" | "gallery" | "profile";

export type ReportRegionRole = "hero" | "overview" | "featured" | "analysis" | "evidence" | "gallery" | "finale";

export interface ReportLayoutDefinition {
  id: ReportLayout;
  regionOrder: ReportRegionRole[];
  density: "airy" | "balanced" | "compact";
  emphasis: "text" | "overview" | "feature" | "data" | "images" | "identity";
}

export const reportLayouts: Record<ReportLayout, ReportLayoutDefinition> = {
  editorial: { id: "editorial", regionOrder: ["hero", "overview", "featured", "analysis", "evidence", "gallery", "finale"], density: "airy", emphasis: "text" },
  bento: { id: "bento", regionOrder: ["hero", "overview", "featured", "analysis", "evidence", "gallery", "finale"], density: "balanced", emphasis: "overview" },
  magazine: { id: "magazine", regionOrder: ["hero", "featured", "gallery", "analysis", "evidence", "overview", "finale"], density: "airy", emphasis: "feature" },
  data: { id: "data", regionOrder: ["hero", "overview", "analysis", "featured", "evidence", "gallery", "finale"], density: "compact", emphasis: "data" },
  gallery: { id: "gallery", regionOrder: ["hero", "gallery", "featured", "overview", "analysis", "evidence", "finale"], density: "airy", emphasis: "images" },
  profile: { id: "profile", regionOrder: ["hero", "overview", "featured", "evidence", "analysis", "gallery", "finale"], density: "balanced", emphasis: "identity" },
};

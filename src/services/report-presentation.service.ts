import type { VisualTemplateDefinition } from "../visual-template/schema";

export type ReportContrastMode = "auto" | "light" | "dark";

/**
 * Applies a generator-owned photograph without mutating the immutable template
 * version.  The card is intentionally generous: it protects every flowing
 * section from a busy or high-contrast background image.
 */
export function applyReportPresentation(
  definition: VisualTemplateDefinition,
  backgroundAssetId: number | null,
  contrastMode: ReportContrastMode = "auto",
): VisualTemplateDefinition {
  if (!backgroundAssetId) return definition;
  const dark = contrastMode === "dark";
  return {
    ...definition,
    background: { type: "telegram_asset", assetId: backgroundAssetId, fit: "cover" },
    report: {
      ...(definition.report ?? {}),
      readability: {
        mode: contrastMode,
        overlay: { color: dark ? "#020617" : "#ffffff", opacity: dark ? 0.48 : 0.32 },
        card: { color: dark ? "#0f172a" : "#ffffff", opacity: dark ? 0.90 : 0.90, radius: 36, inset: 28 },
        textColor: dark ? "#f8fafc" : "#172033",
        itemBackground: dark ? "#1e293b" : "#ffffff",
      },
    },
  };
}

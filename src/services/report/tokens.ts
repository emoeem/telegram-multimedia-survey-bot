export const reportTokens = {
  spacing: { 1: "8px", 2: "12px", 3: "16px", 4: "24px", 5: "32px", 6: "40px", 7: "56px", 8: "72px" },
  radius: { sm: "8px", md: "16px", lg: "24px", xl: "32px", pill: "999px" },
  typography: { xs: "11px", sm: "13px", md: "16px", lg: "18px", xl: "24px", "2xl": "30px", hero: "64px" },
  layout: { viewportWidth: "900px", contentWidth: "792px", readingWidth: "720px", gridGap: "18px", sectionGap: "56px", cardPadding: "24px" },
} as const;

export function reportTokenCss(): string {
  return `:root{${Object.entries(reportTokens.spacing).map(([key, value]) => `--report-space-${key}:${value};`).join("")}${Object.entries(reportTokens.radius).map(([key, value]) => `--report-radius-${key}:${value};`).join("")}${Object.entries(reportTokens.typography).map(([key, value]) => `--report-font-${key}:${value};`).join("")}--report-viewport-width:${reportTokens.layout.viewportWidth};--report-content-width:${reportTokens.layout.contentWidth};--report-reading-width:${reportTokens.layout.readingWidth};--report-grid-gap:${reportTokens.layout.gridGap};--report-section-gap:${reportTokens.layout.sectionGap};--report-card-padding:${reportTokens.layout.cardPadding};--font-display:ReportSans,ReportEmoji,"Noto Sans CJK SC","Microsoft YaHei",sans-serif;--font-heading:var(--font-display);--font-body:var(--font-display);--font-data:var(--font-display);--type-display:64px;--type-h2:30px;--type-h3:18px;--type-body:16px;--type-label:11px;--type-number:48px;--type-caption:11px}`;
}

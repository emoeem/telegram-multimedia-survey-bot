export type ReportBlockType = "hero" | "profile" | "score" | "metric-grid" | "bento" | "radar" | "progress" | "insight" | "quote" | "selected-answer" | "answer-grid" | "gallery" | "featured-image" | "summary" | "divider" | "metadata";

export interface ReportBlock { id: string; type: ReportBlockType; importance?: "primary" | "secondary" | "supporting"; density?: "hero" | "comfortable" | "compact"; }

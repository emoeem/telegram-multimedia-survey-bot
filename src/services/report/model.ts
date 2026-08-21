import type { ReportTheme } from "./themes";
import type { ReportLayout } from "./layouts";

export interface ReportScore {
  key: string;
  label: string;
  value: number;
  max: number;
  percentage: number;
  level: string;
  description?: string;
}

export interface ReportGalleryItem {
  url: string;
  width?: number;
  height?: number;
  aspectRatio?: number;
  orientation?: "portrait" | "landscape" | "square";
  pixelArea?: number;
  byteSize?: number;
  sourceHash?: string;
  caption?: string;
  questionTitle?: string;
}

export interface ReportTextItem {
  id: string;
  sourceId: string;
  title: string;
  text: string;
  tags?: string[];
}

export interface ReportAnswerItem {
  id: string;
  sourceId: string;
  label: string;
  value: string;
}

export interface ReportViewModel {
  hero: { title: string; subtitle: string; avatar?: string; coverImage?: string; tags: string[] };
  scores: ReportScore[];
  charts: { radar: Array<{ label: string; value: number }>; bars: ReportScore[] };
  tags: string[];
  insights: ReportTextItem[];
  quotes: ReportTextItem[];
  gallery: ReportGalleryItem[];
  summary: string;
  profile: ReportAnswerItem[];
  contentStats: { answerCount: number; imageCount: number; longTextCount: number; scoreCount: number };
  meta: { surveyTitle?: string; submittedAt?: string; reportId?: string; layout?: ReportLayout; theme?: ReportTheme };
}

export type ReportReadingWidth = "compact" | "standard" | "wide" | "full";
export type ReportPresentation = "editorial" | "card" | "bento-tile" | "quote" | "image" | "data";

export interface ReportBlockSpec {
  id: string;
  kind: "hero" | "overview" | "featured" | "analysis" | "quotes" | "responses" | "gallery" | "verdict";
  presentation: ReportPresentation;
  columnSpan: number;
  readingWidth: ReportReadingWidth;
  breakPolicy: "auto" | "avoid";
  emphasis: "primary" | "featured" | "standard" | "compact";
}

export interface ReportCompositionRegion {
  id: string;
  role: "hero" | "overview" | "featured" | "analysis" | "evidence" | "gallery" | "finale";
  blocks: ReportBlockSpec[];
}

export interface ReportComposition {
  layout: ReportLayout;
  density: "airy" | "balanced" | "compact";
  regions: ReportCompositionRegion[];
}

export interface PreparedReportContent {
  densityMode: "compact" | "standard" | "extended" | "large";
  featuredInsight?: ReportTextItem;
  analysis: ReportTextItem[];
  quotes: ReportTextItem[];
  featuredAnswer?: ReportAnswerItem;
  editorialAnswers: ReportAnswerItem[];
  compactAnswers: ReportAnswerItem[];
  verdict: {
    title: string;
    summary: string;
    closing: string;
    pillars: Array<{ label: string; value: string }>;
  };
}

export type ReportPageKind = "cover" | "overview" | "analysis" | "responses" | "gallery" | "verdict" | "mixed";

export type ReportPageBlock =
  | { id: string; kind: "hero"; priority: number; estimatedHeight: number }
  | { id: string; kind: "overview"; priority: number; estimatedHeight: number }
  | { id: string; kind: "featured"; priority: number; estimatedHeight: number; item: ReportTextItem }
  | { id: string; kind: "analysis"; priority: number; estimatedHeight: number; items: ReportTextItem[] }
  | { id: string; kind: "quotes"; priority: number; estimatedHeight: number; items: ReportTextItem[] }
  | { id: string; kind: "responses"; priority: number; estimatedHeight: number; featured?: ReportAnswerItem; editorial: ReportAnswerItem[]; compact: ReportAnswerItem[] }
  | { id: string; kind: "gallery"; priority: number; estimatedHeight: number; items: ReportGalleryItem[] }
  | { id: string; kind: "verdict"; priority: number; estimatedHeight: number };

export interface ReportPage {
  id: string;
  kind: ReportPageKind;
  blocks: ReportPageBlock[];
  estimatedHeight: number;
  priority: number;
}

export interface ReportArtifactPage {
  id: string;
  kind: ReportPageKind;
  bytes: Uint8Array;
  size: number;
  width: number;
  height: number;
  pixelCount: number;
  dpr: number;
  format: "png" | "jpeg";
  type: "image/png" | "image/jpeg";
  rawByteSize: number;
  optimizedByteSize: number;
  compressionLevel?: number;
  containsImages: boolean;
  imageCount: number;
  embeddedImageBytes: number;
  htmlByteSize: number;
  estimatedComplexity: number;
  deliveryMode: "photo" | "document";
  optimizationAttempts: number;
  finalStatus: "ready" | "delivered" | "failed";
}

export type ReportFailureStage = "render" | "optimization" | "size_limit" | "telegram_photo" | "telegram_document" | "network" | "invalid_media" | "timeout" | "browser_screenshot" | "browser_memory";

export interface ReportPageFailure {
  pageId: string;
  stage: ReportFailureStage;
  message: string;
  attempts?: Array<{ dpr: number; format: "png" | "jpeg"; byteSize?: number; message?: string }>;
}

export interface ReportArtifact {
  pages: ReportArtifactPage[];
  archivePdf?: Uint8Array;
  archivePdfSize?: number;
  totalPages: number;
  totalBytes: number;
  deliveryMode: "single" | "album" | "multi_document" | "split";
  failures: ReportPageFailure[];
}

import type { ResultFieldType } from "../db/schema";
import type { ResultConditionOperator } from "../result/schema";

export const VISUAL_TEMPLATE_SCHEMA_VERSION = 1;

export type VisualTemplateFormat = "png";
export type VisualElementType =
  | "text"
  | "image"
  | "shape"
  | "rectangle"
  | "circle"
  | "line"
  | "badge"
  | "tag"
  | "progress_bar"
  | "stat"
  | "stat_group"
  | "rating"
  | "divider"
  | "icon"
  | "qr_code"
  | "radar_chart";

export type VisualReportSectionType =
  | "section"
  | "summary"
  | "table"
  | "gallery"
  | "status_grid"
  | "metrics";

export type TemplateVariableType = ResultFieldType | "stats" | "image_map";

export interface TemplateVariable {
  path: string;
  label: string;
  type: TemplateVariableType;
  required?: boolean;
}

export interface TemplateCondition {
  path: string;
  operator: ResultConditionOperator;
  value?: string | number | boolean | string[] | number[];
}

export interface TemplateBackgroundSolid {
  type: "solid";
  color: string;
}

export interface TemplateBackgroundGradient {
  type: "gradient";
  from: string;
  to: string;
  angle?: number;
}

export interface TemplateBackgroundImage {
  type: "image";
  source: string;
  fit?: "cover" | "contain" | "stretch";
  opacity?: number;
}

export interface TemplateBackgroundTelegramAsset {
  type: "telegram_asset";
  assetId: number;
  fit?: "cover" | "contain" | "stretch";
  opacity?: number;
}

export type TemplateBackground =
  | TemplateBackgroundSolid
  | TemplateBackgroundGradient
  | TemplateBackgroundImage
  | TemplateBackgroundTelegramAsset;

export interface VisualTemplateElement {
  id: string;
  type: VisualElementType;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  zIndex?: number;
  opacity?: number;
  rotation?: number;
  visibleIf?: TemplateCondition;
  value?: string;
  source?: string;
  color?: string;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  radius?: number;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number | "normal" | "bold";
  align?: "left" | "center" | "right";
  verticalAlign?: "top" | "middle" | "bottom";
  lineHeight?: number;
  letterSpacing?: number;
  maxLines?: number;
  overflow?: "clip" | "ellipsis";
  fit?: "cover" | "contain" | "stretch";
  shape?: "rectangle" | "rounded" | "circle" | "hexagon";
  max?: string | number;
  gap?: number;
}

/**
 * Auto-laid out report blocks. They consume list/object data from a declared
 * ResultProfile path, so authors never have to calculate a row coordinate.
 */
export interface VisualReportSection {
  id: string;
  type: VisualReportSectionType;
  title?: string;
  subtitle?: string;
  source?: string;
  label?: string;
  value?: string;
  max?: string | number;
  columns?: number;
  gap?: number;
  itemHeight?: number;
  imageHeight?: number;
  color?: string;
  fill?: string;
  background?: string;
  fontSize?: number;
  radius?: number;
  visibleIf?: TemplateCondition;
}

export interface VisualReportLayout {
  paddingX?: number;
  paddingTop?: number;
  paddingBottom?: number;
  sectionGap?: number;
  /**
   * A readability layer used when a report is placed over a photograph.
   * It deliberately lives in the template schema so the renderer stays shared
   * by surveys and report generators.
   */
  readability?: {
    mode?: "auto" | "light" | "dark";
    overlay?: { color: string; opacity: number };
    card?: { color: string; opacity: number; radius?: number; inset?: number };
    textColor?: string;
    itemBackground?: string;
  };
}

export interface VisualTemplateDefinition {
  schemaVersion: typeof VISUAL_TEMPLATE_SCHEMA_VERSION;
  width: number;
  height: number | "auto";
  format: VisualTemplateFormat;
  background: TemplateBackground;
  variables: TemplateVariable[];
  elements: VisualTemplateElement[];
  report?: VisualReportLayout;
  sections?: VisualReportSection[];
}

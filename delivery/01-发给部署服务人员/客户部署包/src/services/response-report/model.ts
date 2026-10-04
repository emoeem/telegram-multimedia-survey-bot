import type { QuestionType } from "../../db/schema";

export type ResponseReportDensity = "compact" | "standard" | "comfortable";
export type ResponseReportMediaRole = "question" | "option" | "answer";

export interface ResponseReportMedia {
  id?: number;
  label: string;
  role: ResponseReportMediaRole;
  imageDataUrl?: string;
  width?: number | null;
  height?: number | null;
}

export interface ResponseReportOption {
  id: number;
  label: string;
  selected: boolean;
  media: ResponseReportMedia[];
}

export interface ResponseReportItem {
  questionId: number;
  number: number;
  type: QuestionType;
  title: string;
  description?: string | null | undefined;
  required: boolean;
  answered: boolean;
  answerId: number | null;
  answer: string;
  rawAnswer: string | null;
  options: ResponseReportOption[];
  matrixColumns?: string[] | undefined;
  matrixSelections?: Record<string, number> | undefined;
  questionMedia: ResponseReportMedia[];
  answerMedia: ResponseReportMedia[];
}

export interface ResponseReport {
  surveyTitle: string;
  responseNumber: number;
  status: string;
  respondent: string;
  startedAt: string;
  completedAt: string;
  density?: ResponseReportDensity;
  items: ResponseReportItem[];
}

export interface ReportFragment {
  item: ResponseReportItem;
  continuation: boolean;
  continuesAfter: boolean;
  title?: string;
  description?: string;
  answer?: string;
  answerStart?: boolean;
  optionStart?: number;
  optionEnd?: number;
  questionMedia?: ResponseReportMedia[];
  answerMedia?: ResponseReportMedia[];
  optionMediaById?: Record<string, ResponseReportMedia[]>;
  matrixColumnStart?: number;
  matrixColumnEnd?: number;
}

export interface ResponseReportPage {
  number: number;
  total: number;
  fragments: ReportFragment[];
  estimatedHeight: number;
}

export interface ResponseReportRenderedPage {
  number: number;
  bytes: Uint8Array;
  byteSize: number;
  dpr: number;
  width: number;
  height: number;
  overTargetSize: boolean;
}

export type ResponseReportRenderResult =
  | { format: "png"; pages: ResponseReportRenderedPage[]; totalBytes: number; targetTotalBytesExceeded: boolean }
  | { format: "pdf"; bytes: Uint8Array; byteSize: number; pageCount: number };

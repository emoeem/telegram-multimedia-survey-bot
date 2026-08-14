export const SURVEY_SCHEMA_VERSION = 1;

export type SurveyQuestionType =
  | "single"
  | "multiple"
  | "text"
  | "long_text"
  | "number"
  | "boolean"
  | "yes_no"
  | "rating"
  | "date"
  | "time"
  | "file"
  | "image"
  | "video"
  | "audio";

export type MediaType =
  | "photo"
  | "video"
  | "audio"
  | "voice"
  | "animation"
  | "gif"
  | "sticker"
  | "document";

export interface SurveyMedia {
  id: string;
  type: MediaType;
  source: "telegram" | "r2" | "url";
  telegram_file_id?: string;
  telegram_file_unique_id?: string;
  url?: string;
  storage_key?: string;
  mime_type?: string;
  file_name?: string;
  caption?: string;
  width?: number;
  height?: number;
  duration?: number;
  size?: number;
}

export interface SurveyOption {
  id: string;
  label: string;
  value: string;
  order: number;
  media?: SurveyMedia;
}

export interface SurveyValidation {
  min_length?: number;
  max_length?: number;
  min?: number;
  max?: number;
  decimal?: boolean;
  min_selections?: number;
  max_selections?: number;
  allowed_mime_types?: string[];
  max_count?: number;
  max_size_mb?: number;
}

export interface SurveyQuestion {
  id: string;
  type: SurveyQuestionType;
  title: string;
  description?: string;
  required: boolean | null;
  order: number;
  page_id?: string;
  options: SurveyOption[];
  media: SurveyMedia[];
  validation?: SurveyValidation;
  settings?: Record<string, unknown>;
  help_text?: string;
  placeholder?: string;
}

export interface SurveyPage {
  id: string;
  title?: string;
  description?: string;
  order: number;
}

export interface SurveySettings {
  anonymous: boolean;
  allow_multiple: boolean;
  max_responses: number;
  shuffle_questions: boolean;
  shuffle_options: boolean;
  show_progress: boolean;
  allow_back: boolean;
  allow_resume: boolean;
}

export interface SurveyMetadata {
  source?: "pdf" | "telegram" | "json" | "microsoft_forms";
  original_text?: string;
  confidence?: number;
  warnings?: string[];
}

export interface UnifiedSurvey {
  schema_version: typeof SURVEY_SCHEMA_VERSION;
  survey: {
    id: string;
    title: string;
    description?: string;
    cover?: SurveyMedia | null;
    pages: SurveyPage[];
    questions: SurveyQuestion[];
    settings: SurveySettings;
    metadata?: SurveyMetadata;
  };
}

export interface UnifiedSurveyImport {
  schema_version: number;
  survey: {
    title: string;
    description?: string;
    cover?: SurveyMedia | null;
    pages: SurveyPage[];
    questions: SurveyQuestion[];
    settings?: Partial<SurveySettings>;
    metadata?: SurveyMetadata;
  };
}

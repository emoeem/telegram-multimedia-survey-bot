export interface PdfBlock {
  page_number: number;
  text: string;
  bbox?: {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  };
  font_size?: number;
  font?: string;
  reading_order?: number;
}

export interface PdfPage {
  page_number: number;
  blocks: PdfBlock[];
}

export interface PdfDocumentModel {
  title: string;
  pages: PdfPage[];
  metadata?: {
    source: "microsoft_forms_pdf";
    original_text?: string;
  };
}

export interface PdfDetectedQuestion {
  id: string;
  type: string;
  title: string;
  required: boolean | null;
  page_id?: string;
  options: {
    id: string;
    label: string;
    value: string;
    order: number;
  }[];
  media: unknown[];
  warnings: string[];
}

export interface PdfDetectedSurvey {
  title: string;
  pages: {
    id: string;
    title?: string;
    order: number;
  }[];
  questions: PdfDetectedQuestion[];
  warnings: string[];
}

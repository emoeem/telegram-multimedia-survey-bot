export interface ReportSizePolicy {
  pageWidth: number;
  maxPageHeight: number;
  pagePaddingY: number;
  targetPageBytes: number;
  hardMaxPageBytes: number;
  maxTotalBytes: number;
  maxImagesPerPage: number;
  maxEmbeddedImageBytesPerPage: number;
  maxHtmlBytesPerPage: number;
  maxTextCharsPerPage: number;
  maxEstimatedPixelArea: number;
  maxPages: number;
  preferredDpr: number;
  fallbackDpr: number;
  maxImageDimension: { thumbnail: number; card: number; gallery: number; featured: number; hero: number };
}

export const DEFAULT_REPORT_SIZE_POLICY: ReportSizePolicy = {
  pageWidth: 900,
  maxPageHeight: 1200,
  pagePaddingY: 96,
  targetPageBytes: 5 * 1024 * 1024,
  hardMaxPageBytes: 10 * 1024 * 1024,
  maxTotalBytes: 40 * 1024 * 1024,
  maxImagesPerPage: 6,
  maxEmbeddedImageBytesPerPage: 8 * 1024 * 1024,
  maxHtmlBytesPerPage: 12 * 1024 * 1024,
  maxTextCharsPerPage: 4200,
  maxEstimatedPixelArea: 2560 * 1800,
  maxPages: 20,
  preferredDpr: 2,
  fallbackDpr: 1.5,
  maxImageDimension: { thumbnail: 400, card: 800, gallery: 1200, featured: 1600, hero: 1920 },
};

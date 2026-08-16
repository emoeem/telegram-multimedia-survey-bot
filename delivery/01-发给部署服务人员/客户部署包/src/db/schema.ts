export type UserSystemRole = "admin" | "participant";

export interface User {
  id: number;
  telegramUserId: number;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  languageCode: string | null;
  systemRole: UserSystemRole;
  createdAt: string;
  updatedAt: string;
}

export type SurveyStatus = "draft" | "published" | "closed" | "archived";

export interface Survey {
  id: number;
  ownerId: number;
  title: string;
  description: string | null;
  coverMediaId: number | null;
  status: SurveyStatus;
  anonymous: boolean;
  allowMultipleResponses: boolean;
  maxResponsesPerUser: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  closedAt: string | null;
  archivedAt: string | null;
  accessCode: string | null;
  accessCodeEncrypted: string | null;
}

export type QuestionType =
  | "single"
  | "multiple"
  | "text"
  | "long_text"
  | "number"
  | "yes_no"
  | "rating"
  | "matrix"
  | "date"
  | "time"
  | "image"
  | "video"
  | "audio"
  | "file";

export interface SurveyQuestion {
  id: number;
  surveyId: number;
  type: QuestionType;
  title: string;
  description: string | null;
  required: boolean;
  order: number;
  validationJson: string | null;
  settingsJson: string | null;
  parentQuestionId: number | null;
  conditionJson: string | null;
  skipToQuestionId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface QuestionOption {
  id: number;
  questionId: number;
  label: string;
  value: string;
  order: number;
  isOther: boolean;
  createdAt: string;
  updatedAt: string;
}

export type SurveyResponseStatus =
  | "in_progress"
  | "completed"
  | "abandoned"
  | "cancelled";

export interface SurveyResponse {
  id: number;
  surveyId: number;
  userId: number | null;
  participantHash: string;
  status: SurveyResponseStatus;
  startedAt: string;
  completedAt: string | null;
  submittedAt: string | null;
  currentQuestionId: number | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface Answer {
  id: number;
  responseId: number;
  questionId: number;
  textValue: string | null;
  numberValue: number | null;
  booleanValue: boolean | null;
  ratingValue: number | null;
  dateValue: string | null;
  timeValue: string | null;
  jsonValue: string | null;
  createdAt: string;
  updatedAt: string;
}

export type MediaType =
  | "photo"
  | "video"
  | "audio"
  | "voice"
  | "animation"
  | "gif"
  | "sticker"
  | "document";

export interface MediaAsset {
  id: number;
  mediaType: MediaType;
  telegramFileId: string | null;
  telegramFileUniqueId: string | null;
  mimeType: string | null;
  fileName: string | null;
  fileSize: number | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  r2Key: string | null;
  createdAt: string;
  updatedAt: string;
}

export type SoftwareLicenseType = "timed" | "perpetual";
export type SoftwareLicenseStatus = "active" | "suspended" | "revoked";

export interface SoftwareLicense {
  id: number;
  publicId: string;
  licenseKeyHash: string;
  customerName: string | null;
  customerContact: string | null;
  licenseType: SoftwareLicenseType;
  status: SoftwareLicenseStatus;
  startsAt: string;
  expiresAt: string | null;
  updatesUntil: string | null;
  maxActivations: number;
  notes: string | null;
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
}

export interface SoftwareLicenseActivation {
  id: number;
  licenseId: number;
  installationId: string;
  installationName: string | null;
  appVersion: string | null;
  metadataJson: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  deactivatedAt: string | null;
}

export interface SoftwareRelease {
  id: number;
  version: string;
  channel: string;
  releasedAt: string;
  minimumVersion: string | null;
  downloadUrl: string | null;
  checksumSha256: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

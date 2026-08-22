import type { SurveyStatus } from "./api";

export const STATUS_LABELS: Record<SurveyStatus, string> = {
  draft: "草稿",
  published: "已发布",
  closed: "已关闭",
  archived: "已归档",
};

export const QUESTION_TYPE_LABELS: Record<string, string> = {
  single: "单选",
  multiple: "多选",
  text: "单行文本",
  long_text: "多行文本",
  number: "数字",
  yes_no: "是非",
  rating: "评分",
  matrix: "矩阵",
  date: "日期",
  time: "时间",
  image: "图片",
  video: "视频",
  audio: "音频",
  file: "文件",
};

export function formatDateTime(value?: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function matrixColumns(settings: { columns?: unknown } | null): string[] {
  if (!settings || !Array.isArray(settings.columns)) return [];
  return settings.columns.filter((column): column is string => typeof column === "string");
}

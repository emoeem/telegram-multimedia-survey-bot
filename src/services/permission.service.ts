import type { Survey, User } from "../db/schema";
import { getSurveyById } from "../db/repositories/survey.repository";
import { getActiveResponse } from "../db/repositories/response.repository";

export type EffectiveRole = "admin" | "owner" | "participant";

export function isAdmin(userId: number, adminIds: number[]): boolean {
  return adminIds.includes(userId);
}

export function getEffectiveRole(
  user: Pick<User, "id" | "telegramUserId" | "systemRole">,
  survey: Pick<Survey, "ownerId">,
  adminIds: number[],
): EffectiveRole {
  if (
    user.systemRole === "admin" ||
    isAdmin(user.telegramUserId, adminIds)
  ) {
    return "admin";
  }

  if (user.id === survey.ownerId) {
    return "owner";
  }

  return "participant";
}

export function canCreateSurvey(
  user: Pick<User, "id" | "telegramUserId" | "systemRole">,
  adminIds: number[],
): boolean {
  return user.systemRole === "admin" || isAdmin(user.telegramUserId, adminIds);
}

export async function canManageSurvey(
  db: D1Database,
  user: Pick<User, "id" | "telegramUserId" | "systemRole">,
  surveyId: number,
  adminIds: number[],
): Promise<boolean> {
  if (user.systemRole === "admin" || isAdmin(user.telegramUserId, adminIds)) {
    return true;
  }

  const survey = await getSurveyById(db, surveyId);
  return survey?.ownerId === user.id;
}

export async function assertCanManageSurvey(
  db: D1Database,
  user: Pick<User, "id" | "telegramUserId" | "systemRole">,
  surveyId: number,
  adminIds: number[],
): Promise<void> {
  if (!(await canManageSurvey(db, user, surveyId, adminIds))) {
    throw new PermissionError("You are not allowed to manage this survey");
  }
}

export async function canFillSurvey(
  db: D1Database,
  surveyId: number,
  user: Pick<User, "id" | "telegramUserId">,
): Promise<boolean> {
  const survey = await getSurveyById(db, surveyId);
  if (!survey || survey.status !== "published") {
    return false;
  }

  if (!survey.allowMultipleResponses) {
    const existing = await getActiveResponse(db, surveyId, `user_${user.telegramUserId}`);
    if (existing) {
      return false;
    }
  }

  return true;
}

export async function assertCanFillSurvey(
  db: D1Database,
  surveyId: number,
  user: Pick<User, "id" | "telegramUserId">,
): Promise<void> {
  if (!(await canFillSurvey(db, surveyId, user))) {
    throw new PermissionError("You are not allowed to fill this survey");
  }
}

export class PermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionError";
  }
}

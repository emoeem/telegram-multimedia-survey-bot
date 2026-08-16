import type { Survey, User } from "../db/schema";
import { getSurveyById } from "../db/repositories/survey.repository";
import {
  countCompletedResponsesBySurveyAndUser,
  getActiveResponseBySurveyAndUser,
  getResponseBySurveyAndHash,
} from "../db/repositories/response.repository";
import { hasActiveCreatorTrial } from "../db/repositories/creator-trial.repository";

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

export async function canCreateSurvey(
  db: D1Database,
  user: Pick<User, "id" | "telegramUserId" | "systemRole">,
  adminIds: number[],
): Promise<boolean> {
  return (
    user.systemRole === "admin" ||
    isAdmin(user.telegramUserId, adminIds) ||
    await hasActiveCreatorTrial(db, user.id)
  );
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
  return survey?.ownerId === user.id && await hasActiveCreatorTrial(db, user.id);
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

  const active = await getActiveResponseBySurveyAndUser(db, surveyId, user.id);
  if (active) {
    return true;
  }

  if (survey.allowMultipleResponses) {
    const completedCount = await countCompletedResponsesBySurveyAndUser(
      db,
      surveyId,
      user.id,
    );
    return (
      survey.maxResponsesPerUser <= 0 ||
      completedCount < survey.maxResponsesPerUser
    );
  }

  const existing = await getResponseBySurveyAndHash(
    db,
    surveyId,
    `user_${user.id}`,
  );
  if (existing?.status === "completed") {
    return false;
  }

  return true;
}

export async function assertCanFillSurvey(
  db: D1Database,
  surveyId: number,
  user: Pick<User, "id" | "telegramUserId">,
): Promise<void> {
  const survey = await getSurveyById(db, surveyId);
  if (!survey || survey.status !== "published") {
    throw new PermissionError("问卷不存在或已关闭。");
  }

  const active = await getActiveResponseBySurveyAndUser(db, surveyId, user.id);
  if (active) return;

  if (survey.allowMultipleResponses) {
    const completedCount = await countCompletedResponsesBySurveyAndUser(
      db,
      surveyId,
      user.id,
    );
    if (
      survey.maxResponsesPerUser > 0 &&
      completedCount >= survey.maxResponsesPerUser
    ) {
      throw new PermissionError(
        "你已达到这份问卷的填写次数上限。问卷仍在发布中，其他用户可以继续填写。",
      );
    }
    return;
  }

  const existing = await getResponseBySurveyAndHash(
    db,
    surveyId,
    `user_${user.id}`,
  );
  if (existing?.status === "completed") {
    throw new PermissionError(
      "你已经完成过这份问卷，不能重复填写。问卷仍在发布中，其他用户可以继续填写。",
    );
  }

  return;
}

export class PermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionError";
  }
}

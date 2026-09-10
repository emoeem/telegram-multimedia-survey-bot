import { trialGrade, TRIAL_GRADE_COPY, type TrialGrade, type TrialMode, type TrialPersona } from "../trial/engine";

export interface TrialSharePayload {
  runId: number;
  packId: number;
  packName: string;
  persona: TrialPersona;
  mode: TrialMode;
  grade: TrialGrade;
  gradeTitle: string;
  gradeText: string;
  score: number;
  completedTasks: number;
  skippedTasks: number;
  floors: number;
}

export function buildTrialShare(input: {
  runId: number;
  packId: number;
  packName: string;
  persona: TrialPersona;
  mode: TrialMode;
  startingFloor: number;
  maxFloor: number;
  score: number;
  completedTasks: number;
  skippedTasks: number;
  maxScore: number;
}): { content: string; payload: TrialSharePayload } {
  const grade = trialGrade({
    id: input.runId,
    packId: input.packId,
    persona: input.persona,
    mode: input.mode,
    startingFloor: input.startingFloor,
    currentFloor: input.maxFloor,
    maxFloor: input.maxFloor,
    score: input.score,
    completedTasks: input.completedTasks,
    skippedTasks: input.skippedTasks,
    status: "completed",
    state: {
      phase: "playing",
      coins: 0,
      inventory: { skipTickets: 0, boosters: 0, shields: 0 },
      boosted: false,
      usedTaskIds: [],
      maxScore: input.maxScore,
      currentTaskId: null,
    },
  });
  const copy = TRIAL_GRADE_COPY[grade];
  const payload: TrialSharePayload = {
    runId: input.runId,
    packId: input.packId,
    packName: input.packName,
    persona: input.persona,
    mode: input.mode,
    grade,
    gradeTitle: copy.title,
    gradeText: copy.text,
    score: input.score,
    completedTasks: input.completedTasks,
    skippedTasks: input.skippedTasks,
    floors: input.maxFloor - input.startingFloor + 1,
  };
  const personaLabel = input.persona === "male" ? "公" : "母";
  const modeLabel = input.mode === "hell" ? "地狱" : "普通";
  const content = [
    `🎯 挑战结局 · ${grade} 级`,
    `${copy.title}`,
    "",
    `任务包「${input.packName}」 · ${modeLabel} · ${personaLabel}`,
    `到达 ${input.maxFloor} 层 · 完成 ${input.completedTasks} 层 · 积分 ${input.score}`,
    "",
    copy.text,
  ].join("\n");
  return { content, payload };
}

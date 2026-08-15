import { DurableObject } from "cloudflare:workers";

import type { QuestionType } from "../db/schema";

export interface DraftOption {
  label: string;
  mediaAssetId: number | null;
}

export interface DraftQuestion {
  type: QuestionType;
  title: string;
  options: DraftOption[];
  mediaAssetId: number | null;
}

export type SurveyBuilderStep =
  | "idle"
  | "survey_title"
  | "survey_description"
  | "question_type"
  | "question_title"
  | "question_media"
  | "question_media_existing"
  | "question_options"
  | "import"
  | "add_question_option"
  | "option_media"
  | "edit_option_label"
  | "edit_question_title"
  | "survey_access_code"
  | "set_survey_access_code"
  | "ready";

export interface SurveyBuilderState {
  userId: number;
  step: SurveyBuilderStep;
  activeDraft: boolean;
  surveyTitle: string;
  surveyDescription: string;
  currentQuestionType: QuestionType | null;
  currentQuestionTitle: string;
  currentOptions: DraftOption[];
  currentMediaAssetId: number | null;
  targetOptionId: number | null;
  targetQuestionId: number | null;
  targetSurveyId: number | null;
  draftSurveyId: number | null;
  suspendedStep: SurveyBuilderStep | null;
  questions: DraftQuestion[];
  updatedAt: string;
}

type BuilderAction =
  | { action: "init"; userId: number }
  | { action: "get" }
  | { action: "start" }
  | {
      action: "restore";
      surveyId: number;
      surveyTitle: string;
      surveyDescription: string;
      questions: DraftQuestion[];
    }
  | { action: "set_draft_survey_id"; surveyId: number }
  | { action: "set_survey_title"; value: string }
  | { action: "set_survey_description"; value: string }
  | { action: "set_question_type"; value: QuestionType }
  | { action: "set_question_title"; value: string }
  | { action: "add_option"; value: string; mediaAssetId?: number | null }
  | { action: "start_question_options" }
  | { action: "start_import" }
  | { action: "start_add_question_option"; questionId: number }
  | { action: "start_option_media"; optionId: number }
  | { action: "start_question_media"; questionId: number }
  | { action: "start_edit_option_label"; optionId: number }
  | { action: "start_edit_question_title"; questionId: number }
  | { action: "start_survey_access_code"; surveyId: number }
  | { action: "start_set_survey_access_code"; surveyId: number }
  | { action: "resume_auxiliary" }
  | { action: "back" }
  | { action: "set_question_media"; mediaAssetId: number }
  | { action: "finish_options" }
  | { action: "finish_questions" }
  | { action: "reset" };

const STATE_KEY = "survey-builder";

function normalizeOption(option: DraftOption | string): DraftOption {
  if (typeof option === "string") {
    return { label: option, mediaAssetId: null };
  }

  return {
    label: option.label,
    mediaAssetId: option.mediaAssetId ?? null,
  };
}

export class SurveyBuilderDO extends DurableObject {
  private async getState(): Promise<SurveyBuilderState | null> {
    const stored = await this.ctx.storage.get<SurveyBuilderState>(STATE_KEY);
    return stored ? this.normalizeState(stored) : null;
  }

  private async putState(state: SurveyBuilderState): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, state);
  }

  private createInitialState(userId: number): SurveyBuilderState {
    return {
      userId,
      step: "idle",
      activeDraft: false,
      surveyTitle: "",
      surveyDescription: "",
      currentQuestionType: null,
      currentQuestionTitle: "",
      currentOptions: [],
      currentMediaAssetId: null,
      targetOptionId: null,
      targetQuestionId: null,
      targetSurveyId: null,
      draftSurveyId: null,
      suspendedStep: null,
      questions: [],
      updatedAt: new Date().toISOString(),
    };
  }

  private createDraftState(userId: number): SurveyBuilderState {
    return {
      ...this.createInitialState(userId),
      step: "survey_title",
      activeDraft: true,
    };
  }

  private normalizeState(state: SurveyBuilderState): SurveyBuilderState {
    const initial = this.createInitialState(state.userId);
    const hasLegacyDraftContent = Boolean(
      state.surveyTitle ||
        state.surveyDescription ||
        state.questions?.length ||
        state.currentQuestionType ||
        state.currentQuestionTitle,
    );
    const activeDraft =
      typeof state.activeDraft === "boolean"
        ? state.activeDraft
        : hasLegacyDraftContent;
    const normalizedStep =
      !activeDraft &&
      state.step !== "import" &&
      state.step !== "add_question_option" &&
      state.step !== "option_media" &&
      state.step !== "question_media_existing" &&
      state.step !== "edit_option_label" &&
      state.step !== "edit_question_title" &&
      state.step !== "survey_access_code" &&
      state.step !== "set_survey_access_code"
        ? "idle"
        : state.step;

    return {
      ...initial,
      ...state,
      step: normalizedStep,
      activeDraft,
      currentOptions: (state.currentOptions ?? []).map(normalizeOption),
      questions: (state.questions ?? []).map((question) => ({
        ...question,
        options: (question.options ?? []).map(normalizeOption),
        mediaAssetId: question.mediaAssetId ?? null,
      })),
      draftSurveyId: state.draftSurveyId ?? null,
      suspendedStep: state.suspendedStep ?? null,
    };
  }

  private startAuxiliary(
    state: SurveyBuilderState,
    step: SurveyBuilderStep,
  ): SurveyBuilderState {
    const alreadyAuxiliary = state.suspendedStep !== null;
    return {
      ...state,
      step,
      suspendedStep: alreadyAuxiliary ? state.suspendedStep : state.step,
      updatedAt: new Date().toISOString(),
    };
  }

  private appendCurrentQuestion(state: SurveyBuilderState): SurveyBuilderState {
    if (!state.currentQuestionType || !state.currentQuestionTitle) {
      throw new Error("question_incomplete");
    }

    if (
      (state.currentQuestionType === "single" ||
        state.currentQuestionType === "multiple") &&
      state.currentOptions.length < 2
    ) {
      throw new Error("choice_options_incomplete");
    }

    return {
      ...state,
      questions: [
        ...state.questions,
        {
          type: state.currentQuestionType,
          title: state.currentQuestionTitle,
          options: state.currentOptions,
          mediaAssetId: state.currentMediaAssetId,
        },
      ],
      currentQuestionType: null,
      currentQuestionTitle: "",
      currentOptions: [],
      currentMediaAssetId: null,
      step: "question_type",
      updatedAt: new Date().toISOString(),
    };
  }

  async fetch(request: Request): Promise<Response> {
    const action = (await request.json()) as BuilderAction;
    let state = await this.getState();

    if (action.action === "init") {
      const nextState =
        state?.userId === action.userId
          ? state
          : this.createInitialState(action.userId);
      await this.putState(nextState);
      return Response.json(nextState);
    }

    if (action.action === "get") {
      return Response.json(state ?? { error: "builder_not_found" }, {
        status: state ? 200 : 404,
      });
    }

    if (!state) {
      return Response.json({ error: "builder_not_found" }, { status: 404 });
    }

    if (action.action === "start") {
      state = this.createDraftState(state.userId);
    } else if (action.action === "restore") {
      state = {
        ...this.createDraftState(state.userId),
        step: "question_type",
        surveyTitle: action.surveyTitle,
        surveyDescription: action.surveyDescription,
        draftSurveyId: action.surveyId,
        questions: action.questions.map((question) => ({
          ...question,
          options: question.options.map(normalizeOption),
        })),
        updatedAt: new Date().toISOString(),
      };
    } else if (action.action === "set_draft_survey_id") {
      state = {
        ...state,
        draftSurveyId: action.surveyId,
        updatedAt: new Date().toISOString(),
      };
    } else if (action.action === "start_import") {
      state = {
        ...this.createInitialState(state.userId),
        step: "import",
      };
    } else if (action.action === "start_add_question_option") {
      state = {
        ...this.startAuxiliary(state, "add_question_option"),
        targetQuestionId: action.questionId,
      };
    } else if (action.action === "start_option_media") {
      state = {
        ...this.startAuxiliary(state, "option_media"),
        targetOptionId: action.optionId,
      };
    } else if (action.action === "start_question_media") {
      state = {
        ...this.startAuxiliary(state, "question_media_existing"),
        targetQuestionId: action.questionId,
      };
    } else if (action.action === "start_edit_option_label") {
      state = {
        ...this.startAuxiliary(state, "edit_option_label"),
        targetOptionId: action.optionId,
      };
    } else if (action.action === "start_edit_question_title") {
      state = {
        ...this.startAuxiliary(state, "edit_question_title"),
        targetQuestionId: action.questionId,
      };
    } else if (action.action === "start_survey_access_code") {
      state = {
        ...this.startAuxiliary(state, "survey_access_code"),
        targetSurveyId: action.surveyId,
      };
    } else if (action.action === "start_set_survey_access_code") {
      state = {
        ...this.startAuxiliary(state, "set_survey_access_code"),
        targetSurveyId: action.surveyId,
      };
    } else if (action.action === "resume_auxiliary") {
      state = {
        ...state,
        step: state.suspendedStep ?? "idle",
        targetOptionId: null,
        targetQuestionId: null,
        targetSurveyId: null,
        suspendedStep: null,
        updatedAt: new Date().toISOString(),
      };
    } else if (action.action === "back") {
      const previousStep =
        state.step === "survey_description"
          ? "survey_title"
          : state.step === "question_type"
            ? "survey_description"
            : state.step === "question_title"
              ? "question_type"
              : state.step === "question_media"
                ? "question_title"
                : state.step === "question_options"
                  ? "question_media"
                  : state.step;

      state = {
        ...state,
        step: previousStep,
        updatedAt: new Date().toISOString(),
      };
    } else if (action.action === "set_survey_title") {
      state = {
        ...state,
        surveyTitle: action.value,
        step: "survey_description",
        updatedAt: new Date().toISOString(),
      };
    } else if (action.action === "set_survey_description") {
      state = {
        ...state,
        surveyDescription: action.value,
        step: "question_type",
        updatedAt: new Date().toISOString(),
      };
    } else if (action.action === "set_question_type") {
      state = {
        ...state,
        currentQuestionType: action.value,
        currentQuestionTitle: "",
        step: "question_title",
        currentOptions: [],
        currentMediaAssetId: null,
        updatedAt: new Date().toISOString(),
      };
    } else if (action.action === "set_question_title") {
      state = {
        ...state,
        currentQuestionTitle: action.value,
        step: "question_media",
        currentOptions: [],
        currentMediaAssetId: null,
        updatedAt: new Date().toISOString(),
      };
    } else if (action.action === "add_option") {
      state = {
        ...state,
        currentOptions: [
          ...state.currentOptions,
          {
            label: action.value,
            mediaAssetId: action.mediaAssetId ?? null,
          },
        ],
        updatedAt: new Date().toISOString(),
      };
    } else if (action.action === "start_question_options") {
      state = {
        ...state,
        step: "question_options",
        updatedAt: new Date().toISOString(),
      };
    } else if (action.action === "set_question_media") {
      state = {
        ...state,
        currentMediaAssetId: action.mediaAssetId,
        updatedAt: new Date().toISOString(),
      };
    } else if (action.action === "finish_options") {
      try {
        state = this.appendCurrentQuestion(state);
      } catch (error) {
        return Response.json(
          {
            error: error instanceof Error ? error.message : "question_incomplete",
          },
          { status: 400 },
        );
      }
    } else if (action.action === "finish_questions") {
      if (state.currentQuestionType || state.currentQuestionTitle) {
        try {
          state = this.appendCurrentQuestion(state);
        } catch (error) {
          return Response.json(
            {
              error: error instanceof Error ? error.message : "question_incomplete",
            },
            { status: 400 },
          );
        }
      }
      state = {
        ...state,
        step: "ready",
        updatedAt: new Date().toISOString(),
      };
    } else if (action.action === "reset") {
      state = this.createInitialState(state.userId);
    }

    await this.putState(state);
    return Response.json(state);
  }
}

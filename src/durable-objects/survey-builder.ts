import { DurableObject } from "cloudflare:workers";

import type { QuestionType } from "../db/schema";

export interface DraftQuestion {
  type: QuestionType;
  title: string;
  options: string[];
  mediaAssetId: number | null;
}

export interface SurveyBuilderState {
  userId: number;
  step:
    | "idle"
    | "survey_title"
    | "survey_description"
    | "question_type"
    | "question_title"
    | "question_options"
    | "import"
    | "option_media"
    | "edit_question_title"
    | "ready";
  surveyTitle: string;
  surveyDescription: string;
  currentQuestionType: QuestionType | null;
  currentQuestionTitle: string;
  currentOptions: string[];
  currentMediaAssetId: number | null;
  targetOptionId: number | null;
  targetQuestionId: number | null;
  questions: DraftQuestion[];
  updatedAt: string;
}

type BuilderAction =
  | { action: "init"; userId: number }
  | { action: "get" }
  | { action: "set_survey_title"; value: string }
  | { action: "set_survey_description"; value: string }
  | { action: "set_question_type"; value: QuestionType }
  | { action: "set_question_title"; value: string }
  | { action: "add_option"; value: string }
  | { action: "start_import" }
  | { action: "start_option_media"; optionId: number }
  | { action: "start_edit_question_title"; questionId: number }
  | { action: "back" }
  | { action: "set_question_media"; mediaAssetId: number }
  | { action: "finish_options" }
  | { action: "finish_questions" }
  | { action: "reset" };

const STATE_KEY = "survey-builder";

export class SurveyBuilderDO extends DurableObject {
  private async getState(): Promise<SurveyBuilderState | null> {
    return (await this.ctx.storage.get<SurveyBuilderState>(STATE_KEY)) ?? null;
  }

  private async putState(state: SurveyBuilderState): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, state);
  }

  private createInitialState(userId: number): SurveyBuilderState {
    return {
      userId,
      step: "survey_title",
      surveyTitle: "",
      surveyDescription: "",
      currentQuestionType: null,
      currentQuestionTitle: "",
      currentOptions: [],
      currentMediaAssetId: null,
      targetOptionId: null,
      targetQuestionId: null,
      questions: [],
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

    if (action.action === "start_import") {
      if (!state) {
        return Response.json({ error: "builder_not_found" }, { status: 404 });
      }
      state = {
        ...state,
        step: "import",
        surveyTitle: "",
        surveyDescription: "",
        currentQuestionType: null,
        currentQuestionTitle: "",
        currentOptions: [],
        currentMediaAssetId: null,
        questions: [],
        updatedAt: new Date().toISOString(),
      };
      await this.putState(state);
      return Response.json(state);
    }

    if (action.action === "start_option_media") {
      if (!state) {
        return Response.json({ error: "builder_not_found" }, { status: 404 });
      }
      state = {
        ...state,
        step: "option_media",
        targetOptionId: action.optionId,
        updatedAt: new Date().toISOString(),
      };
      await this.putState(state);
      return Response.json(state);
    }

    if (action.action === "start_edit_question_title") {
      if (!state) {
        return Response.json({ error: "builder_not_found" }, { status: 404 });
      }
      state = {
        ...state,
        step: "edit_question_title",
        targetQuestionId: action.questionId,
        updatedAt: new Date().toISOString(),
      };
      await this.putState(state);
      return Response.json(state);
    }

    if (action.action === "back") {
      if (!state) {
        return Response.json({ error: "builder_not_found" }, { status: 404 });
      }

      const previousStep =
        state.step === "survey_description"
          ? "survey_title"
          : state.step === "question_type"
            ? "survey_description"
            : state.step === "question_title"
              ? "question_type"
              : state.step === "question_options"
                ? "question_title"
                : state.step;

      state = {
        ...state,
        step: previousStep,
        updatedAt: new Date().toISOString(),
      };
      await this.putState(state);
      return Response.json(state);
    }

    if (action.action === "get") {
      return Response.json(state ?? { error: "builder_not_found" }, {
        status: state ? 200 : 404,
      });
    }

    if (!state) {
      return Response.json({ error: "builder_not_found" }, { status: 404 });
    }

    if (action.action === "set_survey_title") {
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
        step: "question_title",
        currentOptions: [],
        currentMediaAssetId: null,
        updatedAt: new Date().toISOString(),
      };
    } else if (action.action === "set_question_title") {
      state = {
        ...state,
        currentQuestionTitle: action.value,
        step: "question_options",
        currentOptions: [],
        currentMediaAssetId: null,
        updatedAt: new Date().toISOString(),
      };
    } else if (action.action === "add_option") {
      state = {
        ...state,
        currentOptions: [...state.currentOptions, action.value],
        updatedAt: new Date().toISOString(),
      };
    } else if (action.action === "set_question_media") {
      state = {
        ...state,
        currentMediaAssetId: action.mediaAssetId,
        updatedAt: new Date().toISOString(),
      };
    } else if (action.action === "finish_options") {
      if (!state.currentQuestionType || !state.currentQuestionTitle) {
        return Response.json({ error: "question_incomplete" }, { status: 400 });
      }

      state = {
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
    } else if (action.action === "finish_questions") {
      if (!state.currentQuestionType || !state.currentQuestionTitle) {
        return Response.json({ error: "question_incomplete" }, { status: 400 });
      }

      state = {
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

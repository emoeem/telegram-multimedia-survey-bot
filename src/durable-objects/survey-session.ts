import { DurableObject } from "cloudflare:workers";

export interface SurveySessionState {
  userId: number;
  surveyId: number;
  responseId: number;
  currentQuestionId: number | null;
  selectedOptionIds: number[];
  status: "active" | "completed" | "expired";
  version: number;
  lastActivityAt: string;
}

type SessionAction =
  | {
      action: "init";
      userId: number;
      surveyId: number;
      responseId: number;
      currentQuestionId: number | null;
    }
  | {
      action: "get";
    }
  | {
      action: "set_current_question";
      questionId: number | null;
    }
  | {
      action: "toggle_option";
      optionId: number;
    }
  | {
      action: "get_selected_options";
    }
  | {
      action: "clear_options";
    }
  | {
      action: "complete";
    };

const STATE_KEY = "survey-session";

export class SurveySessionDO extends DurableObject {
  private async getState(): Promise<SurveySessionState | null> {
    return (await this.ctx.storage.get<SurveySessionState>(STATE_KEY)) ?? null;
  }

  private async putState(state: SurveySessionState): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, state);
  }

  private createInitialState(
    action: Extract<SessionAction, { action: "init" }>,
  ): SurveySessionState {
    return {
      userId: action.userId,
      surveyId: action.surveyId,
      responseId: action.responseId,
      currentQuestionId: action.currentQuestionId,
      selectedOptionIds: [],
      status: "active",
      version: 1,
      lastActivityAt: new Date().toISOString(),
    };
  }

  async fetch(request: Request): Promise<Response> {
    const action = (await request.json()) as SessionAction;
    const state = await this.getState();

    if (action.action === "init") {
      const nextState =
        state?.status === "active"
          ? {
              ...state,
              currentQuestionId:
                action.currentQuestionId ?? state.currentQuestionId,
              lastActivityAt: new Date().toISOString(),
            }
          : this.createInitialState(action);

      await this.putState(nextState);
      return Response.json(nextState);
    }

    if (!state) {
      return Response.json({ error: "session_not_found" }, { status: 404 });
    }

    if (action.action === "get") {
      return Response.json(state);
    }

    if (action.action === "set_current_question") {
      const nextState = {
        ...state,
        currentQuestionId: action.questionId,
        version: state.version + 1,
        lastActivityAt: new Date().toISOString(),
      };
      await this.putState(nextState);
      return Response.json(nextState);
    }

    if (action.action === "toggle_option") {
      const selected = new Set(state.selectedOptionIds);
      if (selected.has(action.optionId)) {
        selected.delete(action.optionId);
      } else {
        selected.add(action.optionId);
      }

      const nextState = {
        ...state,
        selectedOptionIds: [...selected],
        version: state.version + 1,
        lastActivityAt: new Date().toISOString(),
      };
      await this.putState(nextState);
      return Response.json(nextState);
    }

    if (action.action === "get_selected_options") {
      return Response.json({ selectedOptionIds: state.selectedOptionIds });
    }

    if (action.action === "clear_options") {
      const nextState = {
        ...state,
        selectedOptionIds: [],
        version: state.version + 1,
        lastActivityAt: new Date().toISOString(),
      };
      await this.putState(nextState);
      return Response.json(nextState);
    }

    if (action.action === "complete") {
      const nextState = {
        ...state,
        status: "completed" as const,
        selectedOptionIds: [],
        currentQuestionId: null,
        version: state.version + 1,
        lastActivityAt: new Date().toISOString(),
      };
      await this.putState(nextState);
      return Response.json(nextState);
    }

    return Response.json({ error: "unknown_action" }, { status: 400 });
  }
}

import { DurableObject } from "cloudflare:workers";

export interface UiScreenEntry {
  screen: string;
  state: Record<string, string | number | boolean>;
}

export interface UiSessionState {
  userId: number;
  chatId: number;
  messageId: number | null;
  screen: string | null;
  screenState: Record<string, string | number | boolean>;
  stack: UiScreenEntry[];
  version: number;
  updatedAt: string;
}

type UiSessionAction =
  | { action: "get" }
  | { action: "set_message"; messageId: number }
  | {
      action: "replace_screen";
      screen: string;
      screenState?: Record<string, string | number | boolean>;
    }
  | {
      action: "push_screen";
      screen: string;
      screenState?: Record<string, string | number | boolean>;
    }
  | { action: "pop_screen" }
  | { action: "clear" };

const STATE_KEY = "ui-session";
const UI_SESSION_RETENTION_MS = 24 * 60 * 60 * 1000;

export class UiSessionDO extends DurableObject {
  private async getState(): Promise<UiSessionState | null> {
    return (await this.ctx.storage.get<UiSessionState>(STATE_KEY)) ?? null;
  }

  private async putState(state: UiSessionState): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, state);
    await this.ctx.storage.setAlarm(Date.now() + UI_SESSION_RETENTION_MS);
  }

  private initialState(request: Request): UiSessionState {
    const url = new URL(request.url);
    return {
      userId: Number(url.searchParams.get("userId")),
      chatId: Number(url.searchParams.get("chatId")),
      messageId: null,
      screen: null,
      screenState: {},
      stack: [],
      version: 0,
      updatedAt: new Date().toISOString(),
    };
  }

  async fetch(request: Request): Promise<Response> {
    const action = (await request.json()) as UiSessionAction;
    const current = (await this.getState()) ?? this.initialState(request);

    if (action.action === "get") return Response.json(current);
    if (action.action === "clear") {
      await this.ctx.storage.deleteAll();
      return Response.json({ ...current, messageId: null, screen: null, stack: [] });
    }

    const now = new Date().toISOString();
    let next: UiSessionState;
    if (action.action === "set_message") {
      next = { ...current, messageId: action.messageId, updatedAt: now };
    } else if (action.action === "replace_screen") {
      next = {
        ...current,
        screen: action.screen,
        screenState: action.screenState ?? {},
        version: current.version + 1,
        updatedAt: now,
      };
    } else if (action.action === "push_screen") {
      const previous = current.screen
        ? [...current.stack, { screen: current.screen, state: current.screenState }]
        : current.stack;
      next = {
        ...current,
        screen: action.screen,
        screenState: action.screenState ?? {},
        stack: previous.slice(-12),
        version: current.version + 1,
        updatedAt: now,
      };
    } else if (action.action === "pop_screen") {
      const previous = current.stack.at(-1);
      next = previous
        ? {
            ...current,
            screen: previous.screen,
            screenState: previous.state,
            stack: current.stack.slice(0, -1),
            version: current.version + 1,
            updatedAt: now,
          }
        : current;
    } else {
      return Response.json({ error: "unknown_action" }, { status: 400 });
    }

    await this.putState(next);
    return Response.json(next);
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

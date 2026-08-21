import type { UiSessionDO, UiSessionState } from "../durable-objects/ui-session";

export type UiSessionNamespace = DurableObjectNamespace<UiSessionDO>;

function idFor(userId: number, chatId: number): string {
  return `user:${userId}:chat:${chatId}`;
}

async function callUiSession(
  namespace: UiSessionNamespace,
  userId: number,
  chatId: number,
  body: Record<string, unknown>,
): Promise<UiSessionState> {
  const id = namespace.idFromName(idFor(userId, chatId));
  const response = await namespace.get(id).fetch(
    `https://ui-session.internal/?userId=${userId}&chatId=${chatId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) throw new Error(`UI session request failed: ${response.status}`);
  return response.json() as Promise<UiSessionState>;
}

export function getUiSession(
  namespace: UiSessionNamespace,
  userId: number,
  chatId: number,
): Promise<UiSessionState> {
  return callUiSession(namespace, userId, chatId, { action: "get" });
}

export function setUiMessage(
  namespace: UiSessionNamespace,
  userId: number,
  chatId: number,
  messageId: number,
): Promise<UiSessionState> {
  return callUiSession(namespace, userId, chatId, {
    action: "set_message",
    messageId,
  });
}

export function replaceUiScreen(
  namespace: UiSessionNamespace,
  userId: number,
  chatId: number,
  screen: string,
  screenState: Record<string, string | number | boolean> = {},
): Promise<UiSessionState> {
  return callUiSession(namespace, userId, chatId, {
    action: "replace_screen",
    screen,
    screenState,
  });
}

export function clearUiSession(
  namespace: UiSessionNamespace,
  userId: number,
  chatId: number,
): Promise<UiSessionState> {
  return callUiSession(namespace, userId, chatId, { action: "clear" });
}

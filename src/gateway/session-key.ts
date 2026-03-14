export interface SessionKeyContext {
  source: "cli" | "telegram";
  userId?: string | number;
  chatId?: string | number;
  chatType?: "private" | "group" | "supergroup" | "channel";
  threadId?: string | number;
}

export function createCliSessionKey(): string {
  return "cli:main";
}

export function createTelegramSessionKey(context: Omit<SessionKeyContext, "source">): string {
  const chatType = context.chatType ?? "private";
  if (chatType === "private") {
    if (context.userId === undefined) {
      throw new Error("telegram private session key requires userId");
    }
    return `telegram:dm:${String(context.userId)}`;
  }

  if (context.chatId === undefined) {
    throw new Error("telegram group session key requires chatId");
  }

  const base = `telegram:group:${String(context.chatId)}`;
  if (context.threadId !== undefined && context.threadId !== null) {
    return `${base}:topic:${String(context.threadId)}`;
  }
  return base;
}

export function createSessionKey(context: SessionKeyContext): string {
  if (context.source === "cli") {
    return createCliSessionKey();
  }
  return createTelegramSessionKey(context);
}

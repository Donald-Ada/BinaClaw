import {Bot, GrammyError, HttpError} from "grammy";
import {renderMarkdownToPlainText} from "../../cli/ui.ts";
import {createAppConfig} from "../../core/config.ts";
import {markManagedServiceReady} from "../../core/service-manager.ts";
import type {AppConfig} from "../../core/types.ts";
import {formatSessionJson, formatSessionView} from "../../cli/session.ts";
import {formatTraceJson, formatTraceView, isTraceFilterKind} from "../../cli/trace.ts";
import {GatewayWsClient} from "../client.ts";
import {createTelegramSessionKey} from "../session-key.ts";

const TELEGRAM_STREAM_INITIAL_THRESHOLD = 24;
const TELEGRAM_STREAM_EDIT_INTERVAL_MS = 900;
const TELEGRAM_MAX_TEXT_LENGTH = 4000;

export async function runTelegramProvider(config = createAppConfig()): Promise<void> {
  if (!config.telegram.botToken) {
    throw new Error("未配置 TELEGRAM_BOT_TOKEN，无法启动 Telegram provider。");
  }

  const gateway = new GatewayWsClient({
    ...config,
    gateway: {
      ...config.gateway,
      url: config.gateway.url ?? `ws://${config.gateway.host}:${config.gateway.port}`,
    },
  });
  await gateway.connect();
  await gateway.health();

  const bot = new Bot(config.telegram.botToken, {
    client: {
      apiRoot: config.telegram.apiBaseUrl,
    },
  });

  bot.catch((error) => {
    const context = error.ctx;
    const prefix = `Telegram update ${context.update.update_id}`;
    if (error.error instanceof GrammyError) {
      console.error(`${prefix} grammY error: ${error.error.description}`);
      return;
    }
    if (error.error instanceof HttpError) {
      console.error(`${prefix} HTTP error:`, error.error);
      return;
    }
    console.error(`${prefix} unknown error:`, error.error);
  });

  bot.command("start", async (ctx) => {
    if (!isAllowed(config, ctx.chat.id, ctx.from?.id)) {
      return;
    }
    await replyInChunks(
      ctx,
      [
        "BinaClaw Telegram 已连接。",
        "可用命令：",
        "/reset - 重置当前会话",
        "/trace [json|clear|intent|plan|observation|approval|response|fallback] - 查看轨迹",
        "/session [json] - 查看会话状态",
      ].join("\n"),
    );
  });

  bot.command("help", async (ctx) => {
    if (!isAllowed(config, ctx.chat.id, ctx.from?.id)) {
      return;
    }
    await replyInChunks(
      ctx,
      [
        "常用命令：",
        "/reset",
        "/trace",
        "/trace json",
        "/trace clear",
        "/trace plan",
        "/session",
        "/session json",
      ].join("\n"),
    );
  });

  bot.command("reset", async (ctx) => {
    if (!isAllowed(config, ctx.chat.id, ctx.from?.id)) {
      return;
    }
    const sessionKey = getTelegramSessionKey(ctx);
    await gateway.clearSession(sessionKey);
    await replyInChunks(ctx, "当前 Telegram 会话已重置。");
  });

  bot.command("trace", async (ctx) => {
    if (!isAllowed(config, ctx.chat.id, ctx.from?.id)) {
      return;
    }
    const sessionKey = getTelegramSessionKey(ctx);
    const args = parseTelegramCommandArgs(ctx.match);

    if (args[0] === "clear") {
      await gateway.clearTrace(sessionKey);
      await replyInChunks(ctx, "当前会话轨迹已清空。");
      return;
    }

    const session = await gateway.getSession(sessionKey);
    if (args[0] === "json") {
      await replyInChunks(ctx, formatTraceJson(session));
      return;
    }

    const requestedFilter = args[0];
    if (requestedFilter && !isTraceFilterKind(requestedFilter)) {
      await replyInChunks(ctx, "不支持的 trace 过滤器。可用值：json、clear、intent、plan、observation、approval、response、fallback");
      return;
    }

    const filter = requestedFilter && isTraceFilterKind(requestedFilter) ? requestedFilter : undefined;
    await replyInChunks(ctx, formatTraceView(session, 12, filter));
  });

  bot.command("session", async (ctx) => {
    if (!isAllowed(config, ctx.chat.id, ctx.from?.id)) {
      return;
    }
    const sessionKey = getTelegramSessionKey(ctx);
    const args = parseTelegramCommandArgs(ctx.match);

    const session = await gateway.getSession(sessionKey);
    if (args[0] === "json") {
      await replyInChunks(ctx, formatSessionJson(session));
      return;
    }

    await replyInChunks(ctx, formatSessionView(session));
  });

  bot.on("message:text", async (ctx) => {
    if (!isAllowed(config, ctx.chat.id, ctx.from?.id)) {
      return;
    }
    if (isTelegramCommandMessage(ctx.message.text, ctx.message.entities)) {
      return;
    }

    const sessionKey = getTelegramSessionKey(ctx);

    const stopTyping = startTypingLoop(() => ctx.replyWithChatAction("typing"));
    const streamer = createTelegramStreamer(ctx, stopTyping);
    try {
      const response = await gateway.sendChat(ctx.message.text, sessionKey, {
        onTextDelta: (delta) => {
          streamer.pushDelta(delta);
        },
      });
      const text = sanitizeTelegramText(response.result.text || "我暂时没有可返回的内容。");
      await streamer.finalize(text);
    } catch (error) {
      const message = sanitizeTelegramText(`处理失败: ${error instanceof Error ? error.message : String(error)}`);
      await streamer.fail(message);
    } finally {
      stopTyping();
    }
  });

  process.once("SIGINT", () => bot.stop());
  process.once("SIGTERM", () => bot.stop());

  const botInfo = await bot.api.getMe();
  await markManagedServiceReady("telegram", { username: botInfo.username ?? botInfo.first_name });
  console.log(`Telegram provider connected as @${botInfo.username ?? botInfo.first_name}.`);

  await bot.start({
    timeout: config.telegram.pollingTimeoutSeconds,
    allowed_updates: ["message"],
  });
}

function isAllowed(config: AppConfig, chatId: number, userId?: number): boolean {
  if (config.telegram.allowedUserIds.length > 0) {
    const normalizedUserId = userId !== undefined ? String(userId) : "";
    if (!normalizedUserId || !config.telegram.allowedUserIds.includes(normalizedUserId)) {
      return false;
    }
  }
  if (config.telegram.allowedChatIds.length > 0) {
    const normalizedChatId = String(chatId);
    if (!config.telegram.allowedChatIds.includes(normalizedChatId)) {
      return false;
    }
  }
  return true;
}

function getTelegramSessionKey(ctx: {
  from?: {id?: number};
  chat: {id: number | string; type?: string};
  message?: {message_thread_id?: number};
}) {
  return createTelegramSessionKey({
    userId: typeof ctx.from?.id === "number" ? ctx.from.id : undefined,
    chatId: ctx.chat.id,
    chatType: normalizeTelegramChatType(ctx.chat.type),
    threadId: ctx.message?.message_thread_id,
  });
}

function normalizeTelegramChatType(value: string | undefined): "private" | "group" | "supergroup" | "channel" | undefined {
  if (value === "private" || value === "group" || value === "supergroup" || value === "channel") {
    return value;
  }
  return undefined;
}

export function parseTelegramCommandArgs(match: unknown): string[] {
  if (typeof match !== "string") {
    return [];
  }
  return match
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

export function isTelegramCommandMessage(
  text: string | undefined,
  entities: Array<{type: string; offset: number}> | undefined,
): boolean {
  if (!text || !entities) {
    return false;
  }
  return entities.some((entity) => entity.type === "bot_command" && entity.offset === 0);
}

export function sanitizeTelegramText(text: string): string {
  const normalized = decodeTelegramEscapes(text).replace(/\u0000/g, "");
  return renderMarkdownToPlainText(normalized);
}

function decodeTelegramEscapes(text: string): string {
  if (!(text.includes("\\n") || text.includes("\\r") || text.includes("\\t") || text.includes("\\\""))) {
    return text;
  }
  try {
    const reparsed = JSON.parse(
      JSON.stringify(text)
        .replace(/\\\\n/g, "\\n")
        .replace(/\\\\r/g, "\\r")
        .replace(/\\\\t/g, "\\t")
        .replace(/\\\\\"/g, '\\"'),
    );
    return typeof reparsed === "string" ? reparsed : text;
  } catch {
    return text;
  }
}

function splitTelegramText(text: string): string[] {
  const normalized = sanitizeTelegramText(text);
  if (!normalized) {
    return [""];
  }

  const chunks: string[] = [];
  let remaining = normalized;

  while (remaining.length > TELEGRAM_MAX_TEXT_LENGTH) {
    let splitIndex = findSplitIndex(remaining, TELEGRAM_MAX_TEXT_LENGTH);
    if (splitIndex <= 0) {
      splitIndex = TELEGRAM_MAX_TEXT_LENGTH;
    }
    const chunk = remaining.slice(0, splitIndex).trimEnd();
    chunks.push(chunk || remaining.slice(0, TELEGRAM_MAX_TEXT_LENGTH));
    remaining = remaining.slice(splitIndex).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks.length > 0 ? chunks : [""];
}

function findSplitIndex(text: string, maxLength: number): number {
  const candidate = text.slice(0, maxLength);
  const newlineIndex = candidate.lastIndexOf("\n");
  if (newlineIndex >= maxLength * 0.6) {
    return newlineIndex + 1;
  }

  const punctuationMatches = [...candidate.matchAll(/[。！？.!?；;：:,，]\s*/g)];
  const lastPunctuation = punctuationMatches.at(-1);
  if (lastPunctuation && lastPunctuation.index !== undefined && lastPunctuation.index >= maxLength * 0.6) {
    return lastPunctuation.index + lastPunctuation[0].length;
  }

  const spaceIndex = candidate.lastIndexOf(" ");
  if (spaceIndex >= maxLength * 0.6) {
    return spaceIndex + 1;
  }

  return maxLength;
}

async function replyInChunks(ctx: TelegramReplyContext, text: string): Promise<{message_id: number}[]> {
  const chunks = splitTelegramText(text);
  const messages: {message_id: number}[] = [];
  for (const chunk of chunks) {
    messages.push(await ctx.reply(chunk));
  }
  return messages;
}

function startTypingLoop(sendTyping: () => Promise<unknown>): () => void {
  void sendTyping().catch(() => undefined);
  const timer = setInterval(() => {
    void sendTyping().catch(() => undefined);
  }, 4000);

  return () => {
    clearInterval(timer);
  };
}

type TelegramReplyContext = {
  chat: {
    id: number | string;
    type?: string;
  };
  reply: (text: string) => Promise<{message_id: number}>;
  replyWithChatAction: (action: "typing") => Promise<unknown>;
  replyWithDraft?: (text: string) => Promise<unknown>;
  api: {
    editMessageText: (chatId: number | string, messageId: number, text: string) => Promise<unknown>;
  };
};

type TelegramTextStreamerOptions = {
  initialThreshold?: number;
  editIntervalMs?: number;
};

export function createTelegramTextStreamer(
  ctx: TelegramReplyContext,
  stopTyping: () => void,
  options: TelegramTextStreamerOptions = {},
) {
  const initialThreshold = options.initialThreshold ?? TELEGRAM_STREAM_INITIAL_THRESHOLD;
  const editIntervalMs = options.editIntervalMs ?? TELEGRAM_STREAM_EDIT_INTERVAL_MS;

  let bufferedText = "";
  let renderedText = "";
  let messageId: number | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let flushChain = Promise.resolve();
  let lastFlushAt = 0;
  let typingStopped = false;

  const stopTypingOnce = () => {
    if (typingStopped) {
      return;
    }
    typingStopped = true;
    stopTyping();
  };

  const queueFlush = (work: () => Promise<void>) => {
    flushChain = flushChain.then(work, work);
    return flushChain;
  };

  const clearFlushTimer = () => {
    if (!flushTimer) {
      return;
    }
    clearTimeout(flushTimer);
    flushTimer = null;
  };

  const shouldOpenMessage = (text: string) => {
    if (text.length >= initialThreshold) {
      return true;
    }
    return /[\n。！？.!?：:；;]/.test(text);
  };

  const flush = async (force: boolean) => {
    const nextText = splitTelegramText(bufferedText)[0] ?? "";
    if (!nextText) {
      return;
    }

    if (messageId === null) {
      if (!force && !shouldOpenMessage(nextText)) {
        return;
      }
      const sent = await ctx.reply(nextText);
      messageId = sent.message_id;
      renderedText = nextText;
      lastFlushAt = Date.now();
      stopTypingOnce();
      return;
    }

    if (nextText === renderedText) {
      return;
    }

    try {
      await ctx.api.editMessageText(ctx.chat.id, messageId, nextText);
      renderedText = nextText;
      lastFlushAt = Date.now();
    } catch (error) {
      if (!isMessageNotModifiedError(error)) {
        throw error;
      }
    }
  };

  const scheduleFlush = (force: boolean) => {
    clearFlushTimer();
    if (force) {
      void queueFlush(() => flush(true));
      return;
    }

    if (messageId === null && !shouldOpenMessage((splitTelegramText(bufferedText)[0] ?? ""))) {
      return;
    }

    const delay =
      messageId === null ? 0 : Math.max(0, editIntervalMs - (Date.now() - lastFlushAt));

    flushTimer = setTimeout(() => {
      flushTimer = null;
      void queueFlush(() => flush(false));
    }, delay);
  };

  return {
    pushDelta(delta: string) {
      if (!delta) {
        return;
      }
      bufferedText += delta;
      scheduleFlush(false);
    },
    async finalize(finalText: string) {
      bufferedText = finalText || bufferedText || "我暂时没有可返回的内容。";
      scheduleFlush(true);
      await flushChain;
      const chunks = splitTelegramText(bufferedText);
      if (messageId !== null && chunks.length > 1) {
        for (const chunk of chunks.slice(1)) {
          await ctx.reply(chunk);
        }
      }
      stopTypingOnce();
    },
    async fail(message: string) {
      bufferedText = message;
      scheduleFlush(true);
      try {
        await flushChain;
        const chunks = splitTelegramText(bufferedText);
        if (messageId !== null && chunks.length > 1) {
          for (const chunk of chunks.slice(1)) {
            await ctx.reply(chunk);
          }
        }
      } catch {
        await replyInChunks(ctx, message);
      } finally {
        stopTypingOnce();
      }
    },
    async waitForIdle() {
      if (flushTimer) {
        await new Promise((resolve) => setTimeout(resolve, editIntervalMs + 10));
      }
      await flushChain;
    },
  };
}

function isMessageNotModifiedError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("message is not modified");
}

export function createTelegramDraftStreamer(
  ctx: TelegramReplyContext,
  stopTyping: () => void,
  options: TelegramTextStreamerOptions = {},
) {
  if (!ctx.replyWithDraft) {
    throw new Error("replyWithDraft is not available for this context.");
  }
  const replyWithDraft = ctx.replyWithDraft.bind(ctx);

  const initialThreshold = options.initialThreshold ?? TELEGRAM_STREAM_INITIAL_THRESHOLD;
  const editIntervalMs = options.editIntervalMs ?? TELEGRAM_STREAM_EDIT_INTERVAL_MS;

  let bufferedText = "";
  let renderedText = "";
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let flushChain = Promise.resolve();
  let lastFlushAt = 0;
  let typingStopped = false;

  const stopTypingOnce = () => {
    if (typingStopped) {
      return;
    }
    typingStopped = true;
    stopTyping();
  };

  const queueFlush = (work: () => Promise<void>) => {
    flushChain = flushChain.then(work, work);
    return flushChain;
  };

  const clearFlushTimer = () => {
    if (!flushTimer) {
      return;
    }
    clearTimeout(flushTimer);
    flushTimer = null;
  };

  const shouldOpenDraft = (text: string) => {
    if (text.length >= initialThreshold) {
      return true;
    }
    return /[\n。！？.!?：:；;]/.test(text);
  };

  const flush = async (force: boolean) => {
    const nextText = splitTelegramText(bufferedText)[0] ?? "";
    if (!nextText) {
      return;
    }
    if (!force && !shouldOpenDraft(nextText)) {
      return;
    }
    if (nextText === renderedText) {
      return;
    }
    await replyWithDraft(nextText);
    renderedText = nextText;
    lastFlushAt = Date.now();
    stopTypingOnce();
  };

  const scheduleFlush = (force: boolean) => {
    clearFlushTimer();
    if (force) {
      void queueFlush(() => flush(true));
      return;
    }

    if (!shouldOpenDraft((splitTelegramText(bufferedText)[0] ?? ""))) {
      return;
    }

    const delay = Math.max(0, editIntervalMs - (Date.now() - lastFlushAt));
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void queueFlush(() => flush(false));
    }, delay);
  };

  return {
    pushDelta(delta: string) {
      if (!delta) {
        return;
      }
      bufferedText += delta;
      scheduleFlush(false);
    },
    async finalize(finalText: string) {
      bufferedText = finalText || bufferedText || "我暂时没有可返回的内容。";
      scheduleFlush(true);
      await flushChain;
      await replyInChunks(ctx, bufferedText);
      stopTypingOnce();
    },
    async fail(message: string) {
      stopTypingOnce();
      await replyInChunks(ctx, message);
    },
    async waitForIdle() {
      if (flushTimer) {
        await new Promise((resolve) => setTimeout(resolve, editIntervalMs + 10));
      }
      await flushChain;
    },
  };
}

function createTelegramStreamer(ctx: TelegramReplyContext, stopTyping: () => void) {
  if (ctx.chat.type === "private" && ctx.replyWithDraft) {
    return createTelegramDraftStreamer(ctx, stopTyping);
  }
  return createTelegramTextStreamer(ctx, stopTyping);
}

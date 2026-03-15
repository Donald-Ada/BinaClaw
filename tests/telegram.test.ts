import assert from "node:assert/strict";
import test from "node:test";
import {
  createTelegramDraftStreamer,
  isTelegramCommandMessage,
  parseTelegramCommandArgs,
  createTelegramTextStreamer,
  sanitizeTelegramText,
} from "../src/gateway/providers/telegram.ts";

test("Telegram text streamer replies with early text and then edits as deltas arrive", async () => {
  const replies: string[] = [];
  const edits: string[] = [];
  let stopped = 0;

  const ctx = {
    chat: {id: 123},
    async reply(text: string) {
      replies.push(text);
      return {message_id: 1};
    },
    async replyWithChatAction() {
      return true;
    },
    api: {
      async editMessageText(_chatId: number | string, _messageId: number, text: string) {
        edits.push(text);
        return true;
      },
    },
  };

  const streamer = createTelegramTextStreamer(ctx, () => {
    stopped += 1;
  }, {
    initialThreshold: 1,
    editIntervalMs: 0,
  });

  streamer.pushDelta("你");
  await streamer.waitForIdle();
  assert.deepEqual(replies, ["你"]);

  streamer.pushDelta("好");
  await streamer.waitForIdle();
  assert.deepEqual(edits, ["你好"]);

  await streamer.finalize("你好");
  assert.equal(stopped, 1);
});

test("Telegram text streamer sends final text when no early chunk was flushed", async () => {
  const replies: string[] = [];

  const ctx = {
    chat: {id: 456},
    async reply(text: string) {
      replies.push(text);
      return {message_id: 2};
    },
    async replyWithChatAction() {
      return true;
    },
    api: {
      async editMessageText() {
        throw new Error("should not edit before first reply");
      },
    },
  };

  const streamer = createTelegramTextStreamer(ctx, () => undefined, {
    initialThreshold: 999,
    editIntervalMs: 0,
  });

  streamer.pushDelta("短");
  await streamer.waitForIdle();
  assert.deepEqual(replies, []);

  await streamer.finalize("短回复");
  assert.deepEqual(replies, ["短回复"]);
});

test("Telegram draft streamer uses native drafts before sending the final reply", async () => {
  const drafts: string[] = [];
  const replies: string[] = [];
  let stopped = 0;

  const ctx = {
    chat: {id: 789, type: "private"},
    async reply(text: string) {
      replies.push(text);
      return {message_id: 3};
    },
    async replyWithDraft(text: string) {
      drafts.push(text);
      return true;
    },
    async replyWithChatAction() {
      return true;
    },
    api: {
      async editMessageText() {
        throw new Error("draft streamer should not use editMessageText");
      },
    },
  };

  const streamer = createTelegramDraftStreamer(ctx, () => {
    stopped += 1;
  }, {
    initialThreshold: 1,
    editIntervalMs: 0,
  });

  streamer.pushDelta("你");
  await streamer.waitForIdle();
  streamer.pushDelta("好");
  await streamer.waitForIdle();
  await streamer.finalize("你好");

  assert.deepEqual(drafts, ["你", "你好"]);
  assert.deepEqual(replies, ["你好"]);
  assert.equal(stopped, 1);
});

test("Telegram draft streamer preserves the original context binding", async () => {
  const drafts: string[] = [];

  const ctx = {
    chat: {id: 790, type: "private"},
    msg: {message_id: 99},
    async reply(text: string) {
      drafts.push(`reply:${text}`);
      return {message_id: 4};
    },
    async replyWithDraft(this: {msg?: {message_id: number}}, text: string) {
      drafts.push(`${this.msg?.message_id}:${text}`);
      return true;
    },
    async replyWithChatAction() {
      return true;
    },
    api: {
      async editMessageText() {
        throw new Error("draft streamer should not use editMessageText");
      },
    },
  };

  const streamer = createTelegramDraftStreamer(ctx, () => undefined, {
    initialThreshold: 1,
    editIntervalMs: 0,
  });

  streamer.pushDelta("你");
  await streamer.waitForIdle();
  await streamer.finalize("你好");

  assert.equal(drafts[0], "99:你");
});

test("Telegram text streamer sends follow-up chunks for long final replies", async () => {
  const replies: string[] = [];
  const edits: string[] = [];

  const ctx = {
    chat: {id: 321},
    async reply(text: string) {
      replies.push(text);
      return {message_id: replies.length};
    },
    async replyWithChatAction() {
      return true;
    },
    api: {
      async editMessageText(_chatId: number | string, _messageId: number, text: string) {
        edits.push(text);
        return true;
      },
    },
  };

  const streamer = createTelegramTextStreamer(ctx, () => undefined, {
    initialThreshold: 1,
    editIntervalMs: 0,
  });

  streamer.pushDelta("A");
  await streamer.waitForIdle();

  const longText = `${"甲".repeat(4000)}乙乙乙`;
  await streamer.finalize(longText);

  assert.equal(replies[0].length, 1);
  assert.equal(edits[0].length, 4000);
  assert.equal(replies[1], "乙乙乙");
});

test("Telegram draft streamer sends long final replies in multiple chunks", async () => {
  const drafts: string[] = [];
  const replies: string[] = [];

  const ctx = {
    chat: {id: 654, type: "private"},
    async reply(text: string) {
      replies.push(text);
      return {message_id: replies.length};
    },
    async replyWithDraft(text: string) {
      drafts.push(text);
      return true;
    },
    async replyWithChatAction() {
      return true;
    },
    api: {
      async editMessageText() {
        throw new Error("draft streamer should not use editMessageText");
      },
    },
  };

  const streamer = createTelegramDraftStreamer(ctx, () => undefined, {
    initialThreshold: 1,
    editIntervalMs: 0,
  });

  streamer.pushDelta("A");
  await streamer.waitForIdle();

  const longText = `${"甲".repeat(4000)}乙乙乙`;
  await streamer.finalize(longText);

  assert.equal(drafts[0], "A");
  assert.equal(drafts.at(-1)?.length, 4000);
  assert.equal(replies[0].length, 4000);
  assert.equal(replies[1], "乙乙乙");
});

test("parseTelegramCommandArgs splits ctx.match into command arguments", () => {
  assert.deepEqual(parseTelegramCommandArgs("json"), ["json"]);
  assert.deepEqual(parseTelegramCommandArgs(" plan  extra "), ["plan", "extra"]);
  assert.deepEqual(parseTelegramCommandArgs(undefined), []);
});

test("isTelegramCommandMessage detects leading bot commands", () => {
  assert.equal(
    isTelegramCommandMessage("/trace plan", [{type: "bot_command", offset: 0}]),
    true,
  );
  assert.equal(
    isTelegramCommandMessage("hello /trace", [{type: "bot_command", offset: 6}]),
    false,
  );
  assert.equal(isTelegramCommandMessage("hello", undefined), false);
});

test("sanitizeTelegramText decodes escaped newlines and strips markdown emphasis", () => {
  const text = sanitizeTelegramText("可以，按当前上下文我先按 **BTCUSDT** 给你。\\n\\n**结论**：分批买。");
  assert.equal(text.includes("\\n"), false);
  assert.equal(text.includes("**"), false);
  assert.equal(text.includes("结论"), true);
});

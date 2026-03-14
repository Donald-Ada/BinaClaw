import assert from "node:assert/strict";
import test from "node:test";
import {createCliSessionKey, createSessionKey, createTelegramSessionKey} from "../src/gateway/session-key.ts";

test("createCliSessionKey returns the shared CLI main session", () => {
  assert.equal(createCliSessionKey(), "cli:main");
  assert.equal(createSessionKey({ source: "cli" }), "cli:main");
});

test("createTelegramSessionKey derives private chat keys from user id", () => {
  assert.equal(
    createTelegramSessionKey({
      userId: 12345,
      chatType: "private",
    }),
    "telegram:dm:12345",
  );
});

test("createTelegramSessionKey derives group and topic keys", () => {
  assert.equal(
    createTelegramSessionKey({
      chatId: -100123,
      chatType: "supergroup",
    }),
    "telegram:group:-100123",
  );

  assert.equal(
    createSessionKey({
      source: "telegram",
      chatId: -100123,
      chatType: "supergroup",
      threadId: 77,
    }),
    "telegram:group:-100123:topic:77",
  );
});

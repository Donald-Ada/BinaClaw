import assert from "node:assert/strict";
import test from "node:test";
import {formatSessionJson, formatSessionView} from "../src/cli/session.ts";
import type {SessionState} from "../src/core/types.ts";

test("formatSessionView renders compaction and topic state", () => {
  const session: SessionState = {
    id: "main",
    createdAt: "2026-03-14T10:00:00.000Z",
    updatedAt: "2026-03-14T10:10:00.000Z",
    messages: [
      { role: "user", content: "今天 BNB 能买吗" },
      { role: "assistant", content: "我先看短线信号。" },
    ],
    scratchpad: [],
    activeSkills: ["alpha", "spot"],
    conversationState: {
      currentSymbol: "BNBUSDT",
      currentTopic: "market",
      currentMarketType: "spot",
      summary: "延续 BNB 现货分析。",
    },
    compactionSummary: "此前会话主要围绕 BNB 短线分析。",
    compactions: [
      {
        timestamp: "2026-03-14T10:05:00.000Z",
        trigger: "messages",
        summary: "此前会话主要围绕 BNB 短线分析。",
        durableFacts: [],
        droppedMessages: 14,
        droppedScratchpad: 10,
      },
    ],
  };

  const view = formatSessionView(session);
  assert.match(view, /Session identity/);
  assert.match(view, /BNBUSDT/);
  assert.match(view, /total compactions: 1/);
  assert.match(view, /latest: .*messages/);
});

test("formatSessionJson renders structured session payload", () => {
  const session: SessionState = {
    messages: [],
    scratchpad: [],
    activeSkills: [],
  };

  const json = formatSessionJson(session);
  assert.equal(typeof json, "string");
  assert.match(json, /"messages": \[/);
});

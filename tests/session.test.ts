import assert from "node:assert/strict";
import {mkdtemp, readFile, readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {createAppConfig, ensureAppDirectories} from "../src/core/config.ts";
import type {SessionState} from "../src/core/types.ts";
import {SessionManager} from "../src/core/session.ts";

test("SessionManager persists session snapshots and transcript events without compaction metadata", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-session-"));
  const config = createAppConfig({ BINACLAW_HOME: home }, process.cwd());
  await ensureAppDirectories(config);

  const manager = new SessionManager(
    config.workspaceSessionsIndexFile,
    config.workspaceSessionTranscriptsDir,
  );

  const session: SessionState = {
    messages: [
      { role: "user", content: "今天 BNB 能买吗" },
      { role: "assistant", content: "我先看 BNB 的实时信号。" },
    ],
    scratchpad: [
      {
        timestamp: new Date().toISOString(),
        iteration: 0,
        kind: "plan",
        summary: "先检查 market 工具",
      },
    ],
    activeSkills: ["spot"],
    conversationState: {
      currentSymbol: "BNBUSDT",
      currentTopic: "market",
      currentMarketType: "spot",
      summary: "延续 BNB 现货分析。",
    },
  };

  const saved = await manager.save(session);
  const loaded = await manager.load();

  assert.equal(loaded.messages.length, 2);
  assert.equal(loaded.scratchpad.length, 1);
  assert.equal(loaded.conversationState?.currentSymbol, "BNBUSDT");
  assert.equal(loaded.activeSkills[0], "spot");
  assert.equal(saved.id, loaded.id);

  const sessionsIndex = await readFile(config.workspaceSessionsIndexFile, "utf8");
  assert.doesNotMatch(sessionsIndex, /compactionSummary/);

  const transcripts = (await readdir(config.workspaceSessionTranscriptsDir)).filter((name) => name.endsWith(".jsonl"));
  assert.ok(transcripts.length > 0);
  const transcriptContent = await readFile(join(config.workspaceSessionTranscriptsDir, transcripts[0] as string), "utf8");
  assert.match(transcriptContent, /session\.created/);
  assert.match(transcriptContent, /session\.snapshot/);
});

test("SessionManager prepareForTurn no longer compacts long sessions", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-session-"));
  const config = createAppConfig({ BINACLAW_HOME: home }, process.cwd());
  await ensureAppDirectories(config);

  const manager = new SessionManager(
    config.workspaceSessionsIndexFile,
    config.workspaceSessionTranscriptsDir,
  );

  const session: SessionState = {
    messages: Array.from({ length: 40 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message-${index}`,
    })),
    scratchpad: Array.from({ length: 35 }, (_, index) => ({
      timestamp: new Date().toISOString(),
      iteration: index,
      kind: "plan",
      summary: `step-${index}`,
    })),
    activeSkills: [],
  };

  const prepared = await manager.prepareForTurn(session);
  assert.equal(prepared.messages.length, session.messages.length);
  assert.equal(prepared.scratchpad.length, session.scratchpad.length);
});

test("SessionManager clear resets persisted session", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-session-"));
  const config = createAppConfig({ BINACLAW_HOME: home }, process.cwd());
  await ensureAppDirectories(config);

  const manager = new SessionManager(
    config.workspaceSessionsIndexFile,
    config.workspaceSessionTranscriptsDir,
  );

  await manager.save({
    messages: [{ role: "user", content: "test" }],
    scratchpad: [],
    activeSkills: ["alpha"],
  });

  const cleared = await manager.clear();
  assert.equal(cleared.messages.length, 0);
  assert.equal(cleared.activeSkills.length, 0);

  const persisted = await manager.load();
  assert.equal(persisted.messages.length, 0);
  assert.equal(persisted.activeSkills.length, 0);
});

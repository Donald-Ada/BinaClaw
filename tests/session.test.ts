import assert from "node:assert/strict";
import {mkdtemp, readFile, readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {createAppConfig, ensureAppDirectories} from "../src/core/config.ts";
import {MemoryStore} from "../src/core/memory.ts";
import type {SessionCompactionRequest, SessionCompactionResult, SessionState} from "../src/core/types.ts";
import {SessionManager} from "../src/core/session.ts";
import {getWorkspaceDocumentPaths} from "../src/core/workspace.ts";

test("SessionManager compacts long sessions and flushes durable facts", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-session-"));
  const config = createAppConfig({ BINACLAW_HOME: home }, process.cwd());
  await ensureAppDirectories(config);

  const memoryStore = new MemoryStore(
    config.memoryFile,
    config.workspaceMemoryDir,
    config.workspaceLongTermMemoryFile,
    getWorkspaceDocumentPaths(config),
  );

  const manager = new SessionManager(
    config.workspaceSessionsIndexFile,
    config.workspaceSessionTranscriptsDir,
    memoryStore,
    config.session,
    {
      isConfigured: () => true,
      compactSession: async (_request: SessionCompactionRequest): Promise<SessionCompactionResult> => ({
        summary: "此前会话主要围绕 BNB 现货买入判断，用户随后要求继续从短线角度分析。",
        durableFacts: ["用户长期关注交易对 BNBUSDT", "长期事实: 当前长期主题围绕 BNB 现货短线判断"],
        conversationState: {
          currentSymbol: "BNBUSDT",
          currentTopic: "market",
          currentMarketType: "spot",
          summary: "延续 BNB 现货分析。",
        },
      }),
      selectSkills: async () => null,
      selectSkillReferences: async () => null,
      plan: async () => null,
      extractStableFacts: async () => null,
      summarize: async () => "",
      resolveConversationState: async () => null,
    },
  );

  const session: SessionState = {
    messages: Array.from({ length: 22 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message-${index} `.repeat(8),
    })),
    scratchpad: Array.from({ length: 34 }, (_, index) => ({
      timestamp: new Date().toISOString(),
      iteration: Math.floor(index / 2),
      kind: "plan",
      summary: `step-${index}`,
    })),
    activeSkills: [],
  };

  const compacted = await manager.prepareForTurn(session, await memoryStore.getWorkspaceContext(1));

  assert.ok((compacted.compactions?.length ?? 0) > 0);
  assert.ok((compacted.messages.length ?? 0) < session.messages.length);
  assert.ok((compacted.scratchpad.length ?? 0) < session.scratchpad.length);
  assert.equal(compacted.conversationState?.currentSymbol, "BNBUSDT");
  assert.match(compacted.compactionSummary ?? "", /BNB 现货买入判断/);

  const userContent = await readFile(config.workspaceUserFile, "utf8");
  assert.match(userContent, /用户长期关注交易对 BNBUSDT/);
  const longTermMemory = await readFile(config.workspaceLongTermMemoryFile, "utf8");
  assert.match(longTermMemory, /长期事实: 当前长期主题围绕 BNB 现货短线判断/);

  const sessionsIndex = await readFile(config.workspaceSessionsIndexFile, "utf8");
  assert.match(sessionsIndex, /compactionSummary/);
  const transcripts = (await readdir(config.workspaceSessionTranscriptsDir)).filter((name) => name.endsWith(".jsonl"));
  assert.ok(transcripts.length > 0);
  const transcriptContent = await readFile(join(config.workspaceSessionTranscriptsDir, transcripts[0] as string), "utf8");
  assert.match(transcriptContent, /session\.snapshot/);
});

test("SessionManager compactNow records a manual compaction", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-session-"));
  const config = createAppConfig({ BINACLAW_HOME: home }, process.cwd());
  await ensureAppDirectories(config);

  const memoryStore = new MemoryStore(
    config.memoryFile,
    config.workspaceMemoryDir,
    config.workspaceLongTermMemoryFile,
    getWorkspaceDocumentPaths(config),
  );

  const manager = new SessionManager(
    config.workspaceSessionsIndexFile,
    config.workspaceSessionTranscriptsDir,
    memoryStore,
    config.session,
  );
  const compacted = await manager.compactNow({
    messages: [{ role: "user", content: "继续分析 BNB" }],
    scratchpad: [],
    activeSkills: ["alpha"],
    conversationState: {
      currentSymbol: "BNBUSDT",
      currentTopic: "market",
      currentMarketType: "spot",
      summary: "延续 BNB 分析。",
    },
  });

  assert.equal(compacted.compactions?.at(-1)?.trigger, "manual");
  assert.match(compacted.compactionSummary ?? "", /trigger=manual/);
});

test("SessionManager clear resets persisted session", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-session-"));
  const config = createAppConfig({ BINACLAW_HOME: home }, process.cwd());
  await ensureAppDirectories(config);

  const memoryStore = new MemoryStore(
    config.memoryFile,
    config.workspaceMemoryDir,
    config.workspaceLongTermMemoryFile,
    getWorkspaceDocumentPaths(config),
  );
  const manager = new SessionManager(
    config.workspaceSessionsIndexFile,
    config.workspaceSessionTranscriptsDir,
    memoryStore,
    config.session,
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

test("SessionManager flushes stable facts before compaction summary is generated", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-session-"));
  const config = createAppConfig({ BINACLAW_HOME: home }, process.cwd());
  await ensureAppDirectories(config);

  const memoryStore = new MemoryStore(
    config.memoryFile,
    config.workspaceMemoryDir,
    config.workspaceLongTermMemoryFile,
    getWorkspaceDocumentPaths(config),
  );

  const manager = new SessionManager(
    config.workspaceSessionsIndexFile,
    config.workspaceSessionTranscriptsDir,
    memoryStore,
    config.session,
    {
      isConfigured: () => true,
      compactSession: async (): Promise<SessionCompactionResult> => ({
        summary: "压缩后继续保留最近上下文。",
        durableFacts: [],
        conversationState: undefined,
      }),
      selectSkills: async () => null,
      selectSkillReferences: async () => null,
      plan: async () => null,
      extractStableFacts: async () => ["用户长期关注交易对 LTCUSDT"],
      summarize: async () => "",
      resolveConversationState: async () => null,
    },
  );

  await manager.prepareForTurn(
    {
      messages: Array.from({ length: 24 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `turn-${index}`,
      })),
      scratchpad: [],
      activeSkills: [],
    },
    await memoryStore.getWorkspaceContext(1),
  );

  const userContent = await readFile(config.workspaceUserFile, "utf8");
  assert.match(userContent, /LTCUSDT/);
});

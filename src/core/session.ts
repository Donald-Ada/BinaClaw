import {randomUUID} from "node:crypto";
import {appendFile, mkdir, readFile, writeFile} from "node:fs/promises";
import {dirname, join} from "node:path";
import {MemoryStore} from "./memory.ts";
import type {ChatProvider} from "./provider.ts";
import type {
  ApprovalRequest,
  ChatMessage,
  ConversationState,
  SessionCompactionRecord,
  SessionCompactionRequest,
  SessionCompactionResult,
  SessionConfig,
  SessionIndexEntry,
  SessionIndexFile,
  SessionSnapshot,
  SessionState,
  SessionTranscriptEvent,
  WorkspaceMemoryContext,
} from "./types.ts";

const DEFAULT_SESSION_KEY = "cli:main";
const DEFAULT_SESSION_TYPE = "main";

export class SessionManager {
  private readonly sessionIndexFile: string;
  private readonly transcriptDir: string;
  private readonly memoryStore: MemoryStore;
  private readonly provider?: ChatProvider;
  private readonly settings: SessionConfig;
  private readonly now: () => Date;
  private readonly sessionKey: string;

  constructor(
    sessionIndexFile: string,
    transcriptDir: string,
    memoryStore: MemoryStore,
    settings: SessionConfig,
    provider?: ChatProvider,
    now: () => Date = () => new Date(),
    sessionKey = DEFAULT_SESSION_KEY,
  ) {
    this.sessionIndexFile = sessionIndexFile;
    this.transcriptDir = transcriptDir;
    this.memoryStore = memoryStore;
    this.settings = settings;
    this.provider = provider;
    this.now = now;
    this.sessionKey = sessionKey;
  }

  async load(): Promise<SessionState> {
    const index = await this.readIndex();
    const entry = pickActiveSession(index.sessions, this.sessionKey);
    if (!entry) {
      return createDefaultSession(this.now(), this.sessionKey, this.transcriptDir);
    }
    return normalizeSession(
      {
        ...entry.snapshot,
        transcriptFile: entry.transcriptFile,
      },
      this.now(),
      this.sessionKey,
      this.transcriptDir,
    );
  }

  async save(session: SessionState): Promise<SessionState> {
    const normalized = normalizeSession(session, this.now(), this.sessionKey, this.transcriptDir);
    normalized.updatedAt = this.now().toISOString();
    await this.ensureStorage();

    const index = await this.readIndex();
    const existing = normalized.id
      ? index.sessions.find((entry) => entry.id === normalized.id)
      : undefined;

    if (!existing) {
      archiveSessionsForKey(index.sessions, normalized.key ?? this.sessionKey);
      const entry = createIndexEntry(normalized);
      index.sessions.push(entry);
      await this.writeIndex(index);
      await this.appendTranscriptEvents(entry.transcriptFile, [
        createTranscriptEvent(normalized, "session.created", {
          type: normalized.type ?? DEFAULT_SESSION_TYPE,
        }),
        createTranscriptEvent(normalized, "session.snapshot", {
          snapshot: toSessionSnapshot(normalized),
        }),
      ]);
      return normalized;
    }

    const previous = normalizeSession(
      {
        ...existing.snapshot,
        transcriptFile: existing.transcriptFile,
      },
      this.now(),
      this.sessionKey,
      this.transcriptDir,
    );
    const events = buildTranscriptEvents(previous, normalized);
    updateIndexEntry(existing, normalized);
    await this.writeIndex(index);
    if (events.length > 0) {
      await this.appendTranscriptEvents(existing.transcriptFile, events);
    }
    return normalized;
  }

  async prepareForTurn(session: SessionState, memoryContext?: WorkspaceMemoryContext): Promise<SessionState> {
    const normalized = normalizeSession(session, this.now(), this.sessionKey, this.transcriptDir);
    if (!shouldCompactSession(normalized, this.settings)) {
      return await this.save(normalized);
    }
    const compacted = await this.compact(normalized, memoryContext);
    return await this.save(compacted);
  }

  async clear(): Promise<SessionState> {
    await this.ensureStorage();
    const index = await this.readIndex();
    const active = pickActiveSession(index.sessions, this.sessionKey);
    if (active) {
      active.status = "archived";
      active.updatedAt = this.now().toISOString();
      await this.writeIndex(index);
      await this.appendTranscriptEvents(active.transcriptFile, [
        createTranscriptEvent(
          normalizeSession(
            {
              ...active.snapshot,
              transcriptFile: active.transcriptFile,
            },
            this.now(),
            this.sessionKey,
            this.transcriptDir,
          ),
          "session.cleared",
          {
            archivedAt: this.now().toISOString(),
          },
        ),
      ]);
    }
    const fresh = createDefaultSession(this.now(), this.sessionKey, this.transcriptDir);
    return await this.save(fresh);
  }

  async compactNow(session: SessionState, memoryContext?: WorkspaceMemoryContext): Promise<SessionState> {
    const normalized = normalizeSession(session, this.now(), this.sessionKey, this.transcriptDir);
    if (normalized.messages.length === 0 && normalized.scratchpad.length === 0 && !normalized.compactionSummary) {
      return await this.save(normalized);
    }
    const compacted = await this.compact(normalized, memoryContext, "manual");
    return await this.save(compacted);
  }

  private async compact(
    session: SessionState,
    memoryContext?: WorkspaceMemoryContext,
    triggerOverride?: SessionCompactionRecord["trigger"],
  ): Promise<SessionState> {
    const messagesToCompact = session.messages.slice(
      0,
      Math.max(0, session.messages.length - this.settings.retainRecentMessages),
    );
    const scratchpadToCompact = session.scratchpad.slice(
      0,
      Math.max(0, session.scratchpad.length - this.settings.retainRecentScratchpad),
    );
    const recentMessages = session.messages.slice(-this.settings.retainRecentMessages);
    const recentScratchpad = session.scratchpad.slice(-this.settings.retainRecentScratchpad);
    const trigger = triggerOverride ?? detectCompactionTrigger(session, this.settings);
    const request: SessionCompactionRequest = {
      session,
      messagesToCompact,
      scratchpadToCompact,
      trigger,
      memoryContext,
    };

    const preFlushFacts = await this.resolvePreCompactionFacts(request);
    const modelResult = await this.resolveCompactionResult(request);
    const compactedFacts = await this.memoryStore.flushStableFacts(modelResult.durableFacts);
    const durableFacts = dedupeFacts([...preFlushFacts, ...compactedFacts]);
    await this.memoryStore.appendSessionCompactionRecord(modelResult.summary, durableFacts, this.now());

    const record: SessionCompactionRecord = {
      timestamp: this.now().toISOString(),
      trigger,
      summary: modelResult.summary,
      durableFacts,
      droppedMessages: messagesToCompact.length,
      droppedScratchpad: scratchpadToCompact.length,
    };

    return {
      ...session,
      messages: recentMessages,
      scratchpad: recentScratchpad,
      conversationState: mergeConversationState(session.conversationState, modelResult.conversationState),
      compactionSummary: mergeCompactionSummary(session.compactionSummary, record),
      compactions: [...(session.compactions ?? []), record].slice(-this.settings.maxCompactionRecords),
    };
  }

  private async resolvePreCompactionFacts(request: SessionCompactionRequest): Promise<string[]> {
    if (
      !this.provider?.isConfigured() ||
      !this.provider.extractStableFacts ||
      (request.messagesToCompact.length === 0 && request.scratchpadToCompact.length === 0)
    ) {
      return [];
    }

    try {
      const flushed = await this.provider.extractStableFacts(
        buildCompactionFlushText(request),
        request.session.compactionSummary,
      );
      return await this.memoryStore.flushStableFacts(flushed ?? []);
    } catch {
      return [];
    }
  }

  private async resolveCompactionResult(
    request: SessionCompactionRequest,
  ): Promise<SessionCompactionResult> {
    if (this.provider?.isConfigured() && this.provider.compactSession) {
      try {
        const modelResult = await this.provider.compactSession(request);
        if (modelResult?.summary) {
          return {
            summary: modelResult.summary,
            durableFacts: modelResult.durableFacts ?? [],
            conversationState: modelResult.conversationState,
          };
        }
      } catch {
        // Fall through to local fallback summary.
      }
    }

    return {
      summary: buildFallbackCompactionSummary(request),
      durableFacts: [],
      conversationState: undefined,
    };
  }

  private async readIndex(): Promise<SessionIndexFile> {
    try {
      const raw = await readFile(this.sessionIndexFile, "utf8");
      const parsed = JSON.parse(raw) as Partial<SessionIndexFile>;
      return {
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      };
    } catch {
      return { sessions: [] };
    }
  }

  private async writeIndex(index: SessionIndexFile): Promise<void> {
    await this.ensureStorage();
    const sorted = {
      sessions: [...index.sessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    };
    await writeFile(this.sessionIndexFile, `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
  }

  private async appendTranscriptEvents(transcriptFile: string, events: SessionTranscriptEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }
    await this.ensureStorage();
    const body = events.map((event) => JSON.stringify(event)).join("\n");
    await appendFile(transcriptFile, `${body}\n`, "utf8");
  }

  private async ensureStorage(): Promise<void> {
    await mkdir(dirname(this.sessionIndexFile), { recursive: true });
    await mkdir(this.transcriptDir, { recursive: true });
  }
}

function createDefaultSession(now: Date, key: string, transcriptDir: string): SessionState {
  const timestamp = now.toISOString();
  const id = createSessionId(now);
  return {
    id,
    key,
    type: DEFAULT_SESSION_TYPE,
    transcriptFile: deriveTranscriptFile(transcriptDir, id),
    createdAt: timestamp,
    updatedAt: timestamp,
    messages: [],
    scratchpad: [],
    activeSkills: [],
    compactions: [],
  };
}

function normalizeSession(raw: Partial<SessionState>, now: Date, key: string, transcriptDir: string): SessionState {
  const fallback = createEmptySession(now, key, transcriptDir);
  const id = raw.id ?? fallback.id ?? createSessionId(now);
  return {
    ...fallback,
    ...raw,
    id,
    key: raw.key ?? key,
    type: raw.type ?? DEFAULT_SESSION_TYPE,
    transcriptFile: raw.transcriptFile ?? deriveTranscriptFile(transcriptDir, id),
    createdAt: raw.createdAt ?? fallback.createdAt,
    updatedAt: raw.updatedAt ?? fallback.updatedAt,
    messages: Array.isArray(raw.messages) ? raw.messages : fallback.messages,
    scratchpad: Array.isArray(raw.scratchpad) ? raw.scratchpad : fallback.scratchpad,
    activeSkills: Array.isArray(raw.activeSkills) ? raw.activeSkills : fallback.activeSkills,
    compactions: Array.isArray(raw.compactions) ? raw.compactions : fallback.compactions,
  };
}

function createEmptySession(now: Date, key: string, transcriptDir: string): SessionState {
  return createDefaultSession(now, key, transcriptDir);
}

function createSessionId(now: Date): string {
  return `${now.toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

function deriveTranscriptFile(transcriptDir: string, sessionId: string): string {
  return join(transcriptDir, `${sessionId}.jsonl`);
}

function createIndexEntry(session: SessionState): SessionIndexEntry {
  const transcriptFile = session.transcriptFile ?? deriveTranscriptFile(".", session.id ?? "main");
  return {
    id: session.id ?? "main",
    key: session.key ?? DEFAULT_SESSION_KEY,
    type: session.type ?? DEFAULT_SESSION_TYPE,
    status: "active",
    transcriptFile,
    createdAt: session.createdAt ?? new Date().toISOString(),
    updatedAt: session.updatedAt ?? new Date().toISOString(),
    messageCount: session.messages.length,
    scratchpadCount: session.scratchpad.length,
    compactionCount: session.compactions?.length ?? 0,
    snapshot: toSessionSnapshot({
      ...session,
      transcriptFile,
    }),
  };
}

function updateIndexEntry(entry: SessionIndexEntry, session: SessionState): void {
  entry.key = session.key ?? entry.key;
  entry.type = session.type ?? entry.type;
  entry.transcriptFile = session.transcriptFile ?? entry.transcriptFile;
  entry.updatedAt = session.updatedAt ?? new Date().toISOString();
  entry.messageCount = session.messages.length;
  entry.scratchpadCount = session.scratchpad.length;
  entry.compactionCount = session.compactions?.length ?? 0;
  entry.snapshot = toSessionSnapshot({
    ...session,
    transcriptFile: entry.transcriptFile,
  });
  entry.status = "active";
}

function toSessionSnapshot(session: SessionState): SessionSnapshot {
  return {
    id: session.id,
    key: session.key,
    type: session.type,
    transcriptFile: session.transcriptFile,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messages: session.messages,
    scratchpad: session.scratchpad,
    activeSkills: session.activeSkills,
    pendingApproval: session.pendingApproval,
    portfolioContext: session.portfolioContext,
    lastIntent: session.lastIntent,
    conversationState: session.conversationState,
    compactionSummary: session.compactionSummary,
    compactions: session.compactions,
  };
}

function pickActiveSession(entries: SessionIndexEntry[], key: string): SessionIndexEntry | undefined {
  return [...entries]
    .filter((entry) => entry.key === key)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .find((entry) => entry.status === "active")
    ?? [...entries]
      .filter((entry) => entry.key === key)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

function archiveSessionsForKey(entries: SessionIndexEntry[], key: string): void {
  for (const entry of entries) {
    if (entry.key === key && entry.status === "active") {
      entry.status = "archived";
    }
  }
}

function createTranscriptEvent(
  session: SessionState,
  type: SessionTranscriptEvent["type"],
  payload: Record<string, unknown>,
): SessionTranscriptEvent {
  return {
    timestamp: session.updatedAt ?? new Date().toISOString(),
    type,
    sessionId: session.id ?? "main",
    sessionKey: session.key ?? DEFAULT_SESSION_KEY,
    payload,
  };
}

function buildTranscriptEvents(previous: SessionState, current: SessionState): SessionTranscriptEvent[] {
  if (requiresSnapshotEvent(previous, current)) {
    return [
      createTranscriptEvent(current, "session.snapshot", {
        snapshot: toSessionSnapshot(current),
      }),
    ];
  }

  const events: SessionTranscriptEvent[] = [];
  for (const message of current.messages.slice(previous.messages.length)) {
    events.push(
      createTranscriptEvent(current, "message", {
        role: message.role,
        content: message.content,
      }),
    );
  }
  for (const step of current.scratchpad.slice(previous.scratchpad.length)) {
    events.push(
      createTranscriptEvent(current, "scratchpad", {
        iteration: step.iteration,
        kind: step.kind,
        summary: step.summary,
        detail: step.detail,
      }),
    );
  }
  if (approvalChanged(previous.pendingApproval, current.pendingApproval)) {
    events.push(
      createTranscriptEvent(current, "approval", current.pendingApproval
        ? {
            toolId: current.pendingApproval.toolId,
            expiresAt: current.pendingApproval.expiresAt,
          }
        : {
            cleared: true,
          }),
    );
  }
  for (const record of (current.compactions ?? []).slice(previous.compactions?.length ?? 0)) {
    events.push(
      createTranscriptEvent(current, "compaction", {
        trigger: record.trigger,
        summary: record.summary,
        durableFacts: record.durableFacts,
      }),
    );
  }
  return events;
}

function requiresSnapshotEvent(previous: SessionState, current: SessionState): boolean {
  return (
    current.messages.length < previous.messages.length ||
    current.scratchpad.length < previous.scratchpad.length ||
    (current.compactions?.length ?? 0) > (previous.compactions?.length ?? 0) ||
    JSON.stringify(previous.activeSkills) !== JSON.stringify(current.activeSkills) ||
    JSON.stringify(previous.conversationState) !== JSON.stringify(current.conversationState) ||
    previous.compactionSummary !== current.compactionSummary
  );
}

function approvalChanged(previous: ApprovalRequest | undefined, current: ApprovalRequest | undefined): boolean {
  if (!previous && !current) {
    return false;
  }
  return JSON.stringify(previous) !== JSON.stringify(current);
}

function shouldCompactSession(session: SessionState, settings: SessionConfig): boolean {
  return (
    session.messages.length > settings.messageCompactionLimit ||
    session.scratchpad.length > settings.scratchpadCompactionLimit ||
    estimateSessionChars(session) > settings.charCompactionLimit
  );
}

function detectCompactionTrigger(session: SessionState, settings: SessionConfig): SessionCompactionRecord["trigger"] {
  if (estimateSessionChars(session) > settings.charCompactionLimit) {
    return "chars";
  }
  if (session.messages.length > settings.messageCompactionLimit) {
    return "messages";
  }
  return "scratchpad";
}

function estimateSessionChars(session: SessionState): number {
  return (
    session.messages.reduce((sum, message) => sum + message.content.length, 0) +
    session.scratchpad.reduce((sum, step) => sum + step.summary.length + (step.detail?.length ?? 0), 0) +
    (session.compactionSummary?.length ?? 0)
  );
}

function buildFallbackCompactionSummary(request: SessionCompactionRequest): string {
  const recentMessages = request.messagesToCompact.slice(-6).map((message) => `${message.role}: ${message.content.slice(0, 140)}`);
  const recentSteps = request.scratchpadToCompact.slice(-4).map((step) => `${step.kind}: ${step.summary}`);
  const parts = [
    request.session.compactionSummary ? `此前压缩摘要:\n${request.session.compactionSummary.slice(-600)}` : "",
    request.session.conversationState ? `会话主题状态: ${JSON.stringify(request.session.conversationState)}` : "",
    recentMessages.length > 0 ? `被压缩的最近会话:\n${recentMessages.join("\n")}` : "",
    recentSteps.length > 0 ? `被压缩的推理轨迹:\n${recentSteps.join("\n")}` : "",
  ].filter(Boolean);
  return parts.join("\n\n").slice(0, 1_800) || "本轮会话已压缩，保留最近对话与当前主题状态。";
}

function buildCompactionFlushText(request: SessionCompactionRequest): string {
  const messageBlock = request.messagesToCompact
    .slice(-12)
    .map((message: ChatMessage) => `${message.role}: ${message.content}`)
    .join("\n");
  const scratchpadBlock = request.scratchpadToCompact
    .slice(-8)
    .map((step) => `${step.kind}: ${step.summary}${step.detail ? ` | ${step.detail}` : ""}`)
    .join("\n");
  return [
    request.session.compactionSummary ? `此前压缩摘要:\n${request.session.compactionSummary}` : "",
    request.session.conversationState ? `当前主题状态:\n${JSON.stringify(request.session.conversationState)}` : "",
    messageBlock ? `待压缩消息:\n${messageBlock}` : "",
    scratchpadBlock ? `待压缩轨迹:\n${scratchpadBlock}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 4000);
}

function mergeConversationState(
  previous: ConversationState | undefined,
  next: ConversationState | undefined,
): ConversationState | undefined {
  if (!previous && !next) {
    return undefined;
  }
  return {
    currentSymbol: next?.currentSymbol ?? previous?.currentSymbol,
    currentTopic: next?.currentTopic ?? previous?.currentTopic,
    currentMarketType: next?.currentMarketType ?? previous?.currentMarketType,
    summary: next?.summary ?? previous?.summary,
  };
}

function mergeCompactionSummary(previous: string | undefined, record: SessionCompactionRecord): string {
  const nextChunk = [
    `[${record.timestamp}] trigger=${record.trigger}`,
    record.summary.trim(),
  ].join("\n");
  if (!previous) {
    return nextChunk.slice(0, 2_500);
  }
  return `${previous}\n\n${nextChunk}`.slice(-2_500);
}

function dedupeFacts(lines: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const line of lines) {
    const normalized = line.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push(normalized);
  }
  return deduped;
}

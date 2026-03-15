import {randomUUID} from "node:crypto";
import {appendFile, mkdir, readFile, writeFile} from "node:fs/promises";
import {dirname, join} from "node:path";
import type {
  ApprovalRequest,
  SessionIndexEntry,
  SessionIndexFile,
  SessionSnapshot,
  SessionState,
  SessionTranscriptEvent,
} from "./types.ts";

const DEFAULT_SESSION_KEY = "cli:main";
const DEFAULT_SESSION_TYPE = "main";

export class SessionManager {
  private readonly sessionIndexFile: string;
  private readonly transcriptDir: string;
  private readonly now: () => Date;
  private readonly sessionKey: string;

  constructor(
    sessionIndexFile: string,
    transcriptDir: string,
    now: () => Date = () => new Date(),
    sessionKey = DEFAULT_SESSION_KEY,
  ) {
    this.sessionIndexFile = sessionIndexFile;
    this.transcriptDir = transcriptDir;
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

  async prepareForTurn(session: SessionState): Promise<SessionState> {
    return await this.save(session);
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
  };
}

function normalizeSession(raw: Partial<SessionState>, now: Date, key: string, transcriptDir: string): SessionState {
  const fallback = createDefaultSession(now, key, transcriptDir);
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
  };
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
  return events;
}

function requiresSnapshotEvent(previous: SessionState, current: SessionState): boolean {
  return (
    current.messages.length < previous.messages.length ||
    current.scratchpad.length < previous.scratchpad.length ||
    JSON.stringify(previous.activeSkills) !== JSON.stringify(current.activeSkills) ||
    JSON.stringify(previous.conversationState) !== JSON.stringify(current.conversationState)
  );
}

function approvalChanged(previous: ApprovalRequest | undefined, current: ApprovalRequest | undefined): boolean {
  if (!previous && !current) {
    return false;
  }
  return JSON.stringify(previous) !== JSON.stringify(current);
}

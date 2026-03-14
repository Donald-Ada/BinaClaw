import {mkdir, readFile, readdir, writeFile} from "node:fs/promises";
import {basename, dirname, join} from "node:path";
import type {
  MemoryState,
  WorkspaceBootstrapDocs,
  WorkspaceDocumentPaths,
  WorkspaceMemoryContext,
  WorkspaceMemoryEntry,
} from "./types.ts";

const DEFAULT_MEMORY: MemoryState = {
  preferredLanguage: "zh-CN",
  watchSymbols: ["BTCUSDT", "ETHUSDT"],
  riskProfile: "balanced",
  preferredMarket: "spot",
  recentSummaries: [],
};

export class MemoryStore {
  private readonly memoryFile: string;
  private readonly workspaceMemoryDir?: string;
  private readonly workspaceLongTermMemoryFile?: string;
  private readonly workspaceDocs?: WorkspaceDocumentPaths;

  constructor(
    memoryFile: string,
    workspaceMemoryDir?: string,
    workspaceLongTermMemoryFile?: string,
    workspaceDocs?: WorkspaceDocumentPaths,
  ) {
    this.memoryFile = memoryFile;
    this.workspaceMemoryDir = workspaceMemoryDir;
    this.workspaceLongTermMemoryFile = workspaceLongTermMemoryFile;
    this.workspaceDocs = workspaceDocs;
  }

  async load(): Promise<MemoryState> {
    try {
      const raw = await readFile(this.memoryFile, "utf8");
      return { ...DEFAULT_MEMORY, ...(JSON.parse(raw) as Partial<MemoryState>) };
    } catch {
      return { ...DEFAULT_MEMORY };
    }
  }

  async save(memory: MemoryState): Promise<void> {
    await writeFile(this.memoryFile, JSON.stringify(memory, null, 2), "utf8");
  }

  async rememberSummary(summary: string): Promise<MemoryState> {
    const current = await this.load();
    const next = {
      ...current,
      recentSummaries: [summary, ...current.recentSummaries].slice(0, 12),
    };
    await this.save(next);
    return next;
  }

  async rememberSymbol(symbol: string): Promise<MemoryState> {
    const current = await this.load();
    const next = {
      ...current,
      watchSymbols: [symbol, ...current.watchSymbols.filter((item) => item !== symbol)].slice(0, 10),
    };
    await this.save(next);
    return next;
  }

  async appendDailyLog(role: "user" | "assistant", content: string, now = new Date()): Promise<void> {
    if (!this.workspaceMemoryDir) {
      return;
    }

    await mkdir(this.workspaceMemoryDir, { recursive: true });
    const filePath = join(this.workspaceMemoryDir, `${formatDate(now)}.md`);
    const entry = [
      `## ${now.toISOString()}`,
      `role: ${role}`,
      "",
      content.trim(),
      "",
    ].join("\n");
    const existing = await safeRead(filePath);
    await writeFile(filePath, existing ? `${existing.trimEnd()}\n\n${entry}` : entry, "utf8");
  }

  async appendLongTermMemory(section: string, content: string): Promise<void> {
    if (!this.workspaceLongTermMemoryFile) {
      return;
    }

    const existing = await safeRead(this.workspaceLongTermMemoryFile);
    const entry = [
      `## ${section}`,
      "",
      content.trim(),
      "",
    ].join("\n");
    await writeFile(
      this.workspaceLongTermMemoryFile,
      existing ? `${existing.trimEnd()}\n\n${entry}` : `# BinaClaw Memory\n\n${entry}`,
      "utf8",
    );
  }

  async promoteStableFactsFromText(text: string, modelFacts: string[] = []): Promise<string[]> {
    return await this.flushStableFacts([...modelFacts, ...extractStableFacts(text)]);
  }

  async flushStableFacts(lines: string[]): Promise<string[]> {
    const promotedLines = normalizeStableFacts(lines);
    if (promotedLines.length === 0) {
      return [];
    }

    const { userProfileLines, durableMemoryLines } = classifyStableFacts(promotedLines);
    const current = await this.load();
    let nextMemory = { ...current };
    for (const line of userProfileLines) {
      if (line.includes("偏好中文输出")) {
        nextMemory = { ...nextMemory, preferredLanguage: "zh-CN" };
      }
      if (line.includes("偏好英文输出")) {
        nextMemory = { ...nextMemory, preferredLanguage: "en-US" };
      }
      if (line.includes("偏好现货市场")) {
        nextMemory = { ...nextMemory, preferredMarket: "spot" };
      }
      if (line.includes("偏好合约市场")) {
        nextMemory = { ...nextMemory, preferredMarket: "futures" };
      }
      if (line.includes("风险偏好偏稳健")) {
        nextMemory = { ...nextMemory, riskProfile: "conservative" };
      }
      if (line.includes("风险偏好偏激进")) {
        nextMemory = { ...nextMemory, riskProfile: "aggressive" };
      }
      if (line.includes("风险偏好均衡")) {
        nextMemory = { ...nextMemory, riskProfile: "balanced" };
      }
      const symbolMatch = line.match(/关注交易对\s+([A-Z0-9]+)/);
      if (symbolMatch) {
        nextMemory = {
          ...nextMemory,
          watchSymbols: [
            symbolMatch[1],
            ...nextMemory.watchSymbols.filter((item) => item !== symbolMatch[1]),
          ].slice(0, 10),
        };
      }
    }
    await this.save(nextMemory);
    if (userProfileLines.length > 0) {
      await this.appendUserProfileLines(userProfileLines);
    }
    if (durableMemoryLines.length > 0) {
      await this.appendUniqueLongTermMemoryLines("Durable Facts", durableMemoryLines);
    }
    return promotedLines;
  }

  async appendSessionCompactionRecord(summary: string, durableFacts: string[], now = new Date()): Promise<void> {
    if (!this.workspaceMemoryDir) {
      return;
    }

    await mkdir(this.workspaceMemoryDir, { recursive: true });
    const filePath = join(this.workspaceMemoryDir, `${formatDate(now)}.md`);
    const durableFactsBlock = durableFacts.length > 0
      ? [
          "durable_facts:",
          ...durableFacts.map((line) => `- ${line}`),
          "",
        ].join("\n")
      : "";
    const entry = [
      `## ${now.toISOString()} [session-compaction]`,
      "",
      summary.trim(),
      "",
      durableFactsBlock,
    ]
      .filter(Boolean)
      .join("\n");
    const existing = await safeRead(filePath);
    await writeFile(filePath, existing ? `${existing.trimEnd()}\n\n${entry}` : entry, "utf8");
  }

  async getWorkspaceContext(limit = 2): Promise<WorkspaceMemoryContext> {
    const longTermMemory = this.workspaceLongTermMemoryFile
      ? await safeRead(this.workspaceLongTermMemoryFile)
      : "";
    const recentEntries = await this.getRecentDailyEntries(limit);
    const workspaceDocs = this.workspaceDocs ? await this.readWorkspaceDocs() : undefined;
    return {
      longTermMemory,
      recentEntries,
      workspaceDocs,
    };
  }

  async getRecentDailyEntries(limit = 2): Promise<WorkspaceMemoryEntry[]> {
    if (!this.workspaceMemoryDir) {
      return [];
    }

    try {
      const files = (await readdir(this.workspaceMemoryDir))
        .filter((name) => name.endsWith(".md"))
        .sort()
        .reverse()
        .slice(0, limit);

      const entries: WorkspaceMemoryEntry[] = [];
      for (const file of files) {
        const filePath = join(this.workspaceMemoryDir, file);
        entries.push({
          date: basename(file, ".md"),
          filePath,
          content: await safeRead(filePath),
        });
      }
      return entries;
    } catch {
      return [];
    }
  }

  async searchWorkspaceMemory(query: string, limit = 5): Promise<Array<{ filePath: string; snippet: string }>> {
    const context = await this.getWorkspaceContext(7);
    const lowered = query.toLowerCase();
    const matches: Array<{ filePath: string; snippet: string }> = [];

    if (context.longTermMemory.toLowerCase().includes(lowered) && this.workspaceLongTermMemoryFile) {
      matches.push({
        filePath: this.workspaceLongTermMemoryFile,
        snippet: extractSnippet(context.longTermMemory, query),
      });
    }

    for (const entry of context.recentEntries) {
      if (entry.content.toLowerCase().includes(lowered)) {
        matches.push({
          filePath: entry.filePath,
          snippet: extractSnippet(entry.content, query),
        });
      }
      if (matches.length >= limit) {
        break;
      }
    }

    return matches.slice(0, limit);
  }

  private async appendUniqueLongTermMemoryLines(section: string, lines: string[]): Promise<void> {
    if (!this.workspaceLongTermMemoryFile || lines.length === 0) {
      return;
    }

    await this.appendUniqueMarkdownLines(
      this.workspaceLongTermMemoryFile,
      "# BinaClaw Memory",
      section,
      lines,
    );
  }

  private async appendUserProfileLines(lines: string[]): Promise<void> {
    const userFile = this.workspaceDocs?.userFile;
    if (!userFile) {
      await this.appendUniqueLongTermMemoryLines("User Profile", lines);
      return;
    }
    await this.appendUniqueMarkdownLines(
      userFile,
      "# USER.md",
      "Learned Profile",
      lines,
    );
  }

  private async appendUniqueMarkdownLines(
    filePath: string,
    header: string,
    section: string,
    lines: string[],
  ): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    const existing = await safeRead(filePath);
    const newLines = lines.filter((line) => !existing.includes(line));
    if (newLines.length === 0) {
      return;
    }

    const entry = [
      `## ${section}`,
      "",
      ...newLines.map((line) => `- ${line}`),
      "",
    ].join("\n");

    await writeFile(
      filePath,
      existing ? `${existing.trimEnd()}\n\n${entry}` : `${header}\n\n${entry}`,
      "utf8",
    );
  }

  private async readWorkspaceDocs(): Promise<WorkspaceBootstrapDocs> {
    return {
      agents: this.workspaceDocs ? await safeRead(this.workspaceDocs.agentsFile) : "",
      soul: this.workspaceDocs ? await safeRead(this.workspaceDocs.soulFile) : "",
      user: this.workspaceDocs ? await safeRead(this.workspaceDocs.userFile) : "",
      identity: this.workspaceDocs ? await safeRead(this.workspaceDocs.identityFile) : "",
      heartbeat: this.workspaceDocs ? await safeRead(this.workspaceDocs.heartbeatFile) : "",
      bootstrap: this.workspaceDocs ? await safeRead(this.workspaceDocs.bootstrapFile) : "",
      tools: this.workspaceDocs ? await safeRead(this.workspaceDocs.toolsFile) : "",
    };
  }
}

function formatDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

async function safeRead(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function extractSnippet(content: string, query: string): string {
  const index = content.toLowerCase().indexOf(query.toLowerCase());
  if (index === -1) {
    return content.slice(0, 240);
  }
  const start = Math.max(0, index - 80);
  const end = Math.min(content.length, index + Math.max(query.length, 40) + 80);
  return content.slice(start, end).trim();
}

function extractStableFacts(text: string): string[] {
  const normalized = text.trim();
  const lines: string[] = [];

  if (/请用中文|用中文回答|偏好中文|中文输出/.test(normalized)) {
    lines.push("用户偏好中文输出");
  }
  if (/请用英文|用英文回答|偏好英文|英文输出/.test(normalized)) {
    lines.push("用户偏好英文输出");
  }
  if (/偏好现货|主要做现货|现货为主/.test(normalized)) {
    lines.push("用户偏好现货市场");
  }
  if (/偏好合约|主要做合约|合约为主|永续为主/.test(normalized)) {
    lines.push("用户偏好合约市场");
  }
  if (/稳健|保守/.test(normalized)) {
    lines.push("用户风险偏好偏稳健");
  } else if (/激进/.test(normalized)) {
    lines.push("用户风险偏好偏激进");
  } else if (/均衡|平衡/.test(normalized)) {
    lines.push("用户风险偏好均衡");
  }

  const symbolPreference = normalized.match(/(?:关注|常看|重点看|主要看)\s*([A-Za-z]{2,12}(?:USDT|BUSD|FDUSD|BTC|ETH)?)/i);
  if (symbolPreference) {
    const symbol = normalizePreferenceSymbol(symbolPreference[1]);
    if (symbol) {
      lines.push(`用户长期关注交易对 ${symbol}`);
    }
  }

  return Array.from(new Set(lines));
}

function normalizeStableFacts(lines: string[]): string[] {
  return Array.from(
    new Set(
      lines
        .map((line) => line.trim())
        .filter(Boolean)
    ),
  );
}

function classifyStableFacts(lines: string[]): {
  userProfileLines: string[];
  durableMemoryLines: string[];
} {
  const userProfileLines: string[] = [];
  const durableMemoryLines: string[] = [];

  for (const line of lines) {
    if (isUserProfileLine(line)) {
      userProfileLines.push(line);
      continue;
    }
    durableMemoryLines.push(line);
  }

  return {
    userProfileLines,
    durableMemoryLines,
  };
}

function isUserProfileLine(line: string): boolean {
  return /用户(偏好|风险偏好|长期关注交易对|主要看|常看|重点看|固定习惯|默认)/.test(line);
}

function normalizePreferenceSymbol(raw?: string): string | null {
  if (!raw) {
    return null;
  }
  const compact = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!compact) {
    return null;
  }
  if (/(USDT|BUSD|FDUSD|BTC|ETH)$/.test(compact) && compact.length > 3) {
    return compact;
  }
  return `${compact}USDT`;
}

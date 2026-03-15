import {stdout} from "node:process";
import {APPROVAL_CANCEL, APPROVAL_CONFIRMATION} from "../core/approval.ts";
import type {AppConfig, ApprovalRequest, DeskMarketPulseItem, InstalledSkill} from "../core/types.ts";

const RESET = "\u001b[0m";
const BOLD = "\u001b[1m";
const DIM = "\u001b[2m";
const CLEAR_LINE = "\r\u001b[2K";
const DESK_TIPS = [
  "试试直接问：今天 BNB 能买吗",
  "输入 /trace 可以查看这轮技能选择和工具调用",
  "输入 /session 可以查看当前会话主题和状态",
  "想刷新 skills，直接输入 /skills",
  "Binance 密钥仅从本机环境变量读取，更安全",
];
const ONBOARD_TIPS = [
  "OpenAI 与 Telegram 建议先填真实生产值，避免首启后再返工",
  "Telegram Allowed User IDs 可以填写多个，使用英文逗号分隔",
  "Binance Key 只会写入本机 env.local，不会进入 config.json",
  "Gateway Port 一般保持默认即可，只有端口冲突时再改",
  "Brave Search Key 可选，但配置后热点检索和 Web3 搜索更完整",
];

export interface SpinnerController {
  update(message: string): void;
  stop(): void;
}

export interface TextStreamRenderer {
  append(delta: string): string;
  flush(): string;
  current(): string;
  reset(): void;
}

export interface CliTheme {
  useColor: boolean;
  reset: string;
  bold: string;
  dim: string;
  brand: string;
  accent: string;
  border: string;
  muted: string;
  success: string;
  warning: string;
  danger: string;
  text: string;
  prompt: string;
}

export type PanelVariant =
  | "brand"
  | "info"
  | "help"
  | "skills"
  | "session"
  | "trace"
  | "success"
  | "warning"
  | "approval"
  | "json";

export type StatusPhase =
  | "context"
  | "memory"
  | "skills"
  | "references"
  | "compile"
  | "market"
  | "tools"
  | "plan"
  | "summary"
  | "fallback"
  | "processing";

const STATUS_PHASE_LABELS: Record<StatusPhase, string> = {
  context: "准备上下文",
  memory: "读取工作区记忆",
  skills: "加载技能",
  references: "加载技能参考",
  compile: "编译运行时工具",
  market: "获取实时行情",
  tools: "执行工具",
  plan: "规划行动",
  summary: "生成分析",
  fallback: "本地回退",
  processing: "处理中",
};

export function createCliTheme(useColor = shouldUseColor()): CliTheme {
  if (!useColor) {
    return {
      useColor,
      reset: "",
      bold: "",
      dim: "",
      brand: "",
      accent: "",
      border: "",
      muted: "",
      success: "",
      warning: "",
      danger: "",
      text: "",
      prompt: "",
    };
  }

  return {
    useColor,
    reset: RESET,
    bold: BOLD,
    dim: DIM,
    brand: "\u001b[38;5;81m",
    accent: "\u001b[38;5;45m",
    border: "\u001b[38;5;67m",
    muted: "\u001b[38;5;244m",
    success: "\u001b[38;5;78m",
    warning: "\u001b[38;5;221m",
    danger: "\u001b[38;5;203m",
    text: "\u001b[38;5;252m",
    prompt: "\u001b[38;5;117m",
  };
}

export function renderWelcomeBanner(config: AppConfig, pulse: DeskMarketPulseItem[] = []): string {
  const lines = formatKeyValueRows(
    [
      ["MODEL", config.provider.model ?? "not set"],
      ["RUNTIME", config.gateway.url ? "shared gateway" : "local runtime"],
      ["NETWORK", config.binance.useTestnet ? "binance testnet" : "binance mainnet"],
      ["WORKDIR", cropMiddle(config.cwd, getPanelContentWidth() - 12)],
    ],
    10,
  );

  return `${renderPanel("BinaClaw: Trading Desk", lines, "brand")}\n${renderMarketPulseStrip(pulse)}\n${renderDeskTip()}\n`;
}

export function formatUserPrompt(): string {
  const theme = createCliTheme();
  if (!theme.useColor) {
    return "you > ";
  }
  return `${theme.prompt}${theme.bold}you${theme.reset} ${theme.muted}›${theme.reset} `;
}

export function formatAgentBlock(text: string): string {
  const rendered = renderMarkdownForTerminal(text);
  return `${formatAgentStreamStart()}${formatAgentStreamChunk(rendered)}${formatAgentStreamEnd()}`;
}

export function formatAgentStreamStart(): string {
  const theme = createCliTheme();
  if (!theme.useColor) {
    return "ANALYST: BinaClaw\n  ";
  }
  return `${theme.success}${theme.bold}ANALYST: BinaClaw${theme.reset}\n${theme.border}│${theme.reset} `;
}

export function formatAgentStreamChunk(chunk: string): string {
  const theme = createCliTheme();
  if (!theme.useColor) {
    return chunk;
  }
  return chunk.replace(/\n/g, `\n${theme.border}│${theme.reset} `);
}

export function formatAgentStreamEnd(): string {
  const theme = createCliTheme();
  if (!theme.useColor) {
    return "\n\n";
  }
  return `\n${theme.border}╰─${theme.reset}\n\n`;
}

export function formatInfoBlock(title: string, text: string, variant: PanelVariant = "info"): string {
  return `${renderPanel(title, text, variant)}\n`;
}

export function formatOnboardingWelcome(config: AppConfig): string {
  const lines = [
    "把本地交易台、模型、Telegram Bot 和 Binance 本机密钥一次配好。",
    "",
    ...formatKeyValueRows(
      [
        ["FLOW", "Gateway -> OpenAI -> Telegram -> Brave -> Binance Secrets"],
        ["CONFIG", cropMiddle(config.configFile, getPanelContentWidth() - 10)],
        ["LOCAL ENV", cropMiddle(config.localEnvFile, getPanelContentWidth() - 10)],
      ],
      10,
    ),
    "",
    `TIP         ${pickRandomTip(ONBOARD_TIPS)}`,
  ];
  return `${renderPanel("BinaClaw: First Run", lines, "brand")}\n`;
}

export function formatOnboardingSection(
  step: number,
  total: number,
  title: string,
  description: string,
  fieldLabels: string[],
): string {
  const lines = [
    description,
    "",
    `STEP        ${step}/${total}`,
    `FIELDS      ${fieldLabels.join(" · ")}`,
    "INPUT       留空保持当前值，输入 - 清空可选配置",
  ];
  return `${renderPanel(`Onboard ${step}/${total}: ${title}`, lines, "info")}\n`;
}

export function formatOnboardingSavedSummary(config: AppConfig): string {
  const lines = [
    ...formatKeyValueRows(
      [
        ["GATEWAY", config.gateway.url ?? `ws://127.0.0.1:${config.gateway.port}`],
        ["OPENAI", config.provider.apiKey ? `${config.provider.model ?? "configured"} · ready` : "missing"],
        ["TELEGRAM", config.telegram.botToken ? "configured" : "missing"],
        ["BRAVE", config.brave.apiKey ? "configured" : "optional / missing"],
        ["BINANCE", config.binance.apiKey && config.binance.apiSecret ? "stored in local env" : "missing"],
      ],
      12,
    ),
    "",
    `CONFIG      ${cropMiddle(config.configFile, getPanelContentWidth() - 12)}`,
    `LOCAL ENV   ${cropMiddle(config.localEnvFile, getPanelContentWidth() - 12)}`,
  ];
  return `${renderPanel("Onboard Snapshot", lines, "success")}\n`;
}

export function formatOnboardingServiceCard(
  title: string,
  lines: string[],
  variant: Extract<PanelVariant, "success" | "warning" | "info"> = "success",
): string {
  return `${renderPanel(title, lines, variant)}\n`;
}

export function formatOnboardingCompletion(config: AppConfig, gatewayLogFile: string, telegramLogFile: string): string {
  const gatewayUrl = config.gateway.url ?? `ws://127.0.0.1:${config.gateway.port}`;
  const lines = [
    "配置已完成，后台 Gateway 与 Telegram provider 已准备就绪。",
    "",
    ...formatKeyValueRows(
      [
        ["GATEWAY", gatewayUrl],
        ["TELEGRAM", "bot online"],
        ["LOGS", cropMiddle(`${gatewayLogFile} | ${telegramLogFile}`, getPanelContentWidth() - 8)],
        ["STOP", "binaclaw gateway stop"],
      ],
      10,
    ),
    "",
    "NEXT        现在你可以直接在 Telegram 中与 AI Agent 对话",
  ];
  return `${renderPanel("Desk Online", lines, "success")}\n`;
}

export function formatSkillsTable(skills: InstalledSkill[]): string {
  const summaryLine = `loaded ${skills.length} skills · workspace ${skills.some((skill) => skill.sourcePath.includes("/skills/")) ? "active" : "idle"}`;
  const rows = skills
    .slice()
    .sort((left, right) => left.manifest.name.localeCompare(right.manifest.name))
    .map((skill) => [
      cropMiddle(skill.manifest.name, 24),
      skill.manifest.requires_auth ? "ENV" : "OPEN",
      skill.manifest.dangerous ? "HOLD" : "READ",
      String(skill.knowledge.endpointHints.length || skill.toolDefinitions.length),
      String(skill.manifest.capabilities.length),
      cropMiddle(skill.manifest.version, 8),
    ]);
  const tableLines = buildCompactTable(
    ["SKILL", "AUTH", "RISK", "API", "CAPS", "VER"],
    rows,
    [24, 6, 6, 4, 5, 8],
  );
  const warningCount = skills.reduce((sum, skill) => sum + skill.warnings.length, 0);
  const footer = warningCount > 0
    ? `warnings ${warningCount} · /trace 可查看运行时实际选中的技能`
    : "desk note · /trace 可查看运行时实际选中的技能";
  return `${renderPanel("Skill Deck", [summaryLine, "", ...tableLines, "", footer], "skills", { preserveWhitespace: true })}\n`;
}

export function formatApprovalCard(approval: ApprovalRequest): string {
  const lines = [
    `ACTION      ${approval.toolId}`,
    `RISK        ${approval.riskLevel.toUpperCase()}`,
    `EXPIRES     ${formatTimestamp(approval.expiresAt)}`,
  ];

  const accountSummaryLine = approval.summary
    .split("\n")
    .find((line) => line.startsWith("账户摘要:"));
  if (accountSummaryLine) {
    lines.push(`ACCOUNT     ${accountSummaryLine.replace(/^账户摘要:\s*/, "")}`);
  }

  lines.push(`CONFIRM     输入 ${APPROVAL_CONFIRMATION} 执行，输入 ${APPROVAL_CANCEL} 取消`);
  return `${renderPanel("Execution Hold", lines, "approval")}\n`;
}

export function renderPanel(
  title: string,
  content: string | string[],
  variant: PanelVariant = "info",
  options: { preserveWhitespace?: boolean; useColor?: boolean } = {},
): string {
  const theme = createCliTheme(options.useColor ?? shouldUseColor());
  const bodyLines = normalizePanelLines(content, getPanelContentWidth(), options.preserveWhitespace ?? variant === "json");

  if (!theme.useColor) {
    return [title, ...bodyLines.map((line) => `  ${line}`)].join("\n");
  }

  const panelWidth = Math.max(
    visibleLength(title) + 8,
    ...bodyLines.map((line) => visibleLength(stripAnsi(line)) + 4),
    36,
  );
  const width = Math.min(panelWidth, getPanelWidth());
  const contentWidth = Math.max(18, width - 4);
  const fittedLines = normalizePanelLines(bodyLines, contentWidth, true);
  const { titleColor, borderColor } = getVariantColors(variant, theme);
  const topFill = Math.max(width - visibleLength(title) - 5, 0);
  const top = `${borderColor}┌─${theme.reset} ${titleColor}${theme.bold}${title}${theme.reset} ${borderColor}${"─".repeat(topFill)}┐${theme.reset}`;
  const body = fittedLines
    .map((line) => `${borderColor}│${theme.reset} ${padVisible(line, contentWidth)} ${borderColor}│${theme.reset}`)
    .join("\n");
  const bottom = `${borderColor}└${"─".repeat(width - 2)}┘${theme.reset}`;
  return `${top}\n${body}\n${bottom}`;
}

export function renderStatusBar(elapsedSeconds: number, status?: string): string {
  const theme = createCliTheme();
  const phase = resolveStatusPhase(status);
  const label = STATUS_PHASE_LABELS[phase];
  if (!theme.useColor) {
    return `WORKING (${elapsedSeconds}s • ${label} • /trace 查看过程)`;
  }
  return [
    `${theme.brand}${theme.bold}▋ WORKING${theme.reset}`,
    `${theme.text}${elapsedSeconds}s${theme.reset}`,
    `${theme.border}•${theme.reset}`,
    `${theme.text}${label}${theme.reset}`,
    `${theme.border}•${theme.reset}`,
    `${theme.muted}/trace 查看过程${theme.reset}`,
  ].join(" ");
}

export function resolveStatusPhase(status: string | undefined): StatusPhase {
  if (!status) {
    return "processing";
  }
  if (status.includes("快速获取")) {
    return "market";
  }
  if (status.includes("执行")) {
    return "tools";
  }
  if (status.includes("生成最终回复") || status.includes("生成回复")) {
    return "summary";
  }
  if (status.includes("规划")) {
    return "plan";
  }
  if (status.includes("选择技能")) {
    return "skills";
  }
  if (status.includes("加载技能参考")) {
    return "references";
  }
  if (status.includes("编译技能工具")) {
    return "compile";
  }
  if (status.includes("工作区记忆")) {
    return "memory";
  }
  if (status.includes("记录输入") || status.includes("准备会话")) {
    return "context";
  }
  if (status.includes("本地规划")) {
    return "fallback";
  }
  return "processing";
}

export function createSpinnerController(
  write: (chunk: string) => void,
  useTty = shouldUseColor(),
): SpinnerController {
  let timer: ReturnType<typeof setInterval> | undefined;
  let currentMessage = "";
  let startedAt = 0;
  let lastRenderedLabel = "";

  const render = () => {
    if (!useTty || !currentMessage) {
      return;
    }
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    const label = renderStatusBar(elapsedSeconds, currentMessage);
    if (label === lastRenderedLabel) {
      return;
    }
    lastRenderedLabel = label;
    write(`${CLEAR_LINE}${label}`);
  };

  return {
    update(message: string) {
      if (!message) {
        return;
      }
      if (!useTty) {
        if (message !== currentMessage) {
          currentMessage = message;
          if (!startedAt) {
            startedAt = Date.now();
          }
          const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
          write(formatInfoBlock("Desk Status", renderStatusBar(elapsedSeconds, currentMessage), "info"));
        }
        return;
      }

      if (!currentMessage) {
        startedAt = Date.now();
        lastRenderedLabel = "";
      }
      currentMessage = message;
      if (!timer) {
        render();
        timer = setInterval(render, 200);
        return;
      }
      render();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      if (useTty && currentMessage) {
        write(CLEAR_LINE);
      }
      currentMessage = "";
      startedAt = 0;
      lastRenderedLabel = "";
    },
  };
}

export function createTextStreamRenderer(): TextStreamRenderer {
  let rawCommitted = "";
  let rawPending = "";
  let renderedCommitted = "";

  const flushPending = (force: boolean): string => {
    if (!rawPending) {
      return "";
    }
    if (!force && !shouldFlushPending(rawPending)) {
      return "";
    }

    rawCommitted += rawPending;
    rawPending = "";
    const nextRendered = renderMarkdownForTerminal(rawCommitted);
    const suffix = nextRendered.slice(renderedCommitted.length);
    renderedCommitted = nextRendered;
    return suffix;
  };

  return {
    append(delta: string) {
      rawPending += delta;
      return flushPending(false);
    },
    flush() {
      return flushPending(true);
    },
    current() {
      return renderMarkdownForTerminal(rawCommitted + rawPending);
    },
    reset() {
      rawCommitted = "";
      rawPending = "";
      renderedCommitted = "";
    },
  };
}

export function renderMarkdownForTerminal(markdown: string): string {
  const theme = createCliTheme();
  const normalized = markdown.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return "";
  }

  const output: string[] = [];
  const lines = normalized.split("\n");
  let inCodeBlock = false;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (line.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      if (!inCodeBlock) {
        output.push("");
      }
      continue;
    }

    if (inCodeBlock) {
      output.push(`${theme.muted}›${theme.reset} ${line}`);
      continue;
    }

    if (!line.trim()) {
      if (output.at(-1) !== "") {
        output.push("");
      }
      continue;
    }

    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      output.push(`${theme.bold}${sanitizeInlineMarkdown(heading[1] ?? "")}${theme.reset}`);
      continue;
    }

    const numbered = line.match(/^(\d+\.)\s+(.*)$/);
    if (numbered) {
      output.push(`${theme.accent}${numbered[1]}${theme.reset} ${sanitizeInlineMarkdown(numbered[2] ?? "")}`);
      continue;
    }

    const bullet = line.match(/^[-*+]\s+(.*)$/);
    if (bullet) {
      output.push(`${theme.accent}•${theme.reset} ${sanitizeInlineMarkdown(bullet[1] ?? "")}`);
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      output.push(`${theme.muted}▍${theme.reset} ${sanitizeInlineMarkdown(quote[1] ?? "")}`);
      continue;
    }

    output.push(sanitizeInlineMarkdown(line));
  }

  return collapseBlankLines(output).join("\n");
}

export function renderMarkdownToPlainText(markdown: string): string {
  return stripAnsi(renderMarkdownForTerminal(markdown));
}

function renderMarketPulseStrip(items: DeskMarketPulseItem[]): string {
  const theme = createCliTheme();
  if (items.length === 0) {
    return theme.useColor ? `${theme.muted}pulse: snapshot unavailable${theme.reset}` : "pulse: snapshot unavailable";
  }

  const segments = items.map((item) => {
    const symbol = item.symbol.replace(/USDT$/i, "");
    const directionToken = item.direction === "up" ? "▲" : item.direction === "down" ? "▼" : "•";
    const badgeText = item.changeText
      ? `${directionToken} ${item.changeText}`
      : item.direction === "flat"
        ? "• FLAT"
        : directionToken;
    if (!theme.useColor) {
      return `${symbol} ${item.priceText} ${badgeText}`.trim();
    }
    const badge = formatPulseBadge(badgeText, item.direction, theme);
    const priceColor = item.direction === "up"
      ? theme.success
      : item.direction === "down"
        ? theme.danger
        : theme.text;
    return `${theme.bold}${theme.text}${symbol}${theme.reset} ${priceColor}${item.priceText}${theme.reset} ${badge}`;
  });

  if (!theme.useColor) {
    return `pulse: ${segments.join(" · ")}`;
  }
  return `${theme.muted}pulse:${theme.reset} ${segments.join(` ${theme.border}·${theme.reset} `)}`;
}

function formatPulseBadge(
  text: string,
  direction: DeskMarketPulseItem["direction"],
  theme: CliTheme,
): string {
  const normalized = ` ${text} `;
  const padded = padVisible(normalized, 11);
  if (!theme.useColor) {
    return `[${padded.trimEnd()}]`;
  }

  const background = direction === "up"
    ? "\u001b[48;5;22m"
    : direction === "down"
      ? "\u001b[48;5;88m"
      : "\u001b[48;5;239m";
  const foreground = "\u001b[38;5;255m";
  return `${background}${foreground}${theme.bold}${padded}${theme.reset}`;
}

export function shouldUseColor(): boolean {
  return Boolean(stdout.isTTY && !process.env.NO_COLOR);
}

function renderDeskTip(): string {
  const theme = createCliTheme();
  const tip = pickRandomTip(DESK_TIPS);
  if (!theme.useColor) {
    return `tip: ${tip}`;
  }
  return `${theme.muted}tip:${theme.reset} ${theme.text}${tip}${theme.reset}`;
}

function pickRandomTip(tips: string[]): string {
  return tips[Math.floor(Math.random() * tips.length)] ?? tips[0] ?? "";
}

function getVariantColors(variant: PanelVariant, theme: CliTheme): { titleColor: string; borderColor: string } {
  switch (variant) {
    case "brand":
      return { titleColor: theme.brand, borderColor: theme.brand };
    case "skills":
      return { titleColor: theme.accent, borderColor: theme.accent };
    case "trace":
      return { titleColor: theme.accent, borderColor: theme.border };
    case "session":
      return { titleColor: theme.text, borderColor: theme.border };
    case "success":
      return { titleColor: theme.success, borderColor: theme.success };
    case "warning":
      return { titleColor: theme.warning, borderColor: theme.warning };
    case "approval":
      return { titleColor: theme.danger, borderColor: theme.danger };
    case "json":
      return { titleColor: theme.muted, borderColor: theme.border };
    case "help":
      return { titleColor: theme.brand, borderColor: theme.border };
    case "info":
    default:
      return { titleColor: theme.text, borderColor: theme.border };
  }
}

function formatKeyValueRows(rows: Array<[string, string]>, keyWidth = 10): string[] {
  return rows.map(([key, value]) => `${key.padEnd(keyWidth)} ${value}`);
}

function buildCompactTable(headers: string[], rows: string[][], widths: number[]): string[] {
  const formatRow = (cells: string[], emphasize = false): string =>
    cells
      .map((cell, index) => {
        const value = cropMiddle(cell, widths[index] ?? 12);
        return padVisible(emphasize ? value : stripAnsi(value), widths[index] ?? 12);
      })
      .join("  ");

  const header = formatRow(headers, true);
  const separator = widths.map((width) => "-".repeat(width)).join("  ");
  const body = rows.map((row) => formatRow(row));
  return [header, separator, ...body];
}

function normalizePanelLines(
  content: string | string[],
  width: number,
  preserveWhitespace: boolean,
): string[] {
  const rawLines = Array.isArray(content) ? content : content.trimEnd().split("\n");
  const normalized: string[] = [];
  for (const line of rawLines) {
    if (line === "") {
      normalized.push("");
      continue;
    }
    normalized.push(...wrapLine(stripAnsi(line), width, preserveWhitespace));
  }
  return normalized.length > 0 ? normalized : [""];
}

function wrapLine(line: string, width: number, preserveWhitespace: boolean): string[] {
  if (visibleLength(line) <= width) {
    return [line];
  }

  const chunks: string[] = [];
  let remaining = line;

  while (visibleLength(remaining) > width) {
    const candidate = takeByDisplayWidth(remaining, width);
    const chunk = preserveWhitespace
      ? takeByDisplayWidth(remaining, width)
      : remaining.slice(0, findWrapPoint(candidate, width));
    chunks.push(chunk.trimEnd());
    remaining = preserveWhitespace
      ? remaining.slice(chunk.length)
      : remaining.slice(chunk.length).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

function findWrapPoint(candidate: string, width: number): number {
  const newlineIndex = candidate.lastIndexOf("\n");
  if (newlineIndex >= width * 0.6) {
    return newlineIndex + 1;
  }

  const punctuationMatches = [...candidate.matchAll(/[。！？.!?；;：:,，]\s*/g)];
  const lastPunctuation = punctuationMatches.at(-1);
  if (lastPunctuation && lastPunctuation.index !== undefined && lastPunctuation.index >= width * 0.6) {
    return lastPunctuation.index + lastPunctuation[0].length;
  }

  const spaceIndex = candidate.lastIndexOf(" ");
  if (spaceIndex >= width * 0.6) {
    return spaceIndex + 1;
  }

  return width;
}

function cropMiddle(value: string, maxLength: number): string {
  if (visibleLength(value) <= maxLength) {
    return value;
  }
  if (maxLength <= 7) {
    return `${takeByDisplayWidth(value, Math.max(maxLength - 1, 1))}…`;
  }
  const lead = Math.ceil((maxLength - 1) / 2);
  const tail = Math.floor((maxLength - 1) / 2);
  return `${takeByDisplayWidth(value, lead)}…${takeRightByDisplayWidth(value, tail)}`;
}

function getPanelWidth(): number {
  const columns = stdout.columns ?? 96;
  return Math.max(42, Math.min(columns - 2, 104));
}

function getPanelContentWidth(): number {
  return Math.max(24, getPanelWidth() - 4);
}

function formatTimestamp(value: string): string {
  return value.replace("T", " ").slice(0, 16);
}

function sanitizeInlineMarkdown(input: string): string {
  return input
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .trim();
}

function collapseBlankLines(lines: string[]): string[] {
  const result: string[] = [];
  for (const line of lines) {
    if (line === "" && result.at(-1) === "") {
      continue;
    }
    result.push(line);
  }
  if (result.at(-1) === "") {
    result.pop();
  }
  return result;
}

function shouldFlushPending(value: string): boolean {
  if (!value) {
    return false;
  }
  if (value.includes("\n")) {
    return true;
  }
  const lastChar = value.at(-1) ?? "";
  return /[\s，。！？、；：,.!?;:)\]}>]/.test(lastChar);
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function visibleLength(value: string): number {
  let width = 0;
  for (const character of stripAnsi(value)) {
    width += getCharacterDisplayWidth(character);
  }
  return width;
}

function padVisible(value: string, width: number): string {
  const visible = visibleLength(value);
  return value + " ".repeat(Math.max(width - visible, 0));
}

function takeByDisplayWidth(value: string, width: number): string {
  if (width <= 0) {
    return "";
  }

  let consumed = 0;
  let result = "";
  for (const character of value) {
    const nextWidth = getCharacterDisplayWidth(character);
    if (consumed + nextWidth > width) {
      break;
    }
    result += character;
    consumed += nextWidth;
  }
  return result;
}

function takeRightByDisplayWidth(value: string, width: number): string {
  if (width <= 0) {
    return "";
  }

  const characters = Array.from(value);
  let consumed = 0;
  let result = "";
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index] ?? "";
    const nextWidth = getCharacterDisplayWidth(character);
    if (consumed + nextWidth > width) {
      break;
    }
    result = `${character}${result}`;
    consumed += nextWidth;
  }
  return result;
}

function getCharacterDisplayWidth(character: string): number {
  const codePoint = character.codePointAt(0);
  if (!codePoint) {
    return 0;
  }

  if (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0x300 && codePoint <= 0x36f)
  ) {
    return 0;
  }

  if (
    codePoint >= 0x1100 &&
    (
      codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
      (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    )
  ) {
    return 2;
  }

  return 1;
}

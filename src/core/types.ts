export type JsonSchema = {
  type: string;
  description?: string;
  enum?: string[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
};

export type ToolAuthScope = "none" | "spot" | "futures" | "wallet";
export type BinanceRequestMethod = "GET" | "POST" | "DELETE";
export type BinanceRequestScope = "spot" | "futures" | "wallet";
export type SkillTransportKind =
  | "builtin"
  | "binance-public-http"
  | "binance-signed-http"
  | "http"
  | "exec"
  | "memory";

export type MessageRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: MessageRole;
  content: string;
}

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export interface GatewayConfig {
  url?: string;
  host: string;
  port: number;
}

export interface TelegramConfig {
  botToken?: string;
  apiBaseUrl: string;
  pollingTimeoutSeconds: number;
  allowedUserIds: string[];
  allowedChatIds: string[];
}

export interface BinanceConfig {
  apiKey?: string;
  apiSecret?: string;
  useTestnet: boolean;
  recvWindow: number;
  spotBaseUrl: string;
  futuresBaseUrl: string;
  sapiBaseUrl: string;
  webBaseUrl: string;
}

export interface BraveSearchConfig {
  apiKey?: string;
  baseUrl: string;
  defaultCountry: string;
  searchLanguage: string;
  uiLanguage: string;
}

export interface SessionConfig {
  messageCompactionLimit: number;
  scratchpadCompactionLimit: number;
  charCompactionLimit: number;
  retainRecentMessages: number;
  retainRecentScratchpad: number;
  maxCompactionRecords: number;
}

export interface WorkspaceDocumentPaths {
  agentsFile: string;
  soulFile: string;
  userFile: string;
  identityFile: string;
  heartbeatFile: string;
  bootstrapFile: string;
  toolsFile: string;
}

export interface WorkspaceBootstrapDocs {
  agents: string;
  soul: string;
  user: string;
  identity: string;
  heartbeat: string;
  bootstrap: string;
  tools: string;
}

export interface AppConfig {
  cwd: string;
  appHome: string;
  configFile: string;
  workspaceDir: string;
  workspaceAgentsFile: string;
  workspaceSoulFile: string;
  workspaceUserFile: string;
  workspaceIdentityFile: string;
  workspaceHeartbeatFile: string;
  workspaceBootstrapFile: string;
  workspaceSessionsDir: string;
  workspaceSessionsIndexFile: string;
  workspaceSessionTranscriptsDir: string;
  workspaceSkillsDir: string;
  workspaceToolsFile: string;
  workspaceMemoryDir: string;
  workspaceLongTermMemoryFile: string;
  globalSkillsDir: string;
  localSkillsDir: string;
  memoryFile: string;
  session: SessionConfig;
  gateway: GatewayConfig;
  telegram: TelegramConfig;
  provider: ProviderConfig;
  binance: BinanceConfig;
  brave: BraveSearchConfig;
}

export interface StoredProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export interface StoredBinanceConfig {
  apiKey?: string;
  apiSecret?: string;
  useTestnet?: boolean;
  recvWindow?: number;
  spotBaseUrl?: string;
  futuresBaseUrl?: string;
  sapiBaseUrl?: string;
  webBaseUrl?: string;
}

export interface StoredBraveSearchConfig {
  apiKey?: string;
  baseUrl?: string;
  defaultCountry?: string;
  searchLanguage?: string;
  uiLanguage?: string;
}

export interface StoredSessionConfig {
  messageCompactionLimit?: number;
  scratchpadCompactionLimit?: number;
  charCompactionLimit?: number;
  retainRecentMessages?: number;
  retainRecentScratchpad?: number;
  maxCompactionRecords?: number;
}

export interface StoredGatewayConfig {
  url?: string;
  host?: string;
  port?: number;
}

export interface StoredTelegramConfig {
  botToken?: string;
  apiBaseUrl?: string;
  pollingTimeoutSeconds?: number;
  allowedUserIds?: string[];
  allowedChatIds?: string[];
}

export interface StoredAppConfig {
  provider?: StoredProviderConfig;
  binance?: StoredBinanceConfig;
  brave?: StoredBraveSearchConfig;
  session?: StoredSessionConfig;
  gateway?: StoredGatewayConfig;
  telegram?: StoredTelegramConfig;
}

export interface SkillManifest {
  name: string;
  version: string;
  description: string;
  capabilities: string[];
  requires_auth: boolean;
  dangerous: boolean;
  products: string[];
  tools: string[];
}

export interface SkillBinanceRestConfig {
  scope: BinanceRequestScope;
  method: BinanceRequestMethod;
  path: string;
  signed?: boolean;
  defaultParams?: Record<string, string | number | boolean>;
}

export interface SkillSectionMap {
  whenToUse: string;
  instructions: string;
  availableApis: string;
  outputContract: string;
  examples: string;
  quickReference?: string;
  parameters?: string;
  authentication?: string;
  security?: string;
  agentBehavior?: string;
}

export interface SkillParameterHint {
  name: string;
  required: boolean;
  description: string;
  enumValues: string[];
}

export interface SkillEndpointHint {
  id: string;
  operation: string;
  description: string;
  method: BinanceRequestMethod;
  path: string;
  authRequired: boolean;
  requiredParams: string[];
  optionalParams: string[];
  transport: Exclude<SkillTransportKind, "builtin" | "memory">;
  userAgent?: string;
  dangerLevel: "readonly" | "mutating";
}

export interface SkillReferenceFile {
  relativePath: string;
  absolutePath: string;
}

export interface SkillReferenceSnippet {
  skillName: string;
  relativePath: string;
  content: string;
}

export interface SkillExecutionHint {
  kind: "script";
  name: string;
  relativePath: string;
  absolutePath: string;
  interpreter?: string;
  dangerous: boolean;
}

export interface PolicyRule {
  kind: "approval" | "mask-secrets" | "account-alias" | "user-agent";
  summary: string;
  appliesTo?: string[];
  value?: string;
}

export interface SkillAuthHints {
  requiresApiKey: boolean;
  requiresSecretKey: boolean;
  signatureAlgorithms: string[];
  headerNames: string[];
  userAgent?: string;
  baseUrls: string[];
  confirmOnTransactions: boolean;
}

export interface SkillKnowledge {
  sections: SkillSectionMap;
  endpointHints: SkillEndpointHint[];
  authHints: SkillAuthHints;
  referenceFiles: SkillReferenceFile[];
  executionHints: SkillExecutionHint[];
  policyRules: PolicyRule[];
}

export interface SkillToolDefinition {
  id: string;
  description: string;
  dangerous: boolean;
  authScope: ToolAuthScope;
  transport: "binance-rest";
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  binance: SkillBinanceRestConfig;
}

export interface InstalledSkill {
  manifest: SkillManifest;
  toolDefinitions: SkillToolDefinition[];
  knowledge: SkillKnowledge;
  instructions: string;
  sourcePath: string;
  rootDir: string;
  warnings: string[];
}

export interface DeskMarketPulseItem {
  symbol: string;
  priceText: string;
  changeText?: string;
  direction: "up" | "down" | "flat";
}

export interface ToolExecutionContext {
  config: AppConfig;
  now: () => Date;
}

export interface ToolResult {
  ok: boolean;
  toolId: string;
  data?: unknown;
  error?: string;
  cached?: boolean;
}

export interface ToolDefinition<Input = Record<string, unknown>> {
  id: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  dangerous: boolean;
  authScope: ToolAuthScope;
  transport?: SkillTransportKind;
  sourceSkill?: string;
  handler: (input: Input, context: ToolExecutionContext) => Promise<ToolResult>;
}

export interface ToolCall {
  toolId: string;
  input: Record<string, unknown>;
  dangerous: boolean;
}

export interface ApprovalRequest {
  id: string;
  toolId: string;
  summary: string;
  riskLevel: "medium" | "high";
  payloadPreview: string;
  expiresAt: string;
  toolCall: ToolCall;
}

export interface ReasoningStep {
  timestamp: string;
  iteration: number;
  kind: "intent" | "plan" | "observation" | "approval" | "response" | "fallback";
  summary: string;
  detail?: string;
}

export interface ConversationState {
  currentSymbol?: string;
  currentTopic?: "market" | "news" | "web3" | "account" | "trade" | "orders";
  currentMarketType?: "spot" | "futures";
  summary?: string;
}

export interface SessionCompactionRecord {
  timestamp: string;
  trigger: "messages" | "scratchpad" | "chars" | "manual";
  summary: string;
  durableFacts: string[];
  droppedMessages: number;
  droppedScratchpad: number;
}

export interface SessionSnapshot {
  id?: string;
  key?: string;
  type?: "main";
  transcriptFile?: string;
  createdAt?: string;
  updatedAt?: string;
  messages: ChatMessage[];
  scratchpad: ReasoningStep[];
  activeSkills: string[];
  pendingApproval?: ApprovalRequest;
  portfolioContext?: string;
  lastIntent?: IntentAnalysis;
  conversationState?: ConversationState;
  compactionSummary?: string;
  compactions?: SessionCompactionRecord[];
}

export interface SessionIndexEntry {
  id: string;
  key: string;
  type: "main";
  status: "active" | "archived";
  transcriptFile: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  scratchpadCount: number;
  compactionCount: number;
  snapshot: SessionSnapshot;
}

export interface SessionIndexFile {
  sessions: SessionIndexEntry[];
}

export interface SessionTranscriptEvent {
  timestamp: string;
  type:
    | "session.created"
    | "session.snapshot"
    | "message"
    | "scratchpad"
    | "approval"
    | "compaction"
    | "session.cleared";
  sessionId: string;
  sessionKey: string;
  payload: Record<string, unknown>;
}

export interface SessionState {
  id?: string;
  key?: string;
  type?: "main";
  transcriptFile?: string;
  createdAt?: string;
  updatedAt?: string;
  messages: ChatMessage[];
  scratchpad: ReasoningStep[];
  activeSkills: string[];
  pendingApproval?: ApprovalRequest;
  portfolioContext?: string;
  memoryContext?: WorkspaceMemoryContext;
  referenceContext?: SkillReferenceSnippet[];
  lastIntent?: IntentAnalysis;
  conversationState?: ConversationState;
  compactionSummary?: string;
  compactions?: SessionCompactionRecord[];
}

export interface MemoryState {
  preferredLanguage: string;
  watchSymbols: string[];
  riskProfile: string;
  preferredMarket: string;
  recentSummaries: string[];
}

export interface WorkspaceMemoryEntry {
  date: string;
  filePath: string;
  content: string;
}

export interface WorkspaceMemoryContext {
  longTermMemory: string;
  recentEntries: WorkspaceMemoryEntry[];
  workspaceDocs?: WorkspaceBootstrapDocs;
}

export interface IntentAnalysis {
  categories: string[];
  symbol?: string;
  quantity?: number;
  price?: number;
  side?: "BUY" | "SELL";
  marketType?: "spot" | "futures";
  orderType?: "MARKET" | "LIMIT";
  orderId?: number;
}

export interface PlannerContext {
  input: string;
  skills: InstalledSkill[];
  activeSkills?: InstalledSkill[];
  session: SessionState;
  authAvailable: boolean;
  conversationState?: ConversationState;
}

export interface PlanResult {
  skills: InstalledSkill[];
  toolCalls: ToolCall[];
  intent: IntentAnalysis;
  directResponse?: string;
}

export interface SummaryRequest {
  input: string;
  activeSkills: InstalledSkill[];
  toolResults: ToolResult[];
  session: SessionState;
}

export interface DirectResponseBrief {
  objective: string;
  status?: string;
  facts?: string[];
  asks?: string[];
  nextSteps?: string[];
  constraints?: string[];
}

export interface DirectResponseRequest {
  input: string;
  draft: string;
  intent?: IntentAnalysis;
  session: SessionState;
  mode: "clarify" | "fallback" | "guidance" | "approval" | "result";
  memoryContext?: WorkspaceMemoryContext;
  brief?: DirectResponseBrief;
}

export interface SkillSelectionRequest {
  input: string;
  skills: InstalledSkill[];
  session: SessionState;
  authAvailable: boolean;
  memoryContext?: WorkspaceMemoryContext;
}

export interface SkillSelectionResult {
  skillNames: string[];
  rationale?: string;
}

export interface SkillReferenceSelectionRequest {
  input: string;
  activeSkills: InstalledSkill[];
  session: SessionState;
  authAvailable: boolean;
  memoryContext?: WorkspaceMemoryContext;
}

export interface SkillReferenceSelectionResult {
  references: Array<{
    skillName: string;
    relativePath: string;
  }>;
  rationale?: string;
}

export interface PlanningToolCandidate {
  id: string;
  description: string;
  dangerous: boolean;
  authScope: ToolAuthScope;
  inputSchema: JsonSchema;
  sourceSkill?: string;
  transport?: SkillTransportKind;
}

export interface CompiledToolCandidate extends PlanningToolCandidate {
  runtimeDefinition: ToolDefinition;
}

export interface CompiledSkillRuntime {
  skills: InstalledSkill[];
  toolRegistry: Map<string, ToolDefinition>;
  tools: CompiledToolCandidate[];
}

export interface PlanningRequest {
  input: string;
  candidateSkills: InstalledSkill[];
  session: SessionState;
  authAvailable: boolean;
  tools: PlanningToolCandidate[];
  observations: ToolResult[];
  iteration: number;
  memoryContext?: WorkspaceMemoryContext;
  referenceContext?: SkillReferenceSnippet[];
}

export interface ConversationStateRequest {
  input: string;
  session: SessionState;
  memoryContext?: WorkspaceMemoryContext;
}

export interface SessionCompactionRequest {
  session: SessionState;
  messagesToCompact: ChatMessage[];
  scratchpadToCompact: ReasoningStep[];
  trigger: SessionCompactionRecord["trigger"];
  memoryContext?: WorkspaceMemoryContext;
}

export interface SessionCompactionResult {
  summary: string;
  durableFacts: string[];
  conversationState?: ConversationState;
}

export interface ModelPlanResult {
  selectedSkillNames?: string[];
  directResponse?: string;
  conversationStateUpdate?: ConversationState;
  toolCalls?: Array<{
    toolId: string;
    input: Record<string, unknown>;
  }>;
  rationale?: string;
}

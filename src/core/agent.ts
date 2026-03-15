import {
  APPROVAL_CANCEL,
  APPROVAL_CONFIRMATION,
  createApprovalRequest,
  isApprovalExpired,
  resolveApprovalDecision,
} from "./approval.ts";
import {BinanceClient} from "./binance.ts";
import {createAppConfig, ensureAppDirectories} from "./config.ts";
import {MemoryStore} from "./memory.ts";
import {createPlan} from "./planner.ts";
import {type ChatProvider, fallbackSummary, OpenAICompatibleProvider} from "./provider.ts";
import {inferIntent} from "./router.ts";
import {SessionManager} from "./session.ts";
import {loadInstalledSkills, loadSkillReferenceSnippets, selectFallbackReferenceSnippets, syncWorkspaceToolsIndex} from "./skill.ts";
import {compileSkillRuntime} from "./runtime.ts";
import {createToolRegistry, createToolRegistryFromSkills, executeToolCall} from "./tools.ts";
import {ensureWorkspaceBootstrapFiles, getWorkspaceDocumentPaths} from "./workspace.ts";
import type {
  AppConfig,
  ApprovalRequest,
  CompiledSkillRuntime,
  DeskMarketPulseItem,
  ConversationState,
  DirectResponseBrief,
  EndpointDecision,
  InstalledSkill,
  ReasoningStep,
  SessionState,
  SummaryRequest,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "./types.ts";

interface AgentDependencies {
  provider?: ChatProvider;
  memoryStore?: MemoryStore;
  sessionManager?: SessionManager;
  binanceClient?: BinanceClient;
  skills?: InstalledSkill[];
  toolRegistry?: Map<string, ToolDefinition>;
}

const DEFAULT_MAX_MODEL_STEPS = 4;
const PUBLIC_TOOL_CACHE_TTL_MS = 8_000;
const DESK_PULSE_SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT"] as const;
const DESK_PULSE_TIMEOUT_MS = 1_200;

export interface AgentTurnCallbacks {
  onStatus?: (status: string) => void;
  onTextStart?: () => void;
  onTextDelta?: (delta: string) => void;
  onTextDone?: (fullText: string) => void;
}

export interface AgentTurnResult {
  text: string;
  toolResults: ToolResult[];
  approval?: ApprovalRequest;
}

interface DirectResponseSeed {
  draft: string;
  brief?: DirectResponseBrief;
}

export class BinaClawAgent {
  readonly config: AppConfig;
  private readonly provider: ChatProvider;
  private readonly memoryStore: MemoryStore;
  private readonly sessionManager: SessionManager;
  private readonly binanceClient: BinanceClient;
  private toolRegistry: Map<string, ToolDefinition>;
  private approvalToolRegistry?: Map<string, ToolDefinition>;
  private skills: InstalledSkill[] = [];
  private initialized = false;
  private readonly compiledRuntimeCache = new Map<string, CompiledSkillRuntime>();
  private readonly readOnlyToolCache = new Map<string, { expiresAt: number; result: ToolResult }>();
  private readonly inFlightReadOnlyCalls = new Map<string, Promise<ToolResult>>();
  private session: SessionState = {
    messages: [],
    scratchpad: [],
    activeSkills: [],
  };

  constructor(config = createAppConfig(), deps: AgentDependencies = {}) {
    this.config = config;
    this.provider = deps.provider ?? new OpenAICompatibleProvider(config.provider);
    this.memoryStore =
      deps.memoryStore ??
      new MemoryStore(
        config.memoryFile,
        config.workspaceMemoryDir,
        config.workspaceLongTermMemoryFile,
        getWorkspaceDocumentPaths(config),
      );
    this.binanceClient = deps.binanceClient ?? new BinanceClient(config.binance);
    this.toolRegistry = deps.toolRegistry ?? createToolRegistry(config, this.binanceClient);
    this.sessionManager = deps.sessionManager
      ?? new SessionManager(
        config.workspaceSessionsIndexFile,
        config.workspaceSessionTranscriptsDir,
      );
    if (deps.skills) {
      this.skills = deps.skills;
      if (!deps.toolRegistry) {
        this.toolRegistry = createToolRegistryFromSkills(config, this.skills, this.binanceClient);
      }
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await ensureAppDirectories(this.config);
    await ensureWorkspaceBootstrapFiles(this.config);
    if (this.skills.length === 0) {
      this.skills = await loadInstalledSkills(this.config);
    }
    await syncWorkspaceToolsIndex(this.config, this.skills);
    this.session = await this.sessionManager.load();
    this.initialized = true;
  }

  getSession(): SessionState {
    return this.session;
  }

  clearTrace(): void {
    this.session.scratchpad = [];
    void this.sessionManager.save(this.session);
  }

  async clearSession(): Promise<SessionState> {
    this.session = await this.sessionManager.clear();
    this.approvalToolRegistry = undefined;
    this.readOnlyToolCache.clear();
    this.inFlightReadOnlyCalls.clear();
    return this.session;
  }

  async reloadSkills(): Promise<InstalledSkill[]> {
    this.skills = await loadInstalledSkills(this.config);
    this.toolRegistry = createToolRegistryFromSkills(this.config, this.skills, this.binanceClient);
    this.compiledRuntimeCache.clear();
    await syncWorkspaceToolsIndex(this.config, this.skills);
    this.initialized = true;
    return this.skills;
  }

  async getDeskMarketPulse(): Promise<DeskMarketPulseItem[]> {
    await this.initialize();
    const settled = await Promise.allSettled(
      DESK_PULSE_SYMBOLS.map(async (symbol) =>
        buildDeskMarketPulseItem(
          symbol,
          await withTimeout(this.binanceClient.getTicker(symbol), DESK_PULSE_TIMEOUT_MS),
        )
      ),
    );

    return settled.flatMap((entry) => {
      if (entry.status !== "fulfilled" || !entry.value) {
        return [];
      }
      return [entry.value];
    });
  }

  async handleInput(input: string, callbacks: AgentTurnCallbacks = {}): Promise<AgentTurnResult> {
    callbacks.onStatus?.("正在准备会话环境...");
    await this.initialize();
    const trimmed = input.trim();
    if (!trimmed) {
      const seed = createTaskClarificationSeed();
      const text = await this.composeDirectResponse(
        seed.draft,
        trimmed,
        undefined,
        "guidance",
        seed.brief,
      );
      return { text, toolResults: [] };
    }

    if (this.session.pendingApproval) {
      return this.handleApprovalInput(trimmed);
    }

    this.session.messages.push({ role: "user", content: trimmed });
    const resolvedInput = this.provider.isConfigured() ? trimmed : applyContinuationContext(trimmed, this.session);
    callbacks.onStatus?.("正在记录输入并更新记忆...");
    await this.memoryStore.appendDailyLog("user", trimmed);
    const modelFacts = this.provider.isConfigured() && shouldExtractStableFacts(trimmed)
      ? (await this.provider.extractStableFacts(
          trimmed,
          this.session.scratchpad.slice(-4).map((item) => item.summary).join("；"),
        )) ?? []
      : [];
    const promotedFacts = await this.memoryStore.promoteStableFactsFromText(trimmed, modelFacts);
    if (promotedFacts.length > 0) {
      this.addScratchpadStep(
        0,
        "response",
        `自动提升 ${promotedFacts.length} 条长期记忆`,
        promotedFacts.join("；"),
      );
    }
    callbacks.onStatus?.("正在加载工作区记忆...");
    this.session.memoryContext = await this.memoryStore.getWorkspaceContext(2);
    this.session = await this.sessionManager.prepareForTurn(this.session);
    callbacks.onStatus?.("正在选择技能...");
    const heuristicPlan = createPlan({
      input: resolvedInput,
      skills: this.skills,
      session: this.session,
      authAvailable: this.binanceClient.hasAuth(),
      conversationState: this.session.conversationState,
    });
    const selectedSkills = this.provider.isConfigured()
      ? await this.resolveActiveSkills(resolvedInput, heuristicPlan.skills)
      : heuristicPlan.skills;
    const plan = this.provider.isConfigured()
      ? {
          ...heuristicPlan,
          skills: selectedSkills.length > 0 ? selectedSkills : heuristicPlan.skills,
        }
      : heuristicPlan;
    this.addScratchpadStep(
      0,
      "intent",
      `收到用户请求: ${trimmed}`,
      JSON.stringify({ resolvedInput, intent: plan.intent }),
    );
    this.session.activeSkills = plan.skills.map((skill) => skill.manifest.name);
    if (this.provider.isConfigured()) {
      this.addScratchpadStep(
        0,
        "plan",
        `模型选中 ${plan.skills.length} 个技能进入主规划`,
        plan.skills.map((skill) => skill.manifest.name).join("、"),
      );
    }
    if (hasMeaningfulIntent(plan.intent)) {
      this.session.lastIntent = plan.intent;
      this.session.conversationState = mergeConversationState(this.session.conversationState, {
        currentSymbol: plan.intent.symbol,
        currentTopic: inferPrimaryTopic(plan.intent),
        currentMarketType: plan.intent.marketType,
        summary: trimmed,
      });
    }
    if (!this.provider.isConfigured() && shouldPreferHeuristicClarification(plan)) {
      const text = await this.composeDirectResponse(
        plan.directResponse ?? "",
        trimmed,
        plan.intent,
        "clarify",
        createMissingSymbolBrief(plan.intent),
      );
      await this.emitAssistantText(text, callbacks);
      this.session.messages.push({ role: "assistant", content: text });
      this.addScratchpadStep(
        0,
        "response",
        "缺少关键交易对信息，先向用户确认主语",
        text,
      );
      await this.memoryStore.rememberSummary(text.slice(0, 300));
      await this.memoryStore.appendDailyLog("assistant", text);
      await this.persistSession();
      return {
        text,
        toolResults: [],
      };
    }
    callbacks.onStatus?.("正在加载技能参考...");
    this.session.referenceContext = await this.resolveReferenceContext(resolvedInput, plan.skills);
    callbacks.onStatus?.("正在编译技能工具...");
    const compiledRuntime = await this.getCompiledRuntime(plan.skills);
    if (compiledRuntime.tools.length > 0) {
      this.addScratchpadStep(
        0,
        "plan",
        `已编译 ${compiledRuntime.tools.length} 个 skill runtime tools`,
        compiledRuntime.tools.map((tool) => `${tool.id}:${tool.transport}`).join(", "),
      );
    }
    if (this.session.referenceContext && this.session.referenceContext.length > 0) {
      this.addScratchpadStep(
        0,
        "plan",
        `已懒加载 ${this.session.referenceContext.length} 个 skill references`,
        this.session.referenceContext.map((item) => `${item.skillName}:${item.relativePath}`).join(", "),
      );
    }

    if (shouldUseFastAnalysisPath(resolvedInput, plan)) {
      const execution = await this.executeFastAnalysis(trimmed, resolvedInput, plan, compiledRuntime, callbacks);
      if (!execution.approval) {
        this.session.messages.push({ role: "assistant", content: execution.text });
        this.addScratchpadStep(
          0,
          "response",
          `快速分析路径输出最终回复，累计执行 ${execution.toolResults.length} 个工具`,
          execution.text.slice(0, 300),
        );
        if (plan.intent.symbol) {
          await this.memoryStore.rememberSymbol(plan.intent.symbol);
        }
        await this.memoryStore.rememberSummary(execution.text.slice(0, 300));
        await this.memoryStore.appendDailyLog("assistant", execution.text);
        await this.persistSession();
      }
      return execution;
    }

    const execution = await this.runAgentLoop(trimmed, resolvedInput, plan, compiledRuntime, callbacks);
    if (execution.approval) {
      this.session.pendingApproval = execution.approval;
      this.approvalToolRegistry = compiledRuntime.toolRegistry;
      this.addScratchpadStep(
        this.getLatestIteration(),
        "approval",
        `待确认危险工具: ${execution.approval.toolId}`,
        execution.approval.payloadPreview,
      );
      await this.persistSession();
      return execution;
    }

    this.session.messages.push({ role: "assistant", content: execution.text });
    this.addScratchpadStep(
      this.getLatestIteration(),
      "response",
      `输出最终回复，累计执行 ${execution.toolResults.length} 个工具`,
      execution.text.slice(0, 300),
    );
    if (plan.intent.symbol) {
      await this.memoryStore.rememberSymbol(plan.intent.symbol);
    }
    await this.memoryStore.rememberSummary(execution.text.slice(0, 300));
    await this.memoryStore.appendDailyLog("assistant", execution.text);
    await this.persistSession();

    return execution;
  }

  private async resolveActiveSkills(input: string, fallbackSkills: InstalledSkill[]): Promise<InstalledSkill[]> {
    if (!this.provider.isConfigured()) {
      return fallbackSkills;
    }

    try {
      const selected = await this.provider.selectSkills({
        input,
        skills: this.skills,
        session: this.session,
        authAvailable: this.binanceClient.hasAuth(),
        memoryContext: this.session.memoryContext,
      });

      if (!selected || selected.skillNames.length === 0) {
        this.addScratchpadStep(0, "fallback", "模型未选出可用 skill，回退启发式 skill 路由");
        return fallbackSkills;
      }

      const selectedSet = new Set(selected.skillNames);
      const resolvedSkills = this.skills.filter((skill) => selectedSet.has(skill.manifest.name));
      if (resolvedSkills.length === 0) {
        this.addScratchpadStep(0, "fallback", "模型 skill 路由无有效命中，回退启发式 skill 路由");
        return fallbackSkills;
      }

      this.addScratchpadStep(
        0,
        "plan",
        `模型激活技能: ${resolvedSkills.map((skill) => skill.manifest.name).join("、")}`,
        selected.rationale,
      );
      return resolvedSkills;
    } catch (error) {
      this.addScratchpadStep(
        0,
        "fallback",
        "模型 skill 路由异常，回退启发式 skill 路由",
        error instanceof Error ? error.message : String(error),
      );
      return fallbackSkills;
    }
  }

  private async runAgentLoop(
    rawInput: string,
    planningInput: string,
    heuristicPlan: ReturnType<typeof createPlan>,
    compiledRuntime: CompiledSkillRuntime,
    callbacks: AgentTurnCallbacks,
  ): Promise<AgentTurnResult> {
    const toolResults: ToolResult[] = [];
    const initialDirectResponse = heuristicPlan.directResponse;
    let pendingPlan = heuristicPlan;

    if (!this.provider.isConfigured()) {
      callbacks.onStatus?.("使用本地规划器生成回复...");
      this.addScratchpadStep(0, "fallback", "未配置模型，使用启发式规划", heuristicPlan.directResponse);
      return this.executeSinglePlan(rawInput, heuristicPlan, compiledRuntime, callbacks);
    }

    const maxModelSteps = getMaxModelSteps(planningInput, heuristicPlan);
    for (let iteration = 0; iteration < maxModelSteps; iteration += 1) {
      callbacks.onStatus?.(iteration === 0 ? "正在规划技能与工具..." : "正在根据观察结果继续规划...");
      const resolvedPlan = await this.resolvePlanFromModel(planningInput, pendingPlan, compiledRuntime, toolResults, iteration);
      this.addScratchpadStep(
        iteration,
        "plan",
        resolvedPlan.directResponse
          ? "模型给出了可直接回复或带说明的计划"
          : `模型规划 ${resolvedPlan.toolCalls.length} 个工具调用`,
        JSON.stringify({
          directResponse: resolvedPlan.directResponse,
          endpointDecision: resolvedPlan.endpointDecision,
          toolCalls: resolvedPlan.toolCalls,
        }),
      );

      if (resolvedPlan.endpointDecision) {
        this.addScratchpadStep(
          iteration,
          "plan",
          "模型给出了 skill 接口决策",
          JSON.stringify(resolvedPlan.endpointDecision),
        );
      }

      if (resolvedPlan.conversationStateUpdate && hasMeaningfulConversationState(resolvedPlan.conversationStateUpdate)) {
        this.session.conversationState = mergeConversationState(this.session.conversationState, resolvedPlan.conversationStateUpdate);
        this.addScratchpadStep(
          iteration,
          "plan",
          "主规划调用更新了会话主题状态",
          JSON.stringify(resolvedPlan.conversationStateUpdate),
        );
      }
      if (resolvedPlan.skills.length > 0) {
        this.session.activeSkills = resolvedPlan.skills.map((skill) => skill.manifest.name);
      }

      if (resolvedPlan.directResponse && (resolvedPlan.toolCalls.length === 0 || iteration > 0)) {
        const text = resolvedPlan.directResponse;
        await this.emitAssistantText(text, callbacks);
        return {
          text,
          toolResults,
        };
      }

      const readOnlyCalls = dedupeToolCalls(resolvedPlan.toolCalls.filter((call) => !call.dangerous));
      const dangerousCalls = resolvedPlan.toolCalls.filter((call) => call.dangerous);

      if (dangerousCalls.length > 0) {
        const approval = createApprovalRequest(dangerousCalls[0], toolResults);
        const seed = createApprovalRequiredSeed(approval);
        const text = await this.composeDirectResponse(
          seed.draft,
          rawInput,
          heuristicPlan.intent,
          "approval",
          seed.brief,
        );
        return { text, toolResults, approval };
      }

      if (readOnlyCalls.length === 0) {
        break;
      }

      callbacks.onStatus?.(`正在执行 ${readOnlyCalls.length} 个只读工具...`);
      const stepResults = await this.executeReadOnlyCalls(readOnlyCalls, compiledRuntime.toolRegistry);
      toolResults.push(...stepResults);

      for (const result of stepResults) {
        this.addScratchpadStep(
          iteration,
          "observation",
          result.ok
            ? result.cached
              ? `工具 ${result.toolId} 命中缓存`
              : `工具 ${result.toolId} 执行成功`
            : `工具 ${result.toolId} 执行失败`,
          result.ok ? JSON.stringify(result.data).slice(0, 300) : result.error,
        );
      }

      if (!shouldAllowFollowupPlanning(planningInput, heuristicPlan)) {
        break;
      }

      pendingPlan = {
        ...resolvedPlan,
        toolCalls: readOnlyCalls,
        directResponse: undefined,
      };
    }

    if (toolResults.length > 0) {
      const summaryRequest: SummaryRequest = {
        input: rawInput,
        activeSkills: resolveActiveSkillsForSummary(this.skills, this.session.activeSkills, heuristicPlan.skills),
        toolResults,
        session: this.session,
      };
      callbacks.onStatus?.("正在生成最终回复...");
      if (this.provider.isConfigured() && this.provider.streamSummary && callbacks.onTextDelta) {
        callbacks.onTextStart?.();
        const text = await this.provider.streamSummary(summaryRequest, callbacks.onTextDelta);
        callbacks.onTextDone?.(text);
        return {
          text,
          toolResults,
        };
      }
      return {
        text: this.provider.isConfigured()
          ? await this.provider.summarize(summaryRequest)
          : fallbackSummary(summaryRequest),
        toolResults,
      };
    }

    if (initialDirectResponse) {
      const text = initialDirectResponse;
      await this.emitAssistantText(text, callbacks);
      return { text, toolResults };
    }

    const fallbackSeed = createNeedMoreContextSeed(heuristicPlan.intent);
    const fallbackText = await this.composeDirectResponse(
      fallbackSeed.draft,
      planningInput,
      heuristicPlan.intent,
      "fallback",
      fallbackSeed.brief,
    );
    await this.emitAssistantText(fallbackText, callbacks);
    return {
      text: fallbackText,
      toolResults,
    };
  }

  private async executeFastAnalysis(
    rawInput: string,
    planningInput: string,
    heuristicPlan: ReturnType<typeof createPlan>,
    compiledRuntime: CompiledSkillRuntime,
    callbacks: AgentTurnCallbacks,
  ): Promise<AgentTurnResult> {
    const fastCalls = buildFastAnalysisCalls(heuristicPlan, compiledRuntime);
    if (fastCalls.length === 0) {
      return await this.runAgentLoop(rawInput, planningInput, heuristicPlan, compiledRuntime, callbacks);
    }

    this.addScratchpadStep(
      0,
      "plan",
      `命中快速分析路径，直接执行 ${fastCalls.length} 个市场工具`,
      fastCalls.map((call) => call.toolId).join(", "),
    );
    callbacks.onStatus?.(`正在快速获取 ${fastCalls.length} 个市场信号...`);
    const toolResults = await Promise.all(
      fastCalls.map(async (call) => await this.executeReadOnlyCallWithCache(call, compiledRuntime.toolRegistry)),
    );

    for (const result of toolResults) {
      this.addScratchpadStep(
        0,
        "observation",
        result.ok
          ? result.cached
            ? `工具 ${result.toolId} 命中缓存`
            : `工具 ${result.toolId} 执行成功`
          : `工具 ${result.toolId} 执行失败`,
        result.ok ? JSON.stringify(result.data).slice(0, 300) : result.error,
      );
    }

    const summaryRequest: SummaryRequest = {
      input: rawInput,
      activeSkills: resolveSkillsFromSelection(
        heuristicPlan.skills,
        undefined,
        fastCalls,
        compiledRuntime.toolRegistry,
      ),
      toolResults,
      session: this.session,
    };
    this.session.activeSkills = summaryRequest.activeSkills.map((skill) => skill.manifest.name);

    callbacks.onStatus?.("正在生成最终回复...");
    if (this.provider.isConfigured() && this.provider.streamSummary && callbacks.onTextDelta) {
      callbacks.onTextStart?.();
      const text = await this.provider.streamSummary(summaryRequest, callbacks.onTextDelta);
      callbacks.onTextDone?.(text);
      return {
        text,
        toolResults,
      };
    }

    const text = this.provider.isConfigured()
      ? await this.provider.summarize(summaryRequest)
      : fallbackSummary(summaryRequest);
    await this.emitAssistantText(text, callbacks);
    return {
      text,
      toolResults,
    };
  }

  private async executeSinglePlan(
    input: string,
    heuristicPlan: ReturnType<typeof createPlan>,
    compiledRuntime: CompiledSkillRuntime,
    callbacks: AgentTurnCallbacks,
  ): Promise<AgentTurnResult> {
    if (heuristicPlan.directResponse) {
      const text = await this.composeDirectResponse(
        heuristicPlan.directResponse,
        input,
        heuristicPlan.intent,
        classifyDirectResponseMode(heuristicPlan),
        undefined,
      );
      await this.emitAssistantText(text, callbacks);
      return { text, toolResults: [] };
    }

    const readOnlyCalls = heuristicPlan.toolCalls.filter((call) => !call.dangerous);
    const dangerousCalls = heuristicPlan.toolCalls.filter((call) => call.dangerous);
    const toolResults = await this.executeReadOnlyCalls(readOnlyCalls, compiledRuntime.toolRegistry);

    for (const result of toolResults) {
      this.addScratchpadStep(
        0,
        "observation",
        result.ok
          ? result.cached
            ? `工具 ${result.toolId} 命中缓存`
            : `工具 ${result.toolId} 执行成功`
          : `工具 ${result.toolId} 执行失败`,
        result.ok ? JSON.stringify(result.data).slice(0, 300) : result.error,
      );
    }

    if (dangerousCalls.length > 0) {
      const approval = createApprovalRequest(dangerousCalls[0], toolResults);
      const seed = createApprovalRequiredSeed(approval);
      const text = await this.composeDirectResponse(
        seed.draft,
        input,
        heuristicPlan.intent,
        "approval",
        seed.brief,
      );
      return { text, toolResults, approval };
    }

    const summaryRequest: SummaryRequest = {
      input,
      activeSkills: heuristicPlan.skills,
      toolResults,
      session: this.session,
    };

    return {
      text: await this.emitSummaryText(fallbackSummary(summaryRequest), callbacks),
      toolResults,
    };
  }

  private async emitAssistantText(text: string, callbacks: AgentTurnCallbacks): Promise<void> {
    if (!callbacks.onTextDelta) {
      return;
    }
    callbacks.onTextStart?.();
    for (const chunk of chunkText(text, 18)) {
      callbacks.onTextDelta(chunk);
      await sleep(12);
    }
    callbacks.onTextDone?.(text);
  }

  private async emitSummaryText(text: string, callbacks: AgentTurnCallbacks): Promise<string> {
    await this.emitAssistantText(text, callbacks);
    return text;
  }

  private async composeDirectResponse(
    draft: string,
    input: string,
    intent: ReturnType<typeof createPlan>["intent"] | undefined,
    mode: "clarify" | "fallback" | "guidance" | "approval" | "result",
    brief?: DirectResponseBrief,
  ): Promise<string> {
    void input;
    void intent;
    return formatLocalDirectResponse(draft, mode, brief);
  }

  private async executeReadOnlyCalls(
    readOnlyCalls: ToolCall[],
    runtimeRegistry: Map<string, ToolDefinition>,
  ): Promise<ToolResult[]> {
    return await Promise.all(
      readOnlyCalls.map(async (call) => await this.executeReadOnlyCallWithCache(call, runtimeRegistry)),
    );
  }

  private async executeReadOnlyCallWithCache(
    call: ToolCall,
    runtimeRegistry: Map<string, ToolDefinition>,
  ): Promise<ToolResult> {
    const tool = runtimeRegistry.get(call.toolId);
    if (!tool || !isCacheableReadOnlyTool(tool)) {
      return await executeToolCall(runtimeRegistry, call.toolId, call.input, this.config);
    }

    const cacheKey = buildReadOnlyToolCacheKey(call.toolId, call.input);
    const cached = this.readOnlyToolCache.get(cacheKey);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return {
        ...cached.result,
        cached: true,
      };
    }

    const inFlight = this.inFlightReadOnlyCalls.get(cacheKey);
    if (inFlight) {
      return await inFlight;
    }

    const pending = executeToolCall(runtimeRegistry, call.toolId, call.input, this.config)
      .then((result) => {
        if (result.ok) {
          this.readOnlyToolCache.set(cacheKey, {
            expiresAt: Date.now() + PUBLIC_TOOL_CACHE_TTL_MS,
            result,
          });
        }
        return result;
      })
      .finally(() => {
        this.inFlightReadOnlyCalls.delete(cacheKey);
      });

    this.inFlightReadOnlyCalls.set(cacheKey, pending);
    return await pending;
  }

  private async resolvePlanFromModel(
    input: string,
    heuristicPlan: ReturnType<typeof createPlan>,
    compiledRuntime: CompiledSkillRuntime,
    observations: ToolResult[],
    iteration: number,
  ): Promise<ReturnType<typeof createPlan> & { conversationStateUpdate?: ConversationState; endpointDecision?: EndpointDecision }> {
    if (!this.provider.isConfigured()) {
      return heuristicPlan;
    }

    const allowedTools = compiledRuntime.tools.map((tool) => ({
      id: tool.id,
      description: tool.description,
      dangerous: tool.dangerous,
      authScope: tool.authScope,
      inputSchema: tool.inputSchema,
      sourceSkill: tool.sourceSkill,
      transport: tool.transport,
      operation: tool.operation,
      method: tool.method,
      path: tool.path,
    }));

    if (allowedTools.length === 0) {
      this.addScratchpadStep(iteration, "fallback", "当前激活技能没有可用工具，回退启发式规划");
      return heuristicPlan;
    }

    try {
      const modelPlan = await this.provider.plan({
        input,
        candidateSkills: heuristicPlan.skills,
        session: this.session,
        authAvailable: this.binanceClient.hasAuth(),
        tools: allowedTools,
        observations,
        iteration,
        memoryContext: this.session.memoryContext,
        referenceContext: this.session.referenceContext,
      });

      if (!modelPlan) {
        this.addScratchpadStep(iteration, "fallback", "模型未返回可用计划，回退启发式规划");
        return heuristicPlan;
      }

      const validatedCalls = this.validateModelToolCalls(modelPlan.toolCalls ?? [], allowedTools, compiledRuntime.toolRegistry);
      if (validatedCalls.length === 0 && !modelPlan.directResponse) {
        this.addScratchpadStep(iteration, "fallback", "模型计划无有效工具调用，回退启发式规划");
        return heuristicPlan;
      }

      const selectedSkills = resolveSkillsFromSelection(
        heuristicPlan.skills,
        modelPlan.selectedSkillNames,
        validatedCalls,
        compiledRuntime.toolRegistry,
      );

      return {
        ...heuristicPlan,
        skills: selectedSkills.length > 0 ? selectedSkills : heuristicPlan.skills,
        directResponse: modelPlan.directResponse ?? heuristicPlan.directResponse,
        toolCalls: validatedCalls,
        conversationStateUpdate: modelPlan.conversationStateUpdate,
        endpointDecision: modelPlan.endpointDecision,
      };
    } catch (error) {
      this.addScratchpadStep(
        iteration,
        "fallback",
        "模型规划异常，回退启发式规划",
        error instanceof Error ? error.message : String(error),
      );
      return heuristicPlan;
    }
  }

  private validateModelToolCalls(
    toolCalls: Array<{ toolId: string; input: Record<string, unknown> }>,
    allowedTools: Array<{ id: string }>,
    runtimeRegistry: Map<string, ToolDefinition>,
  ): ToolCall[] {
    const allowed = new Set(allowedTools.map((tool) => tool.id));
    const validated: ToolCall[] = [];

    for (const call of toolCalls) {
      if (!allowed.has(call.toolId)) {
        continue;
      }
      const tool = runtimeRegistry.get(call.toolId);
      if (!tool) {
        continue;
      }
      validated.push({
        toolId: call.toolId,
        input: call.input ?? {},
        dangerous: tool.dangerous,
      });
    }

    return validated;
  }

  private async handleApprovalInput(input: string): Promise<AgentTurnResult> {
    const approval = this.session.pendingApproval;
    if (!approval) {
      const seed = createApprovalMissingSeed();
      return {
        text: await this.composeDirectResponse(
          seed.draft,
          input,
          this.session.lastIntent,
          "approval",
          seed.brief,
        ),
        toolResults: [],
      };
    }

    if (isApprovalExpired(approval)) {
      this.session.pendingApproval = undefined;
      this.approvalToolRegistry = undefined;
      await this.persistSession();
      const seed = createApprovalExpiredSeed(approval);
      return {
        text: await this.composeDirectResponse(
          seed.draft,
          input,
          this.session.lastIntent,
          "approval",
          seed.brief,
        ),
        toolResults: [],
      };
    }

    const decision = resolveApprovalDecision(input);
    if (decision === "cancel") {
      this.session.pendingApproval = undefined;
      this.approvalToolRegistry = undefined;
      await this.persistSession();
      const seed = createApprovalCanceledSeed(approval);
      return {
        text: await this.composeDirectResponse(
          seed.draft,
          input,
          this.session.lastIntent,
          "approval",
          seed.brief,
        ),
        toolResults: [],
      };
    }

    if (decision !== "confirm") {
      const seed = createApprovalReminderSeed(approval);
      return {
        text: await this.composeDirectResponse(
          seed.draft,
          input,
          this.session.lastIntent,
          "approval",
          seed.brief,
        ),
        toolResults: [],
        approval,
      };
    }

    let runtimeRegistry = this.approvalToolRegistry ?? this.toolRegistry;
    if (!runtimeRegistry.has(approval.toolCall.toolId)) {
      const approvalSkills = resolveActiveSkillsForSummary(this.skills, this.session.activeSkills, this.skills);
      const compiledRuntime = await this.getCompiledRuntime(approvalSkills);
      runtimeRegistry = compiledRuntime.toolRegistry;
      this.approvalToolRegistry = compiledRuntime.toolRegistry;
    }
    const result = await executeToolCall(runtimeRegistry, approval.toolCall.toolId, approval.toolCall.input, this.config);
    this.session.pendingApproval = undefined;
    this.approvalToolRegistry = undefined;
    const seed = createApprovalResultSeed(approval, result);
    const text = await this.composeDirectResponse(
      seed.draft,
      input,
      this.session.lastIntent,
      "result",
      seed.brief,
    );
    this.session.messages.push({ role: "assistant", content: text });
    this.addScratchpadStep(
      this.getLatestIteration(),
      "response",
      result.ok ? `危险工具 ${approval.toolId} 执行成功` : `危险工具 ${approval.toolId} 执行失败`,
      result.ok ? JSON.stringify(result.data).slice(0, 300) : result.error,
    );
    await this.memoryStore.rememberSummary(text.slice(0, 300));
    await this.memoryStore.appendDailyLog("assistant", text);
    await this.persistSession();
    return { text, toolResults: [result] };
  }

  private addScratchpadStep(
    iteration: number,
    kind: ReasoningStep["kind"],
    summary: string,
    detail?: string,
  ): void {
    const step: ReasoningStep = {
      timestamp: new Date().toISOString(),
      iteration,
      kind,
      summary,
      detail,
    };
    this.session.scratchpad.push(step);
    this.session.scratchpad = this.session.scratchpad.slice(-40);
  }

  private getLatestIteration(): number {
    return this.session.scratchpad.at(-1)?.iteration ?? 0;
  }

  private async resolveReferenceContext(
    input: string,
    activeSkills: InstalledSkill[],
  ) {
    if (activeSkills.length === 0) {
      return [];
    }

    const hasReferenceFiles = activeSkills.some((skill) => skill.knowledge.referenceFiles.length > 0);
    if (!hasReferenceFiles || !shouldResolveReferences(input, activeSkills)) {
      return [];
    }

    const selected = selectFallbackReferenceSnippets(input, activeSkills);
    if (selected.length === 0) {
      return [];
    }
    return await loadSkillReferenceSnippets(activeSkills, selected);
  }

  private async getCompiledRuntime(skills: InstalledSkill[]): Promise<CompiledSkillRuntime> {
    const cacheKey = skills
      .map((skill) => skill.manifest.name)
      .sort()
      .join("|");

    const cached = this.compiledRuntimeCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const compiledRuntime = await compileSkillRuntime(skills, this.toolRegistry, this.config, this.binanceClient);
    this.compiledRuntimeCache.set(cacheKey, compiledRuntime);
    return compiledRuntime;
  }

  private async persistSession(): Promise<void> {
    this.session = await this.sessionManager.save(this.session);
  }
}

function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const char of Array.from(text)) {
    current += char;
    if (current.length >= size || /[。！？!?，,\n]/.test(char)) {
      chunks.push(current);
      current = "";
    }
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createTaskClarificationSeed(): DirectResponseSeed {
  return {
    draft: "先告诉我你现在想做什么，我再继续帮你处理。",
    brief: {
      objective: "clarify_user_goal",
      asks: ["当前想分析、查询还是准备交易"],
      nextSteps: ["分析某个交易对", "查询账户或订单", "准备一笔现货或合约交易"],
    },
  };
}

function createMissingSymbolBrief(intent: ReturnType<typeof createPlan>["intent"]): DirectResponseBrief {
  return {
    objective: "clarify_missing_symbol",
    facts: intent.categories.length > 0 ? [`当前主题: ${intent.categories.join(",")}`] : [],
    asks: ["需要先确认交易对或代币主语"],
    nextSteps: ["等用户补充具体 symbol 后继续分析或查询"],
  };
}

function createNeedMoreContextSeed(intent: ReturnType<typeof createPlan>["intent"]): DirectResponseSeed {
  return {
    draft: "我这边信息还不够，暂时没法继续判断。",
    brief: {
      objective: "request_more_context",
      facts: [
        intent.symbol ? `当前 symbol: ${intent.symbol}` : "当前没有明确 symbol",
        intent.marketType ? `当前市场类型: ${intent.marketType}` : "当前没有明确市场类型",
      ],
      asks: ["需要补充交易对、市场类型，或最想看的分析维度"],
      nextSteps: ["补充主语后继续分析"],
    },
  };
}

function createApprovalMissingSeed(): DirectResponseSeed {
  return {
    draft: "现在没有待确认的操作。",
    brief: {
      objective: "approval_absent",
      status: "no_pending_approval",
    },
  };
}

function createApprovalRequiredSeed(approval: ApprovalRequest): DirectResponseSeed {
  return {
    draft: `这一步需要你确认后我才会继续，当前操作是 ${approval.toolId}。输入 ${APPROVAL_CONFIRMATION} 或“确认”执行，输入 ${APPROVAL_CANCEL} 或“取消”终止。`,
    brief: {
      objective: "approval_required",
      status: "pending",
      facts: [`工具: ${approval.toolId}`, `风险级别: ${approval.riskLevel}`],
      nextSteps: [
        `输入 ${APPROVAL_CONFIRMATION} 或“确认”执行`,
        `输入 ${APPROVAL_CANCEL} 或“取消”终止`,
      ],
      constraints: ["不要暴露敏感参数"],
    },
  };
}

function createApprovalExpiredSeed(approval: ApprovalRequest): DirectResponseSeed {
  return {
    draft: `刚才那笔待确认操作已经过期了，工具是 ${approval.toolId}。`,
    brief: {
      objective: "approval_expired",
      status: "expired",
      facts: [`工具: ${approval.toolId}`],
      nextSteps: ["如果还要继续，请重新发起一次"],
    },
  };
}

function createApprovalCanceledSeed(approval: ApprovalRequest): DirectResponseSeed {
  return {
    draft: `这次待确认操作我已经帮你取消了，工具是 ${approval.toolId}。`,
    brief: {
      objective: "approval_canceled",
      status: "canceled",
      facts: [`工具: ${approval.toolId}`],
    },
  };
}

function createApprovalReminderSeed(approval: ApprovalRequest): DirectResponseSeed {
  return {
    draft: `还有一笔待确认操作没有处理，工具是 ${approval.toolId}。输入 ${APPROVAL_CONFIRMATION} 或“确认”执行，输入 ${APPROVAL_CANCEL} 或“取消”终止。`,
    brief: {
      objective: "approval_reminder",
      status: "pending",
      facts: [`工具: ${approval.toolId}`],
      nextSteps: [
        `输入 ${APPROVAL_CONFIRMATION} 或“确认”执行`,
        `输入 ${APPROVAL_CANCEL} 或“取消”终止`,
      ],
    },
  };
}

function createApprovalResultSeed(approval: ApprovalRequest, result: ToolResult): DirectResponseSeed {
  return {
    draft: result.ok
      ? `确认过的操作已经执行完了，工具是 ${approval.toolId}。`
      : `确认过的操作执行失败了，工具是 ${approval.toolId}。`,
    brief: {
      objective: "approval_result",
      status: result.ok ? "success" : "failure",
      facts: [
        `工具: ${approval.toolId}`,
        result.ok
          ? `结果摘要: ${summarizeToolResultForReply(result)}`
          : `失败原因: ${result.error ?? "工具执行失败"}`,
      ],
    },
  };
}

function summarizeToolResultForReply(result: ToolResult): string {
  if (!result.ok) {
    return result.error ?? "工具执行失败";
  }
  if (typeof result.data === "string") {
    return result.data.slice(0, 320);
  }
  return JSON.stringify(result.data).slice(0, 320);
}

function formatLocalDirectResponse(
  draft: string,
  mode: "clarify" | "fallback" | "guidance" | "approval" | "result",
  brief?: DirectResponseBrief,
): string {
  if (!brief) {
    return draft;
  }
  if (mode === "approval") {
    return formatApprovalBrief(brief, draft);
  }
  if (mode === "result") {
    return formatResultBrief(brief, draft);
  }
  if (mode === "clarify") {
    return formatClarifyBrief(brief, draft);
  }
  if (mode === "fallback") {
    return formatFallbackBrief(brief, draft);
  }
  return draft;
}

function formatClarifyBrief(brief: DirectResponseBrief, draft: string): string {
  if (brief.objective === "clarify_missing_symbol") {
    return "你想看哪个交易对？告诉我具体币种后我再继续。";
  }
  const ask = brief.asks?.[0];
  return ask ?? draft;
}

function formatFallbackBrief(brief: DirectResponseBrief, draft: string): string {
  const ask = brief.asks?.[0];
  if (ask) {
    return `${draft}${draft.endsWith("。") ? "" : "。"}${ask}。`;
  }
  return draft;
}

function formatApprovalBrief(brief: DirectResponseBrief, draft: string): string {
  const facts = toFactMap(brief.facts);
  const toolId = facts.get("工具");
  const status = brief.status;
  if (status === "pending") {
    return toolId
      ? `当前操作 ${toolId} 需要确认。输入 ${APPROVAL_CONFIRMATION} 或“确认”执行，输入 ${APPROVAL_CANCEL} 或“取消”终止。`
      : draft;
  }
  if (status === "expired") {
    return toolId ? `刚才待确认的 ${toolId} 已经过期，需要你重新发起。` : draft;
  }
  if (status === "canceled") {
    return toolId ? `这次待确认的 ${toolId} 已取消。` : draft;
  }
  return draft;
}

function formatResultBrief(brief: DirectResponseBrief, draft: string): string {
  const facts = toFactMap(brief.facts);
  const toolId = facts.get("工具");
  const resultSummary = facts.get("结果摘要");
  const failureReason = facts.get("失败原因");
  if (brief.status === "success") {
    return [toolId ? `${toolId} 已执行完成。` : draft, resultSummary].filter(Boolean).join(" ");
  }
  if (brief.status === "failure") {
    return [toolId ? `${toolId} 执行失败。` : draft, failureReason].filter(Boolean).join(" ");
  }
  return draft;
}

function toFactMap(facts: string[] | undefined): Map<string, string> {
  return new Map(
    (facts ?? []).map((fact) => {
      const [key, ...rest] = fact.split(":");
      return [key.trim(), rest.join(":").trim()];
    }),
  );
}

function resolveSkillsFromSelection(
  candidateSkills: InstalledSkill[],
  selectedSkillNames: string[] | undefined,
  toolCalls: ToolCall[],
  runtimeRegistry: Map<string, ToolDefinition>,
): InstalledSkill[] {
  if (selectedSkillNames && selectedSkillNames.length > 0) {
    const selectedSet = new Set(selectedSkillNames);
    const resolved = candidateSkills.filter((skill) => selectedSet.has(skill.manifest.name));
    if (resolved.length > 0) {
      return resolved;
    }
  }

  const byTool = resolveSkillsFromToolIds(
    candidateSkills,
    toolCalls.map((call) => call.toolId),
    runtimeRegistry,
  );
  return byTool.length > 0 ? byTool : candidateSkills;
}

function resolveActiveSkillsForSummary(
  allSkills: InstalledSkill[],
  activeSkillNames: string[],
  fallbackSkills: InstalledSkill[],
): InstalledSkill[] {
  if (activeSkillNames.length === 0) {
    return fallbackSkills;
  }
  const activeSet = new Set(activeSkillNames);
  const resolved = allSkills.filter((skill) => activeSet.has(skill.manifest.name));
  return resolved.length > 0 ? resolved : fallbackSkills;
}

function resolveSkillsFromToolIds(
  candidateSkills: InstalledSkill[],
  toolIds: string[],
  runtimeRegistry: Map<string, ToolDefinition>,
): InstalledSkill[] {
  const selectedNames = new Set<string>();
  for (const toolId of toolIds) {
    const runtimeTool = runtimeRegistry.get(toolId);
    if (runtimeTool?.sourceSkill) {
      selectedNames.add(runtimeTool.sourceSkill);
      continue;
    }
    for (const skill of candidateSkills) {
      if (skill.manifest.tools.includes(toolId) || skill.knowledge.endpointHints.some((item) => item.id === toolId)) {
        selectedNames.add(skill.manifest.name);
      }
    }
  }
  return candidateSkills.filter((skill) => selectedNames.has(skill.manifest.name));
}

function dedupeToolCalls(toolCalls: ToolCall[]): ToolCall[] {
  const seen = new Set<string>();
  const deduped: ToolCall[] = [];
  for (const call of toolCalls) {
    const key = `${call.toolId}:${JSON.stringify(call.input)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(call);
  }
  return deduped;
}

function applyContinuationContext(input: string, session: SessionState): string {
  const trimmed = input.trim();
  if (!isContinuationPrompt(trimmed)) {
    return trimmed;
  }

  const previousIntent = session.lastIntent;
  if (!previousIntent?.symbol) {
    return trimmed;
  }

  if (previousIntent.categories.includes("market")) {
    return `${trimmed} 分析 ${previousIntent.symbol}`;
  }
  if (previousIntent.categories.includes("news")) {
    return `${trimmed} ${previousIntent.symbol} 新闻`;
  }
  if (previousIntent.categories.includes("web3")) {
    return `${trimmed} ${previousIntent.symbol} 代币信息`;
  }
  return `${trimmed} ${previousIntent.symbol}`;
}

function isContinuationPrompt(input: string): boolean {
  return /^(继续|接着|然后呢|然后|再看下|再看看|继续说|继续分析|延续一下|补充一下)/.test(input);
}

function hasMeaningfulIntent(intent: ReturnType<typeof createPlan>["intent"]): boolean {
  return Boolean(
    intent.symbol ||
    intent.quantity ||
    intent.price ||
    intent.side ||
    intent.orderId ||
    (intent.categories && intent.categories.length > 0),
  );
}

function shouldResolveConversationState(input: string, session: SessionState): boolean {
  if (session.messages.length < 2) {
    return false;
  }
  return /^(继续|接着|然后呢|然后|再看下|再看看|继续说|继续分析|延续一下|补充一下|那.+呢|换成|还是)/.test(input);
}

function hasMeaningfulConversationState(state: SessionState["conversationState"]): boolean {
  return Boolean(state?.currentSymbol || state?.currentTopic || state?.currentMarketType || state?.summary);
}

function shouldPreferHeuristicClarification(plan: ReturnType<typeof createPlan>): boolean {
  return Boolean(
    plan.directResponse &&
    plan.toolCalls.length === 0 &&
    !plan.intent.symbol &&
    plan.intent.categories.some((category) => ["market", "news", "web3", "trade"].includes(category)),
  );
}

function classifyDirectResponseMode(
  plan: ReturnType<typeof createPlan>,
): "clarify" | "fallback" | "guidance" {
  if (!plan.directResponse) {
    return "fallback";
  }
  if (!plan.intent.symbol && plan.intent.categories.some((category) => ["market", "news", "web3", "trade"].includes(category))) {
    return "clarify";
  }
  if (plan.directResponse.includes("例如") || plan.directResponse.includes("可以")) {
    return "guidance";
  }
  return "fallback";
}

function mergeConversationState(
  previous: SessionState["conversationState"],
  next: SessionState["conversationState"],
): SessionState["conversationState"] {
  return {
    currentSymbol: next?.currentSymbol ?? previous?.currentSymbol,
    currentTopic: next?.currentTopic ?? previous?.currentTopic,
    currentMarketType: next?.currentMarketType ?? previous?.currentMarketType,
    summary: next?.summary ?? previous?.summary,
  };
}

function inferPrimaryTopic(intent: ReturnType<typeof createPlan>["intent"]): ConversationState["currentTopic"] | undefined {
  if (intent.categories.includes("market")) {
    return "market";
  }
  if (intent.categories.includes("news")) {
    return "news";
  }
  if (intent.categories.includes("web3")) {
    return "web3";
  }
  if (intent.categories.includes("account")) {
    return "account";
  }
  if (intent.categories.includes("orders")) {
    return "orders";
  }
  if (intent.categories.includes("trade")) {
    return "trade";
  }
  return undefined;
}

function shouldUseFastAnalysisPath(
  input: string,
  plan: ReturnType<typeof createPlan>,
): boolean {
  if (!plan.intent.symbol) {
    return false;
  }
  if (plan.intent.quantity || plan.intent.orderId) {
    return false;
  }
  if (plan.intent.categories.includes("account") || plan.intent.categories.includes("orders")) {
    return false;
  }
  if (/(撤单|cancel|下单|开仓|平仓|transfer|划转|提现)/i.test(input)) {
    return false;
  }
  if (plan.intent.categories.includes("market")) {
    return true;
  }
  return /(分析|能买吗|能不能买|怎么样|怎么看|值不值得|今日|今天)/.test(input);
}

function getMaxModelSteps(
  input: string,
  plan: ReturnType<typeof createPlan>,
): number {
  if (shouldUseFastAnalysisPath(input, plan)) {
    return 1;
  }
  const categories = new Set(plan.intent.categories);
  const marketOnly =
    plan.intent.symbol &&
    categories.has("market") &&
    !categories.has("account") &&
    !categories.has("orders") &&
    !(categories.has("trade") && plan.intent.quantity);
  if (marketOnly) {
    return 2;
  }
  return DEFAULT_MAX_MODEL_STEPS;
}

function shouldAllowFollowupPlanning(
  input: string,
  plan: ReturnType<typeof createPlan>,
): boolean {
  if (shouldUseFastAnalysisPath(input, plan)) {
    return false;
  }

  const lowered = input.toLowerCase();
  if (/(先.+再|评估.+后|看完.+再|根据.+结果|之后再|然后再|拿到.+再|确认.+后)/.test(input)) {
    return true;
  }

  if (/(after|then|once|based on)/.test(lowered)) {
    return true;
  }

  const categories = new Set(plan.intent.categories);
  const hasTradeFollowup =
    categories.has("trade") &&
    (!plan.intent.quantity || !plan.intent.symbol || categories.has("account") || categories.has("orders"));
  if (hasTradeFollowup) {
    return true;
  }

  const asksForStepwiseReasoning =
    /(再给建议|再判断|再决定|再下单|再执行|再告诉我|再分析|再看是否|再告诉我能不能)/.test(input);
  if (asksForStepwiseReasoning) {
    return true;
  }

  return false;
}

function buildFastAnalysisCalls(
  plan: ReturnType<typeof createPlan>,
  compiledRuntime: CompiledSkillRuntime,
): ToolCall[] {
  const symbol = plan.intent.symbol;
  if (!symbol) {
    return [];
  }

  const availableTools = compiledRuntime.tools.filter((tool) => !tool.dangerous);
  const calls: ToolCall[] = [];

  const maybeAdd = (matcher: (toolId: string) => boolean, inputBuilder: (tool: CompiledSkillRuntime["tools"][number]) => Record<string, unknown>) => {
    const tool = availableTools.find((candidate) => matcher(candidate.id));
    if (!tool) {
      return;
    }
    calls.push({
      toolId: tool.id,
      input: inputBuilder(tool),
      dangerous: false,
    });
  };

  maybeAdd(
    (toolId) => toolId === "market.getTicker" || /(^|[.])ticker$/i.test(toolId) || /24hr/i.test(toolId),
    () => ({ symbol }),
  );
  maybeAdd(
    (toolId) => toolId === "market.getKlines" || /kline/i.test(toolId),
    (tool) => withOptionalInputs(tool, { symbol, interval: "1h", limit: 24 }),
  );

  if (plan.intent.marketType === "futures") {
    maybeAdd(
      (toolId) => toolId === "market.getFunding" || /funding|premium/i.test(toolId),
      () => ({ symbol }),
    );
  } else {
    maybeAdd(
      (toolId) =>
        toolId === "market.getDepth" ||
        /(^|[.])depth$/i.test(toolId) ||
        /(^|[.])orderBook$/i.test(toolId),
      (tool) => withOptionalInputs(tool, { symbol, limit: 5 }),
    );
  }

  return dedupeToolCalls(calls).slice(0, 3);
}

function withOptionalInputs(
  tool: CompiledSkillRuntime["tools"][number],
  preferred: Record<string, unknown>,
): Record<string, unknown> {
  const properties = tool.inputSchema.properties ?? {};
  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(preferred)) {
    if (key === "symbol" || key in properties) {
      input[key] = value;
    }
  }
  return input;
}


function unwrapMarketPayload(data: unknown): unknown {
  if (!data || typeof data !== "object") {
    return data;
  }

  const record = data as Record<string, unknown>;
  if (record.data !== undefined) {
    return record.data;
  }
  if (record.result !== undefined) {
    return record.result;
  }
  return data;
}

function extractOrderBookPrice(entries: unknown): number | undefined {
  if (!Array.isArray(entries) || entries.length === 0) {
    return undefined;
  }
  const first = entries[0];
  if (Array.isArray(first)) {
    return readNumericLike(first[0]);
  }
  if (first && typeof first === "object") {
    const record = first as Record<string, unknown>;
    return readNumericLike(record.price ?? record[0]);
  }
  return undefined;
}

function readNumericLike(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function describeChange(changePercent: number): string {
  if (changePercent > 0) {
    return `上涨 ${formatSignedPercent(changePercent)}`;
  }
  if (changePercent < 0) {
    return `下跌 ${formatSignedPercent(changePercent)}`;
  }
  return "基本持平";
}

function formatObservedNumber(value: number): string {
  if (Math.abs(value) >= 1000) {
    return value.toLocaleString("en-US", {
      maximumFractionDigits: value >= 100 ? 2 : 4,
    });
  }
  return value.toFixed(value >= 1 ? 4 : 6).replace(/\.?0+$/, "");
}

function formatSignedPercent(value: number): string {
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(2)}%`;
}

function isCacheableReadOnlyTool(tool: ToolDefinition): boolean {
  if (tool.dangerous || tool.authScope !== "none") {
    return false;
  }

  return /^(news|web3)\./.test(tool.id);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function buildDeskMarketPulseItem(symbol: string, data: unknown): DeskMarketPulseItem | null {
  const candidate = unwrapMarketPayload(data);
  if (!candidate || typeof candidate !== "object") {
    return null;
  }

  const record = candidate as Record<string, unknown>;
  const lastPrice = readNumericLike(record.lastPrice ?? record.price ?? record.close ?? record.c);
  const priceChangePercent = readNumericLike(
    record.priceChangePercent ?? record.changePercent ?? record.P ?? record.riseFallRate,
  );

  if (lastPrice === undefined) {
    return null;
  }

  return {
    symbol,
    priceText: formatObservedNumber(lastPrice),
    changeText: priceChangePercent === undefined ? undefined : formatSignedPercent(priceChangePercent),
    direction: priceChangePercent === undefined || priceChangePercent === 0
      ? "flat"
      : priceChangePercent > 0
        ? "up"
        : "down",
  };
}

function buildReadOnlyToolCacheKey(toolId: string, input: Record<string, unknown>): string {
  const normalizedEntries = Object.entries(input)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `${toolId}:${JSON.stringify(normalizedEntries)}`;
}

function shouldExtractStableFacts(input: string): boolean {
  return /(偏好|默认|习惯|请用|中文|英文|风险|稳健|激进|保守|长期关注|主要看|优先|盯|关注|我一般|我通常|现货为主|合约为主)/i.test(input);
}

function shouldResolveReferences(input: string, activeSkills: InstalledSkill[]): boolean {
  if (/(auth|sign|signature|apikey|secret|权限|签名|认证|主网|mainnet|参数|parameter|脚本|script|接口|endpoint)/i.test(input)) {
    return true;
  }

  return activeSkills.some(
    (skill) =>
      skill.knowledge.referenceFiles.length > 0 &&
      skill.knowledge.endpointHints.some((endpoint) => endpoint.authRequired || endpoint.dangerLevel === "mutating") &&
      /(下单|交易|买|卖|撤单|transfer|划转|提现|order|trade)/i.test(input),
  );
}

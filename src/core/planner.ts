import {inferIntent, selectSkills} from "./router.ts";
import type {PlannerContext, PlanResult, ToolCall} from "./types.ts";

const MEMORY_HINT_WORDS = [
  "之前",
  "上次",
  "历史",
  "记得",
  "偏好",
  "长期",
  "recent",
  "remember",
  "history",
  "memory",
];
const ADVISORY_MARKET_WORDS = ["分析", "能买吗", "能不能买", "怎么样", "怎么看", "值不值得", "今天"];

function buildMarketCalls(symbol: string): ToolCall[] {
  return [
    { toolId: "market.getTicker", input: { symbol }, dangerous: false },
    { toolId: "market.getDepth", input: { symbol, limit: 5 }, dangerous: false },
    { toolId: "market.getKlines", input: { symbol, interval: "1h", limit: 12 }, dangerous: false },
  ];
}

export function createPlan(context: PlannerContext): PlanResult {
  const intent = enrichIntentWithConversationState(
    inferIntent(context.input),
    context.conversationState,
    context.input,
  );
  const activeSkills = context.activeSkills ?? selectSkills(context.input, context.skills, intent);
  const toolCalls: ToolCall[] = [];
  const inputLowered = context.input.toLowerCase();
  const hasMemoryHint = MEMORY_HINT_WORDS.some((word) => inputLowered.includes(word.toLowerCase()));

  if (hasMemoryHint) {
    toolCalls.push({
      toolId: "memory.getRecent",
      input: { limit: 3 },
      dangerous: false,
    });
    toolCalls.push({
      toolId: "memory.search",
      input: { query: context.input, limit: 5 },
      dangerous: false,
    });
  }

  if (needsSymbolClarification(intent, context.input)) {
    return {
      skills: activeSkills,
      toolCalls,
      intent,
      directResponse: buildMissingSymbolPrompt(intent),
    };
  }

  if (!intent.categories.length && !intent.symbol && !hasMemoryHint) {
    return {
      skills: activeSkills,
      toolCalls,
      intent,
      directResponse: "我可以帮你查行情、账户、订单，或准备现货/合约交易。你可以直接说例如“分析 BTC”或“买 0.01 BTC”。",
    };
  }

  if ((intent.categories.includes("market") || context.input.includes("分析")) && intent.symbol) {
    toolCalls.push(...buildMarketCalls(intent.symbol));
    if (intent.marketType === "futures") {
      toolCalls.push({ toolId: "market.getFunding", input: { symbol: intent.symbol }, dangerous: false });
    }
  }

  if (intent.categories.includes("account")) {
    if (intent.marketType === "futures") {
      toolCalls.push({ toolId: "futures.getAccount", input: {}, dangerous: false });
      toolCalls.push({ toolId: "futures.getPositions", input: {}, dangerous: false });
    } else {
      toolCalls.push({ toolId: "spot.getAccount", input: {}, dangerous: false });
    }
  }

  if (intent.categories.includes("orders")) {
    if (context.input.includes("撤") || context.input.toLowerCase().includes("cancel")) {
      if (!intent.symbol || !intent.orderId) {
        return {
          skills: activeSkills,
          toolCalls,
          intent,
          directResponse: "撤单需要同时提供交易对和订单号，例如：撤单 BTCUSDT order 123456。",
        };
      }
      toolCalls.push({
        toolId: intent.marketType === "futures" ? "futures.cancelOrder" : "spot.cancelOrder",
        input: { symbol: intent.symbol, orderId: intent.orderId },
        dangerous: true,
      });
    } else {
      toolCalls.push({
        toolId: intent.marketType === "futures" ? "futures.getOpenOrders" : "spot.getOpenOrders",
        input: intent.symbol ? { symbol: intent.symbol } : {},
        dangerous: false,
      });
    }
  }

  if (intent.categories.includes("trade")) {
    const canUseSpotQuoteOrderQty = Boolean(
      intent.marketType === "spot"
        && intent.orderType === "MARKET"
        && intent.side === "BUY"
        && intent.quoteOrderQty,
    );
    const canResolveSpotSellAll = Boolean(
      intent.marketType === "spot"
        && intent.orderType === "MARKET"
        && intent.side === "SELL"
        && intent.symbol
        && intent.sellAll,
    );

    if (canResolveSpotSellAll) {
      toolCalls.push({
        toolId: "spot.getAccount",
        input: {},
        dangerous: false,
      });
      return {
        skills: activeSkills,
        toolCalls,
        intent,
      };
    }

    if (!intent.symbol || !intent.side || (!intent.quantity && !canUseSpotQuoteOrderQty)) {
      if (intent.symbol && isAdvisoryTradePrompt(context.input)) {
        return {
          skills: activeSkills,
          toolCalls,
          intent,
        };
      }
      return {
        skills: activeSkills,
        toolCalls,
        intent,
        directResponse:
          "下单请至少提供方向、交易对，以及数量或买入金额，例如：买 0.01 BTCUSDT，或 BTCUSDT 现货市价买入 20 USDT。",
      };
    }

    toolCalls.push({
      toolId: intent.marketType === "futures" ? "futures.placeOrder" : "spot.placeOrder",
      input: {
        symbol: intent.symbol,
        side: intent.side,
        type: intent.orderType ?? "MARKET",
        quantity: intent.quantity,
        quoteOrderQty: canUseSpotQuoteOrderQty ? intent.quoteOrderQty : undefined,
        price: intent.price,
      },
      dangerous: true,
    });
  }

  if (intent.categories.includes("news")) {
    toolCalls.push({
      toolId: "news.getSignal",
      input: { symbol: intent.symbol, query: context.input },
      dangerous: false,
    });
  }

  if (intent.categories.includes("web3")) {
    toolCalls.push({
      toolId: "web3.getTokenInfo",
      input: { symbol: intent.symbol, query: context.input },
      dangerous: false,
    });
  }

  if (context.authAvailable && context.input.includes("分析") && intent.symbol) {
    toolCalls.push({ toolId: "spot.getAccount", input: {}, dangerous: false });
  }

  return {
    skills: activeSkills,
    toolCalls,
    intent,
  };
}

function isAdvisoryTradePrompt(input: string): boolean {
  return ADVISORY_MARKET_WORDS.some((word) => input.includes(word));
}

function enrichIntentWithConversationState(
  intent: ReturnType<typeof inferIntent>,
  state: PlannerContext["conversationState"],
  input: string,
): ReturnType<typeof inferIntent> {
  if (!state) {
    return intent;
  }

  const nextIntent = {
    ...intent,
    categories: [...intent.categories],
  };
  const isFollowUp = /^(继续|接着|然后呢|然后|再看下|再看看|继续说|继续分析|延续一下|补充一下|那.+呢|换成)/.test(input);

  if (!nextIntent.symbol && state.currentSymbol && isFollowUp) {
    nextIntent.symbol = state.currentSymbol;
  }
  if (isFollowUp && nextIntent.categories.length === 0 && state.currentTopic) {
    nextIntent.categories = [state.currentTopic];
  }
  if (!nextIntent.marketType && state.currentMarketType) {
    nextIntent.marketType = state.currentMarketType;
  }
  return nextIntent;
}

function needsSymbolClarification(
  intent: ReturnType<typeof inferIntent>,
  input: string,
): boolean {
  if (intent.symbol) {
    return false;
  }

  if (intent.categories.includes("market") || intent.categories.includes("news") || intent.categories.includes("web3")) {
    return true;
  }

  return intent.categories.includes("trade") && isAdvisoryTradePrompt(input);
}

function buildMissingSymbolPrompt(intent: ReturnType<typeof inferIntent>): string {
  if (intent.categories.includes("news")) {
    return "你想看哪个币的最新资讯？可以直接说：看 BTCUSDT 最新新闻，或看 ETH 最新动态。";
  }
  if (intent.categories.includes("web3")) {
    return "你想查哪个代币的链上或合约信息？可以直接说：查 BTC 代币信息，或查 ETH 合约地址。";
  }
  return "你想看哪个交易对的最新行情？可以直接说：看 BTCUSDT 最新行情，或分析 ETHUSDT 现在怎么样。";
}

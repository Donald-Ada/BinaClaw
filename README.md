# BinaClaw

Terminal-first Binance AI agent with skill-first runtime, workspace memory, session compaction, and approval-gated trading actions.

BinaClaw is built for users who want a local CLI agent that can:

- reason over official Binance-style `SKILL.md` packages
- use the official OpenAI Responses API
- keep long-running session state in a workspace
- inspect its own trace and session state
- treat market data as real-time and dangerous actions as confirmable

## Overview

BinaClaw combines four ideas in one CLI product:

1. `Skill-first runtime`
   The model chooses skills first, then the runtime compiles only the selected skills into executable tools for the current turn.
2. `Workspace as source of truth`
   Session state, memory, trace context, tool index, and bootstrap documents live under a persistent workspace.
3. `Session-centered agent loop`
   Long chats do not just grow forever. BinaClaw persists the session, compacts it when needed, and flushes durable facts back into memory files.
4. `Approval-gated execution`
   Read-only requests run directly. Dangerous actions require explicit confirmation.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Install](#install)
- [Configure](#configure)
- [Run](#run)
- [Common Commands](#common-commands)
- [How to Debug](#how-to-debug)
- [Workspace Layout](#workspace-layout)
- [Skills](#skills)
- [Safety Model](#safety-model)
- [Architecture](#architecture)
- [Development](#development)

## Prerequisites

- Node `>=20`
- npm

## Install

### From npm

```bash
npm install -g binaclaw
```

Then run:

```bash
binaclaw onboard
```

### From source

```bash
npm install
npm run build
```

```bash
node dist/index.js chat
```

## Configure

For the fastest first-time setup:

```bash
binaclaw onboard
```

`binaclaw onboard` will:

- save your OpenAI and Telegram settings into `~/.binaclaw/config.json`
- save Binance private keys into `~/.binaclaw/env.local` when you choose to provide them
- keep Binance secrets env-only
- start `gateway` in the background
- start the Telegram provider in the background
- print a success message when both are healthy

If you prefer manual setup, start chat and run:

```text
/config
```

Minimum recommended configuration:

- `OPENAI_API_KEY`
- `OPENAI_MODEL`

Optional but useful:

- `BRAVE_SEARCH_API_KEY`
- `BINANCE_API_KEY`
- `BINANCE_API_SECRET`
- `BINANCE_USE_TESTNET`

Configuration priority:

1. shell environment variables
2. `~/.binaclaw/env.local` for locally stored Binance secrets managed by `binaclaw onboard`
3. `config.json` for local app settings and non-Binance credentials
4. code defaults

Binance secrets are env-only from the runtime point of view, but `binaclaw onboard` can write them into a local machine-only env file:

- `BINANCE_API_KEY`
- `BINANCE_API_SECRET`

They are never persisted to `config.json`. If older versions wrote them there, BinaClaw now ignores and purges them on startup.

Default config path:

```text
~/.binaclaw/config.json
```

Default local env path:

```text
~/.binaclaw/env.local
```

To keep all state inside the current project directory:

```bash
BINACLAW_HOME="$PWD/.binaclaw" binaclaw chat
```

Important config values:

- `OPENAI_API_KEY`
  Official OpenAI API key. Can be provided via `/config` or environment variable.
- `OPENAI_MODEL`
  Model name.
- `OPENAI_BASE_URL`
  Optional. Defaults to `https://api.openai.com/v1`.
- `BINACLAW_GATEWAY_URL`
  Optional. If set, chat uses the shared gateway instead of creating a local in-process agent.
- `BINACLAW_GATEWAY_HOST`
  Gateway listen host. Defaults to `127.0.0.1`.
- `BINACLAW_GATEWAY_PORT`
  Gateway listen port. Defaults to `8787`.
- `TELEGRAM_BOT_TOKEN`
  Optional. Enables the Telegram provider. Can be provided via `/config` or environment variable.
- `TELEGRAM_ALLOWED_USER_IDS`
  Optional comma-separated allowlist for Telegram DM users.
- `TELEGRAM_ALLOWED_CHAT_IDS`
  Optional comma-separated allowlist for Telegram chats/groups.
- `BRAVE_SEARCH_API_KEY`
  Enables news and Web3-style search. Can be provided via `/config` or environment variable.
- `BINANCE_API_KEY`
  Required for private Binance endpoints. Must be supplied via local environment variable.
- `BINANCE_API_SECRET`
  Required for signed Binance requests. Must be supplied via local environment variable.

Session tuning values:

- `BINACLAW_SESSION_MESSAGE_LIMIT`
- `BINACLAW_SESSION_SCRATCHPAD_LIMIT`
- `BINACLAW_SESSION_CHAR_LIMIT`
- `BINACLAW_SESSION_RETAIN_MESSAGES`
- `BINACLAW_SESSION_RETAIN_SCRATCHPAD`
- `BINACLAW_SESSION_MAX_COMPACTIONS`

## Run

### Interactive chat

```bash
binaclaw chat
```

### One-shot onboarding

```bash
binaclaw onboard
```

After onboarding succeeds, you can chat with your bot directly in Telegram. You do not need to keep a terminal window open for `gateway` or `telegram`.

### Shared gateway mode

Terminal 1:

```bash
binaclaw gateway
```

Terminal 2:

```bash
BINACLAW_GATEWAY_URL="ws://127.0.0.1:8787" binaclaw chat
```

This lets multiple terminal clients share the same persisted session store and runtime state.

### Telegram mode

Terminal 1:

```bash
binaclaw gateway
```

Terminal 2:

```bash
TELEGRAM_BOT_TOKEN="your-bot-token" \
BINACLAW_GATEWAY_URL="ws://127.0.0.1:8787" \
binaclaw telegram
```

The Telegram provider is implemented with `grammY` and forwards incoming updates into the shared gateway runtime.

In this mode, Telegram messages are mapped to gateway-managed session keys:

- private chat: `telegram:dm:<userId>`
- group chat: `telegram:group:<chatId>`
- topic thread: `telegram:group:<chatId>:topic:<threadId>`

### Example prompts

```text
今天 BNB 能买吗
分析一下 BTC 和 ETH 今天怎么样
帮我查下我的资产
查一下 alpha ticker
最近和 SOL 相关的热点新闻
```

## Common Commands

### CLI commands

```bash
binaclaw chat
binaclaw onboard
binaclaw config
binaclaw session
binaclaw session clear
binaclaw session compact
binaclaw skills list
binaclaw skills add <source>
binaclaw auth status
binaclaw doctor
binaclaw gateway
binaclaw telegram
```

### In-chat commands

```text
/help
/config
/skills
/session
/session json
/session clear
/session compact now
/trace
/trace json
/trace clear
/trace intent
/trace plan
/trace observation
/trace approval
/trace response
/trace fallback
/exit
```

## How to Debug

This is the part Dexter gets very right: a product README should tell users where the truth lives when something feels off.

For BinaClaw, the main debugging entry points are:

### 1. View structured reasoning

```text
/trace
/trace plan
/trace observation
/trace approval
/trace json
```

`/trace` shows the agent's structured runtime trace, not hidden raw chain-of-thought.

### 2. View session state

```text
/session
/session json
/session compact now
```

Useful when follow-up turns like `继续` or `那 ETH 呢` feel wrong and you want to inspect the persisted session state.

### 3. Run health checks

```bash
node src/index.ts doctor
```

`doctor` reports:

- Node runtime
- app home
- config file
- skills directories
- loaded skill count
- workspace `TOOLS.md`
- workspace sessions index
- workspace session transcript directory
- Binance / Brave / OpenAI configuration state

### 4. Inspect workspace files directly

Important files:

- `~/.binaclaw/workspace/sessions/sessions.json`
- `~/.binaclaw/workspace/sessions/<session-id>.jsonl`
- `~/.binaclaw/workspace/MEMORY.md`
- `~/.binaclaw/workspace/USER.md`
- `~/.binaclaw/workspace/TOOLS.md`
- `~/.binaclaw/workspace/memory/YYYY-MM-DD.md`

If you set `BINACLAW_HOME`, replace `~/.binaclaw` with your chosen directory.

## Workspace Layout

BinaClaw creates a persistent workspace like this:

```text
.binaclaw/
  config.json
  memory.json
  skills/
  workspace/
    AGENTS.md
    SOUL.md
    USER.md
    IDENTITY.md
    HEARTBEAT.md
    BOOTSTRAP.md
    TOOLS.md
    MEMORY.md
    memory/
      YYYY-MM-DD.md
    sessions/
      sessions.json
      <session-id>.jsonl
    skills/
```

What these files do:

- `AGENTS.md`
  Operating rules and output boundaries.
- `SOUL.md`
  Tone and persona.
- `USER.md`
  User profile facts such as language, market preference, and watched symbols.
- `IDENTITY.md`
  Agent identity.
- `HEARTBEAT.md`
  Routine checks.
- `BOOTSTRAP.md`
  First-run checklist.
- `TOOLS.md`
  Skills and tool index.
- `MEMORY.md`
  Durable facts that are not user-profile facts.
- `memory/YYYY-MM-DD.md`
  Daily memory log.
- `sessions/sessions.json`
  Session index and session metadata.
- `sessions/<session-id>.jsonl`
  Append-only session transcript and lifecycle events.

`USER.md` and `MEMORY.md` are intentionally separate:

- `USER.md` stores user profile memory
- `MEMORY.md` stores non-profile durable facts

That split keeps the agent's memory layer cleaner during long-running sessions.

## Skills

BinaClaw loads skills from two places:

- global skills: `~/.binaclaw/skills`
- local project skills: `./skills`

If a skill exists in both places, the local project skill wins.

Install additional skills with:

```bash
node src/index.ts skills add <local-path>
node src/index.ts skills add <SKILL.md-url>
node src/index.ts skills add <github-repo-url>
```

This repository already includes a set of official Binance-style skills, including:

- `skills/alpha`
- `skills/assets`
- `skills/spot`
- `skills/margin-trading`
- `skills/derivatives-trading-usds-futures`
- `skills/query-token-info`
- `skills/query-address-info`
- `skills/query-token-audit`
- `skills/trading-signal`
- `skills/crypto-market-rank`
- `skills/meme-rush`
- `skills/square-post`

### How the skill-first runtime works

On each turn, BinaClaw roughly does this:

1. load session state, workspace memory, and workspace bootstrap docs
2. let the model select the most relevant skills
3. lazily load only the selected skills and needed `references/*`
4. compile those skills into runtime tools
5. let the model plan against those tools
6. execute tools and generate the final answer

Supported transport types:

- `builtin`
- `binance-public-http`
- `binance-signed-http`
- `http`
- `exec`
- `memory`

`exec` is constrained to the skill root directory.

## Safety Model

- market and price data are not cached
- public read-only endpoints run directly
- private read-only endpoints require Binance credentials
- dangerous actions require explicit confirmation
- confirmation command: `CONFIRM`
- cancel command: `CANCEL`

The confirmation prompt is intentionally high level. It should tell the user that an action needs confirmation without dumping raw low-level tool payloads back into the terminal.

## Architecture

Main source layout:

```text
src/
  index.ts
  cli/
    chat.ts
    commands.ts
    config-wizard.ts
    session.ts
    trace.ts
    ui.ts
  core/
    agent.ts
    provider.ts
    planner.ts
    router.ts
    skill.ts
    runtime.ts
    tools.ts
    binance.ts
    brave.ts
    memory.ts
    session.ts
    workspace.ts
    approval.ts
    config.ts
    types.ts
skills/
  ...
tests/
  ...
```

Key files worth reading first:

- `src/core/agent.ts`
- `src/core/provider.ts`
- `src/core/skill.ts`
- `src/core/runtime.ts`
- `src/core/session.ts`
- `src/core/memory.ts`
- `src/core/workspace.ts`

## Development

Install dependencies:

```bash
npm install
```

Typecheck:

```bash
npm run typecheck
```

Run tests:

```bash
npm test
```

Health check:

```bash
node src/index.ts doctor
```

## Product Status

This repository is already shaped like a terminal product, but it is not yet a fully published npm release with a compiled `dist/` build pipeline.

If you want to push it over that line, the next product-facing steps are:

1. ship a `dist/` build for a more standard npm CLI install path
2. verify global install UX with `npm pack` / `npm link`
3. test real Binance private endpoints with production-like credentials
4. harden terminal UX across different shells and terminals

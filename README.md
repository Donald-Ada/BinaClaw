# BinaClaw

[English](./README.md) | [简体中文](./README.zh-CN.md)

Binance-focused AI agent with a terminal-first workflow, official Binance skills, Telegram access, and approval-gated trading actions.

## What It Does

- Analyzes markets with official Binance-style `SKILL.md` packages
- Runs as a local CLI desk or a shared Gateway + Telegram bot
- Keeps persistent workspace memory and sessions under `~/.binaclaw`
- Requires explicit confirmation before dangerous trading actions
- Stores Binance secrets in a local env file instead of `config.json`

## Quick Start

### Requirements

- Node.js `>=22`
- npm

### Install

```bash
npm install -g binaclaw
```

### First Run

```bash
binaclaw onboard
```

`binaclaw onboard` will guide you through:

- `BINACLAW_GATEWAY_PORT`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWED_USER_IDS`
- `BRAVE_SEARCH_API_KEY`
- `BINANCE_API_KEY`
- `BINANCE_API_SECRET`

After setup, BinaClaw will:

- save app settings into `~/.binaclaw/config.json`
- save Binance secrets into `~/.binaclaw/env.local`
- start the local Gateway in the background
- start the Telegram provider in the background

## Where Secrets Live

- `OPENAI_API_KEY`, `OPENAI_MODEL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_IDS`, `BRAVE_SEARCH_API_KEY`
  Stored in `config.json` unless overridden by shell env vars.
- `BINANCE_API_KEY`, `BINANCE_API_SECRET`
  Stored in `~/.binaclaw/env.local` and loaded locally at runtime. They are not written into `config.json`.

Configuration priority:

1. Shell environment variables
2. `~/.binaclaw/env.local`
3. `~/.binaclaw/config.json`
4. Built-in defaults

## Usage

### Local Terminal

```bash
binaclaw chat
```

Common prompts:

```text
今天 BNB 能买吗
分析一下 BTC 和 ETH 今天怎么样
帮我查下我的资产
BTCUSDT 现货，市价买入 20 USDT
卖出全部 BTC 为 USDT，按市价
```

### Telegram

Run onboarding once, then chat with your bot directly in Telegram.

Typical flow:

1. Send a market or account question
2. Let BinaClaw analyze or prepare an order
3. Reply `CONFIRM` or `确认` only when you really want to execute

### Background Services

```bash
binaclaw gateway
binaclaw gateway stop
binaclaw telegram
binaclaw telegram stop
```

## Core Commands

```bash
binaclaw onboard
binaclaw chat
binaclaw config
binaclaw auth status
binaclaw doctor
binaclaw skills list
binaclaw skills add <source>
binaclaw session
binaclaw session clear
```

In chat:

```text
/help
/config
/skills
/session
/session json
/session clear
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

## Safety Model

- Market data is treated as real-time and not cached for trading decisions
- Public read-only requests run directly
- Private Binance requests require valid credentials
- Dangerous actions require explicit confirmation
- BinaClaw will not claim an order has been filled unless it receives a real exchange response

## How It Works

BinaClaw is split into four layers:

1. `Workspace docs`
   `AGENTS.md`, `USER.md`, `TOOLS.md`, `MEMORY.md`, and daily logs hold long-lived local context.
2. `Skills`
   Official Binance `SKILL.md` packages teach the model how to solve domain tasks.
3. `Tools`
   Runtime adapters execute Binance, Brave, memory, and local operations.
4. `Main model calls`
   The model selects skills, reads the chosen skill docs, decides the endpoint/tool, and either replies directly or summarizes tool results.

## Workspace Layout

```text
~/.binaclaw/
  config.json
  env.local
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
```

## Troubleshooting

Check current configuration and health:

```bash
binaclaw auth status
binaclaw doctor
```

If something feels off in a live session, inspect:

- `/trace`
- `/session`
- `~/.binaclaw/workspace/sessions/sessions.json`
- `~/.binaclaw/workspace/sessions/<session-id>.jsonl`

## Development

Install dependencies:

```bash
npm install
```

Run from source:

```bash
npm run dev:onboard
npm run dev:chat
npm run dev:gateway
npm run dev:telegram
```

Build:

```bash
npm run build
```

Checks:

```bash
npm run typecheck
npm test
```

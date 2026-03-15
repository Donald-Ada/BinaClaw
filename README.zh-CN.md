# BinaClaw

[English](./README.md) | [简体中文](./README.zh-CN.md)

一个面向 Binance 生态的 AI Agent，主打终端优先体验，支持官方 Binance Skills、本地 Gateway、Telegram Bot，以及带确认流的交易执行。

项目完整介绍文档：

- [BinaClaw 项目介绍与设计说明](./docs/BinaClaw-Guide.zh-CN.md)

## 它能做什么

- 基于官方 Binance 风格 `SKILL.md` 做行情分析、账户查询和交易决策
- 既能在本地终端里使用，也能通过 Gateway 接到 Telegram
- 把会话、记忆和工作区文件持久化到 `~/.binaclaw`
- 对危险交易动作强制走确认流
- 将 Binance 密钥放在本机环境文件中，而不是写入 `config.json`

## 快速开始

### 环境要求

- Node.js `>=22`
- npm

### 安装

```bash
npm install -g binaclaw
```

### 首次配置

```bash
binaclaw onboard
```

`binaclaw onboard` 会引导你配置：

- `BINACLAW_GATEWAY_PORT`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWED_USER_IDS`
- `BRAVE_SEARCH_API_KEY`
- `BINANCE_API_KEY`
- `BINANCE_API_SECRET`
- `BINANCE_SQUARE_OPENAPI_KEY`

如果你要让 BinaClaw 通过内置的 `square-post` skill 发 Binance Square 帖子，`BINANCE_SQUARE_OPENAPI_KEY` 是必填项。

配置完成后会自动：

- 将应用配置写入 `~/.binaclaw/config.json`
- 将 Binance 密钥写入 `~/.binaclaw/env.local`
- 后台启动本地 Gateway
- 后台启动 Telegram provider

## 密钥存放规则

- `OPENAI_API_KEY`、`OPENAI_MODEL`、`TELEGRAM_BOT_TOKEN`、`TELEGRAM_ALLOWED_USER_IDS`、`BRAVE_SEARCH_API_KEY`
  默认写入 `config.json`，也可以被 shell 环境变量覆盖。
- `BINANCE_API_KEY`、`BINANCE_API_SECRET`、`BINANCE_SQUARE_OPENAPI_KEY`
  只写入 `~/.binaclaw/env.local`，不会写入 `config.json`。
  其中 `BINANCE_SQUARE_OPENAPI_KEY` 专门用于 Binance Square 发帖。

配置读取优先级：

1. shell 环境变量
2. `~/.binaclaw/env.local`
3. `~/.binaclaw/config.json`
4. 代码默认值

## 使用方式

### 本地终端

```bash
binaclaw chat
```

典型提问：

```text
今天 BNB 能买吗
分析一下 BTC 和 ETH 今天怎么样
帮我查下我的资产
BTCUSDT 现货，市价买入 20 USDT
卖出全部 BTC 为 USDT，按市价
```

### Telegram

完成一次 `onboard` 后，就可以直接在 Telegram 里和你的 bot 对话。

常见流程：

1. 发送行情、账户或交易问题
2. 等 BinaClaw 分析或生成下单意图
3. 只有真正要执行时，才回复 `CONFIRM` 或 `确认`

### 后台服务

```bash
binaclaw gateway
binaclaw gateway stop
binaclaw telegram
binaclaw telegram stop
```

## 常用命令

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

聊天内命令：

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

## 安全模型

- 行情数据按实时数据处理，不用于长期缓存交易决策
- 公开只读请求会直接执行
- Binance 私有接口需要有效凭证
- 危险交易动作必须显式确认
- 未拿到真实交易所回执前，BinaClaw 不会声称订单已成交

## 工作原理

BinaClaw 主要分成四层：

1. `Workspace docs`
   `AGENTS.md`、`USER.md`、`TOOLS.md`、`MEMORY.md` 和 daily log 负责长期本地上下文。
2. `Skills`
   官方 Binance `SKILL.md` 提供领域知识和操作规则。
3. `Tools`
   Runtime 负责执行 Binance、Brave、memory 和本地工具。
4. `主模型调用`
   模型先选 skill，再读选中的 skill 文档，决定应该调用哪个接口或工具；如果需要，再基于工具结果生成总结。

## 工作区结构

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

## 排查问题

查看当前配置和健康状态：

```bash
binaclaw auth status
binaclaw doctor
```

如果会话表现不对，优先看：

- `/trace`
- `/session`
- `~/.binaclaw/workspace/sessions/sessions.json`
- `~/.binaclaw/workspace/sessions/<session-id>.jsonl`

## 开发

安装依赖：

```bash
npm install
```

源码模式：

```bash
npm run dev:onboard
npm run dev:chat
npm run dev:gateway
npm run dev:telegram
```

构建：

```bash
npm run build
```

检查：

```bash
npm run typecheck
npm test
```

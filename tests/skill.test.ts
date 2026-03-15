import assert from "node:assert/strict";
import {mkdir, mkdtemp, readFile, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {BinanceClient} from "../src/core/binance.ts";
import {createAppConfig} from "../src/core/config.ts";
import {installSkillsFromSource, loadInstalledSkills, parseSkillDocument} from "../src/core/skill.ts";
import {createToolRegistryFromSkills} from "../src/core/tools.ts";

test("parseSkillDocument parses manifest, knowledge and warnings", async () => {
  const raw = `---
name: "demo-skill"
version: "1.0.0"
description: "demo"
capabilities: ["demo"]
requires_auth: false
dangerous: false
products: ["spot"]
tools: ["market.getTicker"]
---

## When to use
demo

## Instructions
demo
`;

  const parsed = (await parseSkillDocument(raw, "demo.md")).skill;
  assert.equal(parsed.manifest.name, "demo-skill");
  assert.equal(parsed.toolDefinitions.length, 0);
  assert.equal(parsed.knowledge.sections.whenToUse, "demo");
  assert.equal(parsed.warnings.length, 3);
});

test("parseSkillDocument throws when frontmatter is missing keys", async () => {
  const raw = `---
name: "broken"
---

## When to use
oops`;

  await assert.rejects(() => parseSkillDocument(raw, "broken.md"));
});

test("installSkillsFromSource installs multiple skills from a GitHub repo source", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-skills-"));
  const config = createAppConfig({ BINACLAW_HOME: home }, process.cwd());

  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://api.github.com/repos/demo/skills-repo") {
      return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
    }
    if (url === "https://api.github.com/repos/demo/skills-repo/git/trees/main?recursive=1") {
      return new Response(
        JSON.stringify({
          tree: [
            { path: "skills/alpha.md", type: "blob" },
            { path: "skills/beta.md", type: "blob" },
            { path: "README.md", type: "blob" },
          ],
        }),
        { status: 200 },
      );
    }
    if (url === "https://raw.githubusercontent.com/demo/skills-repo/main/skills/alpha.md") {
      return new Response(
        `---
name: "alpha-skill"
version: "1.0.0"
description: "alpha"
capabilities: ["a"]
requires_auth: false
dangerous: false
products: ["spot"]
tools: ["market.getTicker"]
---

## When to use
a

## Instructions
a

## Available APIs
a

## Output contract
a

## Examples
a
`,
        { status: 200 },
      );
    }
    if (url === "https://raw.githubusercontent.com/demo/skills-repo/main/skills/beta.md") {
      return new Response(
        `---
name: "beta-skill"
version: "1.0.0"
description: "beta"
capabilities: ["b"]
requires_auth: false
dangerous: false
products: ["spot"]
tools: ["market.getDepth"]
---

## When to use
b

## Instructions
b

## Available APIs
b

## Output contract
b

## Examples
b
`,
        { status: 200 },
      );
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const installed = await installSkillsFromSource("https://github.com/demo/skills-repo", config, fetchImpl);
  assert.equal(installed.length, 2);
  assert.deepEqual(installed.map((item) => item.manifest.name), ["alpha-skill", "beta-skill"]);
  const alphaSkill = await readFile(join(home, "skills", "alpha-skill", "alpha.md"), "utf8");
  assert.ok(alphaSkill.includes("name: \"alpha-skill\""));
});

test("loadInstalledSkills includes bundled package skills by default", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-bundled-skills-"));
  const bundled = await mkdtemp(join(tmpdir(), "binaclaw-bundled-source-"));
  const bundledSkillDir = join(bundled, "alpha");
  await mkdir(bundledSkillDir, { recursive: true });
  await writeFile(
    join(bundledSkillDir, "SKILL.md"),
    `---
name: "alpha"
version: "1.0.0"
description: "alpha"
capabilities: ["alpha"]
requires_auth: false
dangerous: false
products: ["spot"]
tools: ["market.getTicker"]
---

## When to use
alpha

## Instructions
alpha

## Available APIs
alpha

## Output contract
alpha

## Examples
alpha
`,
    "utf8",
  );

  const config = createAppConfig(
    { BINACLAW_HOME: home, BINACLAW_BUNDLED_SKILLS_DIR: bundled },
    process.cwd(),
  );
  const installed = await loadInstalledSkills(config);
  assert.ok(installed.some((skill) => skill.manifest.name === "alpha"));
});

test("parseSkillDocument keeps full official spot Quick Reference including /api/v3/order", async () => {
  const raw = await readFile(join(process.cwd(), "skills", "spot", "SKILL.md"), "utf8");
  const parsed = (await parseSkillDocument(raw, join(process.cwd(), "skills", "spot", "SKILL.md"))).skill;

  assert.ok(parsed.knowledge.endpointHints.length > 20);
  const placeOrder = parsed.knowledge.endpointHints.find(
    (item) => item.path === "/api/v3/order" && item.method === "POST",
  );
  assert.ok(placeOrder);
  assert.equal(placeOrder?.authRequired, true);
  assert.equal(placeOrder?.dangerLevel, "mutating");
  assert.ok(placeOrder?.optionalParams.includes("quoteOrderQty"));
});

test("parseSkillDocument extracts structured Binance tool definitions from Available APIs", async () => {
  const raw = `---
name: "demo-skill"
version: "1.0.0"
description: "demo"
capabilities: ["demo"]
requires_auth: true
dangerous: false
products: ["spot"]
tools: ["spot.getAccount"]
---

## When to use
demo

## Instructions
demo

## Available APIs
- \`spot.getAccount\`

\`\`\`json
[
  {
    "id": "spot.getAccount",
    "description": "获取现货账户余额",
    "dangerous": false,
    "authScope": "spot",
    "transport": "binance-rest",
    "inputSchema": { "type": "object" },
    "outputSchema": { "type": "object" },
    "binance": {
      "scope": "spot",
      "method": "GET",
      "path": "/api/v3/account",
      "signed": true
    }
  }
]
\`\`\`

## Output contract
demo

## Examples
demo
`;

  const parsed = (await parseSkillDocument(raw, "demo.md")).skill;
  assert.equal(parsed.toolDefinitions.length, 1);
  assert.equal(parsed.toolDefinitions[0]?.id, "spot.getAccount");
  assert.equal(parsed.toolDefinitions[0]?.binance.path, "/api/v3/account");
});

test("skill-defined Binance tools override builtin implementations", async () => {
  const config = createAppConfig({ BINACLAW_HOME: "/tmp/binaclaw-skill-registry" }, process.cwd());
  const skill = (await parseSkillDocument(
    `---
name: "market-overview"
version: "1.0.0"
description: "demo"
capabilities: ["demo"]
requires_auth: false
dangerous: false
products: ["spot"]
tools: ["market.getTicker"]
---

## When to use
demo

## Instructions
demo

## Available APIs
\`\`\`json
[
  {
    "id": "market.getTicker",
    "description": "自定义 ticker",
    "dangerous": false,
    "authScope": "none",
    "transport": "binance-rest",
    "inputSchema": {
      "type": "object",
      "required": ["symbol"]
    },
    "outputSchema": { "type": "object" },
    "binance": {
      "scope": "spot",
      "method": "GET",
      "path": "/api/v3/ticker/custom",
      "signed": false
    }
  }
]
\`\`\`

## Output contract
demo

## Examples
demo
`,
    "override.md",
  )).skill;

  let requestedUrl = "";
  const client = new BinanceClient(config.binance, (async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch);
  const registry = createToolRegistryFromSkills(config, [skill], client);
  const result = await registry.get("market.getTicker")?.handler({ symbol: "BTCUSDT" }, {
    config,
    now: () => new Date(),
  });

  assert.equal(result?.ok, true);
  assert.ok(requestedUrl.includes("/api/v3/ticker/custom"));
});

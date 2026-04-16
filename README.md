# Clawless

OpenClaw's agent runtime extracted for serverless. Same Pi SDK agent brain, no Gateway daemon. Triggered per-request via HTTP, zero idle cost. Multi-user, multi-agent. Auth-ready and Postgres/Supabase-compatible for durable state.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/clawless)

Clawless is designed for developers who want:

- a reusable AI backend they can drop behind an app
- app-specific agents, not just a generic chatbot
- durable sessions, memos, tools, knowledge, and secrets
- indexed retrieval and pluggable RAG sources for larger knowledge sets
- secure defaults in production without a large setup burden

## Setup

```bash
npm install
cp .env.example .env
# Set your provider API key and model in .env
```

Start the backend:

```bash
npm run dev
```

## Auth and Durable State

Clawless can run in two modes:

- Lightweight mode: no auth, in-memory sessions/memos, file-backed knowledge/tools/secrets.
- Production mode: authenticated users plus Postgres-backed sessions, memos, knowledge, tools, and secrets.

By default, Clawless behaves like this:

- Development/test mode: no auth required unless you explicitly enable it.
- Production mode (`NODE_ENV=production` or `CLAWLESS_MODE=production`): auth is required by default, and admin/config routes are closed by default.

Production mode is configured by environment variables:

```bash
# User auth
AUTH_REQUIRED=true
AUTH_TRUSTED_USER_HEADER=x-user-id

# or JWT/JWKS validation
# AUTH_JWT_SECRET=...
# AUTH_JWKS_URL=https://<project>.supabase.co/auth/v1/.well-known/jwks.json

# Admin/config access
ADMIN_API_KEY=replace-me

# Durable state (works with Supabase/Postgres)
DATABASE_URL=postgresql://...
DATABASE_SSL=true
```

When auth is enabled, `userId` is derived from the verified auth context by default. Normal users cannot impersonate other users by submitting a different `userId`.

### Production Checklist

For a real deployment, you should normally have all of the following:

- `NODE_ENV=production` or `CLAWLESS_MODE=production`
- `DATABASE_URL` pointing at Postgres/Supabase
- either `AUTH_TRUSTED_USER_HEADER` behind a trusted app gateway or JWT/JWKS validation
- `ADMIN_API_KEY` for setup/config routes
- `CORS_ORIGIN` set to your real frontend origin
- app-specific `guardrails` and `networkPolicy`

Do not rely on file persistence for mutable production knowledge/secrets/tools on ephemeral hosts like Railway or Vercel unless you also attach durable storage.

## Defining agents

Edit `clawless.config.ts` to define what your backend does. Each exported `defineAgent()` becomes an available agent.

```ts
import { defineAgent } from "./src/config/agent-def.js";
import { httpTool } from "./src/tools/http-tool.js";

export const myAgent = defineAgent({
  name: "my-agent",
  instructions: "You are a travel planner. Help users plan trips...",
  guardrails: {
    domain: "travel planning",
    outOfScopeMessage: "I can only help with travel planning requests.",
  },
  networkPolicy: {
    mode: "contextual",
  },
  outputSchema: {
    mode: "required",
    allowedBlocks: ["timeline", "actions", "citations"],
    preferredBlocks: ["timeline", "actions"],
    requiredBlocks: ["timeline", "actions"],
    requireCitations: true,
    onInvalid: "reject",
    instructions: "Use a timeline for itineraries and actions for booking next steps.",
  },
  retrieval: {
    mode: "indexed",
    topK: 4,
    sources: [
      { type: "knowledge", chunkSize: 1200, chunkOverlap: 200 },
    ],
    instructions: "Use retrieved fare rules and destination notes before relying on general travel knowledge.",
  },
  tools: [
    httpTool({
      name: "search_flights",
      description: "Search for flights between two cities",
      url: "https://api.example.com/flights",
      method: "GET",
      parameters: {
        origin: { type: "string", description: "Departure city code", required: true },
        destination: { type: "string", description: "Arrival city code", required: true },
        date: { type: "string", description: "Travel date (YYYY-MM-DD)", required: true },
      },
      auth: {
        headers: { "X-Api-Key": "FLIGHTS_API_KEY" },
      },
    }),
  ],
});
```

The `instructions` field is natural language — tell the agent what it does, how it should behave, what to prioritize. The agent figures out when and how to call the tools. Use `guardrails` to keep the agent in-domain and prevent disclosure of backend internals. Use `networkPolicy` to constrain generic HTTP builtins, and `builtinPolicy` to remove them entirely when the product does not need them. Clawless also performs a server-side scope check before the full tool-using agent run, using the agent's instructions and `guardrails.domain` as the source of truth.

`networkPolicy.mode: "contextual"` is the default. In that mode, `fetch_page` and `json_request` can only reach hosts already present in the agent's own configured HTTP tools, persisted dynamic tools, knowledge URLs, or explicit `allowHosts`. This keeps app backends usable without turning those builtins into unrestricted internet access.

If `outputSchema` is enabled, Clawless auto-injects a generated `present_output` tool for that agent. The agent can use it to emit structured UI payloads such as cards, tables, timelines, forms, filters, actions, and citations. Those blocks are returned separately from the final text response so clients do not have to reverse-engineer UI state from markdown.

Clawless also adapts raw tool results into canonical UI objects before returning them. Each `toolCalls[]` entry in `/api/agent` and each streamed `tool_end` event can include `ui`, which uses the same structured block model as final `output`. This lets clients render tables, cards, citations, forms, filters, actions, and timelines directly from tool results without depending on prompt wording.

If `retrieval` is enabled, Clawless resolves request-specific context before the model call. The default source is an indexed chunk search over the agent's knowledge items, and you can also register custom retrievers for external RAG backends. This keeps large knowledge sets from being injected wholesale on every request.

### Use The Right Layer

The cleanest way to shape an agent is to put each kind of information in the right place:

- `instructions`: the agent's role, tone, and priorities
- `knowledge`: product facts, API docs, policies, workflows, allowed external docs, and decision rules
- `tools`: the actual actions the agent is allowed to take
- `secrets`: API keys and credentials only
- `guardrails`: what the agent must refuse and what it must not disclose
- `networkPolicy`: where generic builtin HTTP tools are allowed to connect
- `retrieval`: how the agent pulls request-specific context from indexed knowledge or pluggable RAG sources

If you put everything into `instructions`, the agent becomes hard to maintain. If you put secrets into `knowledge`, the agent becomes unsafe. If you rely on knowledge without guardrails and tools, the agent becomes hard to control.

### Retrieval

Use `retrieval` when the agent should search a larger knowledge base or an external RAG system instead of injecting all knowledge into every prompt.

How it works:

- `off`: keep the current static knowledge injection behavior
- `indexed`: inject only retrieved documents for this request
- `hybrid`: inject both retrieved documents and the full static knowledge section

Built-in source:

- `{ type: "knowledge" }`: chunk and rank the agent's knowledge items with a local text index

Pluggable source:

- `{ type: "retriever", name: "catalog_rag" }`: call a custom retriever you registered in code

Example:

```ts
import { defineAgent, registerRetriever } from "clawless";

registerRetriever({
  name: "catalog_rag",
  description: "Search the external catalog/vector backend",
  retrieve: async ({ query, topK }) => {
    return searchCatalogVectors(query, topK);
  },
});

export const shoppingAssistant = defineAgent({
  name: "shopping-assistant",
  instructions: "You help customers compare products and explain store policy.",
  retrieval: {
    mode: "hybrid",
    topK: 5,
    maxChars: 5000,
    sources: [
      { type: "knowledge" },
      { type: "retriever", name: "catalog_rag", topK: 3 },
    ],
    instructions: "Prefer retrieved catalog context and policy excerpts over general product knowledge.",
  },
  tools: [searchCatalogTool],
});
```

### Network Policy Modes

`networkPolicy` applies to builtin outbound HTTP tools like `fetch_page` and `json_request`.

- `contextual`:
  Safe default. Only hosts already implied by the agent's own tools, persisted tools, knowledge URLs, or explicit `allowHosts` are reachable.
- `open`:
  For intentional open-web agents. Public internet hosts are allowed, but localhost/private-network SSRF targets are still blocked.
- `disabled`:
  Blocks builtin outbound HTTP entirely for that agent.

Notes:

- HTTPS is required by default. Plain HTTP is only allowed when `allowHttp: true`.
- URLs found in knowledge can widen the contextual allowlist, so knowledge should stay intentional and product-specific.
- `networkPolicy` affects builtin HTTP tools. Static/dynamic app-specific HTTP tools still work as configured.

### Structured Output

Use `outputSchema` when you want a frontend-ready response model instead of relying only on free text and raw tool traces.

Supported block types:

- `markdown`
- `cards`
- `table`
- `timeline`
- `form`
- `filters`
- `actions`
- `citations`

Example:

```ts
export const shoppingAssistant = defineAgent({
  name: "shopping-assistant",
  instructions: "You help customers browse products and compare options.",
  outputSchema: {
    mode: "required",
    allowedBlocks: ["cards", "filters", "actions", "citations"],
    preferredBlocks: ["cards", "actions"],
    requiredBlocks: ["cards", "actions"],
    requireCitations: true,
    onInvalid: "reject",
    instructions: "Use cards for products, filters for narrowing choices, and actions for next steps.",
  },
  tools: [searchCatalogTool],
});
```

How it works:

- `auto`: expose structured output support and let the agent use it when helpful
- `required`: always try to produce structured output; if the main agent does not emit it directly, Clawless runs a formatter fallback
- `off`: disable structured output for that agent

The per-agent schema can also:

- restrict which block types are allowed
- require specific block types via `requiredBlocks`
- require citations
- repair invalid output or reject the request via `onInvalid`

If `onInvalid: "reject"` and Clawless still cannot satisfy the contract after salvage/repair, `/api/agent` returns `422` instead of silently returning the wrong shape.

### Recommended Hardening For Product-Specific Agents

If your backend powers a focused application, such as shopping, support, booking, or health workflows, do not leave the agent as a generic assistant.

- Set `guardrails.domain` to the product scope the agent is allowed to serve.
- Set `guardrails.outOfScopeMessage` to the refusal message users should see for unrelated questions.
- Keep `guardrails.hideInternalDetails` enabled so users cannot query tools, models, prompts, providers, or backend configuration.
- Keep `networkPolicy.mode` as `contextual` unless you are intentionally building an open-web agent.
- Add `networkPolicy.allowHosts` only for extra public hosts the builtin HTTP tools should reach.
- Use `builtinPolicy.allow` or `builtinPolicy.deny` to remove broad tools like `fetch_page`, `json_request`, and `web_search` unless the product truly needs them.
- Prefer app-specific tools over general web access. For a shopping backend, expose catalog, inventory, pricing, recommendations, and checkout-adjacent tools instead of generic browsing tools.

Example for a shopping backend:

```ts
export const shoppingAssistant = defineAgent({
  name: "shopping-assistant",
  instructions: "You help customers browse products, compare options, and answer store-related shopping questions.",
  guardrails: {
    domain: "shopping help for this store",
    outOfScopeMessage: "I can only help with shopping-related questions for this store.",
    hideInternalDetails: true,
  },
  networkPolicy: {
    mode: "contextual",
  },
  outputSchema: {
    mode: "required",
    allowedBlocks: ["cards", "actions", "citations"],
    preferredBlocks: ["cards", "actions"],
    requiredBlocks: ["cards", "actions"],
    requireCitations: true,
    onInvalid: "reject",
  },
  tools: [
    searchCatalogTool,
    getProductDetailsTool,
    checkInventoryTool,
  ],
});
```

## Knowledge Guide

Knowledge is agent-scoped context. By default it is injected into the prompt, and when `retrieval` is enabled it can also be chunked and searched as an indexed source.

Good uses for knowledge:

- product catalog rules and business constraints
- API usage notes and response conventions
- refund, shipping, eligibility, or compliance policy
- supported workflows and escalation rules
- allowed external documentation or reference URLs

Bad uses for knowledge:

- secrets, API keys, bearer tokens, passwords
- user-specific private data
- giant document dumps without enabling retrieval or an external RAG source

Important behavior:

- Knowledge is injected into the system prompt when `retrieval.mode` is `off` or `hybrid`.
- Knowledge can also act as an indexed retrieval source when `retrieval.mode` is `indexed` or `hybrid`.
- Knowledge is not per-user; it is shared by the agent.
- Total knowledge size is capped by `MAX_KNOWLEDGE_CHARS` (default `100000`).
- In `contextual` network mode, URLs inside knowledge are treated as allowed outbound hosts for builtin HTTP tools.

Rule of thumb:

- If the agent should know something, put it in knowledge.
- If the agent should be able to do something, make it a tool.
- If the agent must never reveal or answer something, make it a guardrail.
- If the agent needs a credential, store it as a secret.

Example knowledge item:

```json
{
  "agent": "shopping-assistant",
  "title": "Store Shipping Policy",
  "content": "Standard shipping takes 3-5 business days. We do not ship hazardous items internationally. Use https://docs.example.com/shipping for the latest internal shipping rules.",
  "priority": 20
}
```

## Built-in tools

Clawless ships with 14 built-in tools. Core tools are enabled by default. Tools that need external API keys are disabled until you enable them.

Important:

- `fetch_page` and `json_request` are enabled by default, but their outbound access is still constrained by each agent's `networkPolicy`.
- The Builtins API changes global builtin enablement. Agent-level `builtinPolicy` still filters what each agent can actually use.

### Core (enabled by default)

| Tool | Description |
|------|-------------|
| `fetch_page` | Fetch a URL and return readable text (HTML stripped) |
| `json_request` | Generic HTTP call — agent controls URL, method, headers, body |
| `current_datetime` | Current date, time, and timezone |
| `store_memo` | Save notes that persist across turns (per-user) |
| `recall_memo` | Retrieve previously saved memos (per-user) |
| `update_plan` | Show step-by-step progress to the user (A2UI) |
| `sessions_list` | List the user's previous conversations |
| `sessions_history` | Retrieve conversation history from a past session |
| `sessions_spawn` | Spawn a sub-agent for focused parallel tasks |
| `subagents` | List and manage spawned sub-agents |

### Needs API key (disabled by default)

| Tool | Description | Required env vars |
|------|-------------|-------------------|
| `web_search` | Search the web (Brave, SerpAPI, or Google) | `BRAVE_SEARCH_API_KEY` or `SERP_API_KEY` or `GOOGLE_SEARCH_API_KEY` + `GOOGLE_SEARCH_CX` |
| `image_analyze` | Analyze images with a vision model | `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` |
| `image_generate` | Generate images from text (DALL-E) | `OPENAI_API_KEY` |
| `text_to_speech` | Convert text to speech audio | `OPENAI_API_KEY` |

Enable them via the API after providing the required secrets:

```bash
# Provide the key
curl -X POST /api/secrets -d '{"key":"BRAVE_SEARCH_API_KEY","value":"..."}'

# Enable the tool
curl -X POST /api/builtins/web_search/enable
```

## API

All endpoints are under `/api`. Default port is `3000`.

### POST /api/agent

Run the agent with a prompt. Returns the full result when complete.

If the prompt is out of scope for the selected agent, Clawless may refuse it before the full agent run starts and return the configured out-of-scope message with no tool calls.

**Request:**

```json
{
  "prompt": "Find me a round trip from NYC to Tokyo in July",
  "userId": "user-123",
  "agent": "my-agent",
  "sessionKey": "optional-for-followups",
  "model": "gpt-4o",
  "provider": "openai",
  "maxTurns": 10
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `prompt` | Yes | User message |
| `userId` | Yes, unless derived from auth | Unique user identifier — sessions are isolated per user |
| `agent` | No | Agent name from config. Omit to use the default |
| `sessionKey` | No | Pass a previous `sessionKey` to continue a conversation |
| `model` | No | Override model (default from `DEFAULT_MODEL` env) |
| `provider` | No | Override provider (default from `DEFAULT_PROVIDER` env) |
| `fallbackModels` | No | Backup models tried if primary fails (e.g. `["anthropic/claude-sonnet-4-5", "gpt-4o-mini"]`) |
| `maxTurns` | No | Max agent loop iterations (default: 10) |

**Response:**

```json
{
  "sessionKey": "550e8400-e29b-41d4-a716-446655440000",
  "agent": "my-agent",
  "result": "Here are the best flight options...",
  "output": {
    "version": 1,
    "summary": "3 itinerary options found",
    "blocks": [
      {
        "type": "timeline",
        "title": "Recommended Itinerary",
        "items": [
          {
            "title": "Depart JFK",
            "time": "2026-07-15 09:30",
            "description": "Non-stop to NRT"
          }
        ]
      },
      {
        "type": "actions",
        "actions": [
          { "id": "book-now", "label": "Book This Trip", "kind": "primary" }
        ]
      }
    ]
  },
  "retrieval": [
    {
      "id": "policy-returns#0",
      "title": "Baggage Policy",
      "content": "Carry-on bags are included on all direct flights in this fare family...",
      "score": 2.184,
      "sourceType": "knowledge",
      "sourceName": "knowledge_index",
      "url": "https://docs.example.com/baggage"
    }
  ],
  "toolCalls": [
    {
      "name": "search_flights",
      "args": { "origin": "JFK", "destination": "NRT", "date": "2026-07-15" },
      "result": "{...}",
      "ui": {
        "version": 1,
        "blocks": [
          {
            "type": "table",
            "title": "Search Flights",
            "columns": [
              { "key": "airline", "label": "Airline" },
              { "key": "price", "label": "Price" }
            ],
            "rows": [
              { "airline": "Example Air", "price": "$842" }
            ]
          }
        ]
      },
      "isError": false
    }
  ],
  "usage": {
    "totalInputTokens": 2340,
    "totalOutputTokens": 890,
    "totalTokens": 3230,
    "turns": 2
  }
}
```

### POST /api/agent/stream

Same request as `/api/agent`, returns Server-Sent Events (SSE) for real-time streaming.

**SSE events:**

| Event | Data | When |
|-------|------|------|
| `model_selected` | `{ model }` | Which model is being used |
| `model_fallback` | `{ failed, reason }` | Primary failed, trying next model |
| `agent_start` | `{}` | Agent begins processing |
| `retrieval_ready` | `{ documents }` | Retrieved context is ready for this request |
| `turn_start` | `{ turn }` | New LLM turn begins |
| `text_delta` | `{ delta }` | Incremental text token |
| `text_done` | `{ text }` | Full completed assistant message |
| `output_ready` | `{ output }` | Structured output is ready to render |
| `tool_start` | `{ toolCallId, toolName, args }` | Tool execution begins |
| `tool_end` | `{ toolCallId, toolName, result, ui, isError }` | Tool execution finished |
| `turn_end` | `{ turn }` | LLM turn complete |
| `agent_end` | `{ sessionKey, result, output, retrieval, toolCalls, usage }` | Agent finished |
| `error` | `{ message }` | Something went wrong |

### A2UI (Agent-to-UI)

The SSE events provide all the data needed for A2UI rendering. `retrieval_ready` surfaces the indexed/pluggable RAG context chosen for the request. The `update_plan` tool emits step-by-step progress via `tool_end`. `text_delta` streams text token by token. `output_ready` delivers structured UI blocks for the final answer. `tool_end.ui` delivers canonical UI blocks for intermediate tool results. The frontend decides how to render.

### POST /api/setup

Bulk configure tools, knowledge, secrets, and builtins in a single call. Runtime-managed agents, tools, and knowledge now write to the target environment's `draft` snapshot by default.

```json
{
  "secrets": [
    { "key": "MY_API_KEY", "value": "abc123" }
  ],
  "tools": [
    {
      "name": "search_items",
      "agent": "my-agent",
      "description": "Search for items",
      "url": "https://api.example.com/search",
      "parameters": {
        "query": { "type": "string", "description": "Search query", "required": true }
      },
      "auth": { "queryParams": { "api_key": "MY_API_KEY" } }
    }
  ],
  "knowledge": [
    {
      "agent": "my-agent",
      "title": "API Documentation",
      "content": "## How to use the search API\n...",
      "priority": 10
    }
  ],
  "builtins": ["web_search", "image_analyze"]
}
```

Notes:

- If `agent` is omitted on tools or knowledge, Clawless assigns them to the first configured agent.
- `builtins` in `/api/setup` enable those builtins globally, not per-agent.
- Add `"environment": "staging"` to target a non-default config environment.
- Add `"publish": true` to publish the current draft immediately after setup.
- Setup/config routes require admin access by default in production.

### Draft / Publish / Promotion

Clawless now supports release management for runtime-configured agents, tools, and knowledge:

- `draft`: mutable workspace for an environment
- `published`: immutable release snapshot used by production by default
- `rollback`: publish a new release from an older version
- `promotion`: copy a published release from one environment to another

Default behavior:

- development/test runtime reads `draft`
- production runtime reads `published`
- override with `CONFIG_STAGE=draft|published`

Each environment is separate. Typical flow:

1. Write changes to `staging` draft through `/api/agents`, `/api/tools`, `/api/knowledge`, or `/api/setup`.
2. `POST /api/config/publish` for `staging`.
3. Validate on the staging deployment.
4. `POST /api/config/promote` into `production`, optionally with `"publish": true`.

### Tools API

Register HTTP API tools the agent can call at runtime.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/tools` | Register a tool in draft (optional `environment`) |
| `GET` | `/api/tools` | List all (optional `?agent=name&environment=staging&stage=draft`) |
| `GET` | `/api/tools/:name` | Get one (optional `?environment=staging&stage=published`) |
| `PUT` | `/api/tools/:name` | Update a draft tool |
| `DELETE` | `/api/tools/:name` | Delete a draft tool |

In production, the setup/config endpoints (`/api/setup`, `/api/agents`, `/api/tools`, `/api/knowledge`, `/api/secrets`, `/api/builtins`, `/api/config`, `/api/providers`, `/api/capabilities`) require admin access by default. In local development, they stay open unless you configure auth/admin credentials.

### Knowledge API

Teach the agent about APIs, tools, and workflows.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/knowledge` | Add knowledge in draft (optional `environment`) |
| `GET` | `/api/knowledge` | List all (optional `?agent=name&environment=staging&stage=draft`) |
| `GET` | `/api/knowledge/:id` | Get one (optional `?environment=staging&stage=published`) |
| `PUT` | `/api/knowledge/:id` | Update draft knowledge |
| `DELETE` | `/api/knowledge/:id` | Delete draft knowledge |

Knowledge is the right place for role-specific facts and instructions, but not for secrets. Treat it as shared agent context, not user memory.

### Agent Config API

Runtime-managed agent definitions are versioned too. These endpoints manage the serializable parts of an agent: instructions, guardrails, builtinPolicy, networkPolicy, outputSchema, and model defaults. Code-defined tools still come from the repo.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/agents` | Create or replace a draft agent config |
| `GET` | `/api/agents` | List agent configs (optional `?environment=staging&stage=draft`) |
| `GET` | `/api/agents/:name` | Get one agent config |
| `PUT` | `/api/agents/:name` | Update a draft agent config |
| `DELETE` | `/api/agents/:name` | Delete a draft agent config |

This API also supports `retrieval`, so runtime-managed agents can switch between static knowledge injection, indexed knowledge retrieval, and custom named retrievers without a code redeploy.

### Config Lifecycle API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/config` | Current lifecycle status and known environments |
| `GET` | `/api/config/releases` | List published releases for an environment |
| `POST` | `/api/config/publish` | Publish the current draft for an environment |
| `POST` | `/api/config/rollback` | Publish a new release from an older release id/version |
| `POST` | `/api/config/promote` | Copy a published release to another environment, optionally publish it |

Example publish:

```json
{
  "environment": "staging",
  "note": "Spring catalog rollout"
}
```

Example promote:

```json
{
  "sourceEnvironment": "staging",
  "targetEnvironment": "production",
  "releaseId": "replace-with-release-id",
  "publish": true,
  "note": "Promote approved staging release"
}
```

### Secrets API

Provide API keys and credentials at runtime.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/secrets` | Set a secret (`{ key, value, expiresAt? }`) |
| `GET` | `/api/secrets` | List keys (values never exposed) |
| `GET` | `/api/secrets/:key` | Check if exists |
| `DELETE` | `/api/secrets/:key` | Delete |

### Secret resolution

When the agent uses `json_request` or `fetch_page`, it may reference secret key names in URLs, headers, or body values (e.g. `api_key=SCRAPINGDOG_API_KEY`). Clawless automatically resolves these to real values **server-side** before making the HTTP call.

- The agent writes the key name (from its knowledge), not the actual secret
- The tool replaces `UPPER_SNAKE_CASE` values that match registered secrets or safely-prefixed env vars like `CLAWLESS_SECRET_SCRAPINGDOG_API_KEY`
- The real key **never** reaches the frontend — SSE events show the key name, not the value
- Works in URL query params, headers (including `Bearer TOKEN_NAME`), and request body

```
Frontend sees (tool_start):  args.url = "...api_key=SCRAPINGDOG_API_KEY"
Server resolves internally:  ...api_key=69230d...  (never sent to client)
Frontend sees (tool_end):    result = "[product data]"
```

No extra configuration needed — if the secret is registered via `/api/secrets`, resolution is automatic. If you prefer env vars, expose them with the safe prefix (`CLAWLESS_SECRET_<KEY>` by default) instead of relying on arbitrary process env access.

### Retrievers API

List code-registered custom retrievers.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/retrievers` | List named retrievers available to agent `retrieval.sources` |

### Builtins API

Enable or disable built-in tools.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/builtins` | List all with enabled status |
| `POST` | `/api/builtins/:name/enable` | Enable a builtin |
| `POST` | `/api/builtins/:name/disable` | Disable a builtin |

These toggles are global runtime switches. Per-agent restrictions still come from `builtinPolicy`.

### Sessions API

Session endpoints require `?userId=` in unauthenticated/dev usage. In authenticated production usage, the backend derives the effective user identity from auth, and admin callers may still provide an explicit `userId`.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/sessions?userId=X` | List user's sessions |
| `GET` | `/api/sessions/:id?userId=X` | Session metadata |
| `DELETE` | `/api/sessions/:id?userId=X` | Delete session |

When auth is enabled, the backend uses the authenticated user identity and rejects spoofed `userId` values. Admin callers may still provide an explicit `userId`.

### Capabilities

Single view of everything the agent can do — all tool sources, knowledge, and secrets combined.

```
GET /api/capabilities?agent=assistant
```

```json
{
  "environment": "production",
  "stage": "published",
  "agent": "assistant",
  "tools": [
    { "name": "fetch_page", "source": "builtin", "enabled": true, "description": "..." },
    { "name": "present_output", "source": "generated", "description": "..." },
    { "name": "my_api", "source": "dynamic", "description": "...", "url": "https://..." },
    { "name": "search_flights", "source": "config", "description": "..." }
  ],
  "outputSchema": {
    "mode": "required",
    "allowedBlocks": ["cards", "actions", "citations"],
    "preferredBlocks": ["cards", "actions"],
    "requiredBlocks": ["cards", "actions"],
    "requireCitations": true,
    "onInvalid": "reject"
  },
  "retrieval": {
    "mode": "indexed",
    "topK": 5,
    "maxChars": 5000,
    "sources": [
      { "type": "knowledge" },
      { "type": "retriever", "name": "catalog_rag", "topK": 3 }
    ]
  },
  "retrievers": [
    { "name": "catalog_rag", "description": "Search the external catalog/vector backend" }
  ],
  "knowledge": [
    { "id": "abc", "title": "API Docs", "priority": 10, "contentLength": 1200 }
  ],
  "secrets": [
    { "key": "MY_API_KEY", "expired": false }
  ],
  "config": {
    "environment": "production",
    "stage": "published",
    "draftUpdatedAt": 1712345678901,
    "published": { "id": "rel_123", "version": 3, "publishedAt": 1712345678901, "note": "Spring rollout" },
    "releaseCount": 3
  }
}
```

### Other

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/capabilities` | Full view of tools, knowledge, secrets (optional `?agent=name`) |
| `GET` | `/api/retrievers` | List registered custom retrievers |

## Multi-turn conversations

Pass `sessionKey` from a previous response to continue. Sessions are isolated per `userId`.

```ts
const res1 = await fetch("/api/agent", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ prompt: "Hello", userId: "user-123" }),
});
const data1 = await res1.json();

const res2 = await fetch("/api/agent", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    prompt: "Tell me more",
    userId: "user-123",
    sessionKey: data1.sessionKey,
  }),
});
```

## Sub-agents

The agent can spawn sub-agents for complex parallel tasks:

```
User: "Compare budget vs premium camping gear"

Agent uses update_plan → shows 3 steps
Agent uses sessions_spawn → "Research budget camping gear under $200"
Agent uses sessions_spawn → "Research premium camping gear over $500"
Agent merges results and presents comparison
```

Sub-agents run within the same request. They get the same tools and knowledge but a focused task. No persistent processes needed.

## Creating tools

### Via API (runtime, from frontend)

```bash
curl -X POST /api/tools -H "Content-Type: application/json" -d '{
  "name": "my_api",
  "description": "What this API does",
  "url": "https://api.example.com/endpoint",
  "method": "GET",
  "parameters": {
    "query": { "type": "string", "description": "...", "required": true }
  },
  "auth": {
    "queryParams": { "api_key": "MY_API_KEY" }
  }
}'
```

### In config (static, in code)

```ts
// clawless.config.ts
httpTool({ name: "my_tool", ... })

// or with custom logic
defineTool({
  name: "calculate",
  label: "Calculator",
  description: "Perform a calculation",
  parameters: Type.Object({ expression: Type.String() }),
  execute: async (params) => JSON.stringify({ result: eval(params.expression) }),
})
```

### Providers API

Discover available AI providers, their models, and whether they're configured.

```
GET /api/providers
```

```json
{
  "providers": [
    {
      "provider": "openai",
      "envVar": "OPENAI_API_KEY",
      "configured": true,
      "models": [
        { "id": "gpt-4o", "name": "GPT-4o", "reasoning": false, "contextWindow": 128000 },
        { "id": "gpt-4o-mini", "name": "GPT-4o Mini", "reasoning": false, "contextWindow": 128000 }
      ]
    },
    {
      "provider": "anthropic",
      "envVar": "ANTHROPIC_API_KEY",
      "configured": false,
      "models": [...]
    }
  ]
}
```

Get models for a specific provider with cost info:

```
GET /api/providers/anthropic/models
```

The frontend can use these endpoints to let users pick their provider and model during setup.

In production, these provider-discovery routes are admin-only by default.

## Supported providers

Any provider supported by the Pi SDK. Set `DEFAULT_PROVIDER` and `DEFAULT_MODEL` in `.env`, plus the matching API key.

| Provider | Env var | Example models |
|----------|---------|----------------|
| `openai` | `OPENAI_API_KEY` | `gpt-4o`, `gpt-4o-mini` |
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-4-5`, `claude-opus-4-6` |
| `google` | `GEMINI_API_KEY` | `gemini-2.5-pro`, `gemini-2.5-flash` |
| `groq` | `GROQ_API_KEY` | `llama-3.3-70b-versatile` |
| `xai` | `XAI_API_KEY` | `grok-3`, `grok-3-mini` |
| `mistral` | `MISTRAL_API_KEY` | `mistral-large-latest` |
| `openrouter` | `OPENROUTER_API_KEY` | Any model via OpenRouter |
| `cerebras` | `CEREBRAS_API_KEY` | `llama-4-scout-17b` |
| `amazon-bedrock` | `AWS_ACCESS_KEY_ID` | Bedrock models |
| `azure-openai-responses` | `AZURE_OPENAI_API_KEY` | Azure-hosted OpenAI models |

Use `GET /api/providers` to see all available providers and models with live configuration status.

## Model fallback

Configure backup models that are tried in order if the primary fails (rate limit, auth error, outage). Fallbacks can cross providers.

**Via env (global default):**
```
DEFAULT_PROVIDER=openai
DEFAULT_MODEL=gpt-4o
DEFAULT_FALLBACK_MODELS=anthropic/claude-sonnet-4-5,gpt-4o-mini
```

**Via agent config:**
```ts
defineAgent({
  name: "my-agent",
  model: "gpt-4o",
  provider: "openai",
  fallbackModels: ["anthropic/claude-sonnet-4-5", "gpt-4o-mini"],
  ...
});
```

**Via request (per-call override):**
```json
{
  "prompt": "...",
  "userId": "user-1",
  "model": "gpt-4o",
  "fallbackModels": ["anthropic/claude-sonnet-4-5", "groq/llama-3.3-70b-versatile"]
}
```

Format: `"provider/model"` for cross-provider, or just `"model"` to use the same provider. The streaming endpoint emits `model_selected` and `model_fallback` events so the frontend can show which model is being used.

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DEFAULT_PROVIDER` | Yes | `openai` | AI provider (see supported providers) |
| `DEFAULT_MODEL` | Yes | — | Model ID (e.g. `gpt-4o`, `claude-sonnet-4-5`) |
| `DEFAULT_FALLBACK_MODELS` | No | — | Comma-separated fallbacks (e.g. `anthropic/claude-sonnet-4-5,gpt-4o-mini`) |
| `CLAWLESS_MODE` | No | auto | Explicit runtime mode: `development` / `production` |
| `AUTH_REQUIRED` | No | auto | Require authenticated user identity for user routes. Defaults to `true` in production and `false` in dev/test |
| `AUTH_TRUSTED_USER_HEADER` | No | — | Trusted upstream header carrying the authenticated user id |
| `AUTH_JWT_SECRET` | No | — | HMAC secret for HS256 bearer token verification |
| `AUTH_JWKS_URL` | No | — | JWKS URL for RS256 bearer token verification (works with Supabase Auth) |
| `AUTH_JWT_ISSUER` | No | — | Optional JWT issuer check |
| `AUTH_JWT_AUDIENCE` | No | — | Optional JWT audience check |
| `AUTH_USER_ID_CLAIM` | No | `sub` | JWT claim to treat as the user id |
| `AUTH_ADMIN_ROLE_CLAIM` | No | `role` | JWT claim used for admin-role checks |
| `AUTH_ADMIN_ROLE_VALUES` | No | `service_role,admin` | Comma-separated claim values that count as admin |
| `ADMIN_API_KEY` | No | — | Admin key for setup/config routes |
| `ADMIN_API_KEY_HEADER` | No | `x-clawless-admin-key` | Header name for the admin key |
| `PERSISTENCE_DRIVER` | No | auto | `postgres` or `file` |
| `DATABASE_URL` | No | — | Postgres connection string. Enables durable Postgres mode automatically |
| `DATABASE_SSL` | No | auto | Force SSL for Postgres connections |
| `DATABASE_TABLE_PREFIX` | No | `clawless` | Prefix for all Clawless Postgres tables |
| `CONFIG_ENV` | No | `development` or `production` | Config environment name for this deployment |
| `CONFIG_STAGE` | No | auto | Which snapshot this deployment serves: `draft` or `published` |
| `OPENAI_API_KEY` | * | — | API key for OpenAI |
| `ANTHROPIC_API_KEY` | * | — | API key for Anthropic |
| `GEMINI_API_KEY` | * | — | API key for Google Gemini |
| `PORT` | No | `3000` | Server port |
| `CORS_ORIGIN` | No | `localhost:*` | Allowed origins |
| `MAX_TURNS` | No | `10` | Max agent loop iterations |
| `TIMEOUT_MS` | No | `120000` | Request timeout in ms |
| `MAX_KNOWLEDGE_CHARS` | No | `100000` | Max total knowledge size |
| `DATA_DIR` | No | `.clawless` | Persisted data directory when using file mode |
| `SECRET_ENV_PREFIX` | No | `CLAWLESS_SECRET_` | Prefix for safely-exposed env-backed secrets |
| `OUTBOUND_ALLOWED_HOSTS` | No | — | Global allowlist for builtin outbound HTTP hosts (`api.example.com,*.example.com`) |
| `VISION_PROVIDER` | No | inherit | Provider for image_analyze |
| `VISION_MODEL` | No | `gpt-4o` | Model for image_analyze |
| `IMAGE_MODEL` | No | `dall-e-3` | Model for image_generate |
| `TTS_MODEL` | No | `tts-1` | Model for text_to_speech |

*Set the API key matching your `DEFAULT_PROVIDER`. See the providers table for env var names.

## Deploy

**Railway:**

1. Connect your GitHub repo in Railway
2. Railway runs `npm run build` then `npm start` automatically
3. Set environment variables in the Railway dashboard
4. Set `CORS_ORIGIN` to your frontend URL
5. For durable knowledge/tools/secrets/sessions/memos, set `DATABASE_URL` to Postgres/Supabase

If you redeploy on an ephemeral filesystem without Postgres, file-backed knowledge/tools/secrets may be lost and sessions/memos will not survive restarts.

**Vercel:**
```bash
vercel deploy
```

**Any Node.js host:**
```bash
npm install && npm run build && npm start
```

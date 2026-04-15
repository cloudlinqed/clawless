# Clawless

OpenClaw's agent runtime extracted for serverless. Same Pi SDK agent brain, no Gateway daemon. Triggered per-request via HTTP, zero idle cost. Multi-user, multi-agent. Auth-ready and Postgres/Supabase-compatible for durable state.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/clawless)

Clawless is designed for developers who want:

- a reusable AI backend they can drop behind an app
- app-specific agents, not just a generic chatbot
- durable sessions, memos, tools, knowledge, and secrets
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

### Use The Right Layer

The cleanest way to shape an agent is to put each kind of information in the right place:

- `instructions`: the agent's role, tone, and priorities
- `knowledge`: product facts, API docs, policies, workflows, allowed external docs, and decision rules
- `tools`: the actual actions the agent is allowed to take
- `secrets`: API keys and credentials only
- `guardrails`: what the agent must refuse and what it must not disclose
- `networkPolicy`: where generic builtin HTTP tools are allowed to connect

If you put everything into `instructions`, the agent becomes hard to maintain. If you put secrets into `knowledge`, the agent becomes unsafe. If you rely on knowledge without guardrails and tools, the agent becomes hard to control.

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
  tools: [
    searchCatalogTool,
    getProductDetailsTool,
    checkInventoryTool,
  ],
});
```

## Knowledge Guide

Knowledge is agent-scoped prompt context. It is the main way to teach the agent about your app without changing code.

Good uses for knowledge:

- product catalog rules and business constraints
- API usage notes and response conventions
- refund, shipping, eligibility, or compliance policy
- supported workflows and escalation rules
- allowed external documentation or reference URLs

Bad uses for knowledge:

- secrets, API keys, bearer tokens, passwords
- user-specific private data
- giant document dumps that should really be a retrieval/indexing system

Important behavior:

- Knowledge is injected into the system prompt for that agent.
- Knowledge is not a vector database or semantic search index.
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
  "toolCalls": [
    {
      "name": "search_flights",
      "args": { "origin": "JFK", "destination": "NRT", "date": "2026-07-15" },
      "result": "{...}",
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
| `turn_start` | `{ turn }` | New LLM turn begins |
| `text_delta` | `{ delta }` | Incremental text token |
| `text_done` | `{ text }` | Full completed assistant message |
| `tool_start` | `{ toolCallId, toolName, args }` | Tool execution begins |
| `tool_end` | `{ toolCallId, toolName, result, isError }` | Tool execution finished |
| `turn_end` | `{ turn }` | LLM turn complete |
| `agent_end` | `{ sessionKey, result, toolCalls, usage }` | Agent finished |
| `error` | `{ message }` | Something went wrong |

### A2UI (Agent-to-UI)

The SSE events provide all the data needed for A2UI rendering. The `update_plan` tool emits step-by-step progress via `tool_end`. `text_delta` streams text token by token. `tool_start` / `tool_end` give full tool lifecycle. The frontend decides how to render.

### POST /api/setup

Bulk configure tools, knowledge, secrets, and builtins in a single call.

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
- Setup/config routes require admin access by default in production.

### Tools API

Register HTTP API tools the agent can call at runtime.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/tools` | Register a tool |
| `GET` | `/api/tools` | List all (optional `?agent=name`) |
| `GET` | `/api/tools/:name` | Get one |
| `PUT` | `/api/tools/:name` | Update |
| `DELETE` | `/api/tools/:name` | Delete |

In production, the setup/config endpoints (`/api/setup`, `/api/tools`, `/api/knowledge`, `/api/secrets`, `/api/builtins`, `/api/providers`, `/api/capabilities`) require admin access by default. In local development, they stay open unless you configure auth/admin credentials.

### Knowledge API

Teach the agent about APIs, tools, and workflows.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/knowledge` | Add knowledge |
| `GET` | `/api/knowledge` | List all (optional `?agent=name`) |
| `GET` | `/api/knowledge/:id` | Get one |
| `PUT` | `/api/knowledge/:id` | Update |
| `DELETE` | `/api/knowledge/:id` | Delete |

Knowledge is the right place for role-specific facts and instructions, but not for secrets. Treat it as shared agent context, not user memory.

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
  "agent": "assistant",
  "tools": [
    { "name": "fetch_page", "source": "builtin", "enabled": true, "description": "..." },
    { "name": "my_api", "source": "dynamic", "description": "...", "url": "https://..." },
    { "name": "search_flights", "source": "config", "description": "..." }
  ],
  "knowledge": [
    { "id": "abc", "title": "API Docs", "priority": 10, "contentLength": 1200 }
  ],
  "secrets": [
    { "key": "MY_API_KEY", "expired": false }
  ]
}
```

### Other

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/capabilities` | Full view of tools, knowledge, secrets (optional `?agent=name`) |

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

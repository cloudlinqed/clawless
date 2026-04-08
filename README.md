# Clawless

OpenClaw's agent runtime extracted for serverless. Same Pi SDK agent brain, no Gateway daemon. Triggered per-request via HTTP, zero idle cost. Multi-user, multi-agent.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template/clawless?referralCode=clawless)

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

## Defining agents

Edit `clawless.config.ts` to define what your backend does. Each exported `defineAgent()` becomes an available agent.

```ts
import { defineAgent } from "./src/config/agent-def.js";
import { httpTool } from "./src/tools/http-tool.js";

export const myAgent = defineAgent({
  name: "my-agent",
  instructions: "You are a travel planner. Help users plan trips...",
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

The `instructions` field is natural language — tell the agent what it does, how it should behave, what to prioritize. The agent figures out when and how to call the tools.

## Built-in tools

Clawless ships with 14 built-in tools. Core tools are enabled by default. Tools that need external API keys are disabled until you enable them.

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
| `userId` | Yes | Unique user identifier — sessions are isolated per user |
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
      "title": "API Documentation",
      "content": "## How to use the search API\n...",
      "priority": 10
    }
  ],
  "builtins": ["web_search", "image_analyze"]
}
```

### Tools API

Register HTTP API tools the agent can call at runtime.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/tools` | Register a tool |
| `GET` | `/api/tools` | List all (optional `?agent=name`) |
| `GET` | `/api/tools/:name` | Get one |
| `PUT` | `/api/tools/:name` | Update |
| `DELETE` | `/api/tools/:name` | Delete |

### Knowledge API

Teach the agent about APIs, tools, and workflows.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/knowledge` | Add knowledge |
| `GET` | `/api/knowledge` | List all (optional `?agent=name`) |
| `GET` | `/api/knowledge/:id` | Get one |
| `PUT` | `/api/knowledge/:id` | Update |
| `DELETE` | `/api/knowledge/:id` | Delete |

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
- The tool replaces `UPPER_SNAKE_CASE` values that match registered secrets or env vars
- The real key **never** reaches the frontend — SSE events show the key name, not the value
- Works in URL query params, headers (including `Bearer TOKEN_NAME`), and request body

```
Frontend sees (tool_start):  args.url = "...api_key=SCRAPINGDOG_API_KEY"
Server resolves internally:  ...api_key=69230d...  (never sent to client)
Frontend sees (tool_end):    result = "[product data]"
```

No extra configuration needed — if the secret is registered via `/api/secrets`, resolution is automatic.

### Builtins API

Enable or disable built-in tools.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/builtins` | List all with enabled status |
| `POST` | `/api/builtins/:name/enable` | Enable a builtin |
| `POST` | `/api/builtins/:name/disable` | Disable a builtin |

### Sessions API

All session endpoints require `?userId=` query parameter.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/sessions?userId=X` | List user's sessions |
| `GET` | `/api/sessions/:id?userId=X` | Session metadata |
| `DELETE` | `/api/sessions/:id?userId=X` | Delete session |

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
| `GET` | `/api/health` | Health check, lists agents and config |
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
| `OPENAI_API_KEY` | * | — | API key for OpenAI |
| `ANTHROPIC_API_KEY` | * | — | API key for Anthropic |
| `GEMINI_API_KEY` | * | — | API key for Google Gemini |
| `PORT` | No | `3000` | Server port |
| `CORS_ORIGIN` | No | `localhost:*` | Allowed origins |
| `MAX_TURNS` | No | `10` | Max agent loop iterations |
| `TIMEOUT_MS` | No | `120000` | Request timeout in ms |
| `MAX_KNOWLEDGE_CHARS` | No | `100000` | Max total knowledge size |
| `DATA_DIR` | No | `.clawless` | Persisted data directory |
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

**Vercel:**
```bash
vercel deploy
```

**Any Node.js host:**
```bash
npm install && npm run build && npm start
```

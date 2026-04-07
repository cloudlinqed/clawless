# Clawless

OpenClaw's agent runtime extracted for serverless. Same Pi SDK agent brain, no Gateway daemon. Triggered per-request via HTTP, zero idle cost.

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

You can define multiple agents in the same config. Each is reachable by name.

## API

All endpoints are under `/api`. Default port is `3000` (set `PORT` env var to change).

### POST /api/agent

Run the agent with a prompt. Returns the full result when complete.

**Request:**

```json
{
  "prompt": "Find me a round trip from NYC to Tokyo in July",
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
| `agent` | No | Agent name from config. Omit to use the first defined agent |
| `sessionKey` | No | Pass a previous `sessionKey` to continue a conversation |
| `model` | No | Override model (default from `DEFAULT_MODEL` env) |
| `provider` | No | Override provider (default from `DEFAULT_PROVIDER` env) |
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

Same request as `/api/agent`, but returns Server-Sent Events (SSE).

**SSE events:**

| Event | Data | When |
|-------|------|------|
| `agent_start` | `{}` | Agent begins processing |
| `turn_start` | `{ turn }` | New LLM turn begins |
| `text_delta` | `{ delta }` | Incremental text token from the LLM |
| `text_done` | `{ text }` | Full text of completed assistant message |
| `tool_start` | `{ toolCallId, toolName, args }` | Agent is calling a tool |
| `tool_end` | `{ toolCallId, toolName, result, isError }` | Tool execution finished |
| `turn_end` | `{ turn }` | LLM turn complete |
| `agent_end` | `{ sessionKey, result, toolCalls, usage }` | Agent finished |
| `error` | `{ message }` | Something went wrong |

**Frontend example:**

```ts
import { EventSourceParserStream } from "eventsource-parser/stream";

const res = await fetch("http://localhost:3000/api/agent/stream", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ prompt: "Hello" }),
});

const stream = res.body!
  .pipeThrough(new TextDecoderStream())
  .pipeThrough(new EventSourceParserStream());

for await (const { event, data } of stream) {
  switch (event) {
    case "text_delta":
      process.stdout.write(JSON.parse(data).delta);
      break;
    case "tool_start":
      console.log("Calling:", JSON.parse(data).toolName);
      break;
    case "agent_end":
      console.log("Done:", JSON.parse(data));
      break;
  }
}
```

### A2UI (Agent-to-UI)

The SSE events provide all the data needed for A2UI rendering on the frontend. The `tool_start` / `tool_end` events give you the full tool execution lifecycle. `text_delta` gives you token-by-token streaming. The frontend decides how to render this.

### POST /api/setup

Bulk configure knowledge and secrets in a single call. Ideal for frontend onboarding flows.

```json
{
  "secrets": [
    { "key": "MY_API_KEY", "value": "abc123" },
    { "key": "OTHER_KEY", "value": "xyz", "expiresAt": 1735689600000 }
  ],
  "knowledge": [
    {
      "title": "My API Documentation",
      "content": "## Endpoint\n\nhttps://api.example.com/search\n\n## Parameters\n...",
      "priority": 10
    }
  ]
}
```

### Knowledge API

Teach the agent about APIs, tools, and workflows at runtime.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/knowledge` | Add a knowledge item |
| `GET` | `/api/knowledge` | List all (optional `?agent=name` filter) |
| `GET` | `/api/knowledge/:id` | Get one |
| `PUT` | `/api/knowledge/:id` | Update |
| `DELETE` | `/api/knowledge/:id` | Delete |

Knowledge items have a `priority` field (0-1000, default 100). Lower = appears first in the prompt.

### Secrets API

Provide API keys and credentials at runtime.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/secrets` | Set a secret (`{ key, value, expiresAt? }`) |
| `GET` | `/api/secrets` | List keys (values never exposed) |
| `GET` | `/api/secrets/:key` | Check if a secret exists |
| `DELETE` | `/api/secrets/:key` | Delete |

### Other endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Health check, lists agents |
| `GET` | `/api/sessions` | List active sessions |
| `GET` | `/api/sessions/:id` | Session metadata |
| `DELETE` | `/api/sessions/:id` | Delete session |

## Multi-turn conversations

Pass the `sessionKey` from a previous response to continue:

```ts
const res1 = await fetch("/api/agent", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ prompt: "Hello" }),
});
const data1 = await res1.json();

const res2 = await fetch("/api/agent", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    prompt: "Tell me more",
    sessionKey: data1.sessionKey,
  }),
});
```

## Creating tools

### HTTP tools (declarative)

For APIs you just need to call:

```ts
httpTool({
  name: "tool_name",
  description: "What this API does (the agent reads this)",
  url: "https://api.example.com/endpoint",
  method: "GET",
  parameters: {
    query: { type: "string", description: "...", required: true },
    limit: { type: "number", description: "...", default: 10 },
  },
  auth: {
    queryParams: { api_key: "MY_ENV_VAR" },
    headers: { "Authorization": "MY_TOKEN_VAR" },
  },
});
```

### Code tools (custom logic)

```ts
import { defineTool, Type } from "./src/tools/interface.js";

export const myTool = defineTool({
  name: "calculate",
  label: "Calculator",
  description: "Perform a calculation",
  parameters: Type.Object({
    expression: Type.String({ description: "Math expression" }),
  }),
  execute: async (params) => {
    return JSON.stringify({ result: eval(params.expression) });
  },
});
```

## Supported models

Any model supported by the Pi SDK:

| Provider | Model ID | Notes |
|----------|----------|-------|
| `openai` | `gpt-4o` | Default |
| `openai` | `gpt-4o-mini` | Faster, cheaper |
| `anthropic` | `claude-sonnet-4-5` | Strong at tool use |
| `anthropic` | `claude-opus-4-6` | Most capable |
| `google` | `gemini-2.5-pro` | Google alternative |

Set `DEFAULT_PROVIDER` and `DEFAULT_MODEL` in `.env`. Set the matching API key (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`).

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DEFAULT_PROVIDER` | No | `openai` | AI provider |
| `DEFAULT_MODEL` | Yes | — | Model ID (e.g. `gpt-4o`) |
| `OPENAI_API_KEY` | Yes* | — | API key for OpenAI |
| `PORT` | No | `3000` | Server port |
| `CORS_ORIGIN` | No | `localhost:*` | Allowed origins (comma-separated) |
| `MAX_TURNS` | No | `10` | Default max agent loop iterations |
| `TIMEOUT_MS` | No | `120000` | Request timeout in ms |
| `MAX_KNOWLEDGE_CHARS` | No | `100000` | Max total knowledge size |
| `DATA_DIR` | No | `.clawless` | Directory for persisted data |

*Required for the default OpenAI provider. Use the matching env var for other providers.

## Connecting from a frontend

```ts
const CLAWLESS_URL = "http://localhost:3000";

async function ask(prompt: string, sessionKey?: string) {
  const res = await fetch(`${CLAWLESS_URL}/api/agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, sessionKey }),
  });
  return res.json();
}
```

CORS allows all `localhost` origins in dev. Set `CORS_ORIGIN` for production.

## Deploy

**Vercel:**
```bash
vercel deploy
```

**Railway / Docker:**
```bash
npm run build && node dist/adapters/standalone.js
```

Set environment variables in your platform's dashboard.

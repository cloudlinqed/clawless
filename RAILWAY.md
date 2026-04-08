# Deploy and Host Clawless on Railway

Clawless is OpenClaw's agent runtime extracted for serverless. It provides a ready-to-use AI agent backend with 14 built-in tools, SSE streaming, multi-turn sessions, and user isolation. Configure your agent's tools, knowledge, and API keys from any frontend via REST API — no redeployment needed. Supports 11 AI providers with automatic model fallback.

## About Hosting Clawless

Deploying Clawless on Railway takes under a minute. Click the deploy button, set three environment variables (provider, model, API key), and your agent backend is live. Railway handles the Node.js build, port assignment, and health checks automatically. Clawless persists tool configurations, knowledge, and secrets to the local filesystem, which Railway maintains across restarts. Your frontend connects via REST API to send prompts, register tools, teach the agent, and stream responses. No additional databases or services are required for basic usage — everything runs in a single Railway service.

## Common Use Cases

- **AI-powered app backends** — Add intelligent agent capabilities to any web or mobile app without building your own LLM orchestration
- **Multi-tool agents** — Connect external APIs (search, e-commerce, data providers) and let the agent decide when and how to call them
- **Multi-provider flexibility** — Run on OpenAI, Anthropic, Google, Groq, or 7 other providers with automatic fallback if one fails

## Dependencies for Clawless Hosting

- **Node.js 22+** — Runtime environment (Railway provides this automatically)
- **AI provider API key** — At least one key from a supported provider (OpenAI, Anthropic, Google, etc.)

### Deployment Dependencies

- [OpenClaw Pi SDK](https://github.com/openclaw/openclaw) — The agent runtime powering Clawless
- [Hono](https://hono.dev) — Lightweight HTTP framework
- [Clawless GitHub Repository](https://github.com/cloudlinqed/clawless) — Source code and documentation

### Implementation Details

Clawless exposes a REST API for agent interaction and configuration:

```bash
# Send a prompt to the agent (streaming)
curl -N -X POST https://your-app.railway.app/api/agent/stream \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Hello", "userId": "user-1"}'

# Register a tool from your frontend
curl -X POST https://your-app.railway.app/api/tools \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my_api",
    "description": "Search for items",
    "url": "https://api.example.com/search",
    "method": "GET",
    "parameters": {"q": {"type": "string", "description": "Query", "required": true}},
    "auth": {"queryParams": {"api_key": "MY_API_KEY"}}
  }'

# Bulk setup — tools, knowledge, secrets, and builtins in one call
curl -X POST https://your-app.railway.app/api/setup \
  -H "Content-Type: application/json" \
  -d '{
    "secrets": [{"key": "MY_API_KEY", "value": "..."}],
    "tools": [{"name": "my_api", "url": "...", "description": "...", "parameters": {}}],
    "knowledge": [{"title": "API Docs", "content": "How to use the API..."}],
    "builtins": ["web_search"]
  }'
```

## Why Deploy Clawless on Railway?

Railway is a singular platform to deploy your infrastructure stack. Railway will host your infrastructure so you don't have to deal with configuration, while allowing you to vertically and horizontally scale it.

By deploying Clawless on Railway, you are one step closer to supporting a complete full-stack application with minimal burden. Host your servers, databases, AI agents, and more on Railway.

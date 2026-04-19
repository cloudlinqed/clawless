# Deploy Clawless on Railway

Clawless is a reusable AI backend template: request-driven agents with SSE streaming, multi-user sessions and memos, dynamic tools/knowledge/secrets via REST, indexed + pluggable RAG retrieval, durable Postgres-backed state, production-safe auth and SSRF defaults, and structured UI output (cards, tables, timelines, forms, filters, actions, citations + custom block types you register yourself).

Full reference lives in `README.md`. This file covers Railway-specific setup.

## What To Configure And Where

| Goal | Where |
|---|---|
| Change agent behavior | `clawless.config.ts` (`instructions`, `guardrails`, `tools`) |
| Add a REST API as a tool | `clawless.config.ts` (`httpTool`) or `POST /api/tools` |
| Add domain UI blocks (charts, maps, …) | `clawless.config.ts` (`registerBlock`) — see README |
| Teach the agent facts | `POST /api/knowledge` or `POST /api/setup` |
| Store API keys | `POST /api/secrets` or `CLAWLESS_SECRET_*` env vars |
| Enable web search / image / TTS | `POST /api/builtins/<name>/enable` after providing the key |
| Plug in a vector DB for RAG | `registerRetriever` in code + `retrieval.sources` |
| Promote staging → prod | `POST /api/config/promote` |
| Require auth | env: `AUTH_TRUSTED_USER_HEADER` or `AUTH_JWKS_URL` / `AUTH_JWT_SECRET` |
| Restrict outbound HTTP | `networkPolicy` on the agent |

## Production Defaults On Railway

Treat a Railway deploy as production unless it is a private staging instance.

- auth required for user routes
- admin/config routes closed (open them with `ADMIN_API_KEY` or JWT admin role)
- `fetch_page` / `json_request` constrained by each agent's `networkPolicy`
- outbound HTTP blocks localhost and private-network SSRF targets
- secret resolution uses registered secrets or `CLAWLESS_SECRET_*` env vars only
- a server-side scope check runs before every full agent run

A fresh Railway deploy is not an open public playground unless you loosen it deliberately.

## 1. Deploy

Click the Railway deploy button or connect the repo manually. Railway builds and starts the app automatically.

## 2. Attach durable storage

Do this before relying on runtime-configured knowledge, tools, secrets, sessions, or memos.

- add a Railway Postgres service and set `DATABASE_URL`, or
- point `DATABASE_URL` at Supabase/Postgres you already manage

Without it, restarts lose file-backed knowledge/tools/secrets, and in-memory sessions/memos do not survive.

## 3. Set env vars

Minimum:

```bash
DEFAULT_PROVIDER=openai
DEFAULT_MODEL=gpt-4o
OPENAI_API_KEY=...

NODE_ENV=production
CORS_ORIGIN=https://your-frontend.example.com
DATABASE_URL=postgresql://...
ADMIN_API_KEY=replace-me
```

Set `CONFIG_ENV` explicitly per deployment (e.g. `staging`, `production`) so release promotion has a stable target.

## 4. Choose an auth mode

**Trusted upstream (your backend authenticates, forwards user id):**

```bash
AUTH_TRUSTED_USER_HEADER=x-user-id
```

Only use this when requests come through a trusted server/gateway you control. Do not expose a public browser path where clients can set this header themselves.

**JWT / JWKS (Clawless verifies bearer tokens directly):**

```bash
AUTH_JWKS_URL=https://<project>.supabase.co/auth/v1/.well-known/jwks.json
# or
AUTH_JWT_SECRET=...

# optional
AUTH_JWT_ISSUER=...
AUTH_JWT_AUDIENCE=...
AUTH_USER_ID_CLAIM=sub
AUTH_ADMIN_ROLE_CLAIM=role
AUTH_ADMIN_ROLE_VALUES=service_role,admin
```

**Staging-only bypass** (private deployment only — never on public prod):

```bash
CLAWLESS_MODE=development
AUTH_REQUIRED=false
```

## Configuring The Agent

Edit `clawless.config.ts` so the shipped agent matches your product. For focused app backends:

- clear `instructions`
- `guardrails.domain` + `guardrails.outOfScopeMessage`
- keep `guardrails.hideInternalDetails` on
- keep `networkPolicy.mode: "contextual"` unless you want open-web
- add `outputSchema` if your frontend renders cards/tables/timelines/forms/filters/actions/citations
- register custom block types with `registerBlock()` for charts, maps, mermaid, kanban, code-diff, etc.
- prefer app-specific tools over generic browsing

See `README.md` → "Structured Output", "Custom UI Blocks", and the shopping-assistant example.

## Runtime Configuration From Your App

Configure tools, knowledge, and secrets through admin routes using the admin key:

```bash
curl -X POST https://your-app.up.railway.app/api/setup \
  -H "Content-Type: application/json" \
  -H "x-clawless-admin-key: replace-me" \
  -d '{
    "secrets": [{ "key": "MY_API_KEY", "value": "..." }],
    "tools": [{
      "agent": "shopping-assistant",
      "name": "search_items",
      "description": "Search store items",
      "url": "https://api.example.com/search",
      "parameters": { "q": { "type": "string", "description": "Search query", "required": true } },
      "auth": { "queryParams": { "api_key": "MY_API_KEY" } }
    }],
    "knowledge": [{
      "agent": "shopping-assistant",
      "title": "Store Policy",
      "content": "See https://docs.example.com/store-policy for shipping and returns.",
      "priority": 10
    }]
  }'
```

Notes:

- omitted `agent` → assigned to the first configured agent
- URLs in knowledge widen the contextual outbound allowlist for builtin HTTP tools
- never put secrets in knowledge
- runtime changes write to the target environment's `draft`; publish with `POST /api/config/publish`
- for large docs/catalogs, configure `retrieval` on the agent instead of injecting everything as static knowledge

## Draft / Publish / Promote

- staging deployment: `CONFIG_ENV=staging`, `CONFIG_STAGE=published`
- production deployment: `CONFIG_ENV=production`, `CONFIG_STAGE=published`

Typical flow:

1. write changes to the `staging` draft (`/api/agents|tools|knowledge|setup`)
2. `POST /api/config/publish` for `staging`
3. validate
4. `POST /api/config/promote` from `staging` to `production` with `"publish": true`

## Making User Requests

Trusted-header mode:

```bash
curl -X POST https://your-app.up.railway.app/api/agent \
  -H "Content-Type: application/json" \
  -H "x-user-id: user-123" \
  -d '{ "agent": "shopping-assistant", "prompt": "Find waterproof hiking shoes" }'
```

Bearer mode:

```bash
curl -X POST https://your-app.up.railway.app/api/agent \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <jwt>" \
  -d '{ "agent": "shopping-assistant", "prompt": "Find waterproof hiking shoes" }'
```

In production, normal users should not need to send `userId` manually — auth provides it.

## Common Failure Modes

| Symptom | Cause | Fix |
|---|---|---|
| Knowledge/tools lost after redeploy | no durable storage | set `DATABASE_URL` |
| Setup changes not visible in prod | serving `published`, changes still in `draft` | `POST /api/config/publish` (or check `CONFIG_STAGE`) |
| `/api/setup` or `/api/capabilities` returns 401/403 | admin protection working as intended | send `x-clawless-admin-key: <ADMIN_API_KEY>` or JWT admin role |
| User request fails `Authentication is required` | auth enforced, but no identity forwarded | configure `AUTH_TRUSTED_USER_HEADER` or JWT/JWKS |
| Agent refuses out-of-scope prompts | server-side scope check active | adjust `instructions` / `guardrails.domain`; avoid generic agent config for a product-specific backend |

## Intended Production Shape

- Railway app running Clawless
- Railway Postgres or external Postgres/Supabase
- your own frontend/backend calling Clawless
- auth + `ADMIN_API_KEY` configured
- app-specific `instructions`, `guardrails`, `tools`, `knowledge`, `networkPolicy`
- `outputSchema` (plus custom blocks via `registerBlock`) if your frontend renders rich UI
- `retrieval` if you have a large policy corpus, catalog, or knowledge base

Keep those pieces in place and the template is a solid base for an app-specific AI backend rather than a generic public chatbot.

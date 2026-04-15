# Deploy Clawless on Railway

This repo ships as a Railway-friendly template for running Clawless as a reusable AI backend.

Clawless gives you:

- request-driven agent execution with SSE streaming
- multi-user sessions and per-user memos
- dynamic tools, knowledge, and secrets via REST API
- durable Postgres/Supabase-backed state
- production-safe defaults for auth, admin routes, and outbound HTTP

## What Railway Is Good For

Railway is a good fit if you want:

- a hosted AI backend without maintaining your own infra
- a single service that can sit behind your app or API gateway
- durable Postgres storage for sessions, memos, tools, knowledge, and secrets
- a template you can fork and customize for app-specific agents

## Important Production Behavior

On Railway, you should treat this as a production deployment unless you are intentionally running a private staging instance.

Current defaults:

- production mode requires auth for user routes by default
- admin/config routes are closed by default in production
- `fetch_page` and `json_request` are constrained by each agent's `networkPolicy`
- builtin outbound HTTP blocks localhost and private-network SSRF targets
- secret resolution uses registered secrets or safely-prefixed env vars only
- the backend performs a server-side scope check before the full agent run

This means a fresh Railway deploy is not meant to be an open public playground unless you deliberately loosen it.

## Recommended Railway Setup

### 1. Deploy the template

Use the Railway deploy button or connect the repo manually.

Railway will build and start the app automatically.

### 2. Attach durable storage

Do this before you rely on runtime-configured knowledge, tools, secrets, sessions, or memos.

Recommended:

- add a Railway Postgres service and set `DATABASE_URL`
- or point `DATABASE_URL` to Supabase/Postgres you already manage

Without durable storage, Railway redeploys or restarts can lose file-backed knowledge/tools/secrets, and in-memory sessions/memos will not survive restarts.

### 3. Set required environment variables

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

### 4. Choose an auth mode

Clawless supports two main production patterns.

#### Option A: Trusted upstream app/backend

Use this if your own backend or edge layer authenticates the user and forwards trusted identity to Clawless.

```bash
AUTH_TRUSTED_USER_HEADER=x-user-id
```

Important:

- only use this if requests to Clawless come through a trusted server or gateway you control
- do not expose a public browser path where clients can set this header themselves

#### Option B: JWT / JWKS verification

Use this if the client talks to Clawless directly and you want Clawless to verify bearer tokens itself.

```bash
AUTH_JWKS_URL=https://<project>.supabase.co/auth/v1/.well-known/jwks.json
# or
AUTH_JWT_SECRET=...
```

Optional JWT settings:

```bash
AUTH_JWT_ISSUER=...
AUTH_JWT_AUDIENCE=...
AUTH_USER_ID_CLAIM=sub
AUTH_ADMIN_ROLE_CLAIM=role
AUTH_ADMIN_ROLE_VALUES=service_role,admin
```

## Testing Before Real Auth

If you want to test the template quickly before wiring production auth, do it on a private staging deployment only.

You can temporarily use:

```bash
CLAWLESS_MODE=development
AUTH_REQUIRED=false
```

In that mode:

- `userId` can be provided directly in requests
- admin/config routes stay open unless you configure admin/auth credentials

Do not keep this setup on a public production deployment.

## Configuring The Agent For Your App

Update `clawless.config.ts` so the shipped agent matches your product.

For focused application backends:

- define clear `instructions`
- set `guardrails.domain`
- set `guardrails.outOfScopeMessage`
- keep `guardrails.hideInternalDetails` enabled
- keep `networkPolicy.mode` as `contextual` unless you intentionally want open-web behavior
- prefer app-specific tools over generic browsing

Example:

```ts
export const shoppingAssistant = defineAgent({
  name: "shopping-assistant",
  instructions: "You help customers browse products, compare items, and answer store-related questions.",
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

## Runtime Configuration From Your App

Once deployed, your app can configure tools, knowledge, and secrets through admin routes.

Use the admin key for setup/config operations:

```bash
curl -X POST https://your-app.up.railway.app/api/setup \
  -H "Content-Type: application/json" \
  -H "x-clawless-admin-key: replace-me" \
  -d '{
    "secrets": [
      { "key": "MY_API_KEY", "value": "..." }
    ],
    "tools": [
      {
        "agent": "shopping-assistant",
        "name": "search_items",
        "description": "Search store items",
        "url": "https://api.example.com/search",
        "method": "GET",
        "parameters": {
          "q": { "type": "string", "description": "Search query", "required": true }
        },
        "auth": {
          "queryParams": { "api_key": "MY_API_KEY" }
        }
      }
    ],
    "knowledge": [
      {
        "agent": "shopping-assistant",
        "title": "Store Policy",
        "content": "Use https://docs.example.com/store-policy for shipping and return policy rules.",
        "priority": 10
      }
    ]
  }'
```

Notes:

- if `agent` is omitted on tools or knowledge, Clawless assigns them to the first configured agent
- URLs inside knowledge can widen the contextual outbound allowlist for builtin HTTP tools
- do not put secrets into knowledge

## Making User Requests

### With trusted upstream header

```bash
curl -X POST https://your-app.up.railway.app/api/agent \
  -H "Content-Type: application/json" \
  -H "x-user-id: user-123" \
  -d '{
    "agent": "shopping-assistant",
    "prompt": "Find me lightweight waterproof hiking shoes"
  }'
```

### With bearer token auth

```bash
curl -X POST https://your-app.up.railway.app/api/agent \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <jwt>" \
  -d '{
    "agent": "shopping-assistant",
    "prompt": "Find me lightweight waterproof hiking shoes"
  }'
```

In production, normal users should not need to provide `userId` manually if auth is configured correctly.

## Railway-Specific Notes

- set `CORS_ORIGIN` to your real frontend domain
- keep `NODE_ENV=production`
- prefer Railway Postgres or external Postgres/Supabase for durable state
- use `ADMIN_API_KEY` even if you also use JWT auth, because it keeps operational setup simple
- if you need env-backed secrets, expose them with the safe prefix `CLAWLESS_SECRET_` by default

## When To Use `fetch_page` And `json_request`

These builtins stay useful on Railway, but they are no longer meant to be unrestricted internet tools.

Recommended:

- keep `networkPolicy.mode` as `contextual`
- let outbound hosts come from your real app tools and knowledge URLs
- add `networkPolicy.allowHosts` only for hosts you explicitly trust

Use `networkPolicy.mode: "open"` only for agents that are intentionally built for broad web access.

## Common Failure Modes

### Knowledge or tools disappear after redeploy

Cause:

- no durable Postgres storage configured

Fix:

- set `DATABASE_URL`

### `/api/setup`, `/api/providers`, or `/api/capabilities` returns 401/403

Cause:

- production admin protection is working

Fix:

- provide `x-clawless-admin-key: <ADMIN_API_KEY>`
- or use an authenticated admin JWT role if you configured JWT admin claims

### User requests fail with `Authentication is required`

Cause:

- production auth is working, but your app is not forwarding trusted identity or bearer tokens

Fix:

- configure `AUTH_TRUSTED_USER_HEADER` behind a trusted backend, or
- configure JWT/JWKS auth and send bearer tokens

### Agent refuses out-of-scope prompts

Cause:

- scope enforcement is active and the prompt does not fit the configured agent role

Fix:

- adjust `instructions` / `guardrails.domain` if the refusal is wrong
- do not use a generic assistant config for a product-specific app backend

## Railway Template Summary

For the Railway template, the intended production shape is:

- Railway app for the Clawless service
- Railway Postgres or external Postgres/Supabase
- your own frontend or backend calling Clawless
- auth configured
- `ADMIN_API_KEY` configured
- app-specific agent instructions, guardrails, tools, knowledge, and `networkPolicy`

If you keep those pieces in place, the Railway template is a solid base for an app-specific AI backend rather than a generic public chatbot.

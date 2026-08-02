# Plan: Agent API (cc-connect Bridge based)

**Status: proposed — not yet built.** (2026-08-02)

Expose every deployed agent as an HTTP API, so customers can call their
agent from scripts, CI, backends and other products — not just chat.
Built on cc-connect's **Bridge Protocol** (`docs/bridge-protocol.md` in the
cc-connect repo): a WebSocket "platform" that is agent-agnostic, so it works
identically for **Claude Code, Codex, and any future agent type**, with
sessions, slash commands, files and streaming inherited from the engine.

## 1. End-to-end architecture

```
customer code                    control plane (Render)                 instance
────────────                     ─────────────────────                  ────────
POST /v1/agents/:id/messages ──► API gateway                            host-agent v2
  Authorization: aq_...            - verify per-agent API key             │ (persistent outbound
                                   - rate limit / metering                │  WSS tunnel to CP)
                                   - route to instance tunnel ──────────► │
                                                                          ▼
                                                              container: cc-connect
                                                                [bridge] ws :9810
                                                                (127.0.0.1 only)
                                                                          ▼
                                                                Engine → claude / codex
```

- Instances stay **outbound-only**: the host-agent opens a persistent
  WebSocket to the control plane (`/host/tunnel`, authed by host_token);
  API requests are multiplexed down it. No inbound ports, central auth,
  central metering.
- Inside the instance, the host-agent connects to the agent container's
  bridge WebSocket on `127.0.0.1:<port>` (each container publishes its
  bridge port to localhost only: `-p 127.0.0.1:<9810+n>:9810`).
- The control plane acts as a Bridge *adapter* per agent: registers as
  platform `"api"`, sends `message` frames, receives `reply` /
  `reply_stream` frames (schema: bridge-protocol.md §Message Protocol).

## 2. Customer-facing API (v1)

Base URL: `https://<BASE_URL>/v1` · Auth: `Authorization: Bearer aq_<key>`
(per-agent API keys). All errors: `{"error": "..."}` with 4xx/5xx.

### Send a message (the core endpoint)

```
POST /v1/agents/{agentId}/messages
{
  "message": "run the test suite and summarize failures",
  "session": "ci-checks",        // optional; default "default" — maps to a
                                 // bridge session_key api:{keyId}:{session}
  "stream": false                // true => SSE
}
```

Sync response (stream=false):
```json
{
  "reply": "3 failures, all in auth.test.ts: ...",
  "session": "ci-checks",
  "agent": "my-agent",
  "duration_ms": 41250
}
```

SSE response (stream=true) — mapped from bridge `reply_stream`/`typing`:
```
event: status   data: {"state":"working"}
event: delta    data: {"text":"3 failures"}
event: delta    data: {"text":", all in auth.test.ts"}
event: done     data: {"reply":"...full text...","duration_ms":41250}
```

Notes:
- Long-running turns are normal (agents do real work): sync requests get a
  generous timeout (default 300s, `?timeout=` up to 600); `stream: true`
  is the recommended mode.
- Slash commands pass through as message content (`"message": "/model"`),
  identical to chat behavior.

### Sessions

```
GET    /v1/agents/{agentId}/sessions              list (proxies bridge REST /bridge/sessions)
POST   /v1/agents/{agentId}/sessions              {"name": "ci-checks"}
DELETE /v1/agents/{agentId}/sessions/{name}
GET    /v1/agents/{agentId}/sessions/{name}/history?limit=50
```

### Agent info

```
GET /v1/agents/{agentId}    → {name, type, state, model, mode}
```

### Example (curl)

```bash
curl -N https://app.example.com/v1/agents/42/messages \
  -H "Authorization: Bearer aq_live_9f2..." \
  -H "Content-Type: application/json" \
  -d '{"message": "summarize the repo", "stream": true}'
```

## 3. Auth model — how users get and manage keys

Two token layers, only one visible to customers:

| Token | Who holds it | Purpose |
|---|---|---|
| **API key** `aq_...` | Customer | Calls the public API; per **agent**; created in dashboard |
| Bridge token | Control plane + host-agent only | Internal: CP↔cc-connect bridge auth inside the instance; generated at enable time; never shown to anyone |

API keys:
- Table `api_keys(id, agent_id, name, key_hash, prefix, created_at,
  last_used_at, revoked_at)`. Key = `aq_` + 32 random bytes; stored
  **SHA-256 hashed**; full value shown exactly once at creation; list view
  shows `aq_9f2…` prefix + last-used.
- Multiple keys per agent (e.g. one per consuming app); revoke anytime.
- Scope: a key addresses exactly one agent. (Account-wide keys: later, if
  asked for.)

## 4. User configuration flow (dashboard)

Agent card → **Settings** gains an **"API access"** section:

1. Toggle **Enable API** → control plane:
   - generates the internal bridge token,
   - regenerates config.toml with a `[bridge]` block
     (`enabled/port=9810/token`),
   - `update-agent` command → host-agent recreates the container with the
     localhost port mapping and connects/verifies the bridge,
   - timeline event: "🔌 API access enabled".
2. **Create API key** → name it ("github-actions") → key shown once with
   copy button + ready-made curl / JS / Python snippets.
3. Key list with revoke buttons + last-used timestamps.
4. Toggle off → bridge removed from config, keys stop resolving (403).

## 5. Billing & limits

- Metering hook: every completed message increments a per-key counter
  (ledger reason `api <agent> (N msgs)`); Phase 1 ships **included free**
  with rate limits; pricing decision deferred (candidates: per-message
   0.2–0.5c, or free-within-fair-use since the server itself is billed
  hourly anyway — API load is CPU on hardware the customer already rents).
- Rate limits (Phase 1): 60 requests/min per key; 2 concurrent turns per
  agent (matches what one cc-connect comfortably serves); 429 beyond.

## 6. Implementation phases

**Phase 0 — protocol validation — ✅ DONE 2026-08-02.** `scripts/bridge-probe.mjs`
against a real agent-base container (cc-connect v1.4.1) confirmed the full
register → register_ack → message → reply cycle for BOTH claudecode and
codex. Findings that shape the build:
- `[bridge]` is a **global top-level block** (`enabled/port/token/path`),
  NOT a per-project platform. `type = "bridge"` is rejected ("unknown
  platform"). The bridge server starts at `:9810` and enforces the token
  (401 without it).
- BUT cc-connect still requires each project to declare **at least one
  real `[[projects.platforms]]`** or config-load fails. So an API-only
  agent config must include a platform. Options: (a) keep the user's real
  Slack/Telegram platform and add `[bridge]` alongside; (b) for API-only
  agents, add a harmless placeholder platform (e.g. telegram with an
  unused dummy token — it just retries connecting in the background).
  Decide in Phase 1; (a) is free when a platform is already connected.
- Adapters bind to a project via a `project` field in the `register`
  message (or the default project). Session keys are adapter-composed
  (`api:{session}:{key}`) — new name = new conversation, as planned.
- The container **entrypoint currently sleeps** when no
  `[[projects.platforms]]` is present ("waiting for a chat platform") —
  since we always have a platform (real or placeholder), cc-connect runs;
  no entrypoint change needed for Phase 1.

**Phase 1 — MVP (2–3 days).**
- host-agent v2: persistent CP tunnel (outbound WSS, reconnect w/ backoff),
  bridge port mapping + local adapter bridging tunnel↔bridge
- control plane: tunnel endpoint, API gateway routes above (sync + SSE),
  api_keys table + dashboard UI, rate limits, timeline events, changelog
- **Depends on new host-agent → only NEW instances get API support.**
  Strongly prefer building host-agent self-update
  (docs/plan-host-agent-self-update.md) first or in the same release.

**Phase 2 — adoption & revenue.**
- OpenAI-compatible endpoint (`POST /v1/chat/completions` mapping) so any
  OpenAI SDK works out of the box
- Webhooks (agent finished → POST to customer URL), async job mode for
  very long turns (submit → poll/webhook)
- Metered billing + per-key usage in Settings

## 7. Risks / open questions

| Risk | Mitigation |
|---|---|
| Bridge protocol is "1.0-draft" | Phase 0 validation; pin cc-connect version in agent image (we already control the image) |
| One tunnel per instance = SPOF for API traffic | Reconnect w/ backoff; API returns 503 with Retry-After while tunnel is down |
| Long turns vs HTTP timeouts (Render proxy) | SSE keeps the connection warm; async job mode in Phase 2 |
| Concurrency on 2GB instances | 2-concurrent-turn cap per agent; upsell to bigger bundle (future resize feature) |
| Sessions created via API clutter chat `/list` | Use distinct `api:` platform prefix in session keys — engine scopes them naturally |

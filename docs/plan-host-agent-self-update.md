# Plan: host-agent self-update

**Status: proposed — not yet built.** (2026-07-31)

## Problem

`host-agent.js` ships to instances only at bootstrap. Fixes never reach
running instances — this bit us twice (Codex login relay, AGENTS.md
seeding). Instances created before this feature ships can never be
upgraded remotely (their host-agent doesn't know how to check).

## Mechanism

Reuse what exists: instances already fetch `/dist/host-agent.js` at
bootstrap, and systemd (`Restart=always`) revives the process on exit.

```
control plane                        instance (host-agent v7)
  /host/register response:               │
  { hostAgentVersion: 8 }   ───►         │ "8 > 7 — update"
                                         │ 1. GET /dist/host-agent.js → .tmp
                                         │ 2. validate: node --check .tmp
                                         │ 3. cp current → .bak
                                         │ 4. atomic rename .tmp → host-agent.js
                                         │ 5. process.exit(0)
                                         │ systemd restarts → v8 ✨
```

Agent containers are untouched — Docker runs independently of the
host-agent process, so updates cause zero user-visible interruption.
Only in-flight login-relay sessions could be lost (rare, retryable):
skip update while `logins` map is non-empty, retry next heartbeat.

## Phase 1 — core (~1h incl. testing)

1. `const VERSION = N` at top of host-agent.js; bump on every change.
2. Control plane extracts version from its own host-agent.js at boot
   (regex); includes `hostAgentVersion` in `/host/register` and
   `/host/status` responses. No new endpoints.
3. Update routine in host-agent: download → `node --check` validate →
   `.bak` backup → atomic rename → clean exit. On validation failure:
   keep old, report error via command-result channel.
4. Kill switch: `HOST_AGENT_AUTOUPDATE=0` env on control plane freezes
   the fleet (omit version from responses).
5. Test locally: run real host-agent against mock server, bump version,
   watch a live swap.

## Phase 2 — agent image refresh

New `refresh-image` command: `docker pull` latest agent-base +
recreate containers (preserving volumes/env). Lets cc-connect/claude/
codex version updates reach existing servers. Weekly CI rebuild already
publishes fresh images; this closes the delivery gap.

## Phase 3 — at scale (later)

- Staged rollout (10% of instances first, then fleet)
- Version column in admin dashboard
- Update audit log

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Corrupt/broken download installed | `node --check` before swap; atomic rename |
| New version crash-loops under systemd | `.bak` for manual recovery; we integration-test host-agent changes locally before push (established practice) |
| Thundering restart across fleet | Fine at current scale; add jitter in Phase 3 |
| Pre-feature instances unreachable | Accepted: they need one redeploy; all instances created after Phase 1 ships are covered forever |

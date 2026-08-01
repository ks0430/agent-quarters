# AgentDeploy — development conventions

## Changelog rule (do this every time)

Every **user-visible** change (feature, fix, behavior change) MUST add an
entry to `public/changelog.json` in the same commit, newest first:

```json
{ "date": "YYYY-MM-DD", "type": "feature|fix|improvement",
  "title": "Short user-facing title", "detail": "One sentence, written for customers — no internal jargon, no file names." }
```

Skip entries for: internal refactors, docs, admin/debug tooling.
The page renders at `/changelog.html` ("What's new" in the header).

## Other conventions

- Every change to `host-agent/host-agent.js` only reaches NEW instances
  (shipped at bootstrap) — until self-update exists
  (docs/plan-host-agent-self-update.md), call this out to the operator.
- Integration-test against the mock provider before pushing:
  `MOCK_PROVIDER=1 DB_PATH=./test.db PORT=3456 node src/server.js`
  (see README "Local development"); run a real host-agent + docker
  container for host-agent changes.
- Slack app manifest lives in `public/app.js` (`updateSlackManifestLink`) —
  it encodes hard-won rules (no message.channels, no /status //help,
  sanitized bot username, files scopes). Don't regress them.
- Instance lifecycle events: call `logEvent(instanceId, kind, message)`
  (src/events.js) for anything a customer would want on the Details
  timeline. Messages are customer-facing.
- Deploys: `git push` → Render auto-deploys (~1 min). Secrets live in
  Render env vars, never in the repo.

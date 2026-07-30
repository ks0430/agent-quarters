# AgentDeploy

One-click deployment of always-on AI coding agents. Users pick an AWS region,
paste an API key, and get a private cloud server running **Claude Code** or
**Codex**, bridged to Slack/Telegram via [cc-connect](https://github.com/chenhg5/cc-connect).

## Architecture

```
┌─ Control plane (this app) ────────────────────────────┐
│ Express + SQLite + static web UI                      │
│ - user accounts, deploy API, agent config             │
│ - Lightsail provisioning (provider adapter)           │
│ - command queue polled by instances (pull model)      │
└──────────────┬────────────────────────────────────────┘
               │ outbound HTTPS only
┌─ Each Lightsail instance ─────────────────────────────┐
│ bootstrap (user-data): swap, Docker, agent-base image │
│ host-agent (systemd): polls /host/* for commands      │
│  └─ docker container per agent:                       │
│     cc-connect + claude + codex, own /home/agent vol, │
│     --memory 1g --cpus 1.5 --pids-limit 512           │
└───────────────────────────────────────────────────────┘
```

- **Pull model**: instances phone home; no SSH, no inbound ports, works around
  Lightsail's lack of IAM roles.
- **Platform optional**: an agent deploys with just an API key. Without a chat
  platform its container idles ("connect a platform" state); adding
  Slack/Telegram from the dashboard rewrites the config and restarts it.
- **Provider adapter** (`src/provider.js`): tiny interface — a Hetzner/Vultr
  adapter is a drop-in later.

## Repo layout

```
src/server.js      express app + provisioning poller
src/routes-api.js  user API (auth, deploy, agents)
src/routes-host.js API for host-agents (register/commands/status)
src/provider.js    Lightsail adapter + mock provider
src/bootstrap.js   user-data script generator
src/configgen.js   cc-connect config.toml + env generator
host-agent/        daemon served to instances at /dist/host-agent.js
agent-image/       Dockerfile served at /dist/Dockerfile (agent-base image)
public/            web UI (no build step)
```

## Local development

```bash
npm install
npm run dev        # MOCK_PROVIDER=1 — no AWS calls, instances "boot" in 5s
# open http://localhost:3000
```

To exercise the full loop locally, grab the host_token from the DB after a
mock deploy and run a real host-agent against it (requires local Docker):

```bash
sqlite3 agentdeploy.db 'SELECT host_token FROM instances ORDER BY id DESC LIMIT 1'
docker build -t agent-base agent-image/
CP_URL=http://localhost:3000 HOST_TOKEN=<token> node host-agent/host-agent.js
```

## Production deployment

1. **Server**: any always-on box (this can start life on a $12 Lightsail
   instance itself). `npm install && npm start` behind a reverse proxy.
2. **Domain + HTTPS required**: set `BASE_URL=https://yourdomain`. Instances
   fetch bootstrap assets and send API keys over this channel — it must be
   HTTPS and publicly reachable. Caddy makes this a one-liner:
   `caddy reverse-proxy --from yourdomain.com --to :3000`
3. **AWS credentials**: an IAM user with a Lightsail-only policy
   (`lightsail:CreateInstances`, `GetInstance`, `DeleteInstance`). Export as
   `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` or use the SDK default chain.
4. Copy `.env.example` → `.env`, fill in, and load it (e.g. systemd
   `EnvironmentFile=` or `set -a; . ./.env; set +a; npm start`).

### Instance lifecycle

deploy → Lightsail `CreateInstances` (userData bootstrap) → poller marks
`bootstrapping` when the VM runs → bootstrap installs Docker, builds
agent-base, starts host-agent → host-agent registers (`ready`) → picks up the
queued `create-agent` command → container starts → heartbeats every 15s
(status + last 40 log lines). Total ~3 minutes.

## Security notes (read before charging money)

- Agent API keys and platform tokens are stored **unencrypted** in SQLite and
  embedded in queued command payloads. Encrypt at rest (SQLCipher or
  app-level AES with a KMS key) before real customers.
- `host_token` is the only instance credential; it can only reach `/host/*`.
  Rotate by redeploying the instance.
- Rate-limit `/api/login` and `/api/signup` before going public (fail2ban or
  express-rate-limit).
- Bootstrap logs on instances: `/var/log/agentdeploy-bootstrap.log`;
  host-agent logs: `journalctl -u agentdeploy-host`.

## Roadmap (from the business plan)

- [ ] Stripe subscriptions ($19 shared / $39 dedicated)
- [ ] `claude setup-token` device-flow relay (subscription login, no API key)
- [ ] Multi-agent packing (3 per 4GB instance) — host-agent already supports
      multiple containers; needs scheduler + `medium_3_0` bundles
- [ ] Hetzner provider adapter (~4× cheaper)
- [ ] Encrypt secrets at rest; email verification; usage dashboards
```

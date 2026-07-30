# AgentDeploy agent base image: Claude Code + Codex + cc-connect.
# Self-contained (no COPY) so instances can build it straight from this file.
# One container per agent; /home/agent is a per-agent volume from the host.

FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates python3 procps ripgrep \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code @openai/codex cc-connect

# Non-root user: isolates the agent and keeps Claude Code happy (it refuses
# permission-skipping modes as root). uid must match host-agent's chown.
RUN useradd -m -u 1001 -s /bin/bash agent

# printf (not heredoc): heredocs need BuildKit; this builds everywhere.
RUN printf '%s\n' \
      '#!/bin/bash' \
      'CFG=/home/agent/.cc-connect/config.toml' \
      'mkdir -p /home/agent/workspace' \
      'if [ ! -f "$CFG" ]; then' \
      '  echo "[agentdeploy] no config yet - waiting"' \
      '  exec sleep infinity' \
      'fi' \
      'if ! grep -q "projects.platforms" "$CFG"; then' \
      '  echo "[agentdeploy] agent is configured and ready."' \
      '  echo "[agentdeploy] waiting for a chat platform (Slack/Telegram) to be connected from the dashboard..."' \
      '  exec sleep infinity' \
      'fi' \
      'exec cc-connect --config "$CFG"' \
      > /entrypoint.sh && chmod +x /entrypoint.sh

USER agent
WORKDIR /home/agent/workspace
ENTRYPOINT ["/entrypoint.sh"]

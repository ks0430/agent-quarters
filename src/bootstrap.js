// Generates the Lightsail user-data script that turns a blank Ubuntu 24.04
// box into an agent host: swap, Docker, prebuilt agent image, host-agent
// daemon that phones home. Runs once at first boot; logs to
// /var/log/agentdeploy-bootstrap.log on the instance for debugging.

export function buildUserData({ baseUrl, hostToken }) {
  return `#!/bin/bash
set -euo pipefail
exec > /var/log/agentdeploy-bootstrap.log 2>&1
echo "=== agentdeploy bootstrap $(date -u +%FT%TZ) ==="

# 4GB swap: the shock absorber for container memory spikes (Lightsail has none)
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y docker.io nodejs curl

mkdir -p /opt/agentdeploy /opt/agents

curl -fsSL "${baseUrl}/dist/host-agent.js" -o /opt/agentdeploy/host-agent.js
curl -fsSL "${baseUrl}/dist/Dockerfile" -o /opt/agentdeploy/Dockerfile

cat > /etc/systemd/system/agentdeploy-host.service <<'UNIT'
[Unit]
Description=AgentDeploy host agent
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
ExecStart=/usr/bin/node /opt/agentdeploy/host-agent.js
Restart=always
RestartSec=5
EnvironmentFile=/opt/agentdeploy/host.env
OOMScoreAdjust=-500

[Install]
WantedBy=multi-user.target
UNIT

cat > /opt/agentdeploy/host.env <<EOF
CP_URL=${baseUrl}
HOST_TOKEN=${hostToken}
EOF
chmod 600 /opt/agentdeploy/host.env

# Keep dockerd alive in memory pressure too
mkdir -p /etc/systemd/system/docker.service.d
printf '[Service]\\nOOMScoreAdjust=-500\\n' > /etc/systemd/system/docker.service.d/oom.conf

# Register with the control plane FIRST so the dashboard shows progress,
# then build the agent image (5-15 min on small instances). The host-agent
# waits for the image before starting any agent container.
systemctl daemon-reload
systemctl enable --now agentdeploy-host

docker build -t agent-base /opt/agentdeploy

echo "=== bootstrap done ==="
`;
}

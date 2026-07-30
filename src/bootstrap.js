// Generates the Lightsail user-data script that turns a blank Ubuntu 24.04
// box into an agent host: swap, Docker, prebuilt agent image, host-agent
// daemon that phones home. Runs once at first boot; logs to
// /var/log/agentdeploy-bootstrap.log on the instance.
//
// Hardening notes:
// - Every apt call retries with a dpkg lock timeout: first-boot user-data
//   races unattended-upgrades for the lock, and losing that race must not
//   kill the script.
// - On any fatal error the script POSTs the log tail to /host/bootstrap-error
//   so the failure is visible on the dashboard instead of only on the box.

export function buildUserData({ baseUrl, hostToken }) {
  const imageRef = process.env.AGENT_IMAGE || '';
  const imageStep = imageRef
    ? `if retry 3 docker pull "${imageRef}"; then
  docker tag "${imageRef}" agent-base
else
  echo "pull failed - building agent-base locally"
  docker build -t agent-base /opt/agentdeploy
fi`
    : 'docker build -t agent-base /opt/agentdeploy';

  return `#!/bin/bash
exec > /var/log/agentdeploy-bootstrap.log 2>&1
set -x
CP_URL="${baseUrl}"
HOST_TOKEN="${hostToken}"

fail() {
  msg=$(tail -n 4 /var/log/agentdeploy-bootstrap.log | tr -c 'a-zA-Z0-9 .,:/_=-' ' ' | tail -c 400)
  curl -sS -m 10 -X POST -H "Authorization: Bearer $HOST_TOKEN" -H 'Content-Type: application/json' \\
    -d "{\\"message\\": \\"bootstrap failed: $msg\\"}" "$CP_URL/host/bootstrap-error" || true
  exit 1
}

retry() {
  local n=$1; shift
  for i in $(seq 1 "$n"); do
    "$@" && return 0
    echo "retry $i/$n failed: $*"
    sleep 15
  done
  return 1
}

apt_do() {
  retry 20 apt-get -o DPkg::Lock::Timeout=60 "$@"
}

echo "=== agentdeploy bootstrap $(date -u +%FT%TZ) ==="

# 4GB swap: the shock absorber for container memory spikes (Lightsail has none)
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile || fail
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

export DEBIAN_FRONTEND=noninteractive
apt_do update -y || fail
apt_do install -y docker.io nodejs curl || fail

mkdir -p /opt/agentdeploy /opt/agents

retry 10 curl -fsSL "$CP_URL/dist/host-agent.js" -o /opt/agentdeploy/host-agent.js || fail
retry 10 curl -fsSL "$CP_URL/dist/Dockerfile" -o /opt/agentdeploy/Dockerfile || fail

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

# Keep dockerd alive under memory pressure too
mkdir -p /etc/systemd/system/docker.service.d
printf '[Service]\\nOOMScoreAdjust=-500\\n' > /etc/systemd/system/docker.service.d/oom.conf

# Register with the control plane FIRST (dashboard progress), then fetch the
# image; the host-agent waits for the image before starting containers.
systemctl daemon-reload
systemctl enable --now agentdeploy-host || fail

${imageStep}

echo "=== bootstrap done ==="
`;
}

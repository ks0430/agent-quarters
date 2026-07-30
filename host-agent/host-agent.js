#!/usr/bin/env node
// AgentDeploy host-agent: runs on every deployed instance (as root, via
// systemd). Pull-only — polls the control plane over HTTPS for commands and
// reports container status. No inbound ports required.
//
// Env: CP_URL (control plane base URL), HOST_TOKEN (this instance's token).
// Plain CommonJS, no dependencies; works on Node 18+ (Ubuntu 24.04 apt node).

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');

const CP_URL = process.env.CP_URL;
const HOST_TOKEN = process.env.HOST_TOKEN;
const AGENTS_DIR = '/opt/agents';
const AGENT_UID = '1001'; // "agent" user inside the container image

if (!CP_URL || !HOST_TOKEN) {
  console.error('CP_URL and HOST_TOKEN are required');
  process.exit(1);
}

const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 120000, maxBuffer: 1024 * 1024, ...opts }, (err, stdout, stderr) => {
    resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') });
  });
});

async function api(method, urlPath, body) {
  const res = await fetch(`${CP_URL}${urlPath}`, {
    method,
    headers: { Authorization: `Bearer ${HOST_TOKEN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${urlPath}: HTTP ${res.status}`);
  return res.json();
}

const safeName = (name) => {
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(String(name))) throw new Error(`bad agent name: ${name}`);
  return name;
};
const containerOf = (name) => `agent-${name}`;

async function writeAgentFiles(name, configToml, env) {
  const dir = path.join(AGENTS_DIR, name);
  const home = path.join(dir, 'home');
  await fs.mkdir(path.join(home, '.cc-connect'), { recursive: true });
  await fs.mkdir(path.join(home, 'workspace'), { recursive: true });
  await fs.writeFile(path.join(home, '.cc-connect', 'config.toml'), configToml);
  const envLines = Object.entries(env || {}).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  await fs.writeFile(path.join(dir, 'env.list'), envLines, { mode: 0o600 });
  // Container runs as uid 1001; the mounted home must be writable by it.
  await run('chown', ['-R', `${AGENT_UID}:${AGENT_UID}`, home]);
  return dir;
}

async function startContainer(name, dir) {
  await run('docker', ['rm', '-f', containerOf(name)]); // idempotent
  const r = await run('docker', ['run', '-d',
    '--name', containerOf(name),
    '--restart', 'unless-stopped',
    '--memory', '1g', '--memory-swap', '2g',
    '--cpus', '1.5', '--pids-limit', '512',
    '--env-file', path.join(dir, 'env.list'),
    '-v', `${path.join(dir, 'home')}:/home/agent`,
    'agent-base']);
  if (!r.ok) throw new Error(`docker run failed: ${r.stderr.slice(0, 500)}`);
}

const handlers = {
  // create and update are the same idempotent operation: write files, (re)start.
  async 'create-agent'({ agentName, configToml, env }) {
    const name = safeName(agentName);
    const dir = await writeAgentFiles(name, configToml, env);
    await startContainer(name, dir);
    return `container ${containerOf(name)} started`;
  },
  async 'update-agent'(payload) {
    return handlers['create-agent'](payload);
  },
  async 'restart-agent'({ agentName }) {
    const name = safeName(agentName);
    const r = await run('docker', ['restart', containerOf(name)]);
    if (!r.ok) throw new Error(r.stderr.slice(0, 500));
    return 'restarted';
  },
  async 'delete-agent'({ agentName }) {
    const name = safeName(agentName);
    await run('docker', ['rm', '-f', containerOf(name)]);
    await fs.rm(path.join(AGENTS_DIR, name), { recursive: true, force: true });
    return 'deleted';
  },
};

async function pollCommands() {
  const commands = await api('GET', '/host/commands');
  for (const cmd of commands) {
    let ok = true; let output = '';
    try {
      const handler = handlers[cmd.type];
      if (!handler) throw new Error(`unknown command type: ${cmd.type}`);
      output = await handler(cmd.payload);
      console.log(`command ${cmd.id} (${cmd.type}): ${output}`);
    } catch (err) {
      ok = false;
      output = String(err.message || err);
      console.error(`command ${cmd.id} (${cmd.type}) failed: ${output}`);
    }
    await api('POST', `/host/commands/${cmd.id}/result`, { ok, output });
  }
}

async function reportStatus() {
  let names = [];
  try {
    names = (await fs.readdir(AGENTS_DIR)).filter((n) => /^[a-z0-9][a-z0-9-]*$/.test(n));
  } catch { /* dir not created yet */ }

  const agents = [];
  for (const name of names) {
    const inspect = await run('docker', ['inspect', '--format', '{{.State.Status}}', containerOf(name)]);
    const state = inspect.ok ? inspect.stdout.trim() : 'missing';
    const logs = await run('docker', ['logs', '--tail', '40', containerOf(name)]);
    agents.push({ name, state, logs: (logs.stdout + logs.stderr).slice(-6000) });
  }
  await api('POST', '/host/status', { agents });
}

async function main() {
  // Register with retry — the control plane must learn we're alive.
  for (;;) {
    try {
      await api('POST', '/host/register', { version: 1 });
      console.log('registered with control plane');
      break;
    } catch (err) {
      console.error('register failed, retrying in 10s:', err.message);
      await new Promise((r) => setTimeout(r, 10000));
    }
  }

  let tick = 0;
  for (;;) {
    try { await pollCommands(); } catch (err) { console.error('poll:', err.message); }
    if (tick % 3 === 0) {
      try { await reportStatus(); } catch (err) { console.error('status:', err.message); }
    }
    tick += 1;
    await new Promise((r) => setTimeout(r, 5000));
  }
}

main();

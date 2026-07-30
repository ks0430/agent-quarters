#!/usr/bin/env node
// AgentDeploy host-agent: runs on every deployed instance (as root, via
// systemd). Pull-only — polls the control plane over HTTPS for commands and
// reports container status. No inbound ports required.
//
// Env: CP_URL (control plane base URL), HOST_TOKEN (this instance's token).
// Plain CommonJS, no dependencies; works on Node 18+ (Ubuntu 24.04 apt node).

const { execFile, spawn } = require('node:child_process');
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
  const merged = { ...(env || {}) };
  // Preserve a locally-injected subscription token across config updates —
  // the control plane never sees it, so regenerated env would drop it.
  if (!merged.CLAUDE_CODE_OAUTH_TOKEN) {
    try {
      const old = await fs.readFile(path.join(dir, 'env.list'), 'utf8');
      const m = old.match(/^CLAUDE_CODE_OAUTH_TOKEN=(.+)$/m);
      if (m) merged.CLAUDE_CODE_OAUTH_TOKEN = m[1];
    } catch { /* no previous env file */ }
  }
  const envLines = Object.entries(merged).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  await fs.writeFile(path.join(dir, 'env.list'), envLines, { mode: 0o600 });
  // Container runs as uid 1001; the mounted home must be writable by it.
  await run('chown', ['-R', `${AGENT_UID}:${AGENT_UID}`, home]);
  return dir;
}

async function startContainer(name, dir) {
  // The agent image builds in the background during bootstrap; wait for it
  // (up to 20 min) so early create-agent commands don't fail on new hosts.
  for (let i = 0; i < 240; i++) {
    const img = await run('docker', ['image', 'inspect', 'agent-base']);
    if (img.ok) break;
    if (i === 239) throw new Error('agent-base image not ready after 20 min - check /var/log/agentdeploy-bootstrap.log');
    if (i % 12 === 0) console.log('waiting for agent-base image build...');
    await sleep(5000);
  }
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

// ---- subscription login relay ----
// `claude setup-token` is an interactive TUI: it needs a pty (we provide one
// via `script`), prints an OAuth URL, waits for the code the user gets from
// claude.com, then emits a long-lived sk-ant-oat01-* token.
const logins = new Map(); // agentName -> { child, output, exited, exitCode }

const stripAnsi = (s) => s.replace(/\x1b\][^\x07]*\x07/g, ' ').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b[78=>]/g, '');

function startLoginSession(name) {
  const prev = logins.get(name);
  if (prev && !prev.exited) { try { prev.child.kill('SIGKILL'); } catch {} }

  const child = spawn('script', ['-qfc',
    `docker exec -it ${containerOf(name)} claude setup-token`, '/dev/null'],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  const session = { child, output: '', exited: false, exitCode: null };
  child.stdout.on('data', (d) => { session.output += d.toString(); });
  child.stderr.on('data', (d) => { session.output += d.toString(); });
  child.on('exit', (code) => { session.exited = true; session.exitCode = code; });
  // Safety: never leave a login session hanging around for more than 15 min.
  setTimeout(() => { if (!session.exited) { try { child.kill('SIGKILL'); } catch {} } }, 15 * 60 * 1000).unref();
  logins.set(name, session);
  return session;
}

function findOauthUrl(raw) {
  // The URL appears inside OSC-8 hyperlink escapes; match the longest hit.
  const matches = raw.match(/https:\/\/(?:claude\.com|claude\.ai)\/[^\s\x07\x1b"']+/g) || [];
  return matches.sort((a, b) => b.length - a.length)[0] || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  // Returns the OAuth URL as the command output; keeps the pty session alive
  // so submit-login-code can feed it the user's code later.
  async 'start-login'({ agentName }) {
    const name = safeName(agentName);
    const state = await run('docker', ['inspect', '--format', '{{.State.Status}}', containerOf(name)]);
    if (!state.ok || state.stdout.trim() !== 'running') {
      throw new Error('agent container is not running - restart it first');
    }
    const session = startLoginSession(name);
    for (let i = 0; i < 90; i++) { // up to 45s for the URL to appear
      await sleep(500);
      const url = findOauthUrl(session.output);
      if (url) return url;
      if (session.exited) break;
    }
    try { session.child.kill('SIGKILL'); } catch {}
    logins.delete(name);
    throw new Error(`setup-token produced no login URL: ${stripAnsi(session.output).slice(-300)}`);
  },

  async 'submit-login-code'({ agentName, code }) {
    const name = safeName(agentName);
    const session = logins.get(name);
    if (!session || session.exited) {
      throw new Error('login session expired - click "Start login" again');
    }
    session.child.stdin.write(String(code).trim() + '\r');
    for (let i = 0; i < 120 && !session.exited; i++) await sleep(500); // up to 60s
    logins.delete(name);
    if (!session.exited) { try { session.child.kill('SIGKILL'); } catch {} }

    const token = (session.output.match(/sk-ant-oat01-[A-Za-z0-9_-]{20,}/g) || []).pop();
    if (token) {
      // Inject the token and recreate the container (docker restart would not
      // re-read env.list; startContainer does rm -f + run).
      const dir = path.join(AGENTS_DIR, name);
      let envText = '';
      try { envText = await fs.readFile(path.join(dir, 'env.list'), 'utf8'); } catch {}
      const lines = envText.split('\n').filter((l) => l && !l.startsWith('CLAUDE_CODE_OAUTH_TOKEN='));
      lines.push(`CLAUDE_CODE_OAUTH_TOKEN=${token}`);
      await fs.writeFile(path.join(dir, 'env.list'), lines.join('\n') + '\n', { mode: 0o600 });
      await startContainer(name, dir);
      return 'logged in, token installed, container restarted';
    }
    // No token in output: check whether the CLI stored credentials in the
    // home volume instead (also acceptable - it persists across restarts).
    const cred = await run('docker', ['exec', containerOf(name), 'test', '-f', '/home/agent/.claude/.credentials.json']);
    if (cred.ok) {
      await run('docker', ['restart', containerOf(name)]);
      return 'logged in via credentials file';
    }
    throw new Error(`login failed: ${stripAnsi(session.output).slice(-300)}`);
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

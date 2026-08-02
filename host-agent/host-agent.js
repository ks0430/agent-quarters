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
const net = require('node:net');
const crypto = require('node:crypto');

const VERSION = 4; // bump on every host-agent change — drives self-update
const BRIDGE_PORT = 9810; // localhost port the agent container publishes its bridge on

const CP_URL = process.env.CP_URL;
const HOST_TOKEN = process.env.HOST_TOKEN;
const AGENTS_DIR = '/opt/agents';
const AGENT_UID = '1001'; // "agent" user inside the container image
const SELF_PATH = process.argv[1]; // /opt/agentdeploy/host-agent.js in prod

if (!CP_URL || !HOST_TOKEN) {
  console.error('CP_URL and HOST_TOKEN are required');
  process.exit(1);
}

// --- minimal WebSocket client (localhost ws:// only, no deps, no TLS) ---
// Enough to talk to cc-connect's bridge: masked client text frames, decode
// server frames (fragmentation + 16/64-bit lengths), auto-pong. The instance
// only has apt Node (no ws package), so we implement the slice we need.
function wsEncode(payload, opcode = 0x1) {
  const mask = crypto.randomBytes(4);
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, 0x80 | len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}
function wsDecode(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10; }
  if (buf.length < off + len) return null;
  return { fin, opcode, payload: buf.slice(off, off + len), rest: buf.slice(off + len) };
}

// Open a bridge WS, register as the "api" platform, send one message, and
// feed reply frames to onReply(msg) until it returns a truthy result.
function bridgeCall({ token, register, message, onReply, timeoutMs = 180000 }) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(BRIDGE_PORT, '127.0.0.1');
    let buf = Buffer.alloc(0);
    let handshaked = false;
    let frag = [];
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('bridge call timed out')); }, timeoutMs);
    const send = (obj) => sock.write(wsEncode(Buffer.from(JSON.stringify(obj))));
    const finish = (fn, arg) => { clearTimeout(timer); try { sock.end(); } catch {} fn(arg); };

    sock.on('connect', () => sock.write(
      `GET /bridge/ws HTTP/1.1\r\nHost: 127.0.0.1:${BRIDGE_PORT}\r\nUpgrade: websocket\r\n` +
      `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
      `Authorization: Bearer ${token}\r\n\r\n`));

    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!handshaked) {
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        const statusLine = buf.slice(0, buf.indexOf('\r\n')).toString();
        if (!statusLine.includes('101')) return finish(reject, new Error(`bridge handshake failed: ${statusLine}`));
        handshaked = true;
        buf = buf.slice(i + 4);
        send(register);
        send(message);
      }
      for (;;) {
        const f = wsDecode(buf);
        if (!f) break;
        buf = f.rest;
        if (f.opcode === 0x9) { sock.write(wsEncode(f.payload, 0xA)); continue; } // ping -> pong
        if (f.opcode === 0x8) return finish(resolve, null); // close
        if (f.opcode === 0x1 || f.opcode === 0x0) {
          frag.push(f.payload);
          if (!f.fin) continue;
          const text = Buffer.concat(frag).toString(); frag = [];
          let msg; try { msg = JSON.parse(text); } catch { continue; }
          let out; try { out = onReply(msg, send); } catch (e) { return finish(reject, e); }
          if (out) return finish(resolve, out);
        }
      }
    });
    sock.on('error', (e) => finish(reject, e));
    sock.on('close', () => clearTimeout(timer));
  });
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

  // Seed agent guides (once): Codex reads AGENTS.md, Claude reads CLAUDE.md
  // at session start — without this, agents don't know how to deliver files
  // back to the user's chat and invent excuses instead.
  const guide = [
    '# Chat bridge (cc-connect)', '',
    "This workspace is bridged to the user's chat (Slack/Telegram) via cc-connect.", '',
    '- Your normal text replies are delivered to the chat automatically.',
    '- To send a FILE to the user: run `cc-connect send --file /absolute/path`',
    '- To send an IMAGE (renders inline): `cc-connect send --image /absolute/path.png`',
    '- Audio/video: `cc-connect send --audio x.mp3` / `cc-connect send --video x.mp4`',
    '- You can repeat --file/--image flags to send several attachments at once.', '',
    '# Installing tools — persistence rules', '',
    'Only your home directory (/home/agent) survives restarts, backups, and',
    'container recreations. System-level installs are wiped without warning.', '',
    '- PREFER user-space installs: `pip install --user`, virtualenvs inside the',
    '  workspace, `npm install` in a project dir, or `npm install -g --prefix ~/.local`',
    '  (~/.local/bin is worth adding to PATH in ~/.bashrc).',
    '- AVOID relying on `apt install` / global system packages: they vanish on the',
    '  next restart. If you must apt-install something, also append the install',
    '  command to ~/workspace/setup.sh so it can be re-run after a restart.', '',
  ].join('\n');
  for (const f of ['AGENTS.md', 'CLAUDE.md']) {
    const p = path.join(home, 'workspace', f);
    try { await fs.access(p); } catch { await fs.writeFile(p, guide); }
  }
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
  // Publish the bridge port to localhost when this agent has API access
  // enabled (config.toml carries a [bridge] block).
  const cfg = await fs.readFile(path.join(dir, 'home', '.cc-connect', 'config.toml'), 'utf8').catch(() => '');
  const portArgs = /\[bridge\]/.test(cfg) ? ['-p', `127.0.0.1:${BRIDGE_PORT}:${BRIDGE_PORT}`] : [];
  const r = await run('docker', ['run', '-d',
    '--name', containerOf(name),
    '--restart', 'unless-stopped',
    '--memory', '1g', '--memory-swap', '2g',
    '--cpus', '1.5', '--pids-limit', '512',
    ...portArgs,
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

function startLoginSession(name, loginCmd, type) {
  const prev = logins.get(name);
  if (prev && !prev.exited) { try { prev.child.kill('SIGKILL'); } catch {} }

  const child = spawn('script', ['-qfc',
    `docker exec -it ${containerOf(name)} ${loginCmd}`, '/dev/null'],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  const session = { child, output: '', exited: false, exitCode: null, type };
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

  // claude: returns the OAuth URL; session stays alive for submit-login-code.
  // codex: returns JSON {url, code} for device auth; the CLI polls OpenAI on
  // its own and the outcome is reported later via the status heartbeat.
  async 'start-login'({ agentName, agentType }) {
    const name = safeName(agentName);
    const state = await run('docker', ['inspect', '--format', '{{.State.Status}}', containerOf(name)]);
    if (!state.ok || state.stdout.trim() !== 'running') {
      throw new Error('agent container is not running - restart it first');
    }

    if (agentType === 'codex') {
      const session = startLoginSession(name, 'codex login --device-auth', 'codex');
      for (let i = 0; i < 90; i++) {
        await sleep(500);
        const clean = stripAnsi(session.output);
        const url = (clean.match(/https:\/\/[^\s]*openai\.com[^\s]*/) || [])[0];
        const code = (clean.match(/\b[A-Z0-9]{4,6}-[A-Z0-9]{4,8}\b/) || [])[0];
        if (url && code) return JSON.stringify({ url, code });
        if (session.exited) break;
      }
      try { session.child.kill('SIGKILL'); } catch {}
      logins.delete(name);
      throw new Error(`device auth produced no code: ${stripAnsi(session.output).slice(-300)}`);
    }

    const session = startLoginSession(name, 'claude setup-token', 'claude');
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

  // Codex device-auth sessions finish on their own; report and clean up.
  const loginResults = [];
  for (const [name, session] of logins) {
    if (session.type !== 'codex' || !session.exited) continue;
    const cred = await run('docker', ['exec', containerOf(name), 'test', '-f', '/home/agent/.codex/auth.json']);
    loginResults.push({ name, state: cred.ok ? 'success' : 'failed' });
    logins.delete(name);
  }

  return api('POST', '/host/status', { agents, logins: loginResults });
}

// ---- self-update ----
// The control plane advertises its current host-agent version in register
// and status responses. When newer: download -> validate -> backup -> atomic
// swap -> clean exit; systemd (Restart=always) brings us back on new code.
let updating = false;
async function selfUpdate(newVersion) {
  if (updating) return;
  updating = true;
  try {
    // Never interrupt an in-flight login relay; retry on a later heartbeat.
    if ([...logins.values()].some((s) => !s.exited)) { updating = false; return; }
    console.log(`self-update: v${VERSION} -> v${newVersion}, downloading`);
    const res = await fetch(`${CP_URL}/dist/host-agent.js`);
    if (!res.ok) throw new Error(`download HTTP ${res.status}`);
    const code = await res.text();
    if (!code.includes('const VERSION')) throw new Error('downloaded file missing version stamp');
    // Temp file keeps the .js extension so `node --check` can parse it as ESM.
    const tmp = SELF_PATH.replace(/\.js$/, '') + '.new.js';
    await fs.writeFile(tmp, code);
    const check = await run('node', ['--check', tmp]);
    if (!check.ok) { await fs.rm(tmp, { force: true }); throw new Error(`validation failed: ${check.stderr.slice(0, 200)}`); }
    await fs.copyFile(SELF_PATH, `${SELF_PATH}.bak`).catch(() => {});
    await fs.rename(tmp, SELF_PATH);
    console.log('self-update installed — restarting');
    process.exit(0);
  } catch (err) {
    console.error('self-update failed (keeping current version):', err.message);
    updating = false;
  }
}

function maybeUpdate(resp) {
  const v = Number(resp && resp.hostAgentVersion);
  if (v && v > VERSION) selfUpdate(v).catch((e) => console.error('self-update:', e.message));
}

// --- Agent API tunnel (long-poll) ---
// Holds a GET open; the control plane responds when a customer API request
// arrives for this instance. We run the message through the local bridge and
// POST the reply back. Runs as its own loop alongside command polling.
async function handleApiRequest(reqObj) {
  const { requestId, bridgeToken, sessionKey, content, stream, model, reasoning } = reqObj;
  const post = (body) => api('POST', '/host/api-response', { requestId, ...body }).catch(() => {});
  const register = { type: 'register', platform: 'api', capabilities: ['text'],
    metadata: { source: 'agentquarters-api' } };
  // Run a slash command on the session and wait for its reply (used to switch
  // model/reasoning before the real message). Agent-wide, cheap, no-op reply.
  const runCommand = (cmd) => bridgeCall({
    token: bridgeToken, register,
    message: { type: 'message', msg_id: `${requestId}-cmd`, session_key: sessionKey,
      user_id: 'api', user_name: 'API', content: cmd, reply_ctx: `${requestId}-cmd` },
    onReply: (msg) => {
      if (msg.type === 'register_ack') return null;
      if (msg.type === 'reply') return { ok: true };
      return null;
    },
    timeoutMs: 30000,
  });
  try {
    if (model) await runCommand(`/model ${model}`);
    if (reasoning) await runCommand(`/reasoning ${reasoning}`);
    const reply = await bridgeCall({
      token: bridgeToken,
      register,
      message: { type: 'message', msg_id: requestId, session_key: sessionKey,
        user_id: 'api', user_name: 'API', content, reply_ctx: requestId },
      onReply: (msg, send) => {
        if (msg.type === 'register_ack') { if (!msg.ok) throw new Error(`register rejected: ${msg.error}`); return null; }
        if (msg.type === 'reply_stream') { if (stream && msg.delta) post({ delta: msg.delta }); return null; }
        if (msg.type === 'reply') return { content: msg.content || '' };
        return null;
      },
    });
    await post({ done: true, content: reply ? reply.content : '' });
  } catch (err) {
    await post({ done: true, error: String(err.message || err).slice(0, 300) });
  }
}

async function apiTunnelLoop() {
  for (;;) {
    try {
      const reqs = await api('GET', '/host/api-requests'); // long-poll (~25s) or []
      for (const r of Array.isArray(reqs) ? reqs : []) handleApiRequest(r); // concurrent
    } catch (err) {
      await new Promise((r) => setTimeout(r, 3000)); // backoff on error/timeout
    }
  }
}

async function main() {
  apiTunnelLoop(); // fire-and-forget; self-healing
  // Register with retry — the control plane must learn we're alive.
  for (;;) {
    try {
      const resp = await api('POST', '/host/register', { version: VERSION });
      console.log(`registered with control plane (host-agent v${VERSION})`);
      maybeUpdate(resp);
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
      try { maybeUpdate(await reportStatus()); } catch (err) { console.error('status:', err.message); }
    }
    tick += 1;
    await new Promise((r) => setTimeout(r, 5000));
  }
}

main();

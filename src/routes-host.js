// API used by the host-agent daemon running on each instance.
// Auth: Bearer <host_token> (unique per instance, minted at deploy time).

import { Router } from 'express';
import db from './db.js';
import { logEvent } from './events.js';

const router = Router();

function hostAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const instance = token && db.prepare('SELECT * FROM instances WHERE host_token = ?').get(token);
  if (!instance || instance.state === 'deleted') {
    return res.status(401).json({ error: 'invalid host token' });
  }
  req.instance = instance;
  db.prepare("UPDATE instances SET last_seen = datetime('now') WHERE id = ?").run(instance.id);
  next();
}

router.use(hostAuth);

// First call after bootstrap: instance is fully set up and polling.
// During resume the poller still owes static-IP reattachment, so let it
// finish (the heartbeat below completes the -> ready transition instead).
router.post('/register', (req, res) => {
  console.log(`host registered: ${req.instance.name} (instance ${req.instance.id})`);
  if (!['resuming', 'pausing'].includes(req.instance.state)) {
    db.prepare("UPDATE instances SET state = 'ready' WHERE id = ?").run(req.instance.id);
  }
  if (req.instance.state !== 'ready') {
    logEvent(req.instance.id, 'ready', 'Server software online — host connected to the control plane');
  }
  res.json({ ok: true, pollSeconds: 5, statusSeconds: 15 });
});

// Host pulls pending commands; they are marked sent so they run once.
router.get('/commands', (req, res) => {
  const rows = db.prepare("SELECT * FROM commands WHERE instance_id = ? AND status = 'pending' ORDER BY id")
    .all(req.instance.id);
  const mark = db.prepare("UPDATE commands SET status = 'sent', updated_at = datetime('now') WHERE id = ?");
  for (const r of rows) mark.run(r.id);
  res.json(rows.map((r) => ({ id: r.id, type: r.type, payload: JSON.parse(r.payload) })));
});

router.post('/commands/:id/result', (req, res) => {
  const cmd = db.prepare('SELECT * FROM commands WHERE id = ? AND instance_id = ?')
    .get(req.params.id, req.instance.id);
  if (!cmd) return res.status(404).json({ error: 'unknown command' });

  const ok = !!req.body.ok;
  const output = String(req.body.output || '').slice(0, 8192);
  db.prepare("UPDATE commands SET status = ?, result = ?, updated_at = datetime('now') WHERE id = ?")
    .run(ok ? 'done' : 'failed', output, cmd.id);

  const { agentName } = JSON.parse(cmd.payload);
  const agent = agentName && db.prepare('SELECT * FROM agents WHERE instance_id = ? AND name = ?')
    .get(req.instance.id, agentName);

  // Reflect command outcomes onto the agent row.
  if (agent && ['create-agent', 'update-agent', 'restart-agent'].includes(cmd.type)) {
    db.prepare('UPDATE agents SET status = ? WHERE id = ?')
      .run(ok ? 'running' : 'error', agent.id);
    logEvent(req.instance.id, ok ? 'agent' : 'error',
      ok ? `Agent container ${cmd.type === 'create-agent' ? 'started' : cmd.type === 'update-agent' ? 'reconfigured and restarted' : 'restarted'}`
         : `Agent ${cmd.type} failed: ${output.slice(0, 150)}`);
  }
  if (agent && cmd.type === 'start-login') {
    // Output: plain OAuth URL (claude) or JSON {url, code} (codex device auth).
    let url = null; let loginCode = null;
    if (ok) {
      if (output.trim().startsWith('{')) {
        try { ({ url, code: loginCode } = JSON.parse(output)); } catch { /* fall through */ }
      } else if (/^https:\/\//.test(output.trim())) {
        url = output.trim();
      }
    }
    if (url) {
      db.prepare("UPDATE agents SET login_state = 'awaiting_code', login_url = ?, login_code = ? WHERE id = ?")
        .run(url, loginCode, agent.id);
      logEvent(req.instance.id, 'login', 'Login link generated — waiting for user approval');
    } else {
      db.prepare("UPDATE agents SET login_state = 'failed', login_url = NULL, login_code = NULL WHERE id = ?")
        .run(agent.id);
      logEvent(req.instance.id, 'error', `Login start failed: ${output.slice(0, 150)}`);
    }
  }
  if (agent && cmd.type === 'submit-login-code') {
    db.prepare('UPDATE agents SET login_state = ?, login_url = NULL WHERE id = ?')
      .run(ok ? 'logged_in' : 'failed', agent.id);
    logEvent(req.instance.id, ok ? 'login' : 'error',
      ok ? 'Logged in — subscription credentials installed' : `Login failed: ${output.slice(0, 150)}`);
  }
  res.json({ ok: true });
});

// Bootstrap failure report: surfaces the on-instance error on the dashboard.
router.post('/bootstrap-error', (req, res) => {
  const message = String(req.body.message || 'bootstrap failed').slice(0, 500);
  console.error(`bootstrap error on ${req.instance.name}: ${message}`);
  db.prepare('UPDATE instances SET error = ? WHERE id = ?').run(message, req.instance.id);
  logEvent(req.instance.id, 'error', message.slice(0, 300));
  res.json({ ok: true });
});

// Periodic heartbeat: container states + recent logs for every agent on host.
// Also carries async login-session outcomes (codex device auth completes on
// its own when the user approves, with no further command round-trip).
router.post('/status', (req, res) => {
  // A heartbeat proves the host is alive — complete any pending transition
  // (e.g. resume flows where registration raced the static-IP reattach).
  if (req.instance.state === 'bootstrapping') {
    db.prepare("UPDATE instances SET state = 'ready' WHERE id = ?").run(req.instance.id);
  }
  for (const l of Array.isArray(req.body.logins) ? req.body.logins : []) {
    const agent = db.prepare('SELECT * FROM agents WHERE instance_id = ? AND name = ?')
      .get(req.instance.id, String(l.name || ''));
    if (!agent || agent.login_state === 'logged_in') continue;
    if (l.state === 'success') {
      db.prepare("UPDATE agents SET login_state = 'logged_in', login_url = NULL, login_code = NULL WHERE id = ?")
        .run(agent.id);
      logEvent(req.instance.id, 'login', 'Logged in — subscription credentials installed');
    } else if (l.state === 'failed') {
      db.prepare("UPDATE agents SET login_state = 'failed', login_url = NULL, login_code = NULL WHERE id = ?")
        .run(agent.id);
      logEvent(req.instance.id, 'error', 'Device login failed or expired — start again from the dashboard');
    }
  }
  const list = Array.isArray(req.body.agents) ? req.body.agents : [];
  const get = db.prepare('SELECT * FROM agents WHERE instance_id = ? AND name = ?');
  const set = db.prepare('UPDATE agents SET status = ?, last_logs = ? WHERE id = ?');
  for (const a of list) {
    const agent = get.get(req.instance.id, String(a.name || ''));
    if (!agent || agent.status === 'deleted' || agent.status === 'pending') continue;
    const status = a.state === 'running' ? 'running'
      : a.state === 'exited' ? 'stopped'
      : a.state === 'missing' ? 'error' : String(a.state || 'unknown').slice(0, 20);
    set.run(status, String(a.logs || '').slice(0, 8192), agent.id);
  }
  res.json({ ok: true });
});

export default router;

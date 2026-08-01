// User-facing API: auth, one-click deploy, agent management.

import crypto from 'node:crypto';
import { Router } from 'express';
import db from './db.js';
import {
  hashPassword, verifyPassword, createSession, destroySession,
  setSessionCookie, clearSessionCookie, requireUser,
} from './auth.js';
import { generateConfig, generateEnv, validateAgentSpec } from './configgen.js';
import { instanceUsage } from './usage.js';
import {
  chargeInstance, teardownInstance, MIN_DEPLOY_BALANCE_CENTS, RATE_CENTS_HOUR,
} from './billing.js';
import { logEvent, getEvents } from './events.js';
import { getProvider, REGIONS } from './provider.js';
import { buildUserData } from './bootstrap.js';

const router = Router();
const BUNDLE_ID = process.env.BUNDLE_ID || 'small_3_0';
const MAX_INSTANCES = parseInt(process.env.MAX_INSTANCES_PER_USER || '3', 10);

// ---------- auth ----------

router.post('/signup', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'invalid email' });
  if (password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
  try {
    const info = db.prepare('INSERT INTO users (email, pass_hash) VALUES (?, ?)')
      .run(email, hashPassword(password));
    setSessionCookie(res, createSession(info.lastInsertRowid));
    res.json({ ok: true, email });
  } catch {
    res.status(409).json({ error: 'email already registered' });
  }
});

router.post('/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !verifyPassword(String(req.body.password || ''), user.pass_hash)) {
    return res.status(401).json({ error: 'wrong email or password' });
  }
  setSessionCookie(res, createSession(user.id));
  res.json({ ok: true, email });
});

router.post('/logout', (req, res) => {
  if (req.sessionToken) destroySession(req.sessionToken);
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  res.json(req.user ? { email: req.user.email } : {});
});

// ---------- metadata ----------

router.get('/meta', (_req, res) => {
  res.json({ regions: REGIONS, bundle: BUNDLE_ID, maxInstances: MAX_INSTANCES });
});

// ---------- step 1: deploy a server (region only) ----------

router.post('/deploy', requireUser, async (req, res) => {
  const region = String(req.body.region || '');
  if (!REGIONS.some((r) => r.id === region)) return res.status(400).json({ error: 'invalid region' });

  const account = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const count = db.prepare("SELECT COUNT(*) n FROM instances WHERE user_id = ? AND state != 'deleted'")
    .get(req.user.id).n;

  const planLimit = account.plan === 'multi' ? 5 : 1;
  if (count >= Math.min(planLimit, MAX_INSTANCES)) {
    return res.status(403).json({
      error: account.plan === 'multi'
        ? `server limit reached (${Math.min(planLimit, MAX_INSTANCES)})`
        : 'free accounts run 1 server — subscribe to Multi in Settings for up to 5',
    });
  }
  if (account.balance_cents < MIN_DEPLOY_BALANCE_CENTS) {
    return res.status(402).json({
      error: `insufficient credits — top up in Settings (servers cost $${(RATE_CENTS_HOUR * 24 / 100).toFixed(2)}/day)`,
    });
  }

  if (!process.env.BASE_URL && !process.env.MOCK_PROVIDER) {
    return res.status(500).json({ error: 'server misconfigured: BASE_URL not set' });
  }

  const instanceName = `ad-${crypto.randomBytes(3).toString('hex')}`;
  const hostToken = crypto.randomBytes(32).toString('hex');
  const userData = buildUserData({ baseUrl: process.env.BASE_URL || 'http://localhost:3000', hostToken });

  // Static IP opt-in: record intent now; the poller allocates+attaches once
  // the VM is running (Lightsail can't attach at create time).
  const staticIpName = req.body.staticIp ? `ip-${instanceName}` : null;

  const instInfo = db.prepare(`INSERT INTO instances (user_id, name, region, bundle, host_token, static_ip_name)
    VALUES (?, ?, ?, ?, ?, ?)`).run(req.user.id, instanceName, region, BUNDLE_ID, hostToken, staticIpName);
  const instanceId = instInfo.lastInsertRowid;

  try {
    await getProvider().createInstance({ name: instanceName, region, bundleId: BUNDLE_ID, userData });
  } catch (err) {
    db.prepare("UPDATE instances SET state = 'error', error = ? WHERE id = ?")
      .run(String(err.message || err).slice(0, 500), instanceId);
    return res.status(502).json({ error: `cloud provider error: ${err.message || err}` });
  }

  console.log(`deployed ${instanceName} in ${region} for ${req.user.email}`);
  logEvent(instanceId, 'deploy', `Server requested in ${region} (${BUNDLE_ID}${staticIpName ? ', with static IP' : ''})`);
  res.json({ ok: true, instanceId });
});

// ---------- step 2: set up the agent on a deployed server ----------
// Can be called while the server is still provisioning: the create-agent
// command queues and runs as soon as the host-agent comes online.

router.post('/instances/:id/agent', requireUser, (req, res) => {
  const inst = ownedInstance(req, res);
  if (!inst) return;
  if (db.prepare("SELECT COUNT(*) n FROM agents WHERE instance_id = ? AND status != 'deleted'").get(inst.id).n > 0) {
    return res.status(409).json({ error: 'this server already has an agent' });
  }

  const spec = {
    name: String(req.body.name || 'agent').trim().toLowerCase(),
    agentType: req.body.agentType,
    authMethod: req.body.authMethod || 'subscription',
    model: req.body.model ? String(req.body.model).trim() : null,
    mode: req.body.mode,
    apiKey: String(req.body.apiKey || '').trim(),
    platform: req.body.platform || 'none',
    platformConfig: req.body.platformConfig || {},
  };
  const errors = validateAgentSpec(spec);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });

  const configToml = generateConfig(spec);
  const env = generateEnv(spec);
  db.prepare(`INSERT INTO agents (instance_id, name, agent_type, model, platform, config_toml, env_json, auth_method, login_state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(inst.id, spec.name, spec.agentType, spec.model, spec.platform, configToml, JSON.stringify(env),
      spec.authMethod, spec.authMethod === 'subscription' ? 'needs_login' : null);
  db.prepare('INSERT INTO commands (instance_id, type, payload) VALUES (?, ?, ?)')
    .run(inst.id, 'create-agent', JSON.stringify({ agentName: spec.name, configToml, env }));

  logEvent(inst.id, 'agent', `Agent "${spec.name}" (${spec.agentType}, ${spec.authMethod}) installation queued`);
  res.json({ ok: true });
});

// ---------- instances & agents ----------

function ownedInstance(req, res) {
  const inst = db.prepare('SELECT * FROM instances WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!inst || inst.state === 'deleted') {
    res.status(404).json({ error: 'not found' });
    return null;
  }
  return inst;
}

function ownedAgent(req, res) {
  const agent = db.prepare(`SELECT a.*, i.user_id, i.state AS instance_state, i.region, i.id AS iid
    FROM agents a JOIN instances i ON i.id = a.instance_id WHERE a.id = ?`).get(req.params.id);
  if (!agent || agent.user_id !== req.user.id || agent.status === 'deleted') {
    res.status(404).json({ error: 'not found' });
    return null;
  }
  return agent;
}

router.get('/instances', requireUser, (req, res) => {
  const instances = db.prepare(
    "SELECT id, name, region, bundle, state, public_ip, static_ip, static_ip_name, paused_at, last_seen, error, created_at FROM instances WHERE user_id = ? AND state != 'deleted' ORDER BY id DESC"
  ).all(req.user.id);
  const agentsFor = db.prepare(
    "SELECT id, name, agent_type, model, platform, status, auth_method, login_state, created_at FROM agents WHERE instance_id = ? AND status != 'deleted'"
  );
  res.json(instances.map((i) => ({ ...i, agents: agentsFor.all(i.id) })));
});

// Update agent config (add/change platform, model, mode; blank apiKey keeps existing).
router.post('/agents/:id/config', requireUser, (req, res) => {
  const agent = ownedAgent(req, res);
  if (!agent) return;

  const existingEnv = JSON.parse(agent.env_json);
  const existingKey = existingEnv.ANTHROPIC_API_KEY || existingEnv.OPENAI_API_KEY || '';
  const spec = {
    name: agent.name,
    agentType: req.body.agentType || agent.agent_type,
    authMethod: agent.auth_method, // fixed at setup; login state must survive edits
    model: req.body.model !== undefined ? (req.body.model || null) : agent.model,
    mode: req.body.mode,
    apiKey: String(req.body.apiKey || '').trim() || existingKey,
    platform: req.body.platform || agent.platform,
    platformConfig: req.body.platformConfig || {},
  };
  const errors = validateAgentSpec(spec);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });

  const configToml = generateConfig(spec);
  const env = generateEnv(spec);
  db.prepare('UPDATE agents SET agent_type = ?, model = ?, platform = ?, config_toml = ?, env_json = ? WHERE id = ?')
    .run(spec.agentType, spec.model, spec.platform, configToml, JSON.stringify(env), agent.id);
  db.prepare('INSERT INTO commands (instance_id, type, payload) VALUES (?, ?, ?)')
    .run(agent.iid, 'update-agent', JSON.stringify({ agentName: agent.name, configToml, env }));
  logEvent(agent.iid, 'agent', `Configuration updated (platform: ${spec.platform}, mode: ${spec.mode || 'default'})`);
  res.json({ ok: true });
});

// ---------- subscription login relay ----------
// start: runs `claude setup-token` inside the agent's container (via the
// host-agent) and captures the OAuth URL for the user to open.
router.post('/agents/:id/login/start', requireUser, (req, res) => {
  const agent = ownedAgent(req, res);
  if (!agent) return;
  if (agent.auth_method !== 'subscription') {
    return res.status(400).json({ error: 'agent does not use subscription login' });
  }
  db.prepare("UPDATE agents SET login_state = 'starting', login_url = NULL, login_code = NULL WHERE id = ?").run(agent.id);
  db.prepare('INSERT INTO commands (instance_id, type, payload) VALUES (?, ?, ?)')
    .run(agent.iid, 'start-login', JSON.stringify({ agentName: agent.name, agentType: agent.agent_type }));
  logEvent(agent.iid, 'login', `Subscription login started (${agent.agent_type === 'codex' ? 'ChatGPT device auth' : 'Claude OAuth'})`);
  res.json({ ok: true });
});

// code: forwards the code the user got from claude.com back into the CLI.
router.post('/agents/:id/login/code', requireUser, (req, res) => {
  const agent = ownedAgent(req, res);
  if (!agent) return;
  const code = String(req.body.code || '').trim();
  if (!code || code.length > 500) return res.status(400).json({ error: 'invalid code' });
  db.prepare("UPDATE agents SET login_state = 'verifying' WHERE id = ?").run(agent.id);
  db.prepare('INSERT INTO commands (instance_id, type, payload) VALUES (?, ?, ?)')
    .run(agent.iid, 'submit-login-code', JSON.stringify({ agentName: agent.name, code }));
  res.json({ ok: true });
});

router.get('/agents/:id/login', requireUser, (req, res) => {
  const agent = ownedAgent(req, res);
  if (!agent) return;
  res.json({ state: agent.login_state, url: agent.login_url, code: agent.login_code, agentType: agent.agent_type });
});

router.post('/agents/:id/restart', requireUser, (req, res) => {
  const agent = ownedAgent(req, res);
  if (!agent) return;
  db.prepare('INSERT INTO commands (instance_id, type, payload) VALUES (?, ?, ?)')
    .run(agent.iid, 'restart-agent', JSON.stringify({ agentName: agent.name }));
  res.json({ ok: true });
});

router.get('/agents/:id/logs', requireUser, (req, res) => {
  const agent = ownedAgent(req, res);
  if (!agent) return;
  res.json({ logs: agent.last_logs || '', status: agent.status });
});

router.delete('/instances/:id', requireUser, async (req, res) => {
  const inst = ownedInstance(req, res);
  if (!inst) return;
  logEvent(inst.id, 'delete', 'Deletion requested by user');
  await teardownInstance(inst); // VM + snapshot + static IP, tolerant of absences
  res.json({ ok: true });
});

// ---------- pause / resume (snapshot-based) ----------

router.post('/instances/:id/pause', requireUser, async (req, res) => {
  const inst = ownedInstance(req, res);
  if (!inst) return;
  if (inst.state !== 'ready') {
    return res.status(400).json({ error: `can only pause a ready server (state: ${inst.state})` });
  }
  const snapshotName = `snap-${inst.name}`;
  try { chargeInstance(inst); } catch (err) { console.error('pause charge:', err.message); }
  try {
    await getProvider().createSnapshot(inst.name, snapshotName, inst.region);
  } catch (err) {
    return res.status(502).json({ error: `snapshot failed: ${err.message || err}` });
  }
  db.prepare("UPDATE instances SET state = 'pausing', snapshot_name = ? WHERE id = ?")
    .run(snapshotName, inst.id);
  console.log(`pausing ${inst.name} (snapshot ${snapshotName})`);
  logEvent(inst.id, 'pause', 'Pause requested — snapshotting the server (usually 2-5 min)');
  res.json({ ok: true });
});

router.post('/instances/:id/resume', requireUser, async (req, res) => {
  const inst = ownedInstance(req, res);
  if (!inst) return;
  if (inst.state !== 'paused') {
    return res.status(400).json({ error: `server is not paused (state: ${inst.state})` });
  }
  const account = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (account.balance_cents < MIN_DEPLOY_BALANCE_CENTS) {
    return res.status(402).json({ error: 'insufficient credits to resume — top up in Settings' });
  }
  try {
    await getProvider().createFromSnapshot({
      name: inst.name, region: inst.region, bundleId: inst.bundle, snapshotName: inst.snapshot_name,
    });
  } catch (err) {
    return res.status(502).json({ error: `restore failed: ${err.message || err}` });
  }
  db.prepare("UPDATE instances SET state = 'resuming', paused_at = NULL WHERE id = ?").run(inst.id);
  console.log(`resuming ${inst.name} from ${inst.snapshot_name}`);
  logEvent(inst.id, 'resume', 'Resume requested — restoring server from snapshot (usually ~3 min)');
  res.json({ ok: true });
});

// Activity timeline for the Details panel.
router.get('/instances/:id/events', requireUser, (req, res) => {
  const inst = ownedInstance(req, res);
  if (!inst) return;
  res.json({ events: getEvents(inst.id) });
});

// ---------- per-user usage (shown on the settings page) ----------

router.get('/usage', requireUser, (req, res) => {
  const instances = db.prepare(`
    SELECT i.*,
      (SELECT COUNT(*) FROM agents a WHERE a.instance_id = i.id AND a.status != 'deleted') AS agent_count
    FROM instances i WHERE i.user_id = ?
    ORDER BY (i.deleted_at IS NULL) DESC, i.id DESC`).all(req.user.id);

  const rows = instances.map((i) => ({
    name: i.name,
    region: i.region,
    bundle: i.bundle,
    state: i.state,
    agents: i.agent_count,
    created_at: i.created_at,
    deleted_at: i.deleted_at,
    ...instanceUsage(i),
  }));

  res.json({
    summary: {
      activeInstances: rows.filter((r) => r.running).length,
      monthlyRunRate: rows.reduce((s, r) => s + r.monthlyRate, 0),
      costThisMonth: +rows.reduce((s, r) => s + r.costThisMonth, 0).toFixed(2),
      costAllTime: +rows.reduce((s, r) => s + r.costTotal, 0).toFixed(2),
    },
    instances: rows,
  });
});

// ---------- internal cost accounting (admin only) ----------

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').toLowerCase()
  .split(',').map((s) => s.trim()).filter(Boolean);

function requireAdmin(req, res, next) {
  if (!req.user || !ADMIN_EMAILS.includes(req.user.email)) {
    return res.status(404).json({ error: 'not found' }); // don't reveal the endpoint
  }
  next();
}

router.get('/admin/usage', requireUser, requireAdmin, (_req, res) => {
  const instances = db.prepare(`
    SELECT i.*, u.email,
      (SELECT COUNT(*) FROM agents a WHERE a.instance_id = i.id AND a.status != 'deleted') AS agent_count
    FROM instances i JOIN users u ON u.id = i.user_id
    ORDER BY (i.deleted_at IS NULL) DESC, i.id DESC`).all();

  const rows = instances.map((i) => ({
    name: i.name,
    email: i.email,
    region: i.region,
    bundle: i.bundle,
    state: i.state,
    agents: i.agent_count,
    created_at: i.created_at,
    deleted_at: i.deleted_at,
    ...instanceUsage(i),
  }));

  const byUser = {};
  for (const r of rows) {
    byUser[r.email] ??= { email: r.email, active: 0, monthlyRate: 0, costThisMonth: 0, costTotal: 0 };
    const u = byUser[r.email];
    if (r.running) u.active += 1;
    u.monthlyRate += r.monthlyRate;
    u.costThisMonth = +(u.costThisMonth + r.costThisMonth).toFixed(2);
    u.costTotal = +(u.costTotal + r.costTotal).toFixed(2);
  }

  const summary = {
    activeInstances: rows.filter((r) => r.running).length,
    monthlyRunRate: rows.reduce((s, r) => s + r.monthlyRate, 0),
    costThisMonth: +rows.reduce((s, r) => s + r.costThisMonth, 0).toFixed(2),
    costAllTime: +rows.reduce((s, r) => s + r.costTotal, 0).toFixed(2),
  };

  res.json({ summary, users: Object.values(byUser), instances: rows });
});

export default router;

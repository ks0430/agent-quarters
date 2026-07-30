// User-facing API: auth, one-click deploy, agent management.

import crypto from 'node:crypto';
import { Router } from 'express';
import db from './db.js';
import {
  hashPassword, verifyPassword, createSession, destroySession,
  setSessionCookie, clearSessionCookie, requireUser,
} from './auth.js';
import { generateConfig, generateEnv, validateAgentSpec } from './configgen.js';
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

// ---------- deploy (the one-click flow) ----------
// Creates the instance AND queues the agent setup in a single call. The
// create-agent command sits queued until the host-agent registers and polls.

router.post('/deploy', requireUser, async (req, res) => {
  const region = String(req.body.region || '');
  if (!REGIONS.some((r) => r.id === region)) return res.status(400).json({ error: 'invalid region' });

  const count = db.prepare("SELECT COUNT(*) n FROM instances WHERE user_id = ? AND state != 'deleted'")
    .get(req.user.id).n;
  if (count >= MAX_INSTANCES) {
    return res.status(403).json({ error: `instance limit reached (${MAX_INSTANCES})` });
  }

  const spec = {
    name: String(req.body.name || '').trim().toLowerCase(),
    agentType: req.body.agentType,
    model: req.body.model ? String(req.body.model).trim() : null,
    mode: req.body.mode,
    apiKey: String(req.body.apiKey || '').trim(),
    platform: req.body.platform || 'none',
    platformConfig: req.body.platformConfig || {},
  };
  const errors = validateAgentSpec(spec);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });

  if (!process.env.BASE_URL && !process.env.MOCK_PROVIDER) {
    return res.status(500).json({ error: 'server misconfigured: BASE_URL not set' });
  }

  const instanceName = `ad-${crypto.randomBytes(3).toString('hex')}`;
  const hostToken = crypto.randomBytes(32).toString('hex');
  const userData = buildUserData({ baseUrl: process.env.BASE_URL || 'http://localhost:3000', hostToken });

  const instInfo = db.prepare(`INSERT INTO instances (user_id, name, region, bundle, host_token)
    VALUES (?, ?, ?, ?, ?)`).run(req.user.id, instanceName, region, BUNDLE_ID, hostToken);
  const instanceId = instInfo.lastInsertRowid;

  const configToml = generateConfig(spec);
  const env = generateEnv(spec);
  db.prepare(`INSERT INTO agents (instance_id, name, agent_type, model, platform, config_toml, env_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(instanceId, spec.name, spec.agentType, spec.model, spec.platform, configToml, JSON.stringify(env));

  db.prepare('INSERT INTO commands (instance_id, type, payload) VALUES (?, ?, ?)')
    .run(instanceId, 'create-agent', JSON.stringify({ agentName: spec.name, configToml, env }));

  try {
    await getProvider().createInstance({ name: instanceName, region, bundleId: BUNDLE_ID, userData });
  } catch (err) {
    db.prepare("UPDATE instances SET state = 'error', error = ? WHERE id = ?")
      .run(String(err.message || err).slice(0, 500), instanceId);
    return res.status(502).json({ error: `cloud provider error: ${err.message || err}` });
  }

  res.json({ ok: true, instanceId });
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
    "SELECT id, name, region, bundle, state, public_ip, last_seen, error, created_at FROM instances WHERE user_id = ? AND state != 'deleted' ORDER BY id DESC"
  ).all(req.user.id);
  const agentsFor = db.prepare(
    "SELECT id, name, agent_type, model, platform, status, created_at FROM agents WHERE instance_id = ? AND status != 'deleted'"
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
  res.json({ ok: true });
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
  try {
    await getProvider().deleteInstance(inst.name, inst.region);
  } catch (err) {
    // Instance may already be gone on the provider side; proceed either way.
    console.error(`deleteInstance ${inst.name}:`, err.message || err);
  }
  db.prepare("UPDATE instances SET state = 'deleted' WHERE id = ?").run(inst.id);
  db.prepare("UPDATE agents SET status = 'deleted' WHERE instance_id = ?").run(inst.id);
  res.json({ ok: true });
});

export default router;

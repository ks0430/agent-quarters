// API used by the host-agent daemon running on each instance.
// Auth: Bearer <host_token> (unique per instance, minted at deploy time).

import { Router } from 'express';
import db from './db.js';

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
router.post('/register', (req, res) => {
  db.prepare("UPDATE instances SET state = 'ready' WHERE id = ?").run(req.instance.id);
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

  // Reflect create/update results onto the agent row.
  if (['create-agent', 'update-agent', 'restart-agent'].includes(cmd.type)) {
    const { agentName } = JSON.parse(cmd.payload);
    const agent = db.prepare('SELECT * FROM agents WHERE instance_id = ? AND name = ?')
      .get(req.instance.id, agentName);
    if (agent) {
      db.prepare('UPDATE agents SET status = ? WHERE id = ?')
        .run(ok ? 'running' : 'error', agent.id);
    }
  }
  res.json({ ok: true });
});

// Periodic heartbeat: container states + recent logs for every agent on host.
router.post('/status', (req, res) => {
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

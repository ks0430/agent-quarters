// Public Agent API: customers call their deployed agent over HTTP with a
// per-agent API key. Requests are relayed to the instance via the long-poll
// tunnel (apihub) and answered by cc-connect's bridge.

import crypto from 'node:crypto';
import { Router } from 'express';
import db from './db.js';
import { enqueueRequest } from './apihub.js';

const router = Router();

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Resolve `Authorization: Bearer aq_...` to an agent + live instance.
function apiKeyAuth(req, res, next) {
  const key = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!key.startsWith('aq_')) return res.status(401).json({ error: 'missing or invalid API key' });
  const row = db.prepare(`
    SELECT k.id AS key_id, a.*, i.id AS instance_id, i.state AS instance_state, i.bundle
    FROM api_keys k JOIN agents a ON a.id = k.agent_id JOIN instances i ON i.id = a.instance_id
    WHERE k.key_hash = ? AND k.revoked_at IS NULL`).get(sha256(key));
  if (!row) return res.status(401).json({ error: 'invalid or revoked API key' });
  if (!row.api_enabled || !row.bridge_token) return res.status(409).json({ error: 'API access is disabled for this agent' });
  if (row.instance_state === 'paused' || row.instance_state === 'pausing') {
    return res.status(409).json({ error: 'agent server is paused — resume it to use the API' });
  }
  if (row.instance_state !== 'ready') return res.status(503).json({ error: `agent not ready (state: ${row.instance_state})` });
  db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(row.key_id);
  req.agent = row;
  next();
}

router.get('/agents/:id', apiKeyAuth, (req, res) => {
  const a = req.agent;
  res.json({ id: a.id, name: a.name, type: a.agent_type, model: a.model, mode: a.mode, state: a.instance_state });
});

router.post('/agents/:id/messages', apiKeyAuth, (req, res) => {
  const a = req.agent;
  const content = String(req.body.message || '').trim();
  if (!content) return res.status(400).json({ error: 'message is required' });
  if (content.length > 32000) return res.status(400).json({ error: 'message too long (max 32000 chars)' });
  const stream = req.body.stream === true || req.query.stream === 'true';
  // stateless=true: each call is fully isolated in a throwaway session that is
  // deleted after replying (no memory, no accumulation). Otherwise the named
  // session persists and accumulates context across calls.
  const stateless = req.body.stateless === true;
  const session = stateless
    ? `eph-${crypto.randomBytes(6).toString('hex')}`
    : (String(req.body.session || 'default').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 60) || 'default');
  const sessionKey = `api:${session}:${a.id}`;
  // Optional per-request model / reasoning switch (agent-wide, applied before
  // the message). Whitelisted charset since it becomes a slash command.
  const model = req.body.model ? String(req.body.model).replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 60) : null;
  const reasoning = ['minimal', 'low', 'medium', 'high', 'xhigh'].includes(req.body.reasoning) ? req.body.reasoning : null;

  const payload = { bridgeToken: a.bridge_token, sessionKey, content, stream, model, reasoning, cleanup: stateless };
  const started = Date.now();

  if (stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const sse = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    sse('status', { state: 'working' });
    enqueueRequest(a.instance_id, payload, {
      onDelta: (delta) => sse('delta', { text: delta }),
      resolve: (text) => { sse('done', { reply: text, session, duration_ms: Date.now() - started }); res.end(); },
      reject: (err) => { sse('error', { error: err.message }); res.end(); },
    });
    return;
  }

  enqueueRequest(a.instance_id, payload, {
    resolve: (text) => res.json({ reply: text, session, agent: a.name, duration_ms: Date.now() - started }),
    reject: (err) => res.status(504).json({ error: err.message }),
  });
});

export default router;

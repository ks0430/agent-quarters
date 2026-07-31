import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import db from './db.js';
import { sessionMiddleware } from './auth.js';
import apiRoutes from './routes-api.js';
import hostRoutes from './routes-host.js';
import billingRoutes, { handleStripeWebhook } from './routes-billing.js';
import { startBilling } from './billing.js';
import { getProvider } from './provider.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const app = express();

// Stripe webhook needs the raw body for signature verification — mount
// before the json parser.
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), handleStripeWebhook);

app.use(express.json({ limit: '512kb' }));
app.use(sessionMiddleware);

app.use('/api', apiRoutes);
app.use('/api/billing', billingRoutes);
app.use('/host', hostRoutes);

// Internal support/debug endpoint: agent states + logs, gated by a token
// that lives only in the host env (for operator tooling, not end users).
app.get('/internal/debug/agents', (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!process.env.INTERNAL_DEBUG_TOKEN || token !== process.env.INTERNAL_DEBUG_TOKEN) {
    return res.status(404).end();
  }
  const rows = db.prepare(`
    SELECT a.id, a.name, a.agent_type, a.platform, a.status, a.auth_method, a.login_state,
           a.last_logs, i.name AS instance, i.state AS instance_state, i.last_seen, i.public_ip
    FROM agents a JOIN instances i ON i.id = a.instance_id
    WHERE a.status != 'deleted' ORDER BY a.id DESC`).all();
  res.json(rows);
});

// Files fetched by instance bootstrap scripts.
app.get('/dist/host-agent.js', (_req, res) => res.sendFile(path.join(root, 'host-agent', 'host-agent.js')));
app.get('/dist/Dockerfile', (_req, res) => res.sendFile(path.join(root, 'agent-image', 'Dockerfile')));

// no-cache = browsers must revalidate (304 when unchanged), so UI updates
// show up on plain reload instead of requiring a hard refresh.
app.use(express.static(path.join(root, 'public'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

// Background poller: move instances provisioning -> bootstrapping once the VM
// is running (the final -> ready transition happens when host-agent registers).
async function pollProvisioning() {
  const rows = db.prepare(
    "SELECT * FROM instances WHERE state = 'provisioning' AND created_at > datetime('now', '-1 hour')"
  ).all();
  for (const inst of rows) {
    try {
      const info = await getProvider().getInstance(inst.name, inst.region);
      if (info.state === 'running') {
        db.prepare("UPDATE instances SET state = 'bootstrapping', public_ip = ? WHERE id = ?")
          .run(info.publicIp, inst.id);
      }
    } catch (err) {
      console.error(`poll ${inst.name}:`, err.message || err);
    }
  }
  // Anything provisioning for >1h without progress is stuck.
  db.prepare(
    "UPDATE instances SET state = 'error', error = 'provisioning timed out' WHERE state = 'provisioning' AND created_at <= datetime('now', '-1 hour')"
  ).run();
}
setInterval(pollProvisioning, 20000);
if (!process.env.DISABLE_BILLING_CRON) startBilling();

const port = parseInt(process.env.PORT || '3000', 10);
app.listen(port, () => {
  console.log(`AgentDeploy control plane on :${port}`);
  if (process.env.MOCK_PROVIDER) console.log('MOCK_PROVIDER enabled — no real cloud calls');
  else if (!process.env.BASE_URL) console.warn('WARNING: BASE_URL not set; deploys will fail');
});

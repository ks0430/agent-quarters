import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import db from './db.js';
import { sessionMiddleware } from './auth.js';
import apiRoutes from './routes-api.js';
import hostRoutes from './routes-host.js';
import billingRoutes, { handleStripeWebhook } from './routes-billing.js';
import agentApiRoutes from './routes-agentapi.js';
import { startBilling } from './billing.js';
import { getProvider } from './provider.js';
import { logEvent } from './events.js';
import { migratePlaintext, encryptionEnabled } from './secrets.js';
import { startBackups } from './backup.js';

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
app.use('/v1', agentApiRoutes); // public Agent API (per-agent key auth)
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
           a.api_enabled, a.health, a.health_at,
           a.last_logs, i.id AS instance_id, i.name AS instance, i.state AS instance_state, i.last_seen, i.public_ip
    FROM agents a JOIN instances i ON i.id = a.instance_id
    WHERE a.status != 'deleted' ORDER BY a.id DESC`).all();
  const recentCmds = db.prepare(
    "SELECT id, instance_id, type, status, substr(COALESCE(result,''),0,120) AS result, created_at, updated_at FROM commands ORDER BY id DESC LIMIT 12"
  ).all();
  res.json({ agents: rows, recentCommands: recentCmds });
});

// Files fetched by instance bootstrap scripts.
app.get('/dist/host-agent.js', (_req, res) => res.sendFile(path.join(root, 'host-agent', 'host-agent.js')));
app.get('/dist/Dockerfile', (_req, res) => res.sendFile(path.join(root, 'agent-image', 'Dockerfile')));

// no-cache = browsers must revalidate (304 when unchanged), so UI updates
// show up on plain reload instead of requiring a hard refresh.
app.use(express.static(path.join(root, 'public'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

// Background poller drives the instance state machine:
//   provisioning/resuming -> (VM running, attach static IP) -> bootstrapping
//   bootstrapping -> ready happens when the host-agent registers
//   pausing -> (snapshot available, delete VM) -> paused
async function attachStaticIpIfWanted(inst) {
  if (!inst.static_ip_name) return null;
  const provider = getProvider();
  const ip = await provider.allocateStaticIp(inst.static_ip_name, inst.region); // idempotent-ish: reuse if exists
  await provider.attachStaticIp(inst.static_ip_name, inst.name, inst.region);
  db.prepare('UPDATE instances SET static_ip = ?, public_ip = ? WHERE id = ?').run(ip, ip, inst.id);
  return ip;
}

async function pollInstances() {
  const provider = getProvider();
  const rows = db.prepare(
    "SELECT * FROM instances WHERE state IN ('provisioning', 'resuming', 'pausing')"
  ).all();

  for (const inst of rows) {
    try {
      if (inst.state === 'provisioning' || inst.state === 'resuming') {
        const info = await provider.getInstance(inst.name, inst.region);
        if (info.state !== 'running') continue;
        let ip = info.publicIp;
        logEvent(inst.id, 'vm', `Virtual machine is ${inst.state === 'resuming' ? 'restored and ' : ''}running (${ip})`);
        try {
          const staticIp = await attachStaticIpIfWanted(inst);
          if (staticIp) {
            ip = staticIp;
            logEvent(inst.id, 'ip', `Static IP ${staticIp} ${inst.state === 'resuming' ? 're-' : ''}attached`);
          }
        } catch (err) {
          console.error(`static ip ${inst.name}:`, err.message || err);
          logEvent(inst.id, 'error', `Static IP attach failed: ${String(err.message || err).slice(0, 150)}`);
        }
        db.prepare("UPDATE instances SET state = 'bootstrapping', public_ip = ? WHERE id = ?")
          .run(ip, inst.id);
        if (inst.state === 'resuming' && inst.snapshot_name) {
          // VM restored fine — the snapshot has served its purpose.
          try {
            await provider.deleteSnapshot(inst.snapshot_name, inst.region);
            db.prepare('UPDATE instances SET snapshot_name = NULL WHERE id = ?').run(inst.id);
            logEvent(inst.id, 'snapshot', 'Snapshot deleted after successful restore');
          } catch (err) {
            console.error(`snapshot cleanup ${inst.snapshot_name}:`, err.message || err);
          }
        }
      } else if (inst.state === 'pausing') {
        const snapState = await provider.getSnapshotState(inst.snapshot_name, inst.region);
        if (snapState === 'available') {
          logEvent(inst.id, 'snapshot', 'Snapshot completed — shutting the server down');
          await provider.deleteInstance(inst.name, inst.region);
          db.prepare("UPDATE instances SET state = 'paused', paused_at = datetime('now'), public_ip = NULL WHERE id = ?")
            .run(inst.id);
          db.prepare("UPDATE agents SET status = 'paused' WHERE instance_id = ? AND status != 'deleted'").run(inst.id);
          console.log(`paused ${inst.name}`);
          logEvent(inst.id, 'pause', `Server paused — billing dropped to the paused rate${inst.static_ip_name ? '; static IP reserved' : ''}`);
        } else if (snapState === 'error') {
          db.prepare("UPDATE instances SET state = 'ready', error = 'snapshot failed - pause aborted', snapshot_name = NULL WHERE id = ?")
            .run(inst.id);
          logEvent(inst.id, 'error', 'Snapshot failed — pause aborted, server still running');
        }
      }
    } catch (err) {
      console.error(`poll ${inst.name} (${inst.state}):`, err.message || err);
    }
  }

  // Anything provisioning for >1h without progress is stuck.
  db.prepare(
    "UPDATE instances SET state = 'error', error = 'provisioning timed out' WHERE state = 'provisioning' AND created_at <= datetime('now', '-1 hour')"
  ).run();
}
setInterval(pollInstances, 20000);
if (!process.env.DISABLE_BILLING_CRON) startBilling();

migratePlaintext(db);
startBackups();

const port = parseInt(process.env.PORT || '3000', 10);
app.listen(port, () => {
  console.log(`AgentDeploy control plane on :${port} (secrets at rest: ${encryptionEnabled() ? 'encrypted' : 'PLAINTEXT'})`);
  if (process.env.MOCK_PROVIDER) console.log('MOCK_PROVIDER enabled — no real cloud calls');
  else if (!process.env.BASE_URL) console.warn('WARNING: BASE_URL not set; deploys will fail');
});

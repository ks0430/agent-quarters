import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import db from './db.js';
import { sessionMiddleware } from './auth.js';
import apiRoutes from './routes-api.js';
import hostRoutes from './routes-host.js';
import { getProvider } from './provider.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const app = express();

app.use(express.json({ limit: '512kb' }));
app.use(sessionMiddleware);

app.use('/api', apiRoutes);
app.use('/host', hostRoutes);

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

const port = parseInt(process.env.PORT || '3000', 10);
app.listen(port, () => {
  console.log(`AgentDeploy control plane on :${port}`);
  if (process.env.MOCK_PROVIDER) console.log('MOCK_PROVIDER enabled — no real cloud calls');
  else if (!process.env.BASE_URL) console.warn('WARNING: BASE_URL not set; deploys will fail');
});

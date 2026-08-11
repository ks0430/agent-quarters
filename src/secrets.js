// Encryption at rest for customer secrets (agent env vars, API keys, chat
// platform tokens baked into config.toml).
//
// AES-256-GCM with a key from SECRETS_KEY (64 hex chars). Values are stored
// as "enc1:<base64>" so we can tell encrypted from legacy plaintext and
// migrate transparently — dec() passes through anything unprefixed, so the
// app keeps working if the key is missing or rows predate encryption.
//
// Scope note: this covers CUSTOMER secrets. Our own capability tokens
// (instances.host_token, agents.bridge_token) stay plaintext because they're
// looked up by value (WHERE host_token = ?) and GCM is non-deterministic;
// they're random per-instance credentials, not user-supplied secrets.

import crypto from 'node:crypto';

const PREFIX = 'enc1:';
const key = (() => {
  const raw = process.env.SECRETS_KEY || '';
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    if (raw) console.error('SECRETS_KEY must be 64 hex chars — running WITHOUT encryption at rest');
    else console.warn('SECRETS_KEY not set — secrets stored in plaintext (set it to enable encryption)');
    return null;
  }
  return Buffer.from(raw, 'hex');
})();

export const encryptionEnabled = () => key !== null;

export function enc(plain) {
  if (plain === null || plain === undefined) return plain;
  const text = String(plain);
  if (!key || text.startsWith(PREFIX)) return text;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

export function dec(value) {
  if (value === null || value === undefined) return value;
  const text = String(value);
  if (!text.startsWith(PREFIX)) return text; // legacy plaintext
  if (!key) throw new Error('encrypted data present but SECRETS_KEY is not set');
  const buf = Buffer.from(text.slice(PREFIX.length), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

// One-time pass to encrypt rows written before encryption was enabled.
export function migratePlaintext(db) {
  if (!key) return;
  const cols = ['config_toml', 'env_json', 'user_env_json'];
  const rows = db.prepare(`SELECT id, ${cols.join(', ')} FROM agents`).all();
  let n = 0;
  for (const row of rows) {
    const updates = cols.filter((c) => row[c] && !String(row[c]).startsWith(PREFIX));
    if (!updates.length) continue;
    db.prepare(`UPDATE agents SET ${updates.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
      .run(...updates.map((c) => enc(row[c])), row.id);
    n += 1;
  }
  if (n) console.log(`secrets: encrypted ${n} agent row(s) at rest`);
}

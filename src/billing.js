// Prepaid-wallet billing (AutoDL model): users hold a credit balance;
// running servers burn it at USAGE_RATE_CENTS_HOUR (default 2.5c/h ≈ $18/mo,
// vs our ~$12 AWS cost — the markup is the revenue). Balance <= 0 starts a
// 48h grace clock; still negative after that, servers are deleted.

import Stripe from 'stripe';
import db from './db.js';
import { getProvider } from './provider.js';

export const RATE_CENTS_HOUR = parseFloat(process.env.USAGE_RATE_CENTS_HOUR || '2.5');
export const MIN_DEPLOY_BALANCE_CENTS = RATE_CENTS_HOUR * 48; // 2 days of one server
const GRACE_HOURS = 48;

let stripe = null;
export function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  stripe ??= new Stripe(process.env.STRIPE_SECRET_KEY);
  return stripe;
}

const sqliteNow = (d = new Date()) => d.toISOString().slice(0, 19).replace('T', ' ');
const parseUtc = (s) => new Date(String(s).replace(' ', 'T') + 'Z');

// Ledger-backed balance mutation. `ref` de-duplicates (unique index) so a
// replayed Stripe webhook can never double-credit; returns false on dupe.
export function applyLedger(userId, deltaCents, reason, ref = null) {
  const apply = db.transaction(() => {
    const user = db.prepare('SELECT balance_cents FROM users WHERE id = ?').get(userId);
    if (!user) throw new Error(`no user ${userId}`);
    const after = +(user.balance_cents + deltaCents).toFixed(3);
    db.prepare('INSERT INTO credit_ledger (user_id, delta_cents, balance_after, reason, ref) VALUES (?, ?, ?, ?, ?)')
      .run(userId, +deltaCents.toFixed(3), after, reason, ref);
    db.prepare('UPDATE users SET balance_cents = ? WHERE id = ?').run(after, userId);
    return after;
  });
  try {
    return apply();
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return false; // duplicate ref
    throw err;
  }
}

// Charge one instance for wall-clock time since it was last billed.
// AWS bills us from creation to deletion regardless of state, so we do too.
export function chargeInstance(inst, now = new Date()) {
  if (inst.deleted_at) return;
  const from = parseUtc(inst.last_billed_at || inst.created_at);
  const hours = (now - from) / 3600000;
  if (hours < 0.01) return;
  const cost = hours * RATE_CENTS_HOUR;
  applyLedger(inst.user_id, -cost, `usage ${inst.name} (${hours.toFixed(2)}h)`);
  db.prepare('UPDATE instances SET last_billed_at = ? WHERE id = ?').run(sqliteNow(now), inst.id);
}

async function enforceGrace(now = new Date()) {
  const users = db.prepare(`
    SELECT u.* , COUNT(i.id) AS active
    FROM users u LEFT JOIN instances i ON i.user_id = u.id AND i.state != 'deleted'
    GROUP BY u.id`).all();

  for (const u of users) {
    if (u.balance_cents > 0 || u.active === 0) {
      if (u.negative_since) db.prepare('UPDATE users SET negative_since = NULL WHERE id = ?').run(u.id);
      continue;
    }
    if (!u.negative_since) {
      db.prepare('UPDATE users SET negative_since = ? WHERE id = ?').run(sqliteNow(now), u.id);
      continue;
    }
    const negativeHours = (now - parseUtc(u.negative_since)) / 3600000;
    if (negativeHours < GRACE_HOURS) continue;

    // Grace expired: tear down this user's servers to stop our AWS bleed.
    const instances = db.prepare("SELECT * FROM instances WHERE user_id = ? AND state != 'deleted'").all(u.id);
    for (const inst of instances) {
      try {
        await getProvider().deleteInstance(inst.name, inst.region);
      } catch (err) {
        console.error(`grace teardown ${inst.name}:`, err.message || err);
      }
      db.prepare("UPDATE instances SET state = 'deleted', deleted_at = datetime('now') WHERE id = ?").run(inst.id);
      db.prepare("UPDATE agents SET status = 'deleted' WHERE instance_id = ?").run(inst.id);
      applyLedger(u.id, 0, `server ${inst.name} deleted: balance unpaid past ${GRACE_HOURS}h grace`);
      console.log(`grace: deleted ${inst.name} for ${u.email}`);
    }
    db.prepare('UPDATE users SET negative_since = NULL WHERE id = ?').run(u.id);
  }
}

export async function billingTick() {
  const now = new Date();
  const instances = db.prepare("SELECT * FROM instances WHERE state != 'deleted'").all();
  for (const inst of instances) {
    try { chargeInstance(inst, now); } catch (err) { console.error(`bill ${inst.name}:`, err.message); }
  }
  await enforceGrace(now);
}

export function startBilling(intervalMs = 10 * 60 * 1000) {
  setInterval(() => billingTick().catch((e) => console.error('billingTick:', e)), intervalMs);
}

export async function ensureCustomer(user) {
  if (user.stripe_customer_id) return user.stripe_customer_id;
  const customer = await getStripe().customers.create({
    email: user.email,
    metadata: { userId: String(user.id) },
  });
  db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customer.id, user.id);
  return customer.id;
}

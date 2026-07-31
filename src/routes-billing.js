// Billing API: wallet top-ups (Stripe Checkout one-time), the Multi plan
// subscription, Customer Portal, and the Stripe webhook that credits wallets.

import { Router } from 'express';
import db from './db.js';
import { requireUser } from './auth.js';
import {
  getStripe, ensureCustomer, applyLedger, RATE_CENTS_HOUR,
} from './billing.js';

const TOPUP_AMOUNTS = [10, 25, 50]; // USD

const router = Router();

function requireStripe(req, res, next) {
  if (!getStripe()) return res.status(503).json({ error: 'billing not configured' });
  next();
}

router.get('/', requireUser, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const active = db.prepare("SELECT COUNT(*) n FROM instances WHERE user_id = ? AND state != 'deleted'")
    .get(user.id).n;
  const ledger = db.prepare(
    'SELECT delta_cents, balance_after, reason, created_at FROM credit_ledger WHERE user_id = ? ORDER BY id DESC LIMIT 25'
  ).all(user.id);
  res.json({
    balanceCents: +user.balance_cents.toFixed(2),
    plan: user.plan,
    activeServers: active,
    rateCentsHour: RATE_CENTS_HOUR,
    burnCentsDay: +(active * RATE_CENTS_HOUR * 24).toFixed(2),
    negativeSince: user.negative_since,
    topupAmounts: TOPUP_AMOUNTS,
    ledger,
  });
});

router.post('/topup', requireUser, requireStripe, async (req, res) => {
  const amount = Number(req.body.amount);
  if (!TOPUP_AMOUNTS.includes(amount)) return res.status(400).json({ error: 'invalid amount' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const customer = await ensureCustomer(user);
  const base = process.env.BASE_URL || 'http://localhost:3000';
  const session = await getStripe().checkout.sessions.create({
    mode: 'payment',
    customer,
    client_reference_id: String(user.id),
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: amount * 100,
        product_data: { name: `AgentQuarters credits — $${amount}` },
      },
    }],
    metadata: { userId: String(user.id), kind: 'topup', amountUsd: String(amount) },
    success_url: `${base}/settings.html?billing=topup-success`,
    cancel_url: `${base}/settings.html?billing=cancelled`,
  });
  res.json({ url: session.url });
});

router.post('/subscribe', requireUser, requireStripe, async (req, res) => {
  if (!process.env.STRIPE_MULTI_PRICE) return res.status(503).json({ error: 'plan not configured' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (user.plan === 'multi') return res.status(400).json({ error: 'already on Multi' });
  const customer = await ensureCustomer(user);
  const base = process.env.BASE_URL || 'http://localhost:3000';
  const session = await getStripe().checkout.sessions.create({
    mode: 'subscription',
    customer,
    client_reference_id: String(user.id),
    line_items: [{ price: process.env.STRIPE_MULTI_PRICE, quantity: 1 }],
    metadata: { userId: String(user.id), kind: 'subscribe' },
    success_url: `${base}/settings.html?billing=subscribed`,
    cancel_url: `${base}/settings.html?billing=cancelled`,
  });
  res.json({ url: session.url });
});

router.post('/portal', requireUser, requireStripe, async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user.stripe_customer_id) return res.status(400).json({ error: 'no billing history yet' });
  const base = process.env.BASE_URL || 'http://localhost:3000';
  const session = await getStripe().billingPortal.sessions.create({
    customer: user.stripe_customer_id,
    return_url: `${base}/settings.html`,
  });
  res.json({ url: session.url });
});

// Mounted in server.js with express.raw() BEFORE the json parser —
// Stripe signature verification needs the exact raw bytes.
export async function handleStripeWebhook(req, res) {
  const stripeClient = getStripe();
  if (!stripeClient) return res.status(503).end();

  let event;
  try {
    event = stripeClient.webhooks.constructEvent(
      req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('webhook signature failed:', err.message);
    return res.status(400).json({ error: 'bad signature' });
  }

  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    const userId = parseInt(s.client_reference_id || s.metadata?.userId || '0', 10);
    if (userId && s.mode === 'payment' && s.payment_status === 'paid') {
      // amount_total is in cents; ref = session id makes replays no-ops.
      const credited = applyLedger(userId, s.amount_total, `top-up $${(s.amount_total / 100).toFixed(2)}`, s.id);
      if (credited !== false) console.log(`credited ${s.amount_total}c to user ${userId}`);
    }
    if (userId && s.mode === 'subscription') {
      db.prepare("UPDATE users SET plan = 'multi' WHERE id = ?").run(userId);
      console.log(`user ${userId} subscribed to Multi`);
    }
  }

  if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    const user = db.prepare('SELECT * FROM users WHERE stripe_customer_id = ?').get(sub.customer);
    if (user) {
      const active = event.type !== 'customer.subscription.deleted'
        && ['active', 'trialing', 'past_due'].includes(sub.status);
      db.prepare('UPDATE users SET plan = ? WHERE id = ?').run(active ? 'multi' : 'free', user.id);
      console.log(`user ${user.id} plan -> ${active ? 'multi' : 'free'} (${sub.status})`);
    }
  }

  res.json({ received: true });
}

export default router;

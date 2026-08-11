// "Sign in with Google" — OAuth 2.0 authorization-code flow.
//
// No extra dependencies: we redirect to Google, exchange the code for tokens
// server-side using our client secret, and read the returned id_token. The
// token arrives directly from Google's endpoint over TLS in response to an
// authenticated request, so its payload is trusted without separate signature
// verification (Google documents this for confidential clients).

import crypto from 'node:crypto';
import { Router } from 'express';
import db from './db.js';
import { createSession, setSessionCookie } from './auth.js';

const router = Router();

const CLIENT_ID = () => process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = () => process.env.GOOGLE_CLIENT_SECRET || '';
export const googleEnabled = () => !!(CLIENT_ID() && CLIENT_SECRET());
const redirectUri = () => `${process.env.BASE_URL || 'http://localhost:3000'}/api/auth/google/callback`;

// Short-lived CSRF states. In-memory is fine: a lost state just means the
// user retries the sign-in (single control-plane process).
const states = new Map();
setInterval(() => {
  const cutoff = Date.now() - 10 * 60000;
  for (const [s, t] of states) if (t < cutoff) states.delete(s);
}, 60000).unref();

router.get('/google', (req, res) => {
  if (!googleEnabled()) return res.status(503).send('Google sign-in is not configured');
  const state = crypto.randomBytes(16).toString('hex');
  states.set(state, Date.now());
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', CLIENT_ID());
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('prompt', 'select_account');
  res.redirect(url.toString());
});

router.get('/google/callback', async (req, res) => {
  const fail = (msg) => res.redirect(`/?auth_error=${encodeURIComponent(msg)}`);
  try {
    if (!googleEnabled()) return fail('Google sign-in is not configured');
    const { code, state } = req.query;
    if (!code || !state || !states.has(state)) return fail('Sign-in expired, please try again');
    states.delete(state);

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(code),
        client_id: CLIENT_ID(),
        client_secret: CLIENT_SECRET(),
        redirect_uri: redirectUri(),
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) return fail('Google rejected the sign-in');
    const { id_token: idToken } = await tokenRes.json();
    if (!idToken) return fail('Google did not return an identity token');

    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString());
    const email = String(payload.email || '').toLowerCase();
    // Unverified emails could let someone claim an address they don't own.
    if (!email || payload.email_verified === false) return fail('Your Google email is not verified');
    if (payload.aud !== CLIENT_ID()) return fail('Token audience mismatch');

    let user = db.prepare('SELECT * FROM users WHERE google_id = ?').get(payload.sub)
      || db.prepare('SELECT * FROM users WHERE email = ?').get(email);

    if (!user) {
      const info = db.prepare('INSERT INTO users (email, pass_hash, google_id, display_name) VALUES (?, ?, ?, ?)')
        .run(email, '', payload.sub, payload.name || null);
      user = { id: info.lastInsertRowid };
      console.log(`new user via Google: ${email}`);
    } else if (!user.google_id) {
      // Existing password account with the same verified email — link it.
      db.prepare('UPDATE users SET google_id = ?, display_name = COALESCE(display_name, ?) WHERE id = ?')
        .run(payload.sub, payload.name || null, user.id);
    }

    setSessionCookie(res, createSession(user.id));
    res.redirect('/');
  } catch (err) {
    console.error('google oauth:', err.message || err);
    fail('Sign-in failed, please try again');
  }
});

export default router;

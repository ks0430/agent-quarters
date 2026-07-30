import crypto from 'node:crypto';
import db from './db.js';

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64, SCRYPT_PARAMS).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, 64, SCRYPT_PARAMS);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), candidate);
}

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, userId);
  return token;
}

export function destroySession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

// Attaches req.user when a valid session cookie is present.
export function sessionMiddleware(req, res, next) {
  const token = parseCookies(req).session;
  if (token) {
    const row = db.prepare(
      'SELECT u.id, u.email, s.token FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?'
    ).get(token);
    if (row) {
      req.user = { id: row.id, email: row.email };
      req.sessionToken = row.token;
    }
  }
  next();
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'not_authenticated' });
  next();
}

export function setSessionCookie(res, token) {
  const secure = (process.env.BASE_URL || '').startsWith('https') ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure}`);
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'session=; HttpOnly; Path=/; Max-Age=0');
}

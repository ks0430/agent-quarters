import Database from 'better-sqlite3';

const db = new Database(process.env.DB_PATH || './agentdeploy.db');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS instances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT UNIQUE NOT NULL,
  region TEXT NOT NULL,
  bundle TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'provisioning',
  host_token TEXT UNIQUE NOT NULL,
  public_ip TEXT,
  last_seen TEXT,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id INTEGER NOT NULL REFERENCES instances(id),
  name TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  model TEXT,
  platform TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  config_toml TEXT NOT NULL,
  env_json TEXT NOT NULL,
  last_logs TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id INTEGER NOT NULL REFERENCES instances(id),
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS credit_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  delta_cents REAL NOT NULL,
  balance_after REAL NOT NULL,
  reason TEXT NOT NULL,
  ref TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_ref ON credit_ledger(ref) WHERE ref IS NOT NULL;
`);

// Column migrations for databases created before these fields existed.
const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!userCols.includes('google_id')) db.exec('ALTER TABLE users ADD COLUMN google_id TEXT');
if (!userCols.includes('display_name')) db.exec('ALTER TABLE users ADD COLUMN display_name TEXT');
if (!userCols.includes('balance_cents')) db.exec('ALTER TABLE users ADD COLUMN balance_cents REAL NOT NULL DEFAULT 0');
if (!userCols.includes('plan')) db.exec("ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free'");
if (!userCols.includes('stripe_customer_id')) db.exec('ALTER TABLE users ADD COLUMN stripe_customer_id TEXT');
if (!userCols.includes('negative_since')) db.exec('ALTER TABLE users ADD COLUMN negative_since TEXT');
const instCols = db.prepare('PRAGMA table_info(instances)').all().map((c) => c.name);
if (!instCols.includes('last_billed_at')) db.exec('ALTER TABLE instances ADD COLUMN last_billed_at TEXT');
if (!instCols.includes('static_ip_name')) db.exec('ALTER TABLE instances ADD COLUMN static_ip_name TEXT');
if (!instCols.includes('static_ip')) db.exec('ALTER TABLE instances ADD COLUMN static_ip TEXT');
if (!instCols.includes('snapshot_name')) db.exec('ALTER TABLE instances ADD COLUMN snapshot_name TEXT');
if (!instCols.includes('paused_at')) db.exec('ALTER TABLE instances ADD COLUMN paused_at TEXT');
if (!instCols.includes('deleted_at')) {
  db.exec('ALTER TABLE instances ADD COLUMN deleted_at TEXT');
  // Backfill: pre-migration deleted rows have no lifetime record; treating
  // them as zero-duration slightly undercounts history but keeps math sane.
  db.exec("UPDATE instances SET deleted_at = created_at WHERE state = 'deleted'");
}
const agentCols = db.prepare('PRAGMA table_info(agents)').all().map((c) => c.name);
if (!agentCols.includes('auth_method')) {
  db.exec("ALTER TABLE agents ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'api-key'");
}
if (!agentCols.includes('login_state')) db.exec('ALTER TABLE agents ADD COLUMN login_state TEXT');
if (!agentCols.includes('login_url')) db.exec('ALTER TABLE agents ADD COLUMN login_url TEXT');
if (!agentCols.includes('login_code')) db.exec('ALTER TABLE agents ADD COLUMN login_code TEXT');
if (!agentCols.includes('api_enabled')) db.exec('ALTER TABLE agents ADD COLUMN api_enabled INTEGER NOT NULL DEFAULT 0');
if (!agentCols.includes('bridge_token')) db.exec('ALTER TABLE agents ADD COLUMN bridge_token TEXT');
if (!agentCols.includes('admin_from')) db.exec('ALTER TABLE agents ADD COLUMN admin_from TEXT');
if (!agentCols.includes('user_env_json')) db.exec("ALTER TABLE agents ADD COLUMN user_env_json TEXT NOT NULL DEFAULT '{}'");
if (!agentCols.includes('health')) db.exec('ALTER TABLE agents ADD COLUMN health TEXT');
if (!agentCols.includes('health_at')) db.exec('ALTER TABLE agents ADD COLUMN health_at TEXT');

db.exec(`
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  prefix TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_apikeys_agent ON api_keys(agent_id);
`);

export default db;

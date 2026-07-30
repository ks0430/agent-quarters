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

// Column migrations for databases created before these fields existed.
const agentCols = db.prepare('PRAGMA table_info(agents)').all().map((c) => c.name);
if (!agentCols.includes('auth_method')) {
  db.exec("ALTER TABLE agents ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'api-key'");
}
if (!agentCols.includes('login_state')) db.exec('ALTER TABLE agents ADD COLUMN login_state TEXT');
if (!agentCols.includes('login_url')) db.exec('ALTER TABLE agents ADD COLUMN login_url TEXT');

export default db;

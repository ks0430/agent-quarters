// Per-instance activity timeline: every lifecycle step gets a row, shown in
// the dashboard's Details panel. Kinds map to icons in the UI.

import db from './db.js';

db.exec(`
CREATE TABLE IF NOT EXISTS instance_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id INTEGER NOT NULL REFERENCES instances(id),
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_instance ON instance_events(instance_id, id);
`);

const insert = db.prepare('INSERT INTO instance_events (instance_id, kind, message) VALUES (?, ?, ?)');
const trim = db.prepare(`DELETE FROM instance_events WHERE instance_id = ? AND id NOT IN
  (SELECT id FROM instance_events WHERE instance_id = ? ORDER BY id DESC LIMIT 200)`);

// kinds: deploy | vm | ip | ready | agent | login | platform | pause | resume
//        snapshot | billing | delete | error
export function logEvent(instanceId, kind, message) {
  try {
    insert.run(instanceId, kind, String(message).slice(0, 300));
    if (Math.random() < 0.05) trim.run(instanceId, instanceId); // occasional cleanup
  } catch (err) {
    console.error('logEvent:', err.message);
  }
}

export function getEvents(instanceId, limit = 60) {
  return db.prepare(
    'SELECT kind, message, created_at FROM instance_events WHERE instance_id = ? ORDER BY id DESC LIMIT ?'
  ).all(instanceId, limit);
}

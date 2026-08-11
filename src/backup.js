// Off-site backups of the control-plane database.
//
// Losing this DB is existential: users, credit balances, and the mapping to
// their cloud servers all live here — while those servers keep billing us and
// customers keep expecting service. Render's disk snapshots are a floor, not
// a plan.
//
// Approach: SQLite's VACUUM INTO makes a consistent copy of a live database
// (no downtime, no locking games), which we gzip and upload to S3. Hourly by
// default, keeping the most recent N. Disabled unless BACKUP_S3_BUCKET is set.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import db from './db.js';

const BUCKET = process.env.BACKUP_S3_BUCKET || '';
const PREFIX = process.env.BACKUP_S3_PREFIX || 'agentdeploy-db/';
const KEEP = parseInt(process.env.BACKUP_KEEP || '48', 10); // 48 hourly ≈ 2 days
const INTERVAL_MS = parseInt(process.env.BACKUP_INTERVAL_MIN || '60', 10) * 60000;

let s3 = null;
const client = () => (s3 ??= new S3Client({ region: process.env.BACKUP_S3_REGION || process.env.AWS_REGION || 'us-east-1' }));

export async function backupNow() {
  if (!BUCKET) return null;
  const tmp = path.join(os.tmpdir(), `agentdeploy-backup-${Date.now()}.db`);
  try {
    // VACUUM INTO = consistent snapshot of a live DB (also compacts it).
    db.prepare('VACUUM INTO ?').run(tmp);
    const gz = zlib.gzipSync(fs.readFileSync(tmp));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const key = `${PREFIX}${stamp}.db.gz`;
    await client().send(new PutObjectCommand({
      Bucket: BUCKET, Key: key, Body: gz, ContentType: 'application/gzip',
    }));
    console.log(`backup: uploaded ${key} (${(gz.length / 1024).toFixed(0)} KB)`);
    await prune();
    return key;
  } finally {
    fs.rm(tmp, { force: true }, () => {});
  }
}

async function prune() {
  const list = await client().send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: PREFIX }));
  const objs = (list.Contents || []).sort((a, b) => (a.Key < b.Key ? 1 : -1)); // newest first by timestamped name
  const stale = objs.slice(KEEP);
  if (!stale.length) return;
  await client().send(new DeleteObjectsCommand({
    Bucket: BUCKET, Delete: { Objects: stale.map((o) => ({ Key: o.Key })) },
  }));
  console.log(`backup: pruned ${stale.length} old backup(s)`);
}

export function startBackups() {
  if (!BUCKET) {
    console.warn('BACKUP_S3_BUCKET not set — database backups are OFF');
    return;
  }
  const run = () => backupNow().catch((err) => console.error('backup failed:', err.message || err));
  setTimeout(run, 60000); // one shortly after boot
  setInterval(run, INTERVAL_MS);
  console.log(`backups: every ${INTERVAL_MS / 60000} min to s3://${BUCKET}/${PREFIX} (keep ${KEEP})`);
}

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readConfig } from '../config.js';
import { createPool } from './client.js';

const config = readConfig();
if (!config.DATABASE_URL) throw new Error('DATABASE_URL is required for migrations');
const pool = createPool(config.DATABASE_URL);
const client = await pool.connect();

try {
  await client.query('BEGIN');
  // Transaction locks also work with a transaction-pooled Neon connection.
  await client.query('SELECT pg_advisory_xact_lock(743707022)');
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const directory = resolve('migrations');
  for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
    const sql = await readFile(resolve(directory, name), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const existing = await client.query<{ checksum: string }>('SELECT checksum FROM schema_migrations WHERE name = $1', [name]);
    if (existing.rows[0]) {
      if (existing.rows[0].checksum !== checksum) throw new Error(`Applied migration changed: ${name}`);
      continue;
    }
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [name, checksum]);
    console.log(`Applied ${name}`);
  }
  await client.query('COMMIT');
  console.log('Database schema is up to date.');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}

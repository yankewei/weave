import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;
const directory = fileURLToPath(new URL('../migrations/', import.meta.url));

const pool = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL, max: 1 }
    : {
        host: process.env.POSTGRES_HOST ?? '127.0.0.1',
        port: Number(process.env.POSTGRES_PORT ?? 5432),
        user: process.env.POSTGRES_USER ?? 'weave',
        password: process.env.POSTGRES_PASSWORD,
        database: process.env.POSTGRES_DB ?? 'weave',
        max: 1,
      },
);

const checksum = (sql) => createHash('sha256').update(sql).digest('hex');

const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(825513, 1)');
  await client.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  await client.query(
    'ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text',
  );
  const applied = await client.query(
    'SELECT name, checksum FROM schema_migrations',
  );
  const names = (await readdir(directory))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const name of names) {
    const sql = await readFile(`${directory}/${name}`, 'utf8');
    const hash = checksum(sql);
    const existing = applied.rows.find((row) => row.name === name);
    if (existing) {
      if (existing.checksum && existing.checksum !== hash)
        throw new Error(
          `Migration ${name} changed after it was applied. Add a new migration instead.`,
        );
      if (!existing.checksum)
        await client.query(
          'UPDATE schema_migrations SET checksum = $2 WHERE name = $1',
          [name, hash],
        );
      continue;
    }
    await client.query(sql);
    await client.query(
      'INSERT INTO schema_migrations(name, checksum) VALUES($1, $2)',
      [name, hash],
    );
    console.log(`Applied ${name}`);
  }
  await client.query('COMMIT');
  console.log('Database migrations applied.');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}

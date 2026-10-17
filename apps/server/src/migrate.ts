import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Database } from './database.js';

export function migrationChecksum(sql: string) {
  return createHash('sha256').update(sql).digest('hex');
}

// Migrations run explicitly, never as a side effect of starting an API process.
export async function migrate(database: Database) {
  const directory = fileURLToPath(new URL('../migrations/', import.meta.url));
  await database.transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(825513, 1)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    // Existing deployments gain checksums on their next migration run.
    await client.query(
      'ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text',
    );
    const applied = await client.query<{
      name: string;
      checksum: string | null;
    }>('SELECT name, checksum FROM schema_migrations');
    for (const name of (await readdir(directory))
      .filter((name) => name.endsWith('.sql'))
      .sort()) {
      const sql = await readFile(`${directory}/${name}`, 'utf8');
      const checksum = migrationChecksum(sql);
      const existing = applied.rows.find((row) => row.name === name);
      if (existing) {
        if (existing.checksum && existing.checksum !== checksum)
          throw new Error(
            `Migration ${name} changed after it was applied. Add a new migration instead.`,
          );
        if (!existing.checksum) {
          await client.query(
            'UPDATE schema_migrations SET checksum = $2 WHERE name = $1',
            [name, checksum],
          );
          existing.checksum = checksum;
        }
        continue;
      }
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations(name, checksum) VALUES($1, $2)',
        [name, checksum],
      );
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const database = new Database();
  try {
    await migrate(database);
    console.log('Database migrations applied.');
  } finally {
    await database.onModuleDestroy();
  }
}

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Database } from './database.js';

// Migrations run explicitly, never as a side effect of starting an API process.
export async function migrate(database: Database) {
  const directory = fileURLToPath(new URL('../migrations/', import.meta.url));
  await database.transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(825513, 1)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const applied = await client.query<{ name: string }>(
      'SELECT name FROM schema_migrations',
    );
    for (const name of (await readdir(directory))
      .filter((name) => name.endsWith('.sql'))
      .sort()) {
      if (applied.rows.some((row) => row.name === name)) continue;
      await client.query(await readFile(`${directory}/${name}`, 'utf8'));
      await client.query('INSERT INTO schema_migrations(name) VALUES($1)', [
        name,
      ]);
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

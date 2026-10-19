import { Pool, type PoolClient } from 'pg';
import { ApiError } from './http';

// Fluid compute and dev HMR both reuse the module, so the pool must be a
// process singleton rather than one per request or per reload.
const cache = globalThis as unknown as { weavePool?: Pool };

function createPool() {
  return new Pool({
    ...(process.env.DATABASE_URL
      ? { connectionString: process.env.DATABASE_URL }
      : {
          host: process.env.POSTGRES_HOST ?? '127.0.0.1',
          port: Number(process.env.POSTGRES_PORT ?? 5432),
          user: process.env.POSTGRES_USER ?? 'weave',
          password: process.env.POSTGRES_PASSWORD,
          database: process.env.POSTGRES_DB ?? 'weave',
        }),
    // Serverless instances each hold their own pool; keep the default small.
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 30_000,
  });
}

export const pool = cache.weavePool ?? createPool();

if (!cache.weavePool) {
  pool.on('error', (error: Error) =>
    console.error('Idle database connection failed:', error.message),
  );
  cache.weavePool = pool;
}

export async function ping() {
  await pool.query('SELECT 1');
}

export async function transaction<T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect().catch(() => {
    throw new ApiError(503, '数据库不可用，请检查数据库连接。');
  });
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

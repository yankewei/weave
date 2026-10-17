import {
  Injectable,
  ServiceUnavailableException,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';

@Injectable()
export class Database implements OnModuleDestroy {
  readonly pool = new Pool({
    ...(process.env.DATABASE_URL
      ? { connectionString: process.env.DATABASE_URL }
      : {
          host: process.env.POSTGRES_HOST ?? '127.0.0.1',
          port: Number(process.env.POSTGRES_PORT ?? 5432),
          user: process.env.POSTGRES_USER ?? 'weave',
          password: process.env.POSTGRES_PASSWORD,
          database: process.env.POSTGRES_DB ?? 'weave',
        }),
    max: 10,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 30_000,
  });

  constructor() {
    this.pool.on('error', (error: Error) =>
      console.error('Idle database connection failed:', error.message),
    );
  }

  async ping() {
    await this.pool.query('SELECT 1');
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect().catch(() => {
      throw new ServiceUnavailableException('数据库不可用，请检查数据库连接。');
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

  async onModuleDestroy() {
    await this.pool.end();
  }
}

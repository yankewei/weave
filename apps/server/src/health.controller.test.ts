import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { healthResponseSchema } from '@weave/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from './app.module.js';
import { WorkerModule } from './worker.module.js';

describe('API bootstrap', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('returns a valid liveness response without requiring a database', async () => {
    const response = await fetch(`${baseUrl}/api/health`);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(healthResponseSchema.parse(await response.json())).toEqual({
      status: 'ok',
      service: 'weave-api',
    });
  });

  it('does not expose the health route without the API prefix', async () => {
    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(404);
  });
});

it('creates and closes an independent worker context', async () => {
  const worker = await Test.createTestingModule({
    imports: [WorkerModule],
  }).compile();

  await worker.init();
  await worker.close();
});

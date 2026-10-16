import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module.js';

const app = await NestFactory.createApplicationContext(WorkerModule);
Logger.log(
  'Worker bootstrap verified. No task queue is configured; exiting.',
  'Worker',
);
await app.close();

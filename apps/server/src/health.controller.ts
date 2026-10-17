import {
  Controller,
  Get,
  Header,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { HealthResponse, ReadinessResponse } from '@weave/contracts';
import { Database } from './database.js';

@Controller('health')
export class HealthController {
  constructor(@Inject(Database) private readonly database: Database) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  getHealth(): HealthResponse {
    return { status: 'ok', service: 'weave-api' };
  }

  @Get('ready')
  @Header('Cache-Control', 'no-store')
  async getReadiness(): Promise<ReadinessResponse> {
    try {
      await this.database.ping();
    } catch {
      throw new ServiceUnavailableException('数据库不可用。');
    }
    return { status: 'ok', service: 'weave-api', database: 'ok' };
  }
}

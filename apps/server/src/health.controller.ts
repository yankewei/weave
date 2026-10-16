import { Controller, Get, Header } from '@nestjs/common';
import type { HealthResponse } from '@weave/contracts';

@Controller('health')
export class HealthController {
  @Get()
  @Header('Cache-Control', 'no-store')
  getHealth(): HealthResponse {
    return { status: 'ok', service: 'weave-api' };
  }
}

import type { NestExpressApplication } from '@nestjs/platform-express';

// Production and HTTP tests share parser limits and routing configuration.
export function configureApplication(app: NestExpressApplication) {
  app.setGlobalPrefix('api');
  app.useBodyParser('json', { limit: '1mb' });
  app.enableShutdownHooks();
}

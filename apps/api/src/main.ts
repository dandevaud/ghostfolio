import { Logger, ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { json } from 'body-parser';
import helmet from 'helmet';

import { LoggingInterceptor } from './aop/logging.interceptor';
import { AppModule } from './app/app.module';
import { environment } from './environments/environment';
import { HtmlTemplateMiddleware } from './middlewares/html-template.middleware';

async function bootstrap() {
  const configApp = await NestFactory.create(AppModule);
  const configService = configApp.get<ConfigService>(ConfigService);

  let logLevelArray = [];
  let logLevel = configService.get<string>('LOG_LEVEL');
  Logger.log(`Log-Level: ${logLevel}`);

  switch (logLevel?.toLowerCase()) {
    case 'verbose':
      logLevelArray = ['debug', 'error', 'log', 'verbose', 'warn'];
      break;
    case 'debug':
      logLevelArray = ['debug', 'error', 'log', 'warn'];
      break;
    case 'log':
      logLevelArray = ['error', 'log', 'warn'];
      break;
    case 'warn':
      logLevelArray = ['error', 'warn'];
      break;
    case 'error':
      logLevelArray = ['error'];
      break;
    default:
      logLevelArray = environment.production
        ? ['error', 'log', 'warn']
        : ['debug', 'error', 'log', 'verbose', 'warn'];
      break;
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: logLevelArray
  });

  app.enableCors();
  app.enableVersioning({
    defaultVersion: '1',
    type: VersioningType.URI
  });
  app.setGlobalPrefix('api', { exclude: ['sitemap.xml'] });
  app.useGlobalInterceptors(new LoggingInterceptor());
  app.useGlobalPipes(
    new ValidationPipe({
      forbidNonWhitelisted: true,
      transform: true,
      whitelist: true
    })
  );

  // Support 10mb csv/json files for importing activities
  app.use(json({ limit: '10mb' }));

  if (configService.get<string>('ENABLE_FEATURE_SUBSCRIPTION') === 'true') {
    app.use(
      helmet({
        contentSecurityPolicy: {
          directives: {
            connectSrc: ["'self'", 'https://js.stripe.com'], // Allow connections to Stripe
            frameSrc: ["'self'", 'https://js.stripe.com'], // Allow loading frames from Stripe
            scriptSrc: ["'self'", "'unsafe-inline'", 'https://js.stripe.com'], // Allow inline scripts and scripts from Stripe
            scriptSrcAttr: ["'self'", "'unsafe-inline'"], // Allow inline event handlers
            styleSrc: ["'self'", "'unsafe-inline'"] // Allow inline styles
          }
        },
        crossOriginOpenerPolicy: false // Disable Cross-Origin-Opener-Policy header (for Internet Identity)
      })
    );
  }

  app.use(HtmlTemplateMiddleware);

  const HOST = configService.get<string>('HOST') || '0.0.0.0';
  const PORT = configService.get<number>('PORT') || 3333;

  await app.listen(PORT, HOST, () => {
    logLogo();
    Logger.log(`Listening at http://${HOST}:${PORT}`);
    Logger.log('');
  });
}

function logLogo() {
  Logger.log('   ________               __  ____      ___');
  Logger.log('  / ____/ /_  ____  _____/ /_/ __/___  / (_)___');
  Logger.log(' / / __/ __ \\/ __ \\/ ___/ __/ /_/ __ \\/ / / __ \\');
  Logger.log('/ /_/ / / / / /_/ (__  ) /_/ __/ /_/ / / / /_/ /');
  Logger.log(
    `\\____/_/ /_/\\____/____/\\__/_/  \\____/_/_/\\____/ ${environment.version}`
  );
  Logger.log('');
}

bootstrap();

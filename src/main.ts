import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Transport, MicroserviceOptions } from '@nestjs/microservices';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ValidationPipe } from '@nestjs/common';
import { resolveDetectorConfig } from './config';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import { resolve } from 'path';

// 👇 Загружаем .env.{APP_MODE}
dotenv.config({
  path: resolve(process.cwd(), `.env.${process.env.APP_MODE || 'local'}`),
});

async function bootstrap() {
  const config = resolveDetectorConfig();
  const PORT = config.apiPort || 8101;

  // 👇 HTTPS (опционально, если заданы SSL_CERT и SSL_KEY)
  let httpsOptions: { key: Buffer; cert: Buffer } | undefined;
  if (process.env.SSL_KEY && process.env.SSL_CERT) {
    try {
      httpsOptions = {
        key: fs.readFileSync(resolve(process.cwd(), process.env.SSL_KEY)),
        cert: fs.readFileSync(resolve(process.cwd(), process.env.SSL_CERT)),
      };
      console.log('✅ HTTPS включён (сертификаты загружены)');
    } catch (err: any) {
      console.warn(
        `⚠️ Не удалось загрузить сертификаты (${process.env.SSL_KEY}, ${process.env.SSL_CERT}):`,
        err.message,
      );
    }
  }

  const app = await NestFactory.create(AppModule, { httpsOptions });

  // 🔹 глобальный префикс
  app.setGlobalPrefix('api');

  // 🔹 валидация DTO
  app.useGlobalPipes(new ValidationPipe({ transform: true }));

  // 🔹 Swagger setup
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Detector API')
    .setDescription('API для управления детекторами и плагинами')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  // 🔹 Redis microservice
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.REDIS,
    options: {
      host: process.env.REDIS_HOST || 'localhost',
      port: +(process.env.REDIS_PORT || 6379),
    },
  });

  app.enableShutdownHooks();

  await app.startAllMicroservices();
  await app.listen(PORT, '0.0.0.0');

  const proto = httpsOptions ? 'https' : 'http';
  console.log(`🚀 Detector API is running on: ${proto}://localhost:${PORT}/api`);
  console.log(`📘 Swagger docs: ${proto}://localhost:${PORT}/api/docs`);
  console.log(
    `🛰 Active detector sysName: ${config.sysName}, logLevel: ${config.logLevel}`,
  );
}

bootstrap();

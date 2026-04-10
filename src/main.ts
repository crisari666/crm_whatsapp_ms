import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  const port = process.env.APP_PORT;

  app.setGlobalPrefix('ws-rest');

  // Serve static files from media directory
  app.useStaticAssets(join(process.cwd(), 'media'), {
    prefix: '/media/',
  });

  app.enableCors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    // allowedHeaders: ['Content-Type', 'Authorization'],
  });



  await app.listen(port);
  console.log(`🚀 WhatsApp Web Microservice is running on: http://localhost:${port}/ws-rest`);
}
bootstrap();

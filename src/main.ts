import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';

function resolveRabbitMqUrlForMain(): string {
  const direct = (process.env.RABBITMQ_URL ?? '').trim();
  if (direct !== '') {
    return direct;
  }
  const host = (process.env.RABBIT_MQ_HOST ?? '').trim();
  if (host === '') {
    return '';
  }
  const user = (process.env.RABBIT_MQ_USER ?? '').trim() || 'guest';
  const pass = (process.env.RABBIT_MQ_PASS ?? '').trim() || 'guest';
  const port = (process.env.RABBIT_MQ_PORT ?? '').trim() || '5672';
  return `amqp://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const rabbitUrl = resolveRabbitMqUrlForMain();
  if (rabbitUrl !== '') {
    const queue = (process.env.RABBIT_QUEUE_WHATSAPP_EVENTS ?? '').trim() || 'crm.whatsapp.events';
    app.connectMicroservice<MicroserviceOptions>({
      transport: Transport.RMQ,
      options: {
        urls: [rabbitUrl],
        queue,
        queueOptions: { durable: true },
      },
    });
    await app.startAllMicroservices();
  }

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

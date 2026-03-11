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
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  const rabbitMqUser = process.env.RABBIT_MQ_USER || 'guest';
  const rabbitMqPass = process.env.RABBIT_MQ_PASS || 'guest';
  const rabbitMqUrl = `amqp://${rabbitMqUser}:${rabbitMqPass}@localhost:5672`;

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.RMQ,
    options: {
      urls: [rabbitMqUrl],
      queue: 'whatsapp_events_queue',
      queueOptions: {
        durable: true, // 👈 asegura persistencia
      },
    },
  });
  await app.startAllMicroservices();

  await app.listen(port);
  console.log(`🚀 WhatsApp Web Microservice is running on: http://localhost:${port}/rest`);
}
bootstrap();

import { Module } from '@nestjs/common';
import { WhatsappWebService } from './whatsapp-web.service';
import { WhatsappWebController } from './whatsapp-web.controller';
import { MongooseModule } from '@nestjs/mongoose';
import { WhatsAppSession, WhatsAppSessionSchema } from './schemas/whatsapp-session.schema';
import { WhatsAppMessage, WhatsAppMessageSchema } from './schemas/whatsapp-message.schema';
import { WhatsAppChat, WhatsAppChatSchema } from './schemas/whatsapp-chat.schema';
import { WhatsappStorageService } from './whatsapp-storage.service';
import { WhatsappWebGateway } from './whatsapp-web.gateway';
import { WhatsappAlertsService } from './whatsapp-alerts.service';
import { RabbitService } from 'src/rabbit.service';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ConfigModule, ConfigService } from '@nestjs/config';

function resolveRabbitMqUrl(configService: ConfigService): string {
  const directUrl = configService.get<string>('RABBITMQ_URL', '').trim();
  if (directUrl !== '') {
    return directUrl;
  }
  const rabbitMqUser = configService.get<string>('RABBIT_MQ_USER', 'guest');
  const rabbitMqPass = configService.get<string>('RABBIT_MQ_PASS', 'guest');
  const rabbitMqHost = configService.get<string>('RABBIT_MQ_HOST', 'localhost');
  const rabbitMqPort = configService.get<string>('RABBIT_MQ_PORT', '5672');
  return `amqp://${rabbitMqUser}:${rabbitMqPass}@${rabbitMqHost}:${rabbitMqPort}`;
}

@Module({
  imports: [
    MongooseModule.forFeature(
      [
        { name: WhatsAppSession.name, schema: WhatsAppSessionSchema },
        { name: WhatsAppMessage.name, schema: WhatsAppMessageSchema },
        { name: WhatsAppChat.name, schema: WhatsAppChatSchema },
      ]
    ),
    ClientsModule.registerAsync([
      {
        name: 'RECORDS_AI_CHATS_ANALYSIS_SERVICE',
        imports: [ConfigModule],
        useFactory: (configService: ConfigService) => {
          return {
            transport: Transport.RMQ,
            options: {
              urls: [resolveRabbitMqUrl(configService)],
              queue: configService.get<string>(
                'RABBIT_QUEUE_RECORDS_AI',
                'records_ai_chats_analysis_events',
              ),
              queueOptions: { durable: true },
            },
          };
        },
        inject: [ConfigService],
      },
      {
        name: 'CUSTOMERS_MS_SERVICE',
        imports: [ConfigModule],
        useFactory: (configService: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [resolveRabbitMqUrl(configService)],
            queue: configService.get<string>(
              'RABBIT_QUEUE_CUSTOMERS_MS',
              'crm.customers.whatsapp_integration',
            ),
            queueOptions: { durable: true },
          },
        }),
        inject: [ConfigService],
      },
    ]),
  ],
  controllers: [WhatsappWebController],
  providers: [WhatsappWebService, WhatsappStorageService, WhatsappWebGateway, WhatsappAlertsService, RabbitService],
  exports: [WhatsappWebService, WhatsappStorageService, WhatsappAlertsService],
})
export class WhatsappWebModule { }


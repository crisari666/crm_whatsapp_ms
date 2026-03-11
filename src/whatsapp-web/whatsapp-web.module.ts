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
          const rabbitMqUser = configService.get<string>('RABBIT_MQ_USER', 'guest');
          const rabbitMqPass = configService.get<string>('RABBIT_MQ_PASS', 'guest');
          const rabbitMqUrl = `amqp://${rabbitMqUser}:${rabbitMqPass}@localhost:5672`;

          return {
            transport: Transport.RMQ,
            options: {
              urls: [rabbitMqUrl],
              queue: 'records_ai_chats_analysis_events', // where MS2 is listening
              queueOptions: { durable: true },
            },
          };
        },
        inject: [ConfigService],
      },
    ]),
  ],
  controllers: [WhatsappWebController],
  providers: [WhatsappWebService, WhatsappStorageService, WhatsappWebGateway, WhatsappAlertsService, RabbitService],
  exports: [WhatsappWebService, WhatsappStorageService, WhatsappAlertsService],
})
export class WhatsappWebModule { }


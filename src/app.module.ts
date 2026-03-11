import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { WhatsappWebModule } from './whatsapp-web/whatsapp-web.module';
import databaseConfig from './config/database.config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { RabbitService } from './rabbit.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig],
    }),
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => {
        return ({
          uri: configService.get<string>('database.uri'),
        })
      },
      inject: [ConfigService],
    }),

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
    WhatsappWebModule,
  ],
  controllers: [AppController],
  providers: [AppService, RabbitService],
})
export class AppModule { }

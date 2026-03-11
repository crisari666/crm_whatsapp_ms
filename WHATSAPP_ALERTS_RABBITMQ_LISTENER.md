# WhatsApp Alerts RabbitMQ Listener Implementation Guide

This document describes how to implement a RabbitMQ listener in your backend microservice to receive WhatsApp alert events.

## Overview

The WhatsApp Web microservice sends alert events through RabbitMQ whenever alerts are created. Each event includes a `eventType` field in the payload to identify the type of alert.

## Queue Configuration

- **Queue Name**: `records_ai_chats_analysis_events`
- **Transport**: RabbitMQ
- **Exchange Type**: Default (direct)
- **Durability**: Queue is durable

## Event Types

The following event types are sent:

1. `whatsapp.alert.disconnected` - When a WhatsApp session is disconnected
2. `whatsapp.alert.message_deleted` - When a message is deleted
3. `whatsapp.alert.message_edited` - When a message is edited
4. `whatsapp.alert.chat_removed` - When a chat is removed

## Event Payload Structure

All events follow a consistent structure:

```typescript
{
  eventType: string; // The event type identifier
  alert: {
    _id: string; // MongoDB ObjectId as string
    session: string; // Session ObjectId as string
    sessionId: string; // Session ID string
    type: string; // Alert type: 'disconnected' | 'message_deleted' | 'message_edited' | 'chat_removed'
    message?: string; // Optional human-readable message
    isRead: boolean; // Whether the alert has been read
    createdAt?: Date; // Alert creation timestamp
    updatedAt?: Date; // Alert last update timestamp
    // Type-specific fields (only present for relevant alert types):
    messageId?: string; // For message_deleted and message_edited
    chatId?: string; // For message_deleted, message_edited, and chat_removed
    timestamp?: number; // Unix timestamp for message_deleted, message_edited, and chat_removed
  }
}
```

## Event-Specific Payloads

### 1. whatsapp.alert.disconnected

```json
{
  "eventType": "whatsapp.alert.disconnected",
  "alert": {
    "_id": "507f1f77bcf86cd799439011",
    "session": "507f1f77bcf86cd799439012",
    "sessionId": "session_123",
    "type": "disconnected",
    "message": "WhatsApp session disconnected",
    "isRead": false,
    "createdAt": "2024-01-15T10:30:00.000Z",
    "updatedAt": "2024-01-15T10:30:00.000Z"
  }
}
```

### 2. whatsapp.alert.message_deleted

```json
{
  "eventType": "whatsapp.alert.message_deleted",
  "alert": {
    "_id": "507f1f77bcf86cd799439013",
    "session": "507f1f77bcf86cd799439012",
    "sessionId": "session_123",
    "type": "message_deleted",
    "messageId": "msg_456",
    "chatId": "chat_789",
    "timestamp": 1705312200000,
    "message": "--",
    "isRead": false,
    "createdAt": "2024-01-15T10:30:00.000Z",
    "updatedAt": "2024-01-15T10:30:00.000Z"
  }
}
```

### 3. whatsapp.alert.message_edited

```json
{
  "eventType": "whatsapp.alert.message_edited",
  "alert": {
    "_id": "507f1f77bcf86cd799439014",
    "session": "507f1f77bcf86cd799439012",
    "sessionId": "session_123",
    "type": "message_edited",
    "messageId": "msg_456",
    "chatId": "chat_789",
    "timestamp": 1705312200000,
    "message": "Message edited: msg_456",
    "isRead": false,
    "createdAt": "2024-01-15T10:30:00.000Z",
    "updatedAt": "2024-01-15T10:30:00.000Z"
  }
}
```

### 4. whatsapp.alert.chat_removed

```json
{
  "eventType": "whatsapp.alert.chat_removed",
  "alert": {
    "_id": "507f1f77bcf86cd799439015",
    "session": "507f1f77bcf86cd799439012",
    "sessionId": "session_123",
    "type": "chat_removed",
    "chatId": "chat_789",
    "timestamp": 1705312200000,
    "message": "Chat removed: chat_789",
    "isRead": false,
    "createdAt": "2024-01-15T10:30:00.000Z",
    "updatedAt": "2024-01-15T10:30:00.000Z"
  }
}
```

## Implementation Examples

### NestJS Implementation

```typescript
import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload, Ctx, RmqContext } from '@nestjs/microservices';
import { RabbitMQService } from './rabbitmq.service'; // Your service to handle the events

@Controller()
export class WhatsAppAlertsListenerController {
  private readonly logger = new Logger(WhatsAppAlertsListenerController.name);

  constructor(private readonly rabbitMQService: RabbitMQService) {}

  @EventPattern('whatsapp.alert.disconnected')
  async handleDisconnectedAlert(
    @Payload() data: { eventType: string; alert: any },
    @Ctx() context: RmqContext,
  ) {
    this.logger.log(`Received disconnected alert: ${JSON.stringify(data)}`);
    
    try {
      // Process the disconnected alert
      await this.rabbitMQService.processDisconnectedAlert(data.alert);
      
      // Acknowledge the message
      const channel = context.getChannelRef();
      const originalMsg = context.getMessage();
      channel.ack(originalMsg);
    } catch (error) {
      this.logger.error('Error processing disconnected alert', error);
      // Optionally: reject and requeue or send to DLQ
      const channel = context.getChannelRef();
      const originalMsg = context.getMessage();
      channel.nack(originalMsg, false, true); // requeue
    }
  }

  @EventPattern('whatsapp.alert.message_deleted')
  async handleMessageDeletedAlert(
    @Payload() data: { eventType: string; alert: any },
    @Ctx() context: RmqContext,
  ) {
    this.logger.log(`Received message deleted alert: ${JSON.stringify(data)}`);
    
    try {
      await this.rabbitMQService.processMessageDeletedAlert(data.alert);
      
      const channel = context.getChannelRef();
      const originalMsg = context.getMessage();
      channel.ack(originalMsg);
    } catch (error) {
      this.logger.error('Error processing message deleted alert', error);
      const channel = context.getChannelRef();
      const originalMsg = context.getMessage();
      channel.nack(originalMsg, false, true);
    }
  }

  @EventPattern('whatsapp.alert.message_edited')
  async handleMessageEditedAlert(
    @Payload() data: { eventType: string; alert: any },
    @Ctx() context: RmqContext,
  ) {
    this.logger.log(`Received message edited alert: ${JSON.stringify(data)}`);
    
    try {
      await this.rabbitMQService.processMessageEditedAlert(data.alert);
      
      const channel = context.getChannelRef();
      const originalMsg = context.getMessage();
      channel.ack(originalMsg);
    } catch (error) {
      this.logger.error('Error processing message edited alert', error);
      const channel = context.getChannelRef();
      const originalMsg = context.getMessage();
      channel.nack(originalMsg, false, true);
    }
  }

  @EventPattern('whatsapp.alert.chat_removed')
  async handleChatRemovedAlert(
    @Payload() data: { eventType: string; alert: any },
    @Ctx() context: RmqContext,
  ) {
    this.logger.log(`Received chat removed alert: ${JSON.stringify(data)}`);
    
    try {
      await this.rabbitMQService.processChatRemovedAlert(data.alert);
      
      const channel = context.getChannelRef();
      const originalMsg = context.getMessage();
      channel.ack(originalMsg);
    } catch (error) {
      this.logger.error('Error processing chat removed alert', error);
      const channel = context.getChannelRef();
      const originalMsg = context.getMessage();
      channel.nack(originalMsg, false, true);
    }
  }
}
```

### Generic Handler (Single Method for All Events)

```typescript
import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload, Ctx, RmqContext } from '@nestjs/microservices';

@Controller()
export class WhatsAppAlertsListenerController {
  private readonly logger = new Logger(WhatsAppAlertsListenerController.name);

  constructor(private readonly alertProcessorService: AlertProcessorService) {}

  @EventPattern('whatsapp.alert.*')
  async handleWhatsAppAlert(
    @Payload() data: { eventType: string; alert: any },
    @Ctx() context: RmqContext,
  ) {
    this.logger.log(`Received alert event: ${data.eventType}`);
    
    try {
      // Route to appropriate handler based on eventType
      switch (data.eventType) {
        case 'whatsapp.alert.disconnected':
          await this.alertProcessorService.processDisconnectedAlert(data.alert);
          break;
        case 'whatsapp.alert.message_deleted':
          await this.alertProcessorService.processMessageDeletedAlert(data.alert);
          break;
        case 'whatsapp.alert.message_edited':
          await this.alertProcessorService.processMessageEditedAlert(data.alert);
          break;
        case 'whatsapp.alert.chat_removed':
          await this.alertProcessorService.processChatRemovedAlert(data.alert);
          break;
        default:
          this.logger.warn(`Unknown event type: ${data.eventType}`);
      }
      
      // Acknowledge the message
      const channel = context.getChannelRef();
      const originalMsg = context.getMessage();
      channel.ack(originalMsg);
    } catch (error) {
      this.logger.error(`Error processing alert ${data.eventType}`, error);
      const channel = context.getChannelRef();
      const originalMsg = context.getMessage();
      channel.nack(originalMsg, false, true); // requeue on error
    }
  }
}
```

### Module Configuration

```typescript
import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { WhatsAppAlertsListenerController } from './whatsapp-alerts-listener.controller';

@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: 'RABBITMQ_SERVICE',
        imports: [ConfigModule],
        useFactory: (configService: ConfigService) => {
          const rabbitMqUser = configService.get<string>('RABBIT_MQ_USER', 'guest');
          const rabbitMqPass = configService.get<string>('RABBIT_MQ_PASS', 'guest');
          const rabbitMqHost = configService.get<string>('RABBIT_MQ_HOST', 'localhost');
          const rabbitMqPort = configService.get<string>('RABBIT_MQ_PORT', '5672');
          const rabbitMqUrl = `amqp://${rabbitMqUser}:${rabbitMqPass}@${rabbitMqHost}:${rabbitMqPort}`;

          return {
            transport: Transport.RMQ,
            options: {
              urls: [rabbitMqUrl],
              queue: 'records_ai_chats_analysis_events',
              queueOptions: {
                durable: true,
              },
              // Enable message acknowledgment
              noAck: false,
            },
          };
        },
        inject: [ConfigService],
      },
    ]),
  ],
  controllers: [WhatsAppAlertsListenerController],
  providers: [AlertProcessorService],
})
export class WhatsAppAlertsModule {}
```

### main.ts Configuration

```typescript
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);

  // Connect RabbitMQ microservice
  const rabbitMqUser = configService.get<string>('RABBIT_MQ_USER', 'guest');
  const rabbitMqPass = configService.get<string>('RABBIT_MQ_PASS', 'guest');
  const rabbitMqHost = configService.get<string>('RABBIT_MQ_HOST', 'localhost');
  const rabbitMqPort = configService.get<string>('RABBIT_MQ_PORT', '5672');
  const rabbitMqUrl = `amqp://${rabbitMqUser}:${rabbitMqPass}@${rabbitMqHost}:${rabbitMqPort}`;

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.RMQ,
    options: {
      urls: [rabbitMqUrl],
      queue: 'records_ai_chats_analysis_events',
      queueOptions: {
        durable: true,
      },
      noAck: false, // Enable manual acknowledgment
    },
  });

  await app.startAllMicroservices();
  await app.listen(3000);
}
bootstrap();
```

## TypeScript Interfaces

For type safety, you can define interfaces:

```typescript
export interface WhatsAppAlertPayload {
  eventType: string;
  alert: {
    _id: string;
    session: string;
    sessionId: string;
    type: 'disconnected' | 'message_deleted' | 'message_edited' | 'chat_removed';
    message?: string;
    isRead: boolean;
    createdAt?: Date;
    updatedAt?: Date;
    messageId?: string;
    chatId?: string;
    timestamp?: number;
  };
}

export interface DisconnectedAlert extends WhatsAppAlertPayload {
  eventType: 'whatsapp.alert.disconnected';
}

export interface MessageDeletedAlert extends WhatsAppAlertPayload {
  eventType: 'whatsapp.alert.message_deleted';
  alert: WhatsAppAlertPayload['alert'] & {
    messageId: string;
    chatId: string;
    timestamp: number;
  };
}

export interface MessageEditedAlert extends WhatsAppAlertPayload {
  eventType: 'whatsapp.alert.message_edited';
  alert: WhatsAppAlertPayload['alert'] & {
    messageId: string;
    chatId: string;
    timestamp: number;
  };
}

export interface ChatRemovedAlert extends WhatsAppAlertPayload {
  eventType: 'whatsapp.alert.chat_removed';
  alert: WhatsAppAlertPayload['alert'] & {
    chatId: string;
    timestamp: number;
  };
}
```

## Error Handling

- Always acknowledge messages after successful processing
- Use `nack` with requeue option for transient errors
- Consider implementing a Dead Letter Queue (DLQ) for messages that fail repeatedly
- Log all errors for debugging and monitoring

## Environment Variables

Ensure the following environment variables are set:

```bash
RABBIT_MQ_USER=guest
RABBIT_MQ_PASS=guest
RABBIT_MQ_HOST=localhost
RABBIT_MQ_PORT=5672
```

## Testing

You can test the listener by:

1. Using RabbitMQ Management UI to publish test messages
2. Creating alerts in the WhatsApp Web service
3. Using a RabbitMQ client library to publish test events

## Monitoring

- Monitor queue depth to ensure messages are being processed
- Set up alerts for unacknowledged messages
- Track processing times and error rates
- Monitor RabbitMQ connection health


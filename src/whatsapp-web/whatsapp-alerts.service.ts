import { Injectable, Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import { RabbitService } from '../rabbit.service';

@Injectable()
export class WhatsappAlertsService {
  private readonly logger = new Logger(WhatsappAlertsService.name);

  constructor(
    private readonly rabbitService: RabbitService,
  ) {}

  async createDisconnectedAlert(sessionObjectId: Types.ObjectId, sessionId: string, message?: string) {
    try {
      const alertData = {
        _id: new Types.ObjectId().toString(),
        session: sessionObjectId.toString(),
        sessionId,
        type: 'disconnected',
        message: message ?? 'WhatsApp session disconnected',
        isRead: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Send event to RabbitMQ
      this.rabbitService.emitToRecordsAiChatsAnalysisService('whatsapp.alert.disconnected', {
        eventType: 'whatsapp.alert.disconnected',
        alert: alertData,
      });

      this.logger.log(`Disconnected alert event sent for session: ${sessionId}`);
      return alertData;
    } catch (error) {
      this.logger.error('Failed to send disconnected alert event', error as Error);
      throw error;
    }
  }


  async createMessageDeletedAlert(
    sessionObjectId: Types.ObjectId,
    sessionId: string,
    messageId: string,
    chatId: string,
    timestamp?: number,
    message?: string,
  ) {
    try {
      const alertData = {
        _id: new Types.ObjectId().toString(),
        session: sessionObjectId.toString(),
        sessionId,
        type: 'message_deleted',
        messageId,
        chatId,
        timestamp: timestamp || Date.now(),
        message: message || `--`,
        isRead: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Send event to RabbitMQ
      this.rabbitService.emitToRecordsAiChatsAnalysisService('whatsapp.alert.message_deleted', {
        eventType: 'whatsapp.alert.message_deleted',
        alert: alertData,
      });

      this.logger.log(`Message deleted alert event sent for session: ${sessionId}, messageId: ${messageId}`);
      return alertData;
    } catch (error) {
      this.logger.error('Failed to send message deleted alert event', error as Error);
      throw error;
    }
  }

  async createMessageEditedAlert(
    sessionObjectId: Types.ObjectId,
    sessionId: string,
    messageId: string,
    chatId: string,
    timestamp?: number,
    message?: string,
  ) {
    try {
      const alertData = {
        _id: new Types.ObjectId().toString(),
        session: sessionObjectId.toString(),
        sessionId,
        type: 'message_edited',
        messageId,
        chatId,
        timestamp: timestamp || Date.now(),
        message: message || `Message edited: ${messageId}`,
        isRead: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Send event to RabbitMQ
      this.rabbitService.emitToRecordsAiChatsAnalysisService('whatsapp.alert.message_edited', {
        eventType: 'whatsapp.alert.message_edited',
        alert: alertData,
      });

      this.logger.log(`Message edited alert event sent for session: ${sessionId}, messageId: ${messageId}`);
      return alertData;
    } catch (error) {
      this.logger.error('Failed to send message edited alert event', error as Error);
      throw error;
    }
  }

  async createChatRemovedAlert(
    sessionObjectId: Types.ObjectId,
    sessionId: string,
    chatId: string,
    timestamp?: number,
    message?: string,
  ) {
    try {
      const alertData = {
        _id: new Types.ObjectId().toString(),
        session: sessionObjectId.toString(),
        sessionId,
        type: 'chat_removed',
        chatId,
        timestamp: timestamp || Date.now(),
        message: message || `Chat removed: ${chatId}`,
        isRead: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Send event to RabbitMQ
      this.rabbitService.emitToRecordsAiChatsAnalysisService('whatsapp.alert.chat_removed', {
        eventType: 'whatsapp.alert.chat_removed',
        alert: alertData,
      });

      this.logger.log(`Chat removed alert event sent for session: ${sessionId}, chatId: ${chatId}`);
      return alertData;
    } catch (error) {
      this.logger.error('Failed to send chat removed alert event', error as Error);
      throw error;
    }
  }
}



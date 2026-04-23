import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model, Types } from 'mongoose';
import { WhatsAppChat, WhatsAppChatDocument } from './schemas/whatsapp-chat.schema';
import { WhatsAppMessage, WhatsAppMessageDocument } from './schemas/whatsapp-message.schema';
import type {
  NormalizedChat,
  NormalizedMedia,
  NormalizedMessage,
  WhatsappChatContactSnapshot,
} from './types/normalized-whatsapp.types';
import * as path from 'path';
import * as fs from 'fs/promises';
import { RabbitService } from 'src/rabbit.service';

/**
 * Digits from the WhatsApp JID user part (before @). Used when {@link WhatsappChatContactSnapshot.userId}
 * is missing (common for @lid peers) so the customers-ms RPC lookup can still run.
 */
function digitsFromChatId(chatId: string): string | null {
  if (!chatId || chatId.endsWith('@g.us')) {
    return null;
  }
  const userPart = chatId.split('@')[0] ?? '';
  const digits = userPart.replace(/\D/g, '');
  return digits.length > 0 ? digits : null;
}

@Injectable()
export class WhatsappStorageService {
  private readonly logger = new Logger(WhatsappStorageService.name);
  private readonly mediaPath = path.join(process.cwd(), 'media');

  constructor(
    @InjectModel(WhatsAppChat.name) private whatsAppChatModel: Model<WhatsAppChatDocument>,
    @InjectModel(WhatsAppMessage.name) private whatsAppMessageModel: Model<WhatsAppMessageDocument>,
    private readonly rabbitService: RabbitService,
  ) {
    // Ensure media directory exists
    this.ensureMediaDirectory();
  }

  /**
   * Ensure media directory exists
   */
  private async ensureMediaDirectory(): Promise<void> {
    try {
      await fs.mkdir(this.mediaPath, { recursive: true });
      this.logger.log(`📁 Media directory ensured: ${this.mediaPath}`);
    } catch (error) {
      this.logger.error(`Error creating media directory: ${error.message}`);
    }
  }

  /**
   * Save or update a chat in the database
   * Validates if the chat already exists to avoid duplicates
   */
  async saveChat(
    sessionId: string,
    chat: NormalizedChat,
    options?: {
      customerId?: string | null;
      userSessionId?: string;
      contact?: WhatsappChatContactSnapshot | null;
    },
  ): Promise<string | null> {
    try {
      const chatData: Record<string, unknown> = {
        chatId: chat.chatId,
        sessionId,
        name: chat.name,
        isGroup: chat.isGroup,
        unreadCount: chat.unreadCount,
        timestamp: chat.timestamp,
        archived: chat.archived,
        pinned: chat.pinned,
        isReadOnly: chat.isReadOnly,
        isMuted: chat.isMuted,
        muteExpiration: chat.muteExpiration,
        lastMessage: chat.lastMessage ?? null,
        lastMessageTimestamp: chat.lastMessageTimestamp ?? null,
        lastMessageFromMe: chat.lastMessageFromMe,
        deleted: false,
      };
      const validSessionOwner =
        options?.userSessionId !== undefined && options.userSessionId === sessionId;
      if (validSessionOwner) {
        chatData.userSessionId = options.userSessionId;
      }
      if (options?.contact?.userId) {
        chatData.contact = options.contact;
      }

      // Sync path: RPC customers-ms during save so chat gets customerId immediately when match exists.
      let resolvedCustomerId: string | null = null;
      if (validSessionOwner && options?.customerId && isValidObjectId(options.customerId)) {
        resolvedCustomerId = options.customerId;
      } else if (validSessionOwner) {
        const waUserId = options?.contact?.userId?.replace(/\D/g, '') || null;
        console.log('waUserId', waUserId);
        resolvedCustomerId = await this.resolveCustomerIdForChat(
          sessionId,
          chat.chatId,
          waUserId,
        );
      }
      if (validSessionOwner && resolvedCustomerId && isValidObjectId(resolvedCustomerId)) {
        chatData.customerId = new Types.ObjectId(resolvedCustomerId);
      }

      await this.whatsAppChatModel.findOneAndUpdate(
        { chatId: chat.chatId, sessionId },
        { $set: chatData, $setOnInsert: { deletedAt: [] } },
        { upsert: true, new: true }
      );
      this.logger.debug(`💾 Chat saved: ${chat.chatId}`);
      return resolvedCustomerId;
    } catch (error) {
      this.logger.error(`Error saving chat: ${(error as Error).message}`);
      throw error;
    }
  }

  private async resolveCustomerIdForChat(
    sessionId: string,
    chatId: string,
    whatsappUserId: string | null,
  ): Promise<string | null> {
    if (!chatId || chatId.endsWith('@g.us')) {
      return null;
    }
    const existing = await this.whatsAppChatModel
      .findOne({ sessionId, chatId })
      .select('customerId')
      .lean()
      .exec();
    const existingCustomerId =
      existing && typeof existing === 'object' && 'customerId' in existing && existing.customerId
        ? String(existing.customerId)
        : null;
    if (existingCustomerId && isValidObjectId(existingCustomerId)) {
      return existingCustomerId;
    }
    const phone = (whatsappUserId ?? '').replace(/\D/g, '');
    console.log('phone', phone);
    if (!phone) {
      return null;
    }

    try {
      const lookup = await this.rabbitService.lookupCustomerByWhatsappPhone({
        phone,
        userSessionId: sessionId,
      });
      if (!lookup?.found || !lookup.customerId || !isValidObjectId(lookup.customerId)) {
        return null;
      }
      return lookup.customerId;
    } catch (error) {
      this.logger.warn(
        `Customer lookup failed for chat ${chatId}: ${(error as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Save multiple chats (batch operation)
   */
  async saveChats(
    sessionId: string,
    chats: NormalizedChat[],
    options?: { userSessionId?: string },
    onProgress?: (currentIndex: number, total: number, chat: NormalizedChat) => void | Promise<void>
  ): Promise<void> {
    try {
      const total = chats.length;
      for (let i = 0; i < chats.length; i++) {
        const chat = chats[i];
        const chatData: Record<string, unknown> = {
          chatId: chat.chatId,
          sessionId,
          name: chat.name,
          isGroup: chat.isGroup,
          unreadCount: chat.unreadCount,
          timestamp: chat.timestamp,
          archived: chat.archived,
          pinned: chat.pinned,
          isReadOnly: chat.isReadOnly,
          isMuted: chat.isMuted,
          muteExpiration: chat.muteExpiration,
          lastMessage: chat.lastMessage ?? null,
          lastMessageTimestamp: chat.lastMessageTimestamp ?? null,
          lastMessageFromMe: chat.lastMessageFromMe,
          deleted: false,
        };
        if (options?.userSessionId && options.userSessionId === sessionId) {
          chatData.userSessionId = options.userSessionId;
        }
        await this.whatsAppChatModel.findOneAndUpdate(
          { chatId: chat.chatId, sessionId },
          { $set: chatData, $setOnInsert: { deletedAt: [] } },
          { upsert: true, new: true }
        );
        if (onProgress) {
          await onProgress(i + 1, total, chat);
        }
      }
      this.logger.log(`💾 Saved ${chats.length} chats for session ${sessionId}`);
    } catch (error) {
      this.logger.error(`Error saving chats: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Save or update a message in the database
   */
  async saveMessage(sessionId: string, message: NormalizedMessage, chatId?: string): Promise<void> {
    try {
      const messageChatId = chatId ?? message.chatId;
      const messageData = {
        messageId: message.messageId,
        sessionId,
        chatId: messageChatId,
        body: message.body,
        type: message.type,
        from: message.from,
        to: message.to,
        author: message.author,
        fromMe: message.fromMe,
        isForwarded: message.isForwarded,
        forwardingScore: message.forwardingScore,
        isStatus: message.isStatus,
        hasMedia: message.hasMedia,
        mediaType: message.mediaType,
        mediaPath: null,
        mediaSize: null,
        mediaFilename: null,
        hasQuotedMsg: message.hasQuotedMsg,
        isStarred: message.isStarred,
        isGif: message.isGif,
        isEphemeral: message.isEphemeral,
        timestamp: message.timestamp,
        ack: message.ack,
        deletedAt: null,
        deletedBy: null,
        edition: [],
        deviceType: message.deviceType,
        broadcast: message.broadcast,
        mentionedIds: message.mentionedIds,
        rawData: message.rawData ?? {},
      };
      const existingMessage = await this.whatsAppMessageModel.findOne({
        messageId: message.messageId,
        sessionId,
      });
      if (!existingMessage) {
        await this.whatsAppMessageModel.create({ ...messageData, isDeleted: false });
        this.logger.debug(`💾 Message saved: ${messageChatId}`);
      } else {
        if (existingMessage.isDeleted) {
          return;
        }
        await this.whatsAppMessageModel.updateOne(
          { messageId: message.messageId, sessionId },
          { $set: messageData }
        );
        this.logger.debug(`✏️ Message updated: ${message.messageId}`);
      }
    } catch (error) {
      this.logger.error(`Error saving message: ${(error as Error).message}`);
    }
  }

  /**
   * Batch save messages (more efficient for bulk operations)
   */
  async saveMessages(
    sessionId: string,
    messages: NormalizedMessage[],
    chatId?: string,
    onProgress?: (messagesSaved: number) => void | Promise<void>
  ): Promise<void> {
    try {
      if (messages.length === 0) {
        return;
      }
      const operations = messages.map((message) => {
        const messageChatId = chatId ?? message.chatId;
        return {
          updateOne: {
            filter: { messageId: message.messageId, sessionId },
            update: {
              $set: {
                messageId: message.messageId,
                sessionId,
                chatId: messageChatId,
                body: message.body,
                type: message.type,
                from: message.from,
                to: message.to,
                author: message.author,
                fromMe: message.fromMe,
                isForwarded: message.isForwarded,
                forwardingScore: message.forwardingScore,
                isStatus: message.isStatus,
                hasMedia: message.hasMedia,
                mediaType: message.mediaType,
                mediaPath: null,
                mediaSize: null,
                mediaFilename: null,
                hasQuotedMsg: message.hasQuotedMsg,
                isStarred: message.isStarred,
                isGif: message.isGif,
                isEphemeral: message.isEphemeral,
                timestamp: message.timestamp,
                ack: message.ack,
                isDeleted: false,
                deletedAt: null,
                deletedBy: null,
                edition: [],
                deviceType: message.deviceType,
                broadcast: message.broadcast,
                mentionedIds: message.mentionedIds,
                rawData: message.rawData ?? {},
              },
              $setOnInsert: { createdAt: new Date() },
            },
            upsert: true,
          },
        };
      });
      await this.whatsAppMessageModel.bulkWrite(operations);
      this.logger.log(`💾 Batch saved ${messages.length} messages for session ${sessionId}`);
      if (onProgress) {
        await onProgress(messages.length);
      }
    } catch (error) {
      this.logger.error(`Error batch saving messages: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Mark message as deleted
   */
  async markMessageAsDeleted(sessionId: string, messageId: string, deletedBy: string = 'everyone'): Promise<void> {
    try {
      await this.whatsAppMessageModel.updateOne(
        { messageId, sessionId },
        {
          $set: {
            isDeleted: true,
            deletedAt: new Date(),
            deletedBy,
          }
        }
      );

      this.logger.debug(`🗑️ Message marked as deleted: ${messageId} by ${deletedBy}`);
    } catch (error) {
      this.logger.error(`Error marking message as deleted: ${error.message}`);
    }
  }

  /**
   * Update message edition history
   */
  async updateMessageEdition(
    sessionId: string,
    messageId: string,
    newBody: string,
    prevBody: string
  ): Promise<void> {
    try {
      const existingMessage = await this.whatsAppMessageModel.findOne({
        messageId,
        sessionId,
      });
      const editionHistory = existingMessage?.edition ?? [];
      editionHistory.push(prevBody);
      await this.whatsAppMessageModel.updateOne(
        { messageId, sessionId },
        { $set: { body: newBody, edition: editionHistory } }
      );
      this.logger.debug(`✏️ Message edition saved: ${messageId}`);
    } catch (error) {
      this.logger.error(`Error updating message edition: ${(error as Error).message}`);
    }
  }

  /**
   * Get all chats from database for a session
   */
  async getStoredChats(sessionId: string, options?: {
    archived?: boolean;
    isGroup?: boolean;
    limit?: number;
    skip?: number;
  }): Promise<WhatsAppChat[]> {
    try {
      const query: any = { sessionId };

      if (options?.archived !== undefined) {
        query.archived = options.archived;
      }
      if (options?.isGroup !== undefined) {
        query.isGroup = options.isGroup;
      }

      const chats = await this.whatsAppChatModel
        .find(query)
        .sort({ timestamp: -1 })
        .limit(options?.limit || 500)
        .skip(options?.skip || 0)
        .exec();

      return chats;
    } catch (error) {
      this.logger.error(`Error getting stored chats: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get a specific chat from database
   */
  async getStoredChat(sessionId: string, chatId: string): Promise<WhatsAppChat | null> {
    try {
      const chat = await this.whatsAppChatModel
        .findOne({ sessionId, chatId })
        .exec();

      return chat;
    } catch (error) {
      this.logger.error(`Error getting stored chat: ${error.message}`);
      throw error;
    }
  }

  /**
   * Mark chat as deleted
   */
  async markChatAsDeleted(sessionId: string, chatId: string): Promise<void> {
    try {
      const deletionDate = new Date();

      const chat = await this.whatsAppChatModel.findOne({ chatId, sessionId });
      if (!chat) {
        this.logger.warn(`Chat not found: ${chatId} in session ${sessionId}`);
        return;
      }
      await this.whatsAppChatModel.updateOne(
        { chatId, sessionId },
        {
          $set: {
            deleted: true,
          },
          $push: {
            deletedAt: deletionDate,
          }
        }
      );

      this.logger.debug(`🗑️ Chat marked as deleted: ${chatId} in session ${sessionId} at ${deletionDate.toISOString()}`);
    } catch (error) {
      this.logger.error(`Error marking chat as deleted: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get all stored messages from database
   */
  async getStoredMessages(sessionId: string, chatId?: string, options?: {
    includeDeleted?: boolean;
    limit?: number;
    skip?: number;
    startTimestamp?: number;
    endTimestamp?: number;
  }): Promise<WhatsAppMessage[]> {
    try {
      const query: any = { sessionId };

      if (chatId) {
        query.chatId = chatId;
      }

      if (!options?.includeDeleted) {
        query.isDeleted = false;
      }

      if (options?.startTimestamp) {
        query.timestamp = { $gte: options.startTimestamp };
      }

      if (options?.endTimestamp) {
        if (!query.timestamp) {
          query.timestamp = {};
        }
        query.timestamp.$lte = options.endTimestamp;
      }

      const messages = await this.whatsAppMessageModel
        .find(query)
        .sort({ timestamp: -1 })
        .limit(options?.limit || 50)
        .skip(options?.skip || 0)
        .exec();

      return messages;
    } catch (error) {
      this.logger.error(`Error getting stored messages: ${error.message}`);
      throw error;
    }
  }

  /**
   * Save media file to local storage
   * @param sessionId - Session ID
   * @param messageId - Message ID
   * @param media - Media object from WhatsApp
   * @returns Media file path relative to media directory
   */
  async saveMediaFile(sessionId: string, messageId: string, media: NormalizedMedia): Promise<{
    mediaPath: string;
    mediaSize: number;
    mediaFilename: string;
  } | null> {
    try {
      if (!media || !media.data) {
        this.logger.warn(`No media data to save for message ${messageId}`);
        return null;
      }

      // Determine file extension from mimetype
      const extension = this.getFileExtension(media.mimetype);
      if (!extension) {
        this.logger.warn(`Unknown mimetype: ${media.mimetype} for message ${messageId}`);
        return null;
      }

      // Create session-specific directory
      const sessionMediaPath = path.join(this.mediaPath, sessionId);
      await fs.mkdir(sessionMediaPath, { recursive: true });

      // Generate filename: messageId.extension
      const filename = `${messageId.replace(/[^a-zA-Z0-9]/g, '_')}.${extension}`;
      const filePath = path.join(sessionMediaPath, filename);

      // Convert base64 data to buffer
      const buffer = Buffer.from(media.data, 'base64');

      // Save file
      await fs.writeFile(filePath, buffer);

      // Calculate file size
      const stats = await fs.stat(filePath);
      const fileSize = stats.size;

      // Return relative path for easy access (e.g., sessionId/filename)
      const relativePath = path.join(sessionId, filename).replace(/\\/g, '/');

      this.logger.log(`💾 Media file saved: ${relativePath} (${fileSize} bytes)`);

      return {
        mediaPath: relativePath,
        mediaSize: fileSize,
        mediaFilename: media.filename || filename,
      };
    } catch (error) {
      this.logger.error(`Error saving media file for message ${messageId}: ${error.message}`);
      return null;
    }
  }

  /**
   * Get file extension from mimetype
   */
  private getFileExtension(mimetype: string): string | null {
    const mimeToExt: { [key: string]: string } = {
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'video/mp4': 'mp4',
      'video/quicktime': 'mov',
      'video/x-msvideo': 'avi',
      'audio/ogg; codecs=opus': 'ogg',
      'audio/ogg': 'ogg',
      'audio/mpeg': 'mp3',
      'audio/mp4': 'm4a',
      'audio/webm': 'webm',
      'audio/aac': 'aac',
      'application/pdf': 'pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
      'application/msword': 'doc',
      'application/vnd.ms-excel': 'xls',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
      'text/plain': 'txt',
    };

    // Handle mimetype with parameters (e.g., "audio/ogg; codecs=opus")
    const baseMime = mimetype.split(';')[0].trim();
    return mimeToExt[baseMime] || mimeToExt[mimetype] || null;
  }

  /**
   * Update message with media path
   */
  async updateMessageMedia(
    sessionId: string,
    messageId: string,
    mediaInfo: { mediaPath: string; mediaSize: number; mediaFilename: string }
  ): Promise<void> {
    try {
      await this.whatsAppMessageModel.updateOne(
        { messageId, sessionId },
        {
          $set: {
            mediaPath: mediaInfo.mediaPath,
            mediaSize: mediaInfo.mediaSize,
            mediaFilename: mediaInfo.mediaFilename,
          }
        }
      );
      this.logger.debug(`✏️ Message media path updated: ${messageId}`);
    } catch (error) {
      this.logger.error(`Error updating message media path: ${error.message}`);
    }
  }

  async assignCustomerToChat(params: {
    sessionId: string;
    chatId: string;
    userSessionId: string;
    customerId: string;
  }): Promise<void> {
    try {
      console.log('Assigning customer to chat', params);
      if (!isValidObjectId(params.customerId)) {
        return;
      }
      await this.whatsAppChatModel.updateOne(
        {
          sessionId: params.sessionId,
          chatId: params.chatId,
          userSessionId: params.userSessionId,
        },
        {
          $set: {
            customerId: new Types.ObjectId(params.customerId),
          },
        },
      );
    } catch (error) {
      this.logger.error(`Error assigning customer to chat: ${(error as Error).message}`);
    }
  }
}


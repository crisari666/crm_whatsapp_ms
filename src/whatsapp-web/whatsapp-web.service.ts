// src/whatsapp-web/whatsapp-web.service.ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client, LocalAuth } from 'whatsapp-web.js';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import * as mongoose from 'mongoose';
import * as qrcode from 'qrcode-terminal';
import * as puppeteer from 'puppeteer';
import { WhatsAppSession, WhatsAppSessionDocument } from './schemas/whatsapp-session.schema';
import { WhatsAppMessage, WhatsAppMessageDocument } from './schemas/whatsapp-message.schema';
import { WhatsappStorageService } from './whatsapp-storage.service';
import { WhatsappWebGateway } from './whatsapp-web.gateway';
import * as path from 'path';
import * as fs from 'fs/promises';
import { WhatsappAlertsService } from './whatsapp-alerts.service';
import { RabbitService } from 'src/rabbit.service';

@Injectable()
export class WhatsappWebService implements OnModuleInit {
  private readonly logger = new Logger(WhatsappWebService.name);
  private readonly sessionPath = path.join(process.cwd(), '.wwebjs_auth');
  private sessions: Map<string, { client: Client; isReady: boolean; lastRestore?: Date; isRestoring?: boolean }> = new Map();
  private isInitializing = false;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(WhatsAppSession.name) private whatsAppSessionModel: mongoose.Model<WhatsAppSessionDocument>,
    @InjectModel(WhatsAppMessage.name) private whatsAppMessageModel: mongoose.Model<WhatsAppMessageDocument>,
    private readonly rabbitService: RabbitService,
    private readonly configService: ConfigService,
    private readonly storageService: WhatsappStorageService,
    private readonly gateway: WhatsappWebGateway,
    private readonly alertsService: WhatsappAlertsService,
  ) { }

  async onModuleInit() {
    this.logger.log('🚀 Initializing WhatsApp Web Service...');
    await this.initializeStoredSessions();
  }

  /**
   * Initialize stored sessions from local storage
   * Queries database for sessions with 'ready' or 'authenticated' status
   */
  private async initializeStoredSessions() {
    if (this.isInitializing) {
      this.logger.warn('Session initialization already in progress');
      return;
    }


    this.isInitializing = true;

    try {
      // Wait for MongoDB connection to be ready
      await this.connection.readyState;

      // Query for sessions with ready or authenticated status
      const documents = await this.whatsAppSessionModel.find({
        status: { $in: ['ready', 'authenticated'] }
      }).exec();

      this.logger.log(`📱 Found ${documents.length} ready/authenticated sessions in database`);

      if (documents.length === 0) {
        this.logger.log('No ready/authenticated sessions to restore');
        return;
      }

      // Extract unique session IDs from the documents
      const sessionIds = [...new Set(documents.map(doc => doc.sessionId))];

      for (const sessionId of sessionIds) {
        // Check if session is already active
        if (this.sessions.has(sessionId)) {
          this.logger.log(`Session ${sessionId} is already active, skipping...`);
          continue;
        }

        try {
          this.logger.log(`🔄 Attempting to restore session: ${sessionId}`);
          await this.createSession(sessionId, { isRestoring: true });
          this.logger.log(`✅ Session ${sessionId} restored successfully`);
        } catch (error) {
          this.logger.error(`❌ Failed to restore session ${sessionId}:`, error.message);
        }
      }

      this.logger.log(`📊 Total active sessions: ${this.sessions.size}`);
    } catch (error) {
      this.logger.error('Error initializing stored sessions:', error);
    } finally {
      this.isInitializing = false;
    }
  }

  /**
   * Store session metadata in MongoDB
   */
  private async storeSessionMetadata(sessionId: string, metadata: { status?: string; lastSeen?: Date; isDisconnected?: boolean; disconnectedAt?: Date; refId?: mongoose.Types.ObjectId; groupId?: mongoose.Types.ObjectId, qrCode?: string; title?: string }) {
    try {
      await this.whatsAppSessionModel.updateOne(
        { sessionId: sessionId },
        {
          $set: {
            sessionId: sessionId,
            ...metadata,
          }
        },
        { upsert: true }
      );
    } catch (error) {
      this.logger.error(`Error storing session metadata for ${sessionId}:`, error);
    }
  }

  /**
   * Setup event listeners for WhatsApp client
   */
  private setupClientListeners(client: Client, sessionId: string) {
    client.on('qr', async (qr) => {
      // Check if session is already ready to avoid emitting QR again
      const session = this.sessions.get(sessionId);
      if (session && session.isReady) {
        this.logger.warn(`⚠️ Session ${sessionId} is already ready, ignoring QR event`);
        return;
      }

      this.logger.log(`📱 QR received for session ${sessionId}`);
      qrcode.generate(qr, { small: true, width: 100, height: 100 });

      await this.storeSessionMetadata(sessionId, {
        status: 'qr_generated',
        lastSeen: new Date(),
        qrCode: qr
      });
      this.emitQrEvent(sessionId, qr);
    });

    client.on('ready', async () => {
      this.logger.log(`✅ Session ${sessionId} is ready!`);
      const session = this.sessions.get(sessionId);
      if (session) {
        session.isReady = true;
      }
      await this.storeSessionMetadata(sessionId, {
        status: 'ready',
        lastSeen: new Date(),
        isDisconnected: false,
        qrCode: null
      });

      // Only synchronize chats and messages for new sessions, not restored ones
      const isRestoring = session?.isRestoring || false;

      if (!isRestoring) {
        // Synchronize chats and messages with progress events
        try {
          this.logger.log(`🔄 Starting chat synchronization for session ${sessionId}`);
          
          const result = await this.syncChatsWithProgress(sessionId);
          this.logger.log(`✅ Chat synchronization completed for session ${sessionId}: ${result.chatsProcessed} chats`);

          // Emit to RabbitMQ after synchronization is complete
          const storedChats = await this.storageService.getStoredChats(sessionId);
          this.rabbitService.emitToRecordsAiChatsAnalysisService('session_ready', {
            sessionId: sessionId,
            chats: storedChats.map(chat => chat.chatId)
          });
          this.emitReadyEvent(sessionId);
        } catch (error) {
          this.logger.error(`Error synchronizing chats for session ${sessionId}: ${error.message}`);
          // Continue execution even if sync fails
        }
      } else {
        this.logger.log(`⏭️ Skipping chat synchronization for restored session ${sessionId}`);
        // Still emit ready event for restored sessions
        this.emitReadyEvent(sessionId);
      }
    });

    client.on('authenticated', async () => {
      this.logger.log(`🔐 Session ${sessionId} authenticated`);
      await this.storeSessionMetadata(sessionId, {
        status: 'authenticated',
        lastSeen: new Date()
      });
    });

    client.on('auth_failure', async (error) => {
      this.logger.error(`❌ Session ${sessionId} authentication failed:`, error);
      await this.storeSessionMetadata(sessionId, {
        status: 'auth_failure',
        lastSeen: new Date()
      });
      this.emitAuthFailureEvent(sessionId, error);
    });

    client.on('message', async (message) => {
      console.log('On message event', {message});
      //await this.storageService.saveCall(sessionId, call);
    });


    client.on('message_create', async (message) => {
      try {
        console.log('message_create', {message});
        this.logger.log(`📤 Message received in session ${sessionId}: ${message.body?.substring(0, 50) || 'media message'}`);
        await this.storageService.saveMessage(sessionId, message);
        // Get the chat from the session and save/update it in the database
        try {
          const chat = await message.getChat();
          await this.storageService.saveChat(sessionId, chat);
          this.logger.debug(`💾 Chat saved/updated: ${chat.id._serialized}`);
        } catch (chatError) {
          this.logger.warn(`Error saving chat for message: ${chatError.message}`);
          // Continue execution even if chat save fails
        }
        // Emit socket event to the session room with the same structure as getStoredMessages
        const chatId = message.id.remote || message.from || message.to;
        const messageData: any = {
          messageId: message.id._serialized,
          chatId: chatId,
          body: message.body || '',
          type: message.type,
          from: message.from,
          to: message.to,
          author: message.author || null,
          fromMe: message.fromMe,
          timestamp: message.timestamp,
          isDeleted: false,
          deletedAt: null,
          deletedBy: null,
          edition: [],
          hasMedia: message.hasMedia || false,
          mediaType: message.hasMedia ? message.type : null,
          hasQuotedMsg: message.hasQuotedMsg || false,
          isForwarded: message.isForwarded || false,
          isStarred: message.isStarred || false,
        };

        // Handle media files
        if(message.hasMedia){
          try {
            const media = await message.downloadMedia();
            if (media && media.data) {
              // Save media file to local storage
              const mediaInfo = await this.storageService.saveMediaFile(
                sessionId,
                message.id._serialized,
                media
              );
              
              if (mediaInfo) {
                // Update message document with media path
                await this.storageService.updateMessageMedia(
                  sessionId,
                  message.id._serialized,
                  mediaInfo
                );
                
                // Add media info to message data for socket event
                messageData.mediaPath = mediaInfo.mediaPath;
                messageData.mediaSize = mediaInfo.mediaSize;
                messageData.mediaFilename = mediaInfo.mediaFilename;
                
                this.logger.log(`📎 Media saved for message ${message.id._serialized}: ${mediaInfo.mediaPath}`);
              }
            }
          } catch (mediaError) {
            this.logger.error(`Error downloading/saving media for message ${message.id._serialized}: ${mediaError.message}`);
            // Continue execution even if media save fails
          }
        }
        this.emitNewMessageEvent(sessionId, messageData);

        this.rabbitService.emitToRecordsAiChatsAnalysisService('message_create', {
          sessionId: sessionId,
          message: messageData
        });
      } catch (error) {
        this.logger.error(`Error handling message_create: ${error.message}`);
      }
    });

    client.on('call', async (call) => {
      console.log('call', {call});
      //await this.storageService.saveCall(sessionId, call);
    })
    
    client.on('chat_removed', async (chat) => {
      try {
        this.logger.log(`🗑️ Chat removed in session ${sessionId}: ${chat.id._serialized}`);
        await this.storageService.markChatAsDeleted(sessionId, chat.id._serialized);
        this.gateway.emitChatRemoved(sessionId, chat.id._serialized);
        
        // Create chat removed alert
        try {
          const sessionDoc = await this.whatsAppSessionModel.findOne({ sessionId }).exec();
          if (sessionDoc?._id) {
            await this.alertsService.createChatRemovedAlert(
              sessionDoc._id as mongoose.Types.ObjectId,
              sessionId,
              chat.id._serialized,
              chat.timestamp,
              `Chat removed: ${chat.name || chat.id._serialized}`
            );
          }
        } catch (e) {
          this.logger.error(`Failed to create chat removed alert for ${sessionId}`, e as Error);
        }
      } catch (error) {
        this.logger.error(`Error handling chat_removed: ${error.message}`);
      }
    });
  

    client.on('disconnected', async (reason) => {
      this.logger.warn(`⚠️ Session ${sessionId} disconnected: ${reason}`);
      const session = this.sessions.get(sessionId);
      if (session) {
        session.isReady = false;
      }

      await this.storeSessionMetadata(sessionId, {
        status: 'disconnected',
        lastSeen: new Date()
      });

      // Create a disconnection alert linked to the session's Mongo _id
      try {
        const sessionDoc = await this.whatsAppSessionModel.findOne({ sessionId }).exec();
        await this.whatsAppSessionModel.updateOne({ sessionId }, { $set: { isDisconnected: true, closedAt: new Date() } });
        if (sessionDoc?._id) {
          await this.alertsService.createDisconnectedAlert(sessionDoc._id as mongoose.Types.ObjectId, sessionId, `Session ${sessionId} disconnected: ${reason}`);
        }
      } catch (e) {
        this.logger.error(`Failed to create disconnected alert for ${sessionId}`, e as Error);
      }

      this.sessions.delete(sessionId);
      // Auto-reconnect after 5 seconds
      // setTimeout(async () => {
      // this.logger.log(`🔄 Attempting to reconnect session ${sessionId}`);
      //await this.createSession(sessionId);
      // }, 5000);
    });

    client.on('message_revoke_me', async (message) => {
      try {
        this.logger.log(`🗑️ Message revoked (me) in session ${sessionId}: ${message.body?.substring(0, 50) || 'media message'}`);
        await this.storageService.markMessageAsDeleted(sessionId, message.id._serialized, 'me');
        
        const chatId = message.id.remote || message.from || message.to;
        if (chatId) {
          this.gateway.emitMessageDeleted(sessionId, chatId, message.id._serialized);
        }
        
        // Create message deleted alert
        try {
          const sessionDoc = await this.whatsAppSessionModel.findOne({ sessionId }).exec();
          if (sessionDoc?._id && chatId) {
            await this.alertsService.createMessageDeletedAlert(
              sessionDoc._id as mongoose.Types.ObjectId,
              sessionId,
              message.id._serialized,
              chatId,
              message.timestamp,
              `Message deleted by me: ${message.body?.substring(0, 50) || 'media message'}`
            );
          }
        } catch (e) {
          this.logger.error(`Failed to create message deleted alert for ${sessionId}`, e as Error);
        }
      } catch (error) {
        this.logger.error(`Error handling message_revoke_me: ${error.message}`);
      }
    });

    client.on('message_revoke_everyone', async (message, revokedMsg) => {
      try {
        this.logger.log(`🗑️ Message revoked (everyone) in session ${sessionId}: ${message.body?.substring(0, 50) || 'media message'}`);

        // If we have the revoked message, save it first
        if (revokedMsg) {
          await this.storageService.saveMessage(sessionId, message);
        }

        await this.storageService.markMessageAsDeleted(sessionId, revokedMsg.id._serialized, 'everyone');
        
        const chatId = message.id.remote || message.from || message.to;
        if (chatId) {
          this.gateway.emitMessageDeleted(sessionId, chatId, revokedMsg.id._serialized);
        }
        
        // Create message deleted alert
        try {
          const sessionDoc = await this.whatsAppSessionModel.findOne({ sessionId }).exec();
          if (sessionDoc?._id && chatId) {
            await this.alertsService.createMessageDeletedAlert(
              sessionDoc._id as mongoose.Types.ObjectId,
              sessionId,
              revokedMsg.id._serialized,
              chatId,
              revokedMsg.timestamp,
              `Message deleted for everyone: ${message.body?.substring(0, 50) || 'media message'}`
            );
          }
        } catch (e) {
          this.logger.error(`Failed to create message deleted alert for ${sessionId}`, e as Error);
        }
      } catch (error) {
        this.logger.error(`Error handling message_revoke_everyone: ${error.message}`);
      }
    });

    client.on('message_edit', async (message, newBody, prevBody) => {
      try {
        this.logger.log(`✏️ Message edited in session ${sessionId}: ${message.body?.substring(0, 50) || 'media message'}`);
        await this.storageService.updateMessageEdition(sessionId, message, String(newBody), String(prevBody));
        
        // Create message edited alert
        try {
          const sessionDoc = await this.whatsAppSessionModel.findOne({ sessionId }).exec();
          const chatId = message.id.remote || message.from || message.to;
          if (sessionDoc?._id && chatId) {
            await this.alertsService.createMessageEditedAlert(
              sessionDoc._id as mongoose.Types.ObjectId,
              sessionId,
              message.id._serialized,
              chatId,
              message.timestamp,
              `Message edited: ${String(newBody)?.substring(0, 50) || 'media message'}`
            );
          }
        } catch (e) {
          this.logger.error(`Failed to create message edited alert for ${sessionId}`, e as Error);
        }
      } catch (error) {
        this.logger.error(`Error handling message_edit: ${error.message}`);
      }
    });

    client.on('local_session_saved', async () => {
      this.logger.log(`💾 Session ${sessionId} data saved to local storage`);
    });

    client.on('remote_session_saved', async () => {
      this.logger.log(`💾 Session ${sessionId} data saved to MongoDB`);
    });


    client.on('loading_screen', (percent, message) => {
      this.logger.log(`📱 Session ${sessionId} loading: ${percent}% - ${message}`);
      // Emit sync event during loading
      this.gateway.emitSyncChats(sessionId, {
        nChats: 0,
        currentChat: 0,
        messagesSynced: 0,
      });
    });
  }

  /**
   * Remove session folder to clean up lock files
   */
  private async removeSessionFolder(sessionId: string): Promise<void> {
    try {
      const sessionFolder = path.join(this.sessionPath, `session-${sessionId}`);
      await fs.rm(sessionFolder, { recursive: true, force: true });
      this.logger.log(`🧹 Removed session folder: ${sessionFolder}`);
    } catch (error) {
      this.logger.warn(`⚠️ Error removing session folder for ${sessionId}: ${error.message}`);
    }
  }

  /**
   * Check if error is related to SingletonLock
   */
  private isSingletonLockError(error: any): boolean {
    const errorMessage = error?.message || error?.toString() || '';
    const errorStack = error?.stack || '';
    const fullError = `${errorMessage} ${errorStack}`;
    return fullError.includes('SingletonLock') ||
      fullError.includes('Failed to create a ProcessSingleton') ||
      (fullError.includes('File exists') && fullError.includes('session-'));
  }

  /**
   * Create a new WhatsApp session
   */
  async createSession(sessionId: string, options?: { groupId?: string; isRestoring?: boolean; title?: string }, retryCount: number = 0) {
    try {
      console.log('createSession or restore session', sessionId);

      // Check if session already exists in memory and is ready/authenticated
      const existingSession = this.sessions.get(sessionId);

      //console.log({ existingSession });

      const storedSession = await this.whatsAppSessionModel.findOne({ sessionId }).exec();

      if (existingSession && existingSession.isReady && storedSession && (storedSession.status === 'ready' || storedSession.status === 'authenticated')) {
        this.logger.warn(`Session ${sessionId} already exists and is ready`);
        return { success: false, sessionId, message: 'Session already exists and is authenyticated' };
      }


      // Check database for stored session with authenticated/ready status
      if (storedSession && (storedSession.status === 'ready' || storedSession.status === 'authenticated')) {
        // If there's a stored authenticated session but not in memory, try to restore it
        if (!existingSession) {
          this.logger.log(`🔄 Found authenticated session ${sessionId} in database, restoring...`);
          // Don't return here, allow the session creation to proceed which will restore it
        } else {
          this.logger.warn(`Session ${sessionId} is authenticated in database`);
          return { success: false, sessionId, message: 'Session is already authenticated' };
        }
      }

      // If session exists but not ready, we'll recreate it
      if (existingSession && !existingSession.isReady) {
        this.logger.log(`Session ${sessionId} exists but not ready, proceeding with recreation`);
        // Clean up existing session before creating new one
        try {
          await existingSession.client.destroy();
        } catch (error) {
          this.logger.warn(`Error destroying existing session: ${error.message}`);
        }
        this.sessions.delete(sessionId);
      }

      this.logger.log(`🔨 Creating session: ${sessionId}`);

      // Store session metadata (optionally include groupId mapped to refId and title)
      let refObjectId: mongoose.Types.ObjectId | undefined;
      if (options?.groupId && mongoose.Types.ObjectId.isValid(options.groupId)) {
        refObjectId = new mongoose.Types.ObjectId(options.groupId);
      }
      await this.storeSessionMetadata(sessionId, {
        status: 'initializing',
        lastSeen: new Date(),
        ...(refObjectId ? { refId: refObjectId } : {}),
        ...(options?.title ? { title: options.title } : {}),
      });

      // Puppeteer options
      // Get the executable path to ensure Chromium is found
      const executablePath = puppeteer.executablePath();
      const defaultPuppeteerOptions = {
        headless: true,
        executablePath: executablePath,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--no-zygote',
          '--single-process',
          // Memory optimization flags
          '--disable-extensions',
          '--disable-plugins',
          '--disable-background-networking',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-breakpad',
          '--disable-client-side-phishing-detection',
          '--disable-component-extensions-with-background-pages',
          '--disable-default-apps',
          '--disable-features=TranslateUI',
          '--disable-hang-monitor',
          '--disable-ipc-flooding-protection',
          '--disable-popup-blocking',
          '--disable-prompt-on-repost',
          '--disable-renderer-backgrounding',
          '--disable-sync',
          '--disable-translate',
          '--metrics-recording-only',
          '--mute-audio',
          '--no-default-browser-check',
          '--no-first-run',
          '--safebrowsing-disable-auto-update',
          '--enable-automation',
          '--disable-features=AudioServiceOutOfProcess',
          '--disable-features=MediaRouter',
          '--disable-software-rasterizer',
          '--disable-background-media-suspend',
          '--disable-low-res-tiling',
          '--disable-remote-fonts',
          '--disable-web-security',
          '--disable-features=VizDisplayCompositor',
        ],
      };

      this.logger.log(`🔧 Using browser executable: ${executablePath}`);

      const client = new Client({
        authStrategy: new LocalAuth({
          clientId: sessionId,
          dataPath: this.sessionPath,
        }),
        puppeteer: {
          ...defaultPuppeteerOptions,
        },
        webVersionCache: {
          type: 'remote',
          remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
        },
      });

      // Set up event handlers
      this.setupClientListeners(client, sessionId);

      // Initialize client
      await client.initialize();

      this.sessions.set(sessionId, {
        client,
        isReady: false,
        lastRestore: new Date(),
        isRestoring: options?.isRestoring || false
      });

      return { success: true, sessionId, message: 'Session created successfully' };
    } catch (error) {
      this.logger.error(`❌ Error creating session ${sessionId}:`, error);

      // Check if this is a SingletonLock error and we haven't retried yet
      if (this.isSingletonLockError(error) && retryCount === 0) {
        this.logger.warn(`🔒 SingletonLock error detected for session ${sessionId}, removing session folder and retrying...`);

        // Remove the session folder to clean up lock files
        await this.removeSessionFolder(sessionId);

        // Remove from sessions if it was added
        this.sessions.delete(sessionId);

        // Wait a bit before retrying
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Retry creating the session
        this.logger.log(`🔄 Retrying session creation for ${sessionId}...`);
        return this.createSession(sessionId, options, retryCount + 1);
      }

      // Remove from sessions if it was added
      this.sessions.delete(sessionId);

      // Update metadata
      await this.storeSessionMetadata(sessionId, {
        status: 'error',
        lastSeen: new Date()
      });

      throw new Error(`Failed to create session: ${error.message}`);
    }
  }

  /**
   * Destroy a session
   */
  async destroySession(sessionId: string) {
    try {
      const session = this.sessions.get(sessionId);
      if (session) {
        await session.client.destroy();
        this.sessions.delete(sessionId);
      }

        // Remove from MongoDB using the model
      await this.whatsAppSessionModel.deleteMany({ sessionId: sessionId });
      this.logger.log(`🧹 Session ${sessionId} destroyed and removed from MongoDB`);
      return { success: true, message: 'Session destroyed successfully' };
    } catch (error) {
      this.logger.error(`Error destroying session ${sessionId}:`, error);
      throw new Error(`Failed to destroy session: ${error.message}`);
    }
  }

  /**
   * Send message
   */
  async sendMessage(sessionId: string, phone: string, message: string) {
    try {
      const session = this.sessions.get(sessionId);
      if (!session) {
        throw new Error(`Session ${sessionId} not found`);
      }

      if (!session.isReady) {
        throw new Error(`Session ${sessionId} is not ready yet`);
      }

      // Format phone number (remove any non-digit characters and ensure proper format)
      const formattedPhone = phone.replace(/\D/g, '');
      const chatId = `${formattedPhone}@c.us`;

      const result = await session.client.sendMessage(chatId, message);

      this.logger.log(`📤 Message sent to ${phone} via session ${sessionId}`);
      return {
        success: true,
        messageId: result.id._serialized,
        timestamp: result.timestamp,
      };
    } catch (error) {
      this.logger.error(`Error sending message via session ${sessionId}:`, error);
      throw new Error(`Failed to send message: ${error.message}`);
    }
  }

  /**
   * Get session status
   */
  getSessionStatus(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { exists: false, ready: false };
    }
    return {
      exists: true,
      ready: session.isReady,
      state: session.client.info // Additional client info if available
    };
  }

  /**
   * Get a session by sessionId
   */
  async getSession(sessionId: string) {
    const session = await this.whatsAppSessionModel.findOne({ sessionId }).exec();
    return session;
  }

  /**
   * Get the QR code of a session by sessionId
   */
  async getSessionQrCode(sessionId: string) {
    try {
      const session = await this.whatsAppSessionModel.findOne({ sessionId }).exec();

      if (!session) {
        return {
          success: false,
          message: 'Session not found',
          qrCode: null
        };
      }

      if (!session.qrCode) {
        return {
          success: false,
          message: 'QR code not generated yet',
          status: session.status,
          qrCode: null
        };
      }

      return {
        success: true,
        sessionId: session.sessionId,
        status: session.status,
        qrCode: session.qrCode,
        qrAttempts: session.qrAttempts,
        maxQrAttempts: session.maxQrAttempts
      };
    } catch (error) {
      this.logger.error(`Error getting QR code for session ${sessionId}:`, error);
      throw new Error(`Failed to get QR code: ${error.message}`);
    }
  }

  /**
   * List all active sessions
   */
  getSessions() {
    const sessions = [];
    for (const [sessionId, session] of this.sessions.entries()) {
      sessions.push({
        sessionId,
        isReady: session.isReady,
        lastRestore: session.lastRestore,
      });
    }
    return sessions;
  }

  /**
   * List all stored sessions in MongoDB
   */
  async getStoredSessions() {
    try {
      const sessions = await this.whatsAppSessionModel.find({}).exec();
      return sessions.map(session => ({
        _id: session._id,
        sessionId: session.sessionId,
        status: session.status,
        title: session.title,
        lastSeen: session.lastSeen,
        updatedAt: session.updatedAt,
        createdAt: session.createdAt,
        refId: session.refId,
      }));
    } catch (error) {
      this.logger.error('Error fetching stored sessions:', error);
      return [];
    }
  }

  /**
   * Get client instance (for advanced operations)
   */
  getClient(sessionId: string): Client | null {
    const session = this.sessions.get(sessionId);
    return session ? session.client : null;
  }

  /**
   * Get chats for a session from database
   * Synchronization happens automatically when session becomes ready
   */
  async getChats(sessionId: string) {
    try {
      // Fetch and return the stored chats from database
      const storedChats = await this.storageService.getStoredChats(sessionId);

      return storedChats.map(chat => ({
        id: chat.chatId,
        name: chat.name,
        isGroup: chat.isGroup,
        unreadCount: chat.unreadCount,
        lastMessage: chat.lastMessage,
        timestamp: chat.timestamp,
        archive: chat.archived,
        pinned: chat.pinned,
      }));
    } catch (error) {
      this.logger.error(`Error getting chats from session ${sessionId}:`, error);
      throw new Error(`Failed to get chats: ${error.message}`);
    }
  }
  /**
   * Get messages from a specific chat
   * Stores messages in database to avoid duplicates, then returns stored messages
   */
  async getChatMessages(sessionId: string, chatId: string, limit?: number) {
    try {
      const session = this.sessions.get(sessionId);
      if (!session) {
        throw new Error(`Session ${sessionId} not found`);
      }

      if (!session.isReady) {
        throw new Error(`Session ${sessionId} is not ready yet`);
      }

      // Fetch messages from WhatsApp
      const chat = await session.client.getChatById(chatId);
      const messages = (await chat.fetchMessages({ limit: limit || 50 })).sort((a, b) => a.timestamp - b.timestamp);
      this.logger.log(`📨 Retrieved ${messages.length} messages from chat ${chatId} in session ${sessionId}`);

      console.log('messages', {messages});
      // Store messages in database (batch operation to avoid duplicates)
      try {
        // Save messages concurrently with proper chatId
        const savePromises = messages.map((message) =>
          this.storageService.saveMessage(sessionId, message, chatId),
        );
        await Promise.all(savePromises);
        this.logger.log(`💾 Saved ${messages.length} messages to database for chat ${chatId}`);
      } catch (error) {
        this.logger.error(`Error saving messages to database: ${error.message}`);
        // Continue even if save fails, return the fetched messages
      }

      // Fetch stored messages from database
      const storedMessages = await this.getStoredMessages(sessionId, chatId, {
        limit: limit || 50
      });

      this.logger.log(`📥 Returning ${storedMessages.length} stored messages from database`);

      return storedMessages.map(msg => ({
        id: msg.messageId,
        body: msg.body,
        from: msg.from,
        to: msg.to,
        fromMe: msg.fromMe,
        timestamp: msg.timestamp,
        hasMedia: msg.hasMedia,
        mediaType: msg.mediaType,
        hasQuotedMsg: msg.hasQuotedMsg,
        isForwarded: msg.isForwarded,
        isStarred: msg.isStarred,
        isDeleted: msg.isDeleted,
        type: msg.type,
        rawData: msg.rawData
      }));
    } catch (error) {
      this.logger.error(`Error getting messages from chat ${chatId} in session ${sessionId}:`, error);
      if (error?.message && /Session closed/i.test(error.message)) {
        await this.handleSessionClosed(sessionId, chatId);
      }
      throw new Error(`Failed to get messages: ${error.message}`);
    }
  }

  /**
   * Sync recent messages from the live session into local storage
   * If chatId is provided, sync only that chat; otherwise sync all chats
   */
  async syncRecentMessages(sessionId: string, chatId?: string, limitPerChat: number = 100) {
    try {
      const session = this.sessions.get(sessionId);
      if (!session) {
        throw new Error(`Session ${sessionId} not found`);
      }

      if (!session.isReady) {
        throw new Error(`Session ${sessionId} is not ready yet`);
      }

      const targetChatIds: string[] = [];

      if (chatId) {
        targetChatIds.push(chatId);
      } else {
        const chats = await session.client.getChats();
        for (const chat of chats) {
          targetChatIds.push(chat.id._serialized);
        }
      }

      this.logger.log(`🔄 Syncing recent messages for ${targetChatIds.length} chat(s) on session ${sessionId}`);

      for (const targetId of targetChatIds) {
        try {
          const chat = await session.client.getChatById(targetId);
          const messages = await chat.fetchMessages({ limit: limitPerChat });
          if (messages.length > 0) {
            await this.storageService.saveMessages(sessionId, messages, targetId);
            this.logger.log(`💾 Synced ${messages.length} messages for chat ${targetId}`);
          }
        } catch (innerError) {
          this.logger.error(`Error syncing messages for chat ${targetId}: ${innerError.message}`);
        }
      }

      return { success: true, chatsProcessed: targetChatIds.length };
    } catch (error) {
      this.logger.error(`Error syncing recent messages for session ${sessionId}:`, error);
      throw new Error(`Failed to sync recent messages: ${error.message}`);
    }
  }

  /**
   * Synchronize chats and messages with WebSocket progress events
   * This method orchestrates the entire synchronization process and emits events to the frontend
   * Each chat is saved individually and all its messages are synced before moving to the next chat
   */
  async syncChatsWithProgress(sessionId: string, limitPerChat: number = 100) {
    try {
      const session = this.sessions.get(sessionId);
      if (!session) {
        throw new Error(`Session ${sessionId} not found`);
      }

      if (!session.isReady) {
        throw new Error(`Session ${sessionId} is not ready yet`);
      }

      // Step 1: Get all chats from WhatsApp
      this.logger.log(`📋 Fetching chats for session ${sessionId}`);
      const chats = await session.client.getChats();
      const nChats = chats.length;

      this.logger.log(`📋 Retrieved ${nChats} chats from session ${sessionId}`);

      // Step 2: Emit initial sync event with total chat count
      this.gateway.emitSyncChats(sessionId, {
        nChats,
        currentChat: 0,
        messagesSynced: 0,
      });

      // Step 3: Process each chat sequentially - save chat then sync all its messages
      for (let i = 0; i < chats.length; i++) {
        const chat = chats[i];
        const chatId = chat.id._serialized;

        try {
          this.logger.log(`📋 Processing chat ${i + 1}/${nChats}: ${chatId}`);

          // Save the current chat to database
          await this.storageService.saveChats(sessionId, [chat], async (currentIndex, total, savedChat) => {
            // Emit progress after chat is saved
            this.gateway.emitSyncChats(sessionId, {
              nChats,
              currentChat: i + 1,
              chatId: savedChat.id._serialized,
              messagesSynced: 0,
            });
          });

          this.logger.log(`💾 Saved chat ${i + 1}/${nChats}: ${chatId}`);

          // Fetch messages from WhatsApp for this chat
          this.logger.log(`📨 Fetching messages for chat ${i + 1}/${nChats}: ${chatId}`);

          const chatInstance = await session.client.getChatById(chatId);
          const messages = await chatInstance.fetchMessages({ limit: limitPerChat })

          if (messages.length > 0) {
            // Save messages to database with progress callback
            await this.storageService.saveMessages(
              sessionId,
              messages,
              chatId,
              async (messagesSaved) => {
                // Emit progress after messages are saved
                this.gateway.emitSyncChats(sessionId, {
                  nChats,
                  currentChat: i + 1,
                  chatId,
                  messagesSynced: messagesSaved,
                });
              }
            );

            this.logger.log(`💾 Synced ${messages.length} messages for chat ${chatId}`);
          } else {
            // Emit progress even if no messages
            this.gateway.emitSyncChats(sessionId, {
              nChats,
              currentChat: i + 1,
              chatId,
              messagesSynced: 0,
            });
            this.logger.log(`📭 No messages to sync for chat ${chatId}`);
          }

          this.logger.log(`✅ Completed synchronization for chat ${i + 1}/${nChats}: ${chatId}`);
        } catch (innerError) {
          this.logger.error(`Error syncing chat ${chatId}: ${innerError.message}`);
          // Emit error progress but continue with next chat
          this.gateway.emitSyncChats(sessionId, {
            nChats,
            currentChat: i + 1,
            chatId,
            messagesSynced: 0,
          });
        }
      }

      this.logger.log(`✅ Synchronization completed for session ${sessionId}`);

      return {
        success: true,
        chatsProcessed: nChats,
        message: 'Synchronization completed successfully',
      };
    } catch (error) {
      this.logger.error(`Error synchronizing chats with progress for session ${sessionId}:`, error);
      throw new Error(`Failed to synchronize chats: ${error.message}`);
    }
  }

  /**
   * Get messages from database
   */
  async getStoredMessages(sessionId: string, chatId?: string, options?: {
    includeDeleted?: boolean;
    limit?: number;
    skip?: number;
    startTimestamp?: number;
    endTimestamp?: number;
  }) {
    try {
      const query: any = { sessionId };

      if (chatId) {
        query.chatId = chatId;
      }
      console.log('options', options);
      // if (!options?.includeDeleted) {
      //   query.isDeleted = false;
      // }
      if (options?.startTimestamp) {
        query.timestamp = { $gte: options.startTimestamp };
      }
      if (options?.endTimestamp) {
        if (!query.timestamp) {
          query.timestamp = {};
        }
        query.timestamp.$lte = options.endTimestamp;
      }

      console.log('query', query);
      const messages = await this.whatsAppMessageModel
        .find(query)
        .sort({ timestamp: 1 })
        //.limit(options?.limit || 50)
        .skip(options?.skip || 0)
        .exec();

      return messages.map(msg => ({
        messageId: msg.messageId,
        chatId: msg.chatId,
        body: msg.body,
        type: msg.type,
        from: msg.from,
        to: msg.to,
        author: msg.author,
        fromMe: msg.fromMe,
        timestamp: msg.timestamp,
        isDeleted: msg.isDeleted,
        deletedAt: msg.deletedAt,
        deletedBy: msg.deletedBy,
        edition: msg.edition,
        hasMedia: msg.hasMedia,
        mediaType: msg.mediaType,
        hasQuotedMsg: msg.hasQuotedMsg,
        isForwarded: msg.isForwarded,
        isStarred: msg.isStarred,
        rawData: msg.rawData,
      }));
    } catch (error) {
      this.logger.error(`Error getting stored messages: ${error.message}`);
      throw new Error(`Failed to get stored messages: ${error.message}`);
    }
  }

  /**
   * Get deleted messages
   */
  async getDeletedMessages(sessionId: string, chatId?: string, limit?: number) {
    try {
      const query: any = { sessionId, isDeleted: true };

      if (chatId) {
        query.chatId = chatId;
      }

      const messages = await this.whatsAppMessageModel
        .find(query)
        .sort({ deletedAt: -1 })
        .limit(limit || 50)
        .exec();

      return messages;
    } catch (error) {
      this.logger.error(`Error getting deleted messages: ${error.message}`);
      throw new Error(`Failed to get deleted messages: ${error.message}`);
    }
  }

  /**
   * Get message by ID
   */
  async getStoredMessageById(sessionId: string, messageId: string) {
    try {
      const message = await this.whatsAppMessageModel.findOne({
        sessionId,
        messageId
      }).exec();

      if (!message) {
        throw new Error('Message not found');
      }

      return {
        messageId: message.messageId,
        chatId: message.chatId,
        body: message.body,
        type: message.type,
        from: message.from,
        to: message.to,
        author: message.author,
        fromMe: message.fromMe,
        timestamp: message.timestamp,
        isDeleted: message.isDeleted,
        deletedAt: message.deletedAt,
        deletedBy: message.deletedBy,
        edition: message.edition,
        hasMedia: message.hasMedia,
        mediaType: message.mediaType,
        editionHistory: message.edition,
        rawData: message.rawData,
      };
    } catch (error) {
      this.logger.error(`Error getting stored message: ${error.message}`);
      throw new Error(`Failed to get message: ${error.message}`);
    }
  }

  /**
   * Get message edit history
   */
  async getMessageEditHistory(sessionId: string, messageId: string) {
    try {
      const message = await this.whatsAppMessageModel.findOne({
        sessionId,
        messageId
      }).exec();

      if (!message) {
        throw new Error('Message not found');
      }

      return {
        messageId: message.messageId,
        currentBody: message.body,
        editionHistory: message.edition,
        editCount: message.edition.length,
      };
    } catch (error) {
      this.logger.error(`Error getting message edit history: ${error.message}`);
      throw new Error(`Failed to get edit history: ${error.message}`);
    }
  }

  /**
   * Get stored chats from database
   */
  async getStoredChats(sessionId: string, options?: {
    archived?: boolean;
    isGroup?: boolean;
    limit?: number;
    skip?: number;
  }) {
    return this.storageService.getStoredChats(sessionId, options);
  }


  /**
   * Get a specific stored chat from database
   */
  async getStoredChat(sessionId: string, chatId: string) {
    return this.storageService.getStoredChat(sessionId, chatId);
  }

  /**
   * Send message to RabbitMQ for testing in ms2
   */
  async sendRMMessage(payload: any) {
    try {
      this.logger.log(`📤 Sending RM message to ms2: ${JSON.stringify(payload)}`);
      this.rabbitService.emitToRecordsAiChatsAnalysisService('test_message', payload);
      return {
        success: true,
        message: 'Message sent to RabbitMQ',
        payload
      };
    } catch (error) {
      this.logger.error(`Error sending RM message: ${error.message}`);
      throw new Error(`Failed to send RM message: ${error.message}`);
    }
  }

  // Event emitter methods using WebSocket
  async setMessageGroup(sessionId: string, messageId: string, groupId: string) {
    try {
      if (!groupId) {
        throw new Error('groupId is required');
      }
      const result = await this.whatsAppMessageModel.updateOne(
        { sessionId, messageId },
        { $set: { groupId } },
      );
      if (result.matchedCount === 0) {
        throw new Error('Message not found');
      }
      return { success: true };
    } catch (error) {
      this.logger.error(`Error setting groupId for message ${messageId} in session ${sessionId}: ${error.message}`);
      throw new Error(`Failed to set groupId: ${error.message}`);
    }
  }

  // Event emitter methods using WebSocket
  private emitQrEvent(sessionId: string, qr: string) {
    this.gateway.emitQrCode(sessionId, qr);
  }

  private emitReadyEvent(sessionId: string) {
    this.gateway.emitReady(sessionId);
  }

  private emitAuthFailureEvent(sessionId: string, error: any) {
    this.gateway.emitAuthFailure(sessionId, error);
  }

  private emitNewMessageEvent(sessionId: string, messageData: any) {
    this.gateway.emitNewMessage(sessionId, messageData);
  }

  private async handleSessionClosed(sessionId: string, chatId?: string) {
    try {
      const session = this.sessions.get(sessionId);
      if (session) {
        session.isReady = false;
      }
      await this.storeSessionMetadata(sessionId, {
        status: 'closed',
        lastSeen: new Date(),
      });
      this.gateway.emitSessionClosed(sessionId, chatId);
    } catch (e) {
      this.logger.error(`Failed to handle session closed for ${sessionId}: ${e.message}`);
    }
  }
}


// src/whatsapp-web/whatsapp-web.service.ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import * as mongoose from 'mongoose';
import { Client, RemoteAuth, type Chat, type Message } from 'whatsapp-web.js';
import { MongoRemoteAuthStore } from './mongo-remote-auth.store';
import { WhatsAppSession, WhatsAppSessionDocument } from './schemas/whatsapp-session.schema';
import { WhatsAppMessage, WhatsAppMessageDocument } from './schemas/whatsapp-message.schema';
import { WhatsappStorageService } from './whatsapp-storage.service';
import { WhatsappWebGateway } from './whatsapp-web.gateway';
import * as path from 'path';
import * as fs from 'fs/promises';
import { WhatsappAlertsService } from './whatsapp-alerts.service';
import { RabbitService } from 'src/rabbit.service';
import type { NormalizedChat, NormalizedMessage } from './types/normalized-whatsapp.types';

type WwebSession = {
  client: Client;
  isReady: boolean;
  lastRestore?: Date;
  isRestoring?: boolean;
};

@Injectable()
export class WhatsappWebService implements OnModuleInit {
  private readonly logger = new Logger(WhatsappWebService.name);
  private readonly wwebJsAuthRoot = path.join(process.cwd(), 'wwebjs_auth');
  private readonly remoteAuthStore: MongoRemoteAuthStore;
  private readonly remoteBackupIntervalMs = 300_000;
  private sessions: Map<string, WwebSession> = new Map();
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
  ) {
    this.remoteAuthStore = new MongoRemoteAuthStore(this.connection);
  }

  private clientIdForSession(sessionId: string): string {
    return sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  private remoteAuthFolderName(sessionId: string): string {
    return `RemoteAuth-${this.clientIdForSession(sessionId)}`;
  }

  async onModuleInit() {
    this.logger.log('🚀 Initializing WhatsApp Web (whatsapp-web.js) service...');
    await fs.mkdir(this.wwebJsAuthRoot, { recursive: true });
    await this.initializeStoredSessions();
  }

  private async initializeStoredSessions() {
    if (this.isInitializing) {
      this.logger.warn('Session initialization already in progress');
      return;
    }
    this.isInitializing = true;
    try {
      await this.connection.readyState;
      const documents = await this.whatsAppSessionModel
        .find({ status: { $in: ['ready', 'authenticated'] } })
        .exec();
      this.logger.log(`📱 Found ${documents.length} ready/authenticated sessions in database`);
      if (documents.length === 0) {
        this.logger.log('No ready/authenticated sessions to restore');
        return;
      }
      const sessionIds = [...new Set(documents.map((doc) => doc.sessionId))];
      for (const sessionId of sessionIds) {
        if (this.sessions.has(sessionId)) {
          continue;
        }
        try {
          this.logger.log(`🔄 Attempting to restore session: ${sessionId}`);
          await this.createSession(sessionId, { isRestoring: true });
          this.logger.log(`✅ Session ${sessionId} restore initiated`);
        } catch (error) {
          this.logger.error(`❌ Failed to restore session ${sessionId}:`, (error as Error).message);
        }
      }
      this.logger.log(`📊 Total active sessions: ${this.sessions.size}`);
    } catch (error) {
      this.logger.error('Error initializing stored sessions:', error);
    } finally {
      this.isInitializing = false;
    }
  }

  private async storeSessionMetadata(
    sessionId: string,
    metadata: {
      status?: string;
      lastSeen?: Date;
      isDisconnected?: boolean;
      disconnectedAt?: Date;
      refId?: mongoose.Types.ObjectId;
      groupId?: mongoose.Types.ObjectId;
      qrCode?: string | null;
      title?: string;
    },
  ) {
    try {
      await this.whatsAppSessionModel.updateOne(
        { sessionId },
        { $set: { sessionId, ...metadata } },
        { upsert: true },
      );
    } catch (error) {
      this.logger.error(`Error storing session metadata for ${sessionId}:`, error);
    }
  }

  private wwebMessageToNormalized(msg: Message): NormalizedMessage | null {
    try {
      if (!msg?.id) {
        return null;
      }
      const chatId = msg.fromMe ? msg.to : msg.from;
      const messageId = msg.id._serialized;
      const type = String(msg.type);
      const hasMedia = !!msg.hasMedia;
      return {
        messageId,
        chatId,
        body: msg.body ?? '',
        type,
        from: msg.from,
        to: msg.to,
        author: msg.author ?? null,
        fromMe: msg.fromMe,
        isForwarded: msg.isForwarded,
        forwardingScore: msg.forwardingScore ?? 0,
        isStatus: msg.isStatus,
        hasMedia,
        mediaType: hasMedia ? type : null,
        hasQuotedMsg: msg.hasQuotedMsg,
        isStarred: msg.isStarred,
        isGif: msg.isGif,
        isEphemeral: msg.isEphemeral,
        timestamp: msg.timestamp,
        ack: typeof msg.ack === 'number' ? msg.ack : 0,
        deviceType: msg.deviceType,
        broadcast: msg.broadcast,
        mentionedIds: (msg.mentionedIds ?? []).map((id) =>
          typeof id === 'string' ? id : (id as { _serialized: string })._serialized,
        ),
        rawData: (msg.rawData as object) ?? {},
      };
    } catch {
      return null;
    }
  }

  private async wwebChatToNormalized(chat: Chat): Promise<NormalizedChat> {
    const id = chat.id._serialized;
    const lastMsg = chat.lastMessage;
    let lastBody: string | null = null;
    let lastTs = chat.timestamp;
    let lastFromMe = false;
    if (lastMsg) {
      lastBody = lastMsg.body || null;
      lastTs = lastMsg.timestamp;
      lastFromMe = lastMsg.fromMe;
    }
    return {
      chatId: id,
      name: chat.name || id,
      isGroup: chat.isGroup,
      unreadCount: chat.unreadCount,
      timestamp: lastTs,
      archived: chat.archived,
      pinned: chat.pinned,
      isReadOnly: chat.isReadOnly,
      isMuted: chat.isMuted,
      muteExpiration: chat.muteExpiration ?? null,
      lastMessage: lastBody,
      lastMessageTimestamp: lastTs,
      lastMessageFromMe: lastFromMe,
    };
  }

  private buildNormalizedChatFromMessage(message: NormalizedMessage): NormalizedChat {
    return {
      chatId: message.chatId,
      name: message.chatId,
      isGroup: message.chatId.endsWith('@g.us'),
      unreadCount: 0,
      timestamp: message.timestamp,
      archived: false,
      pinned: false,
      isReadOnly: false,
      isMuted: false,
      muteExpiration: null,
      lastMessage: message.body || null,
      lastMessageTimestamp: message.timestamp,
      lastMessageFromMe: message.fromMe,
    };
  }

  private normalizedChatToSyncAppRow(chat: NormalizedChat) {
    const tsSec = chat.lastMessageTimestamp ?? chat.timestamp;
    return {
      id: chat.chatId,
      contactName: chat.name || chat.chatId,
      contactPhone: chat.isGroup
        ? ''
        : (chat.chatId.split('@')[0] || '').replace(/\D/g, '') || chat.chatId,
      lastMessage: chat.lastMessage ?? '',
      lastMessageTime: new Date(tsSec * 1000).toISOString(),
      unreadCount: chat.unreadCount ?? 0,
    };
  }

  private mapWwebAckToUiStatus(
    ack: number,
  ): 'sending' | 'sent' | 'delivered' | 'read' {
    if (ack >= 3) return 'read';
    if (ack >= 2) return 'delivered';
    if (ack >= 1) return 'sent';
    return 'sending';
  }

  private mapDbTypeToUiType(
    type: string,
  ): 'text' | 'image' | 'video' | 'audio' | 'voice' | 'document' {
    const t = (type || 'chat').toLowerCase();
    if (t === 'chat' || t === 'conversation') return 'text';
    if (t === 'image' || t === 'video' || t === 'audio' || t === 'voice' || t === 'document') {
      return t;
    }
    return 'text';
  }

  private wwebMessageToSyncAppPayload(msg: Message) {
    if (String(msg.type) === 'revoked') {
      const ts = msg.timestamp;
      const chatId = msg.fromMe ? msg.to : msg.from;
      return {
        id: msg.id._serialized,
        chatId,
        sender: msg.fromMe ? ('me' as const) : ('them' as const),
        content: '',
        type: 'text' as const,
        timestamp: new Date(ts * 1000).toISOString(),
        status: 'read' as const,
        isEdited: false,
        editHistory: [] as { content: string; editedAt: string }[],
        isDeleted: true,
        deletedAt: undefined as string | undefined,
        hasMedia: false,
        mediaType: undefined as string | undefined,
      };
    }
    const normalized = this.wwebMessageToNormalized(msg);
    if (!normalized) {
      return null;
    }
    const status = this.mapWwebAckToUiStatus(normalized.ack);
    return {
      id: normalized.messageId,
      chatId: normalized.chatId,
      sender: normalized.fromMe ? ('me' as const) : ('them' as const),
      content: normalized.body ?? '',
      type: this.mapDbTypeToUiType(normalized.type),
      timestamp: new Date(normalized.timestamp * 1000).toISOString(),
      status,
      isEdited: false,
      editHistory: [] as { content: string; editedAt: string }[],
      isDeleted: false,
      deletedAt: undefined as string | undefined,
      hasMedia: !!normalized.hasMedia,
      mediaType: normalized.mediaType ?? undefined,
    };
  }

  private setupWwebClientListeners(client: Client, sessionId: string): void {
    client.on('qr', async (qr) => {
      const session = this.sessions.get(sessionId);
      if (session?.isReady) {
        this.logger.warn(`⚠️ Session ${sessionId} already ready, ignoring QR`);
        return;
      }
      this.logger.log(`📱 QR received for session ${sessionId}`);
      await this.storeSessionMetadata(sessionId, {
        status: 'qr_generated',
        lastSeen: new Date(),
        qrCode: qr,
      });
      this.emitQrEvent(sessionId, qr);
    });

    client.on('authenticated', () => {
      this.logger.log(`🔐 Session ${sessionId} authenticated`);
    });

    client.on('auth_failure', async (message) => {
      this.logger.error(`Auth failure ${sessionId}: ${message}`);
      this.emitAuthFailureEvent(sessionId, message);
      await this.storeSessionMetadata(sessionId, {
        status: 'error',
        lastSeen: new Date(),
        qrCode: null,
      });
    });

    client.on('ready', async () => {
      this.logger.log(`✅ Session ${sessionId} is ready (whatsapp-web.js)`);
      const session = this.sessions.get(sessionId);
      if (session) {
        session.isReady = true;
      }
      await this.storeSessionMetadata(sessionId, {
        status: 'ready',
        lastSeen: new Date(),
        isDisconnected: false,
        qrCode: null,
      });
      const isRestoring = session?.isRestoring || false;
      if (!isRestoring) {
        try {
          const storedChats = await this.storageService.getStoredChats(sessionId);
          this.rabbitService.emitToRecordsAiChatsAnalysisService('session_ready', {
            sessionId,
            chats: storedChats.map((chat) => chat.chatId),
          });
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          this.logger.error(`Error emitting session_ready for ${sessionId}: ${msg}`);
        }
      }
      this.emitReadyEvent(sessionId);
    });

    client.on('remote_session_saved', () => {
      this.logger.log(`RemoteAuth session persisted to MongoDB for ${sessionId}`);
    });

    client.on('disconnected', async (reason) => {
      this.logger.warn(`⚠️ Session ${sessionId} disconnected: ${reason}`);
      const entry = this.sessions.get(sessionId);
      if (entry) {
        entry.isReady = false;
      }
      this.sessions.delete(sessionId);
      await this.storeSessionMetadata(sessionId, {
        status: 'disconnected',
        lastSeen: new Date(),
        qrCode: null,
      });
      try {
        const sessionDoc = await this.whatsAppSessionModel.findOne({ sessionId }).exec();
        await this.whatsAppSessionModel.updateOne(
          { sessionId },
          { $set: { isDisconnected: true, closedAt: new Date() } },
        );
        if (sessionDoc?._id) {
          await this.alertsService.createDisconnectedAlert(
            sessionDoc._id as mongoose.Types.ObjectId,
            sessionId,
            `Session ${sessionId} disconnected (${String(reason)})`,
          );
        }
      } catch (e) {
        this.logger.error(`Failed disconnected follow-up for ${sessionId}`, e as Error);
      }
    });

    client.on('message_create', async (msg) => {
      try {
        const normalized = this.wwebMessageToNormalized(msg);
        if (!normalized) {
          return;
        }
        await this.storageService.saveMessage(sessionId, normalized);
        const normalizedChat = this.buildNormalizedChatFromMessage(normalized);
        await this.storageService.saveChat(sessionId, normalizedChat);
        const messageData: Record<string, unknown> = {
          messageId: normalized.messageId,
          chatId: normalized.chatId,
          body: normalized.body,
          type: normalized.type,
          from: normalized.from,
          to: normalized.to,
          author: normalized.author,
          fromMe: normalized.fromMe,
          timestamp: normalized.timestamp,
          isDeleted: false,
          deletedAt: null,
          deletedBy: null,
          edition: [],
          hasMedia: normalized.hasMedia,
          mediaType: normalized.mediaType,
          hasQuotedMsg: normalized.hasQuotedMsg,
          isForwarded: normalized.isForwarded,
          isStarred: normalized.isStarred,
        };
        this.emitNewMessageEvent(sessionId, messageData);
        this.rabbitService.emitToRecordsAiChatsAnalysisService('message_create', {
          sessionId,
          message: messageData,
        });
      } catch (error: unknown) {
        const msgErr = error instanceof Error ? error.message : String(error);
        this.logger.error(`message_create ${sessionId}: ${msgErr}`);
      }
    });
  }

  async createSession(
    sessionId: string,
    options?: { groupId?: string; isRestoring?: boolean; title?: string },
  ) {
    try {
      const existingSession = this.sessions.get(sessionId);
      const storedSession = await this.whatsAppSessionModel.findOne({ sessionId }).exec();
      console.log('storedSession', JSON.stringify({storedSession}, null, 2));
      const dbReady =
        !!storedSession &&
        (storedSession.status === 'ready' || storedSession.status === 'authenticated');

      if (existingSession?.isReady && dbReady) {
        this.logger.log(`Session ${sessionId} already active`);
        return { success: true, sessionId, message: 'Session already active' };
      }

      if (existingSession) {
        this.logger.log(`Session ${sessionId}: replacing existing client`);
        try {
          await existingSession.client.destroy();
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          this.logger.warn(`Error destroying previous client: ${msg}`);
        }
        this.sessions.delete(sessionId);
      }

      if (dbReady) {
        this.logger.log(`🔄 Restoring session ${sessionId} from MongoDB (RemoteAuth)...`);
      }

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

      const clientId = this.clientIdForSession(sessionId);
      const client = new Client({
        authStrategy: new RemoteAuth({
          store: this.remoteAuthStore,
          clientId,
          dataPath: this.wwebJsAuthRoot,
          backupSyncIntervalMs: this.remoteBackupIntervalMs,
        }),
        puppeteer: {
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
          ],
        },
      });

      const isRestoring = options?.isRestoring !== undefined ? options.isRestoring : dbReady;
      this.sessions.set(sessionId, {
        client,
        isReady: false,
        lastRestore: new Date(),
        isRestoring,
      });

      this.setupWwebClientListeners(client, sessionId);
      await client.initialize();

      return {
        success: true,
        sessionId,
        message: dbReady ? 'Session restore started' : 'Session created successfully',
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`❌ Error creating session ${sessionId}:`, error);
      this.sessions.delete(sessionId);
      await this.storeSessionMetadata(sessionId, {
        status: 'error',
        lastSeen: new Date(),
      });
      throw new Error(`Failed to create session: ${msg}`);
    }
  }

  async disconnectSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (session) {
      try {
        await session.client.destroy();
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Error destroying client ${sessionId}: ${msg}`);
      }
      this.sessions.delete(sessionId);
    }
    await this.storeSessionMetadata(sessionId, {
      status: 'disconnected',
      lastSeen: new Date(),
      qrCode: null,
    });
    await this.whatsAppSessionModel.updateOne(
      { sessionId },
      { $set: { isDisconnected: true, closedAt: new Date() } },
    );
    this.logger.log(`🔌 Session ${sessionId} disconnected`);
    return { success: true, sessionId, message: 'Disconnected' };
  }

  async disconnectAllActiveSessions() {
    const ids = [...this.sessions.keys()];
    if (ids.length === 0) {
      return {
        success: true,
        disconnected: [] as string[],
        count: 0,
        message: 'No active sessions',
      };
    }
    const disconnected: string[] = [];
    for (const id of ids) {
      await this.disconnectSession(id);
      disconnected.push(id);
    }
    return {
      success: true,
      disconnected,
      count: disconnected.length,
      message: `Disconnected ${disconnected.length} session(s)`,
    };
  }

  async destroySession(sessionId: string) {
    try {
      const session = this.sessions.get(sessionId);
      if (session) {
        try {
          await session.client.logout();
        } catch {
          try {
            await session.client.destroy();
          } catch {
            /* ignore */
          }
        }
        this.sessions.delete(sessionId);
      }
      try {
        await this.remoteAuthStore.delete({ session: this.remoteAuthFolderName(sessionId) });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.warn(`RemoteAuth GridFS cleanup for ${sessionId}: ${msg}`);
      }
      await this.removeRemoteAuthLocalData(sessionId);
      await this.whatsAppSessionModel.deleteMany({ sessionId });
      this.logger.log(`🧹 Session ${sessionId} destroyed`);
      return { success: true, message: 'Session destroyed successfully' };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error destroying session ${sessionId}:`, error);
      throw new Error(`Failed to destroy session: ${msg}`);
    }
  }

  async sendMessage(sessionId: string, phone: string, message: string) {
    try {
      const session = this.sessions.get(sessionId);
      if (!session) {
        throw new Error(`Session ${sessionId} not found`);
      }
      if (!session.isReady) {
        throw new Error(`Session ${sessionId} is not ready yet`);
      }
      const formattedPhone = phone.replace(/\D/g, '');
      const jid = `${formattedPhone}@c.us`;
      const sent = await session.client.sendMessage(jid, message);
      this.logger.log(`📤 Message sent to ${phone} via session ${sessionId}`);
      return {
        success: true,
        messageId: sent.id._serialized,
        timestamp: sent.timestamp * 1000,
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error sending message via ${sessionId}:`, error);
      throw new Error(`Failed to send message: ${msg}`);
    }
  }

  getSessionStatus(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { exists: false, ready: false };
    }
    return {
      exists: true,
      ready: session.isReady,
      state: session.client.info,
    };
  }

  async getSession(sessionId: string) {
    return this.whatsAppSessionModel.findOne({ sessionId }).exec();
  }

  async getSessionQrCode(sessionId: string) {
    try {
      const session = await this.whatsAppSessionModel.findOne({ sessionId }).exec();
      if (!session) {
        return { success: false, message: 'Session not found', qrCode: null };
      }
      if (!session.qrCode) {
        return {
          success: false,
          message: 'QR code not generated yet',
          status: session.status,
          qrCode: null,
        };
      }
      return {
        success: true,
        sessionId: session.sessionId,
        status: session.status,
        qrCode: session.qrCode,
        qrAttempts: session.qrAttempts,
        maxQrAttempts: session.maxQrAttempts,
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error getting QR for ${sessionId}:`, error);
      throw new Error(`Failed to get QR code: ${msg}`);
    }
  }

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

  async getStoredSessions() {
    try {
      const sessions = await this.whatsAppSessionModel.find({}).exec();
      return sessions.map((session) => ({
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

  getClient(sessionId: string): Client | null {
    const session = this.sessions.get(sessionId);
    return session ? session.client : null;
  }

  async getChatsFromSession(sessionId: string): Promise<NormalizedChat[]> {
    const session = this.sessions.get(sessionId);
    if (!session?.isReady) {
      throw new Error(`Session ${sessionId} is not connected or not ready`);
    }
    const chats = await session.client.getChats();
    const out: NormalizedChat[] = [];
    for (const c of chats) {
      const sid = c.id._serialized;
      if (sid.includes('status@broadcast')) {
        continue;
      }
      out.push(await this.wwebChatToNormalized(c));
    }
    return out;
  }

  async getChats(sessionId: string) {
    try {
      const normalizedChats = await this.getChatsFromSession(sessionId);
      return normalizedChats.map((n) => ({
        id: n.chatId,
        name: n.name,
        isGroup: n.isGroup,
        unreadCount: n.unreadCount,
        lastMessage: n.lastMessage,
        timestamp: n.timestamp,
        archive: n.archived,
        pinned: n.pinned,
      }));
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error getting chats for ${sessionId}:`, error);
      throw new Error(`Failed to get chats: ${msg}`);
    }
  }

  async getChatsForSyncApp(sessionId: string) {
    try {
      const normalizedChats = await this.getChatsFromSession(sessionId);
      return normalizedChats.map((c) => this.normalizedChatToSyncAppRow(c));
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error getChatsForSyncApp ${sessionId}:`, error);
      throw new Error(`Failed to get chats: ${msg}`);
    }
  }

  async getMessagesForSyncApp(sessionId: string, chatId: string, limit: number = 100) {
    try {
      const session = this.sessions.get(sessionId);
      if (!session?.isReady) {
        throw new Error(`Session ${sessionId} is not connected or not ready`);
      }
      const id = decodeURIComponent(chatId);
      const chat = await session.client.getChatById(id);
      const messages = await chat.fetchMessages({ limit });
      const out = [];
      for (const m of messages) {
        const row = this.wwebMessageToSyncAppPayload(m);
        if (row) {
          out.push(row);
        }
      }
      return out;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`getMessagesForSyncApp ${sessionId}/${chatId}:`, error);
      throw new Error(`Failed to get messages: ${msg}`);
    }
  }

  async getChatMessages(sessionId: string, chatId: string, limit?: number) {
    try {
      const storedMessages = await this.getStoredMessages(sessionId, chatId, {
        limit: limit || 50,
      });
      this.logger.log(`📥 Returning ${storedMessages.length} stored messages`);
      return storedMessages.map((msg) => ({
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
        rawData: msg.rawData,
      }));
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`getChatMessages ${chatId}:`, error);
      throw new Error(`Failed to get messages: ${msg}`);
    }
  }

  async syncRecentMessages(sessionId: string, chatId?: string) {
    void sessionId;
    void chatId;
    return { success: true, chatsProcessed: 0 };
  }

  async syncChatsWithProgress(sessionId: string, limitPerChat?: number) {
    const lim = limitPerChat && limitPerChat > 0 ? Math.min(limitPerChat, 500) : 100;
    try {
      const session = this.sessions.get(sessionId);
      if (!session?.isReady) {
        throw new Error(`Session ${sessionId} is not connected or not ready`);
      }
      const client = session.client;
      const chats = (await client.getChats()).filter(
        (c) => !c.id._serialized.includes('status@broadcast'),
      );
      const nChats = chats.length;
      this.gateway.emitSyncChats(sessionId, {
        nChats,
        currentChat: 0,
        messagesSynced: 0,
      });
      for (let i = 0; i < chats.length; i++) {
        const chat = chats[i];
        const jid = chat.id._serialized;
        const normalized = await this.wwebChatToNormalized(chat);
        await this.storageService.saveChat(sessionId, normalized);
        const messages = await chat.fetchMessages({ limit: lim });
        for (const m of messages) {
          const n = this.wwebMessageToNormalized(m);
          if (n) {
            await this.storageService.saveMessage(sessionId, n);
          }
        }
        this.gateway.emitSyncChats(sessionId, {
          nChats,
          currentChat: i + 1,
          chatId: jid,
          messagesSynced: messages.length,
        });
      }
      this.logger.log(`✅ Sync completed for session ${sessionId}`);
      return {
        success: true,
        chatsProcessed: nChats,
        message: `Synchronized ${nChats} chats`,
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`syncChatsWithProgress ${sessionId}:`, error);
      throw new Error(`Failed to synchronize chats: ${msg}`);
    }
  }

  async getStoredMessages(
    sessionId: string,
    chatId?: string,
    options?: {
      includeDeleted?: boolean;
      limit?: number;
      skip?: number;
      startTimestamp?: number;
      endTimestamp?: number;
    },
  ) {
    try {
      const query: Record<string, unknown> = { sessionId };
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
        (query.timestamp as Record<string, number>).$lte = options.endTimestamp;
      }
      let q = this.whatsAppMessageModel
        .find(query)
        .sort({ timestamp: 1 })
        .skip(options?.skip || 0);
      if (options?.limit != null && options.limit > 0) {
        q = q.limit(Math.min(options.limit, 500));
      }
      const messages = await q.exec();
      return messages.map((msg) => ({
        messageId: msg.messageId,
        chatId: msg.chatId,
        body: msg.body,
        type: msg.type,
        from: msg.from,
        to: msg.to,
        author: msg.author,
        fromMe: msg.fromMe,
        timestamp: msg.timestamp,
        ack: msg.ack,
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
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`getStoredMessages: ${msg}`);
      throw new Error(`Failed to get stored messages: ${msg}`);
    }
  }

  async getDeletedMessages(sessionId: string, chatId?: string, limit?: number) {
    try {
      const query: Record<string, unknown> = { sessionId, isDeleted: true };
      if (chatId) {
        query.chatId = chatId;
      }
      return this.whatsAppMessageModel
        .find(query)
        .sort({ deletedAt: -1 })
        .limit(limit || 50)
        .exec();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`getDeletedMessages: ${msg}`);
      throw new Error(`Failed to get deleted messages: ${msg}`);
    }
  }

  async getStoredMessageById(sessionId: string, messageId: string) {
    try {
      const message = await this.whatsAppMessageModel.findOne({ sessionId, messageId }).exec();
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
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`getStoredMessageById: ${msg}`);
      throw new Error(`Failed to get message: ${msg}`);
    }
  }

  async getMessageEditHistory(sessionId: string, messageId: string) {
    try {
      const message = await this.whatsAppMessageModel.findOne({ sessionId, messageId }).exec();
      if (!message) {
        throw new Error('Message not found');
      }
      return {
        messageId: message.messageId,
        currentBody: message.body,
        editionHistory: message.edition,
        editCount: message.edition.length,
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`getMessageEditHistory: ${msg}`);
      throw new Error(`Failed to get edit history: ${msg}`);
    }
  }

  async getStoredChats(
    sessionId: string,
    options?: {
      archived?: boolean;
      isGroup?: boolean;
      limit?: number;
      skip?: number;
    },
  ) {
    return this.storageService.getStoredChats(sessionId, options);
  }

  async getStoredChat(sessionId: string, chatId: string) {
    return this.storageService.getStoredChat(sessionId, chatId);
  }

  async sendRMMessage(payload: unknown) {
    try {
      this.logger.log(`📤 sendRMMessage: ${JSON.stringify(payload)}`);
      this.rabbitService.emitToRecordsAiChatsAnalysisService('test_message', payload);
      return { success: true, message: 'Message sent to RabbitMQ', payload };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`sendRMMessage: ${msg}`);
      throw new Error(`Failed to send RM message: ${msg}`);
    }
  }

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
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`setMessageGroup: ${msg}`);
      throw new Error(`Failed to set groupId: ${msg}`);
    }
  }

  private emitQrEvent(sessionId: string, qr: string) {
    this.gateway.emitQrCode(sessionId, qr);
  }

  private emitReadyEvent(sessionId: string) {
    this.gateway.emitReady(sessionId);
  }

  private emitAuthFailureEvent(sessionId: string, error: unknown) {
    this.gateway.emitAuthFailure(sessionId, error);
  }

  private emitNewMessageEvent(sessionId: string, messageData: Record<string, unknown>) {
    this.gateway.emitNewMessage(sessionId, messageData);
  }

  private async removeRemoteAuthLocalData(sessionId: string): Promise<void> {
    const cid = this.clientIdForSession(sessionId);
    const base = this.wwebJsAuthRoot;
    const paths = [
      path.join(base, this.remoteAuthFolderName(sessionId)),
      path.join(base, `wwebjs_temp_session_${cid}`),
      path.join(base, `${this.remoteAuthFolderName(sessionId)}.zip`),
    ];
    for (const p of paths) {
      try {
        await fs.rm(p, { recursive: true, force: true });
        this.logger.log(`Removed RemoteAuth path: ${p}`);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.warn(`Could not remove ${p}: ${msg}`);
      }
    }
  }

  private async handleSessionClosed(sessionId: string, chatId?: string) {
    try {
      const session = this.sessions.get(sessionId);
      if (session) {
        session.isReady = false;
      }
      await this.removeRemoteAuthLocalData(sessionId);
      await this.storeSessionMetadata(sessionId, {
        status: 'closed',
        lastSeen: new Date(),
      });
      this.gateway.emitSessionClosed(sessionId, chatId);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`handleSessionClosed ${sessionId}: ${msg}`);
    }
  }
}

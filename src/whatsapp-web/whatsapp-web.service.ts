// src/whatsapp-web/whatsapp-web.service.ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  Browsers,
  makeInMemoryStore,
} from '@whiskeysockets/baileys';
import type { WASocket, WAMessage } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import * as mongoose from 'mongoose';
import * as qrcode from 'qrcode-terminal';
import * as path from 'path';
import * as fs from 'fs/promises';
import { WhatsAppSession, WhatsAppSessionDocument } from './schemas/whatsapp-session.schema';
import { WhatsAppMessage, WhatsAppMessageDocument } from './schemas/whatsapp-message.schema';
import { WhatsappStorageService } from './whatsapp-storage.service';
import { WhatsappWebGateway } from './whatsapp-web.gateway';
import { WhatsappAlertsService } from './whatsapp-alerts.service';
import { RabbitService } from 'src/rabbit.service';
import type { NormalizedChat, NormalizedMessage } from './types/normalized-whatsapp.types';

/** Parse CONFIG_SESSION_PHONE_VERSION / WA_VERSION (e.g. "2.3000.1019707846") to Baileys WAVersion tuple to fix qr: undefined (see https://github.com/WhiskeySockets/Baileys/issues/1482) */
function parsePhoneVersion(versionStr: string | undefined): [number, number, number] | undefined {
  if (!versionStr?.trim()) return undefined;
  const parts = versionStr.trim().split('.').map((s) => parseInt(s, 10));
  if (parts.length < 3 || parts.some(Number.isNaN)) return undefined;
  return [parts[0], parts[1], parts[2]];
}

type SessionEntry = {
  sock: WASocket;
  isReady: boolean;
  lastRestore?: Date;
  isRestoring?: boolean;
  store?: ReturnType<typeof makeInMemoryStore>;
};

@Injectable()
export class WhatsappWebService implements OnModuleInit {
  private readonly logger = new Logger(WhatsappWebService.name);
  private readonly authPath = path.join(process.cwd(), 'baileys_auth');
  private sessions: Map<string, SessionEntry> = new Map();
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
    //await this.initializeStoredSessions();
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
   * Extract text body from Baileys WAMessage
   */
  private getBaileysMessageBody(msg: WAMessage): string {
    const m = msg.message;
    if (!m) return '';
    if (typeof (m as any).conversation === 'string') return (m as any).conversation;
    if ((m as any).extendedTextMessage?.text) return (m as any).extendedTextMessage.text;
    if ((m as any).imageMessage?.caption) return (m as any).imageMessage.caption;
    if ((m as any).videoMessage?.caption) return (m as any).videoMessage.caption;
    if ((m as any).documentMessage?.caption) return (m as any).documentMessage.caption;
    return '[media]';
  }

  /**
   * Get message type from Baileys WAMessage
   */
  private getBaileysMessageType(msg: WAMessage): string {
    const m = msg.message;
    if (!m) return 'chat';
    if ((m as any).conversation) return 'chat';
    if ((m as any).extendedTextMessage) return 'chat';
    if ((m as any).imageMessage) return 'image';
    if ((m as any).videoMessage) return 'video';
    if ((m as any).audioMessage) return 'audio';
    if ((m as any).documentMessage) return 'document';
    return 'chat';
  }

  /**
   * Normalize a Baileys WAMessage into our library-agnostic structure
   */
  private normalizeBaileysMessage(msg: WAMessage, chatId?: string): NormalizedMessage {
    const key = msg.key;
    const remoteJid = key.remoteJid!;
    const id = key.id!;
    const fromMe = key.fromMe ?? false;
    const participant = key.participant;
    const messageId = `${remoteJid}_${id}`;
    const resolvedChatId = chatId ?? remoteJid;
    const from = fromMe ? remoteJid : (participant || remoteJid);
    const to = remoteJid;
    const body = this.getBaileysMessageBody(msg);
    const type = this.getBaileysMessageType(msg);
    const hasMedia = type !== 'chat' && type !== 'conversation';
    const timestamp = msg.messageTimestamp ? Number(msg.messageTimestamp) : Math.floor(Date.now() / 1000);
    return {
      messageId,
      chatId: resolvedChatId,
      body,
      type,
      from,
      to,
      author: participant || null,
      fromMe,
      isForwarded: !!(msg.message as any).forwarded,
      forwardingScore: (msg.message as any).forwardingScore ?? 0,
      isStatus: remoteJid === 'status@broadcast',
      hasMedia,
      mediaType: hasMedia ? type : null,
      hasQuotedMsg: !!((msg.message as any).extendedTextMessage?.contextInfo?.quotedMessage),
      isStarred: false,
      isGif: !!((msg.message as any).videoMessage?.gifPlayback),
      isEphemeral: !!((msg.message as any).ephemeralMessage),
      timestamp,
      ack: 0,
      broadcast: !!(msg.message as any).broadcast,
      mentionedIds: ((msg.message as any).extendedTextMessage?.contextInfo?.mentionedJid) || [],
      rawData: msg as unknown as object,
    };
  }

  /**
   * Build NormalizedChat from Baileys chat (store) or jid + name
   */
  private normalizeBaileysChat(chatId: string, name?: string, isGroup?: boolean): NormalizedChat {
    return {
      chatId,
      name: name || chatId.split('@')[0] || chatId,
      isGroup: isGroup ?? chatId.endsWith('@g.us'),
      unreadCount: 0,
      timestamp: Math.floor(Date.now() / 1000),
      archived: false,
      pinned: false,
      isReadOnly: false,
      isMuted: false,
      muteExpiration: null,
      lastMessage: null,
      lastMessageTimestamp: null,
      lastMessageFromMe: false,
    };
  }

  /**
   * Setup Baileys socket event listeners
   */
  private setupBaileysListeners(sock: WASocket, sessionId: string, saveCreds: () => Promise<void>) {
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      const session = this.sessions.get(sessionId);
      console.log('update', JSON.stringify(update, null, 2));
      // QR event: on a qr event, connection and lastDisconnect are empty (per Baileys docs)
      if (qr) {
        if (session?.isReady) {
          this.logger.warn(`⚠️ Session ${sessionId} is already ready, ignoring QR event`);
          return;
        }
        this.logger.log(`📱 QR received for session ${sessionId} — scan with your WhatsApp app:`);
        qrcode.generate(qr, { small: false });
        await this.storeSessionMetadata(sessionId, { status: 'qr_generated', lastSeen: new Date(), qrCode: qr });
        this.emitQrEvent(sessionId, qr);
      }

      if (connection === 'open') {
        this.logger.log(`✅ Session ${sessionId} is ready!`);
        if (session) session.isReady = true;
        await this.storeSessionMetadata(sessionId, {
          status: 'ready',
          lastSeen: new Date(),
          isDisconnected: false,
          qrCode: undefined,
        });
        const isRestoring = session?.isRestoring ?? false;
        if (!isRestoring) {
          try {
            this.logger.log(`🔄 Starting chat synchronization for session ${sessionId}`);
            const result = await this.syncChatsWithProgress(sessionId);
            this.logger.log(`✅ Chat synchronization completed for session ${sessionId}: ${result.chatsProcessed} chats`);
            const storedChats = await this.storageService.getStoredChats(sessionId);
            this.rabbitService.emitToRecordsAiChatsAnalysisService('session_ready', {
              sessionId,
              chats: storedChats.map((c) => c.chatId),
            });
          } catch (err) {
            this.logger.error(`Error synchronizing chats for session ${sessionId}: ${(err as Error).message}`);
          }
        }
        this.emitReadyEvent(sessionId);
      }

      // Close: handle per https://baileys.wiki/docs/socket/connecting/
      // After QR scan WhatsApp forces disconnect with restartRequired (515) — create a NEW socket, current one is useless.
      // 405 = Connection Failure / Method Not Allowed — often version or method rejection; create new socket to retry.
      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const isRestartRequired = statusCode === DisconnectReason.restartRequired;
        const isConnectionFailure405 = statusCode === 405;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;

        if (session) session.isReady = false;
        this.sessions.delete(sessionId);

        if (isRestartRequired) {
          this.logger.log(`🔄 Session ${sessionId}: restart required (e.g. after QR scan) — creating new socket...`);
          await this.storeSessionMetadata(sessionId, { status: 'initializing', lastSeen: new Date() });
          setImmediate(() => this.createSession(sessionId, { isRestoring: true }).catch((e) => this.logger.error(e)));
          return;
        }

        if (isConnectionFailure405) {
          this.logger.warn(`⚠️ Session ${sessionId}: connection failure (405). Creating new socket in 5s...`);
          await this.storeSessionMetadata(sessionId, { status: 'disconnected', lastSeen: new Date() });
          setTimeout(() => this.createSession(sessionId, { isRestoring: true }).catch((e) => this.logger.error(e)), 5000);
          return;
        }

        if (!isLoggedOut) {
          this.logger.warn(`⚠️ Session ${sessionId} disconnected (${statusCode}). Reconnecting in 3s...`);
          await this.storeSessionMetadata(sessionId, { status: 'disconnected', lastSeen: new Date() });
          try {
            const sessionDoc = await this.whatsAppSessionModel.findOne({ sessionId }).exec();
            await this.whatsAppSessionModel.updateOne({ sessionId }, { $set: { isDisconnected: true, closedAt: new Date() } });
            if (sessionDoc?._id) {
              await this.alertsService.createDisconnectedAlert(
                sessionDoc._id as mongoose.Types.ObjectId,
                sessionId,
                `Session ${sessionId} disconnected: ${statusCode}`
              );
            }
          } catch (e) {
            this.logger.error(`Failed to create disconnected alert for ${sessionId}`, e as Error);
          }
          setTimeout(() => this.createSession(sessionId, { isRestoring: true }).catch((e) => this.logger.error(e)), 3000);
        } else {
          await this.storeSessionMetadata(sessionId, { status: 'closed', lastSeen: new Date() });
        }
      }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        try {
          const chatId = msg.key.remoteJid!;
          const body = this.getBaileysMessageBody(msg);
          this.logger.log(`📤 Message received in session ${sessionId}: ${body?.substring(0, 50) || 'media message'}`);
          const normalized = this.normalizeBaileysMessage(msg);
          await this.storageService.saveMessage(sessionId, normalized);
          const normalizedChat = this.normalizeBaileysChat(chatId);
          await this.storageService.saveChat(sessionId, normalizedChat);

          const messageData: any = {
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
          this.rabbitService.emitToRecordsAiChatsAnalysisService('message_create', { sessionId, message: messageData });
        } catch (error) {
          this.logger.error(`Error handling messages.upsert: ${(error as Error).message}`);
        }
      }
    });

    sock.ev.on('messages.update', async (updates) => {
      for (const u of updates) {
        const status = (u.update as any)?.status;
        if (String(status) === 'DELETED' && u.key?.id && u.key?.remoteJid) {
          const messageId = `${u.key.remoteJid}_${u.key.id}`;
          await this.storageService.markMessageAsDeleted(sessionId, messageId, 'everyone');
          this.gateway.emitMessageDeleted(sessionId, u.key.remoteJid, messageId);
        }
      }
    });
  }

  /**
   * Remove session auth folder (Baileys)
   */
  private async removeSessionFolder(sessionId: string): Promise<void> {
    try {
      const sessionFolder = path.join(this.authPath, sessionId);
      await fs.rm(sessionFolder, { recursive: true, force: true });
      this.logger.log(`🧹 Removed session folder: ${sessionFolder}`);
    } catch (error) {
      this.logger.warn(`⚠️ Error removing session folder for ${sessionId}: ${(error as Error).message}`);
    }
  }

  /**
   * Create a new WhatsApp session (Baileys)
   */
  async createSession(sessionId: string, options?: { groupId?: string; isRestoring?: boolean; title?: string }) {
    try {
      this.logger.log(`createSession or restore session: ${sessionId}`);

      const existingSession = this.sessions.get(sessionId);
      const storedSession = await this.whatsAppSessionModel.findOne({ sessionId }).exec();

      if (existingSession?.isReady && storedSession && (storedSession.status === 'ready' || storedSession.status === 'authenticated')) {
        this.logger.warn(`Session ${sessionId} already exists and is ready`);
        return { success: false, sessionId, message: 'Session already exists and authenticated' };
      }

      if (storedSession && (storedSession.status === 'ready' || storedSession.status === 'authenticated') && existingSession) {
        return { success: false, sessionId, message: 'Session is already authenticated' };
      }

      if (existingSession && !existingSession.isReady) {
        this.logger.log(`Session ${sessionId} exists but not ready, recreating`);
        try {
          (existingSession.sock as any).end?.();
        } catch (e) {
          this.logger.warn(`Error ending existing session: ${(e as Error).message}`);
        }
        this.sessions.delete(sessionId);
      }

      this.logger.log(`🔨 Creating session (Baileys): ${sessionId}`);

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

      const authDir = path.join(this.authPath, sessionId);
      await fs.mkdir(authDir, { recursive: true });
      const { state, saveCreds } = await useMultiFileAuthState(authDir);

      const store = makeInMemoryStore({});
      // Pin version via CONFIG_SESSION_PHONE_VERSION or WA_VERSION to avoid qr: undefined (connection failure before QR)
      const versionStr =
        this.configService.get<string>('CONFIG_SESSION_PHONE_VERSION') ??
        this.configService.get<string>('WA_VERSION');

        const version = parsePhoneVersion(versionStr);
        console.log('version', version);

      const sock = makeWASocket({
        auth: state,
        version: version,
        printQRInTerminal: true,
        browser: Browsers.ubuntu('CRM'),
        syncFullHistory: true,
        getMessage: async () => undefined,
        cachedGroupMetadata: async () => undefined,
      });

      store.bind(sock.ev);

      this.setupBaileysListeners(sock, sessionId, saveCreds);

      this.sessions.set(sessionId, {
        sock,
        isReady: false,
        lastRestore: new Date(),
        isRestoring: options?.isRestoring ?? false,
        store,
      });

      return { success: true, sessionId, message: 'Session created successfully' };
    } catch (error) {
      this.logger.error(`❌ Error creating session ${sessionId}:`, error);
      this.sessions.delete(sessionId);
      await this.storeSessionMetadata(sessionId, { status: 'error', lastSeen: new Date() });
      throw new Error(`Failed to create session: ${(error as Error).message}`);
    }
  }

  /**
   * Destroy a session (Baileys)
   */
  async destroySession(sessionId: string) {
    try {
      const session = this.sessions.get(sessionId);
      if (session) {
        try {
          (session.sock as any).end?.();
        } catch (_) {}
        this.sessions.delete(sessionId);
      }
      await this.whatsAppSessionModel.deleteMany({ sessionId });
      this.logger.log(`🧹 Session ${sessionId} destroyed and removed from MongoDB`);
      return { success: true, message: 'Session destroyed successfully' };
    } catch (error) {
      this.logger.error(`Error destroying session ${sessionId}:`, error);
      throw new Error(`Failed to destroy session: ${(error as Error).message}`);
    }
  }

  /**
   * Send message (Baileys)
   */
  async sendMessage(sessionId: string, phone: string, message: string) {
    try {
      const session = this.sessions.get(sessionId);
      if (!session) throw new Error(`Session ${sessionId} not found`);
      if (!session.isReady) throw new Error(`Session ${sessionId} is not ready yet`);

      const formattedPhone = phone.replace(/\D/g, '');
      const jid = `${formattedPhone}@s.whatsapp.net`;

      const result = await session.sock.sendMessage(jid, { text: message });

      this.logger.log(`📤 Message sent to ${phone} via session ${sessionId}`);
      const key = result?.key;
      const messageId = key ? `${key.remoteJid}_${key.id}` : '';
      const timestamp = result?.messageTimestamp ? Number(result.messageTimestamp) : Math.floor(Date.now() / 1000);
      return { success: true, messageId, timestamp };
    } catch (error) {
      this.logger.error(`Error sending message via session ${sessionId}:`, error);
      throw new Error(`Failed to send message: ${(error as Error).message}`);
    }
  }

  /**
   * Get session status (Baileys)
   */
  getSessionStatus(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return { exists: false, ready: false };
    return {
      exists: true,
      ready: session.isReady,
      state: (session.sock as any).user,
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
   * Get socket instance (Baileys) for advanced operations
   */
  getClient(sessionId: string): WASocket | null {
    const session = this.sessions.get(sessionId);
    return session ? session.sock : null;
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
   * Get messages from a specific chat (from DB; Baileys receives messages via events and stores them)
   */
  async getChatMessages(sessionId: string, chatId: string, limit?: number) {
    try {
      const session = this.sessions.get(sessionId);
      if (!session) throw new Error(`Session ${sessionId} not found`);
      if (!session.isReady) throw new Error(`Session ${sessionId} is not ready yet`);

      const storedMessages = await this.getStoredMessages(sessionId, chatId, { limit: limit || 50 });
      this.logger.log(`📥 Returning ${storedMessages.length} stored messages for chat ${chatId}`);

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
    } catch (error) {
      this.logger.error(`Error getting messages from chat ${chatId} in session ${sessionId}:`, error);
      if ((error as Error)?.message && /Session closed/i.test((error as Error).message)) {
        await this.handleSessionClosed(sessionId, chatId);
      }
      throw new Error(`Failed to get messages: ${(error as Error).message}`);
    }
  }

  /**
   * Sync recent messages from Baileys in-memory store into DB (if store has chats/messages)
   */
  async syncRecentMessages(sessionId: string, chatId?: string, limitPerChat: number = 100) {
    try {
      const session = this.sessions.get(sessionId);
      if (!session) throw new Error(`Session ${sessionId} not found`);
      if (!session.isReady) throw new Error(`Session ${sessionId} is not ready yet`);

      const store = session.store;
      const targetChatIds: string[] = chatId ? [chatId] : (store ? Object.keys(store.chats || {}) : []);

      if (targetChatIds.length === 0 && !chatId) {
        return { success: true, chatsProcessed: 0 };
      }

      this.logger.log(`🔄 Syncing recent messages for ${targetChatIds.length} chat(s) on session ${sessionId}`);

      for (const targetId of targetChatIds) {
        try {
          const msgBag = store?.messages?.[targetId];
          const messages = (msgBag?.array ?? msgBag?.toJSON?.() ?? []).slice(-limitPerChat);
          if (messages.length > 0) {
            const normalizedMessages: NormalizedMessage[] = messages.map((m) => this.normalizeBaileysMessage(m, targetId));
            await this.storageService.saveMessages(sessionId, normalizedMessages, targetId);
            this.logger.log(`💾 Synced ${messages.length} messages for chat ${targetId}`);
          }
        } catch (innerError) {
          this.logger.error(`Error syncing messages for chat ${targetId}: ${(innerError as Error).message}`);
        }
      }

      return { success: true, chatsProcessed: targetChatIds.length };
    } catch (error) {
      this.logger.error(`Error syncing recent messages for session ${sessionId}:`, error);
      throw new Error(`Failed to sync recent messages: ${(error as Error).message}`);
    }
  }

  /**
   * Synchronize chats and messages from Baileys in-memory store with progress events
   */
  async syncChatsWithProgress(sessionId: string, limitPerChat: number = 100) {
    try {
      const session = this.sessions.get(sessionId);
      if (!session) throw new Error(`Session ${sessionId} not found`);
      if (!session.isReady) throw new Error(`Session ${sessionId} is not ready yet`);

      const store = session.store;
      const chatIds = store ? Object.keys(store.chats || {}) : [];
      const nChats = chatIds.length;

      this.logger.log(`📋 Syncing ${nChats} chats from store for session ${sessionId}`);
      this.gateway.emitSyncChats(sessionId, { nChats, currentChat: 0, messagesSynced: 0 });

      for (let i = 0; i < chatIds.length; i++) {
        const chatId = chatIds[i];
        try {
          this.logger.log(`📋 Processing chat ${i + 1}/${nChats}: ${chatId}`);
          const chat = (store as any).chats?.[chatId];
          const name = chat?.name || chatId.split('@')[0] || chatId;
          const isGroup = chatId.endsWith('@g.us');
          const normalizedChat = this.normalizeBaileysChat(chatId, name, isGroup);
          await this.storageService.saveChats(sessionId, [normalizedChat], async (_, __, savedChat) => {
            this.gateway.emitSyncChats(sessionId, { nChats, currentChat: i + 1, chatId: savedChat.chatId, messagesSynced: 0 });
          });

          const msgBag = (store as any).messages?.[chatId];
          const messages = (msgBag?.array ?? msgBag?.toJSON?.() ?? []).slice(-limitPerChat);
          if (messages.length > 0) {
            const normalizedMessages: NormalizedMessage[] = messages.map((m) => this.normalizeBaileysMessage(m, chatId));
            await this.storageService.saveMessages(sessionId, normalizedMessages, chatId, (messagesSaved) => {
              this.gateway.emitSyncChats(sessionId, { nChats, currentChat: i + 1, chatId, messagesSynced: messagesSaved });
            });
            this.logger.log(`💾 Synced ${messages.length} messages for chat ${chatId}`);
          } else {
            this.gateway.emitSyncChats(sessionId, { nChats, currentChat: i + 1, chatId, messagesSynced: 0 });
          }
        } catch (innerError) {
          this.logger.error(`Error syncing chat ${chatId}: ${(innerError as Error).message}`);
          this.gateway.emitSyncChats(sessionId, { nChats, currentChat: i + 1, chatId, messagesSynced: 0 });
        }
      }

      this.logger.log(`✅ Synchronization completed for session ${sessionId}`);
      return { success: true, chatsProcessed: nChats, message: 'Synchronization completed successfully' };
    } catch (error) {
      this.logger.error(`Error synchronizing chats for session ${sessionId}:`, error);
      throw new Error(`Failed to synchronize chats: ${(error as Error).message}`);
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
      if (session) session.isReady = false;
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


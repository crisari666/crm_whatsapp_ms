// src/whatsapp-web/whatsapp-web.service.ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import * as mongoose from 'mongoose';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  proto,
  useMultiFileAuthState,
  type WAMessage,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { WhatsAppSession, WhatsAppSessionDocument } from './schemas/whatsapp-session.schema';
import { WhatsAppMessage, WhatsAppMessageDocument } from './schemas/whatsapp-message.schema';
import { WhatsappStorageService } from './whatsapp-storage.service';
import { WhatsappWebGateway } from './whatsapp-web.gateway';
import * as path from 'path';
import * as fs from 'fs/promises';
import { WhatsappAlertsService } from './whatsapp-alerts.service';
import { RabbitService } from 'src/rabbit.service';
import type { NormalizedChat, NormalizedMessage } from './types/normalized-whatsapp.types';

function parsePhoneVersion(versionStr: string | undefined): [number, number, number] | undefined {
  if (!versionStr?.trim()) return undefined;
  const parts = versionStr.trim().split('.').map((s) => parseInt(s, 10));
  if (parts.length < 3 || parts.some(Number.isNaN)) return undefined;
  return [parts[0], parts[1], parts[2]];
}

type BaileysSocket = ReturnType<typeof makeWASocket>;

@Injectable()
export class WhatsappWebService implements OnModuleInit {
  private readonly logger = new Logger(WhatsappWebService.name);
  private readonly baileysAuthPath = path.join(process.cwd(), 'baileys_auth');
  private sessions: Map<string, { socket: BaileysSocket; isReady: boolean; lastRestore?: Date; isRestoring?: boolean }> = new Map();
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

  private async initializeStoredSessions() {
    if (this.isInitializing) {
      this.logger.warn('Session initialization already in progress');
      return;
    }

    this.isInitializing = true;

    try {
      await this.connection.readyState;

      const documents = await this.whatsAppSessionModel.find({
        status: { $in: ['ready', 'authenticated'] }
      }).exec();

      this.logger.log(`📱 Found ${documents.length} ready/authenticated sessions in database`);

      if (documents.length === 0) {
        this.logger.log('No ready/authenticated sessions to restore');
        return;
      }

      const sessionIds = [...new Set(documents.map(doc => doc.sessionId))];

      for (const sessionId of sessionIds) {
        if (this.sessions.has(sessionId)) {
          this.logger.log(`Session ${sessionId} is already active, skipping...`);
          continue;
        }

        try {
          this.logger.log(`🔄 Attempting to restore session: ${sessionId}`);
          await this.createSession(sessionId, { isRestoring: true });
          this.logger.log(`✅ Session ${sessionId} restored successfully`);
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

  private async resolveWaWebVersion(): Promise<[number, number, number] | undefined> {
    const pinnedStr =
      this.configService.get<string>('CONFIG_SESSION_PHONE_VERSION') ??
      this.configService.get<string>('WA_VERSION');
    const versionOnly =
      this.configService.get<string>('WA_VERSION_ONLY') === 'true' ||
      this.configService.get<string>('WA_VERSION_ONLY') === '1';

    if (versionOnly) {
      const v = parsePhoneVersion(pinnedStr);
      if (v) {
        this.logger.log(`WA Web version (pin): ${v.join('.')}`);
      } else {
        this.logger.warn('WA_VERSION_ONLY set but CONFIG_SESSION_PHONE_VERSION/WA_VERSION is missing or invalid');
      }
      return v;
    }

    try {
      const fetched = await fetchLatestBaileysVersion();
      if (fetched.error) {
        this.logger.warn(`fetchLatestBaileysVersion: ${fetched.error}`);
      }
      this.logger.log(
        `WA Web version (fetched): ${fetched.version.join('.')}, isLatest=${fetched.isLatest}`,
      );
      return fetched.version;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`fetchLatestBaileysVersion failed (${msg}); trying env pin`);
      const v = parsePhoneVersion(pinnedStr);
      if (v) {
        this.logger.log(`WA Web version (env fallback): ${v.join('.')}`);
      }
      return v;
    }
  }

  private async storeSessionMetadata(sessionId: string, metadata: { status?: string; lastSeen?: Date; isDisconnected?: boolean; disconnectedAt?: Date; refId?: mongoose.Types.ObjectId; groupId?: mongoose.Types.ObjectId, qrCode?: string | null; title?: string }) {
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

  private buildNormalizedMessage(waMessage: WAMessage): NormalizedMessage | null {
    const { key, message, messageTimestamp } = waMessage;
    if (!message || !key.remoteJid || !key.id) {
      return null;
    }
    const content = message;
    let body = '';
    let type = '';
    if (content.conversation) {
      body = content.conversation;
      type = 'chat';
    } else if (content.extendedTextMessage?.text) {
      body = content.extendedTextMessage.text;
      type = 'chat';
    } else if (content.imageMessage) {
      body = content.imageMessage.caption ?? '';
      type = 'image';
    } else if (content.videoMessage) {
      body = content.videoMessage.caption ?? '';
      type = 'video';
    } else if (content.audioMessage) {
      type = 'audio';
    } else if (content.documentMessage) {
      body = content.documentMessage.caption ?? '';
      type = 'document';
    } else {
      type = Object.keys(content)[0] ?? 'unknown';
    }
    const chatId = key.remoteJid;
    const from = key.remoteJid;
    const to = key.participant ?? key.remoteJid;
    const fromMe = !!key.fromMe;
    const hasMedia =
      !!content.imageMessage ||
      !!content.videoMessage ||
      !!content.audioMessage ||
      !!content.documentMessage ||
      !!content.stickerMessage;
    const hasQuotedMsg = !!(
      content.extendedTextMessage?.contextInfo ||
      content.imageMessage?.contextInfo ||
      content.videoMessage?.contextInfo
    );
    const contextInfo = (content as { contextInfo?: proto.IContextInfo }).contextInfo;
    const timestampSec = Number(messageTimestamp ?? 0);
    const rawData = waMessage as unknown as object;
    const normalized: NormalizedMessage = {
      messageId: key.id,
      chatId,
      body,
      type,
      from,
      to,
      author: key.participant ?? null,
      fromMe,
      isForwarded: !!contextInfo?.isForwarded,
      forwardingScore: contextInfo?.forwardingScore ?? 0,
      isStatus: key.remoteJid === 'status@broadcast',
      hasMedia,
      mediaType: hasMedia ? type : null,
      hasQuotedMsg,
      isStarred: false,
      isGif: !!content.videoMessage?.gifPlayback,
      isEphemeral: false,
      timestamp: timestampSec,
      ack: 0,
      deviceType: undefined,
      broadcast: false,
      mentionedIds: content.extendedTextMessage?.contextInfo?.mentionedJid ?? [],
      rawData,
    };
    return normalized;
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

  private setupBaileysListeners(
    socket: BaileysSocket,
    sessionId: string,
    saveCreds: () => Promise<void>,
  ): void {
    socket.ev.on('creds.update', saveCreds);
    socket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        const session = this.sessions.get(sessionId);
        if (session && session.isReady) {
          this.logger.warn(`⚠️ Session ${sessionId} is already ready, ignoring QR event`);
          return;
        }
        this.logger.log(`📱 QR received for session ${sessionId}`);
        await this.storeSessionMetadata(sessionId, {
          status: 'qr_generated',
          lastSeen: new Date(),
          qrCode: qr,
        });
        this.emitQrEvent(sessionId, qr);
      }
      if (connection === 'open') {
        this.logger.log(`✅ Session ${sessionId} is ready!`);
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
            this.logger.error(
              `Error emitting session_ready for session ${sessionId}: ${msg}`,
            );
          }
        }
        this.emitReadyEvent(sessionId);
      }
      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        const isRestartRequired = statusCode === DisconnectReason.restartRequired;
        const isConnectionFailure405 = statusCode === 405;

        this.logger.warn(
          `⚠️ Session ${sessionId} disconnected: status=${statusCode}, loggedOut=${isLoggedOut}`,
        );

        const entry = this.sessions.get(sessionId);
        if (entry) {
          entry.isReady = false;
        }
        this.sessions.delete(sessionId);

        if (isRestartRequired) {
          this.logger.log(
            `🔄 Session ${sessionId}: restart required (e.g. after QR) — new socket...`,
          );
          await this.storeSessionMetadata(sessionId, {
            status: 'initializing',
            lastSeen: new Date(),
          });
          setImmediate(() => {
            void this.createSession(sessionId, { isRestoring: true }).catch((err) =>
              this.logger.error(err),
            );
          });
          return;
        }

        if (isConnectionFailure405) {
          this.logger.warn(
            `Session ${sessionId}: connection failure (405) — often stale WA Web version; retrying in 3s`,
          );
          await this.storeSessionMetadata(sessionId, {
            status: 'disconnected',
            lastSeen: new Date(),
          });
          setTimeout(() => {
            void this.createSession(sessionId, { isRestoring: true }).catch((err) =>
              this.logger.error(err),
            );
          }, 3000);
          return;
        }

        await this.storeSessionMetadata(sessionId, {
          status: 'disconnected',
          lastSeen: new Date(),
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
              `Session ${sessionId} disconnected (code ${statusCode ?? 'unknown'})`,
            );
          }
        } catch (e) {
          this.logger.error(`Failed to create disconnected alert for ${sessionId}`, e as Error);
        }

        if (isLoggedOut) {
          this.emitAuthFailureEvent(sessionId, lastDisconnect?.error);
          await this.handleSessionClosed(sessionId);
          return;
        }

        this.logger.warn(`Session ${sessionId}: reconnecting in 3s...`);
        setTimeout(() => {
          void this.createSession(sessionId, { isRestoring: true }).catch((err) =>
            this.logger.error(err),
          );
        }, 3000);
      }
    });
    socket.ev.on('messages.upsert', async (upsert) => {
      if (upsert.type !== 'notify') {
        return;
      }
      for (const waMessage of upsert.messages) {
        try {
          const normalized = this.buildNormalizedMessage(waMessage);
          if (!normalized) {
            continue;
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
          const msg = error instanceof Error ? error.message : String(error);
          this.logger.error(
            `Error handling messages.upsert for session ${sessionId}: ${msg}`,
          );
        }
      }
    });
  }

  async createSession(sessionId: string, options?: { groupId?: string; isRestoring?: boolean; title?: string }) {
    try {
      const existingSession = this.sessions.get(sessionId);
      const storedSession = await this.whatsAppSessionModel.findOne({ sessionId }).exec();
      const dbReady =
        !!storedSession &&
        (storedSession.status === 'ready' || storedSession.status === 'authenticated');

      if (existingSession?.isReady && dbReady) {
        this.logger.log(`Session ${sessionId} already active (socket ready)`);
        return {
          success: true,
          sessionId,
          message: 'Session already active',
        };
      }

      if (existingSession) {
        this.logger.log(
          `Session ${sessionId}: replacing existing socket (${existingSession.isReady ? 'stale or reconnect' : 'not ready'})`,
        );
        try {
          existingSession.socket.end(undefined);
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          this.logger.warn(`Error ending previous socket: ${msg}`);
        }
        this.sessions.delete(sessionId);
      }

      if (dbReady) {
        this.logger.log(`🔄 Restoring authenticated session ${sessionId} from local auth state...`);
      }

      this.logger.log(`🔨 Creating session: ${sessionId}`);
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
      const authDir = path.join(this.baileysAuthPath, sessionId);
      await fs.mkdir(authDir, { recursive: true });
      const { state, saveCreds } = await useMultiFileAuthState(authDir);
      const version = await this.resolveWaWebVersion();
      const socket = makeWASocket({
        auth: state,
        ...(version ? { version } : {}),
        printQRInTerminal: true,
        browser: Browsers.ubuntu('CRM'),
        shouldSyncHistoryMessage: () => false,
        syncFullHistory: false,
      });
      this.setupBaileysListeners(socket, sessionId, saveCreds);
      const isRestoring =
        options?.isRestoring !== undefined ? options.isRestoring : dbReady;
      this.sessions.set(sessionId, {
        socket,
        isReady: false,
        lastRestore: new Date(),
        isRestoring,
      });
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
        session.socket.end(undefined);
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Error ending socket for ${sessionId}: ${msg}`);
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
    this.logger.log(`🔌 Session ${sessionId} disconnected (socket closed, credentials kept)`);
    return {
      success: true,
      sessionId,
      message: 'Disconnected',
    };
  }

  async disconnectAllActiveSessions() {
    const ids = [...this.sessions.keys()];
    if (ids.length === 0) {
      return {
        success: true,
        disconnected: [] as string[],
        count: 0,
        message: 'No active socket sessions',
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
        session.socket.end(undefined);
        this.sessions.delete(sessionId);
      }

      await this.whatsAppSessionModel.deleteMany({ sessionId: sessionId });
      this.logger.log(`🧹 Session ${sessionId} destroyed and removed from MongoDB`);
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
      const jid = `${formattedPhone}@s.whatsapp.net`;
      const result = await session.socket.sendMessage(jid, { text: message });
      this.logger.log(`📤 Message sent to ${phone} via session ${sessionId}`);
      return {
        success: true,
        messageId: result.key.id,
        timestamp: Number(result.messageTimestamp ?? 0) * 1000,
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error sending message via session ${sessionId}:`, error);
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
      state: session.socket.user,
    };
  }

  async getSession(sessionId: string) {
    const session = await this.whatsAppSessionModel.findOne({ sessionId }).exec();
    return session;
  }

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
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error getting QR code for session ${sessionId}:`, error);
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

  getClient(sessionId: string): BaileysSocket | null {
    const session = this.sessions.get(sessionId);
    return session ? session.socket : null;
  }

  async getChats(sessionId: string) {
    try {
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
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error getting chats from session ${sessionId}:`, error);
      throw new Error(`Failed to get chats: ${msg}`);
    }
  }

  async getChatsForSyncApp(sessionId: string) {
    try {
      const storedChats = await this.storageService.getStoredChats(sessionId);
      return storedChats
        .filter((chat) => !chat.deleted)
        .map((chat) => {
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
        });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error getting sync-app chats for session ${sessionId}:`, error);
      throw new Error(`Failed to get chats: ${msg}`);
    }
  }

  private mapAckToUiStatus(
    ack: number,
  ): 'sending' | 'sent' | 'delivered' | 'read' {
    if (ack >= 3) return 'read';
    if (ack >= 2) return 'delivered';
    if (ack >= 1) return 'sent';
    return 'sent';
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

  async getMessagesForSyncApp(
    sessionId: string,
    chatId: string,
    limit: number = 100,
  ) {
    try {
      const rows = await this.getStoredMessages(sessionId, chatId, {
        limit,
        includeDeleted: false,
      });
      return rows.map((msg) => ({
        id: msg.messageId,
        chatId: msg.chatId,
        sender: msg.fromMe ? ('me' as const) : ('them' as const),
        content: msg.body ?? '',
        type: this.mapDbTypeToUiType(msg.type),
        timestamp: new Date(msg.timestamp * 1000).toISOString(),
        status: this.mapAckToUiStatus(msg.ack ?? 0),
        isEdited: Array.isArray(msg.edition) && msg.edition.length > 0,
        editHistory: [] as { content: string; editedAt: string }[],
        isDeleted: !!msg.isDeleted,
        deletedAt: msg.deletedAt
          ? new Date(msg.deletedAt).toISOString()
          : undefined,
        hasMedia: !!msg.hasMedia,
        mediaType: msg.mediaType ?? undefined,
      }));
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Error getting sync-app messages for ${sessionId}/${chatId}:`,
        error,
      );
      throw new Error(`Failed to get messages: ${msg}`);
    }
  }

  async getChatMessages(sessionId: string, chatId: string, limit?: number) {
    try {
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
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error getting messages from chat ${chatId} in session ${sessionId}:`, error);
      throw new Error(`Failed to get messages: ${msg}`);
    }
  }

  async syncRecentMessages(sessionId: string, chatId?: string) {
    try {
      this.logger.log(
        `🔄 syncRecentMessages called for session ${sessionId}, chatId=${chatId || 'all'} (Baileys mode uses stored messages only)`,
      );
      return { success: true, chatsProcessed: 0 };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error syncing recent messages for session ${sessionId}:`, error);
      throw new Error(`Failed to sync recent messages: ${msg}`);
    }
  }

  async syncChatsWithProgress(sessionId: string, limitPerChat?: number) {
    void limitPerChat;
    try {
      const storedChats = await this.storageService.getStoredChats(sessionId);
      const nChats = storedChats.length;
      this.gateway.emitSyncChats(sessionId, {
        nChats,
        currentChat: 0,
        messagesSynced: 0,
      });
      for (let i = 0; i < storedChats.length; i++) {
        const chat = storedChats[i];
        this.gateway.emitSyncChats(sessionId, {
          nChats,
          currentChat: i + 1,
          chatId: chat.chatId,
          messagesSynced: 0,
        });
      }
      this.logger.log(`✅ Synchronization (stored data) completed for session ${sessionId}`);
      return {
        success: true,
        chatsProcessed: nChats,
        message: 'Synchronization completed using stored chats only',
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error synchronizing chats with progress for session ${sessionId}:`, error);
      throw new Error(`Failed to synchronize chats: ${msg}`);
    }
  }

  async getStoredMessages(sessionId: string, chatId?: string, options?: {
    includeDeleted?: boolean;
    limit?: number;
    skip?: number;
    startTimestamp?: number;
    endTimestamp?: number;
  }) {
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
      this.logger.error(`Error getting stored messages: ${msg}`);
      throw new Error(`Failed to get stored messages: ${msg}`);
    }
  }

  async getDeletedMessages(sessionId: string, chatId?: string, limit?: number) {
    try {
      const query: Record<string, unknown> = { sessionId, isDeleted: true };

      if (chatId) {
        query.chatId = chatId;
      }

      const messages = await this.whatsAppMessageModel
        .find(query)
        .sort({ deletedAt: -1 })
        .limit(limit || 50)
        .exec();

      return messages;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error getting deleted messages: ${msg}`);
      throw new Error(`Failed to get deleted messages: ${msg}`);
    }
  }

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
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error getting stored message: ${msg}`);
      throw new Error(`Failed to get message: ${msg}`);
    }
  }

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
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error getting message edit history: ${msg}`);
      throw new Error(`Failed to get edit history: ${msg}`);
    }
  }

  async getStoredChats(sessionId: string, options?: {
    archived?: boolean;
    isGroup?: boolean;
    limit?: number;
    skip?: number;
  }) {
    return this.storageService.getStoredChats(sessionId, options);
  }

  async getStoredChat(sessionId: string, chatId: string) {
    return this.storageService.getStoredChat(sessionId, chatId);
  }

  async sendRMMessage(payload: unknown) {
    try {
      this.logger.log(`📤 Sending RM message to ms2: ${JSON.stringify(payload)}`);
      this.rabbitService.emitToRecordsAiChatsAnalysisService('test_message', payload);
      return {
        success: true,
        message: 'Message sent to RabbitMQ',
        payload
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error sending RM message: ${msg}`);
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
      this.logger.error(`Error setting groupId for message ${messageId} in session ${sessionId}: ${msg}`);
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
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`Failed to handle session closed for ${sessionId}: ${msg}`);
    }
  }
}

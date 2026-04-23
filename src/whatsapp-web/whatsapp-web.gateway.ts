import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';

@WebSocketGateway({
  cors: {
    origin: '*',
  },

  transports: ['websocket'],
  path: '/ws-socket',
  namespace: '/ws-rest',
})
export class WhatsappWebGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(WhatsappWebGateway.name);

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);

    // Allow clients to join rooms via query parameter or handshake auth
    const sessionId = client.handshake.query.sessionId as string;
    if (sessionId) {
      const room = `session:${sessionId}`;
      client.join(room);
      this.logger.log(`Client ${client.id} joined room: ${room}`);
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('join-session')
  handleJoinSession(client: Socket, payload: { sessionId: string }) {
    const room = `session:${payload.sessionId}`;
    client.join(room);
    this.logger.log(`Client ${client.id} joined room: ${room}`);
    return { success: true, room };
  }


  private getSessionRoom(sessionId: string): string {
    return `session:${sessionId}`;
  }

  @SubscribeMessage('joinRoom')
  handleJoinRoom(@ConnectedSocket() client: Socket, @MessageBody() sessionId: string) {
    console.log('handleJoinRoom', sessionId);
    client.join(sessionId);
    this.logger.log(`Client ${client.id} joined room: ${sessionId}`);
  }

  private ensureServer(): boolean {
    // With namespace (/ws-rest), this.server is a Namespace (has .adapter); without namespace it's Server (has .sockets.adapter)
    if (!this.server) {
      this.logger.warn('WebSocket server not ready, skipping emit');
      return false;
    }
    const adapter = (this.server as any).sockets?.adapter ?? (this.server as any).adapter;
    if (!adapter) {
      this.logger.warn('WebSocket adapter not ready, skipping emit');
      return false;
    }
    return true;
  }

  emitQrCode(sessionId: string, qr: string) {
    if (!this.ensureServer()) return;
    const roomName = this.getSessionRoom(sessionId);
    this.server.to(roomName).emit('qr', { sessionId, qr, roomName });
    this.logger.log(`QR code emitted for session ${sessionId}`);
  }

  emitReady(sessionId: string) {
    if (!this.ensureServer()) return;
    this.server.emit('ready', { sessionId });
    this.logger.log(`Ready event emitted for session ${sessionId}`);
  }

  emitAuthFailure(sessionId: string, error: any) {
    if (!this.ensureServer()) return;
    this.server.to(this.getSessionRoom(sessionId)).emit('auth_failure', { sessionId, error: error.message || error });
    this.logger.log(`Auth failure emitted for session ${sessionId}`);
  }

  emitSessionClosed(sessionId: string, chatId?: string) {
    if (!this.ensureServer()) return;
    this.server.emit('sessionClosed', { sessionId, chatId });
    this.logger.log(`Session closed emitted for session ${sessionId}${chatId ? `, chat ${chatId}` : ''}`);
  }

  emitNewMessage(sessionId: string, messageData: any) {
    if (!this.ensureServer()) return;
    const room = this.getSessionRoom(sessionId);
    this.server.to(room).emit('new_message', { sessionId, message: messageData });
    this.logger.log(`New message emitted to room ${room} for session ${sessionId}`);
  }

  emitSyncChats(sessionId: string, payload: { nChats: number; currentChat: number; chatId?: string; messagesSynced?: number }) {
    if (!this.ensureServer()) return;
    const room = this.getSessionRoom(sessionId);
    this.server.to(room).emit('sync_chats', { sessionId, ...payload });
    this.logger.log(`Sync chats progress emitted for session ${sessionId}: ${payload.currentChat}/${payload.nChats}`);
  }

  emitChatRemoved(sessionId: string, chatId: string) {
    if (!this.ensureServer()) return;
    const room = this.getSessionRoom(sessionId);
    this.server.to(room).emit('chat_removed', { sessionId, chatId });
    this.logger.log(`Chat removed event emitted for session ${sessionId}, chat ${chatId}`);
  }

  emitMessageDeleted(sessionId: string, chatId: string, messageId: string) {
    if (!this.ensureServer()) return;
    const room = this.getSessionRoom(sessionId);
    this.server.to(room).emit('message_deleted', { sessionId, chatId, messageId });
    this.logger.log(`Message deleted event emitted for session ${sessionId}, message ${messageId}`);
  }
}


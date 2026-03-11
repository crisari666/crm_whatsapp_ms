import { Controller, Get, Post, Body, Param, Delete, Query } from '@nestjs/common';
import { WhatsappWebService } from './whatsapp-web.service';
import { EventPattern, Payload } from '@nestjs/microservices';

@Controller('whatsapp-web')
export class WhatsappWebController {
  constructor(private readonly whatsappWebService: WhatsappWebService) { }

  @Post('session/:id')
  async createSession(
    @Param('id') id: string,
    @Body() body?: { groupId?: string; title?: string },
  ) {
    return this.whatsappWebService.createSession(id, body);
  }

  @Get('sessions')
  getSessions() {
    return this.whatsappWebService.getSessions();
  }

  @Get('sessions/stored')
  async getStoredSessions() {
    return this.whatsappWebService.getStoredSessions();
  }

  @Post('send-rm-message')
  async sendRMMessage(@Body() payload: any) {
    return this.whatsappWebService.sendRMMessage(payload);
  }
  @Post('send/:id')
  async sendMessage(
    @Param('id') id: string,
    @Body() body: { phone: string; message: string },
  ) {
    return this.whatsappWebService.sendMessage(id, body.phone, body.message);
  }

  @Delete('session/:id')
  async destroySession(@Param('id') id: string) {
    return this.whatsappWebService.destroySession(id);
  }

  @Get('session/:id')
  async getSession(@Param('id') id: string) {
    return this.whatsappWebService.getSession(id);
  }

  @Get('session/:id/status')
  getSessionStatus(@Param('id') id: string) {
    return this.whatsappWebService.getSessionStatus(id);
  }

  @Get('session/:id/qr-code')
  async getSessionQrCode(@Param('id') id: string) {
    return this.whatsappWebService.getSessionQrCode(id);
  }

  @Get('session/:id/chats')
  async getChats(@Param('id') id: string) {
    return this.whatsappWebService.getChats(id);
  }

  @Post('session/:id/sync-chats')
  async syncChatsWithProgress(
    @Param('id') id: string,
    @Query('limitPerChat') limitPerChat?: number,
  ) {
    return this.whatsappWebService.syncChatsWithProgress(
      id,
      limitPerChat ? parseInt(limitPerChat as any) : 100
    );
  }

  @Get('session/:id/chats/:chatId/messages')
  async getChatMessages(
    @Param('id') id: string,
    @Param('chatId') chatId: string,
    @Query('limit') limit?: number,
  ) {
    return this.whatsappWebService.getChatMessages(id, chatId, limit);
  }

  @Get('session/:id/stored-messages')
  async getStoredMessages(
    @Param('id') id: string,
    @Query('chatId') chatId?: string,
    @Query('includeDeleted') includeDeleted?: boolean,
    @Query('limit') limit?: number,
    @Query('skip') skip?: number,
  ) {

    return this.whatsappWebService.getStoredMessages(id, chatId, {
      includeDeleted: includeDeleted == true,
      limit: limit ? parseInt(limit as any) : undefined,
      skip: skip ? parseInt(skip as any) : undefined,
    });
  }


  @Get('session/:id/messages/deleted')
  async getDeletedMessages(
    @Param('id') id: string,
    @Query('chatId') chatId?: string,
    @Query('limit') limit?: number,
  ) {
    return this.whatsappWebService.getDeletedMessages(id, chatId, limit);
  }

  @Get('session/:id/messages/:messageId')
  async getMessageById(
    @Param('id') id: string,
    @Param('messageId') messageId: string,
  ) {
    return this.whatsappWebService.getStoredMessageById(id, messageId);
  }

  @Post('session/:id/messages/:messageId/group')
  async setMessageGroup(
    @Param('id') id: string,
    @Param('messageId') messageId: string,
    @Body() body: { groupId: string },
  ) {
    return this.whatsappWebService.setMessageGroup(id, messageId, body.groupId);
  }

  @Get('session/:id/messages/:messageId/edits')
  async getMessageEditHistory(
    @Param('id') id: string,
    @Param('messageId') messageId: string,
  ) {
    return this.whatsappWebService.getMessageEditHistory(id, messageId);
  }

  @Get('session/:id/chats/stored')
  async getStoredChats(
    @Param('id') id: string,
    @Query('archived') archived?: boolean,
    @Query('isGroup') isGroup?: boolean,
    @Query('limit') limit?: number,
    @Query('skip') skip?: number,
  ) {
    return this.whatsappWebService.getStoredChats(id, {
      archived: archived,
      isGroup: isGroup,
      limit: limit ? parseInt(limit as any) : undefined,
      skip: skip ? parseInt(skip as any) : undefined,
    });
  }

  @Get('session/:id/chats/stored/:chatId')
  async getStoredChat(
    @Param('id') id: string,
    @Param('chatId') chatId: string,
  ) {
    return this.whatsappWebService.getStoredChat(id, chatId);
  }

  @EventPattern('remove_session')
  async handleIncoming(@Payload() data: any) {
    this.whatsappWebService.destroySession(data);
  }

}


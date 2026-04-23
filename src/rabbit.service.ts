import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class RabbitService {
  constructor(
    @Inject('RECORDS_AI_CHATS_ANALYSIS_SERVICE')
    private client: ClientProxy,
    @Inject('CUSTOMERS_MS_SERVICE')
    private customersClient: ClientProxy,
  ) {}

  // Send event to MS2
  emitToRecordsAiChatsAnalysisService(pattern: string, data: any) {
    return this.client.emit(pattern, data); // fire and forget
  }

  async sendToRecordsAiChatsAnalysisService(pattern: string, data: any) {
    return this.client.send(pattern, data); // request-response
  }

  async lookupCustomerByWhatsappPhone(payload: {
    phone: string;
    userSessionId: string;
  }): Promise<{ found: boolean; customerId: string | null; userSessionId?: string }> {
    console.log('lookupCustomerByWhatsappPhone send', payload);
    return firstValueFrom(
      this.customersClient.send('customers.whatsapp.customer.lookup.v1', payload),
    );
  }

  emitToCustomersMs(pattern: string, data: any) {
    return this.customersClient.emit(pattern, data);
  }

  emitCustomerLookupRequest(payload: {
    eventVersion: 'v1';
    eventName: 'customers.whatsapp.chat.lookup.request.v1';
    occurredAt: string;
    source: 'crm_whatsapp_ms';
    sessionId: string;
    userSessionId: string;
    chatId: string;
    phone: string;
    messageId: string;
  }) {
    return this.customersClient.emit(
      'customers.whatsapp.chat.lookup.request.v1',
      payload,
    );
  }
}
export interface CustomersWhatsappMessageUpsertV1 {
  eventVersion: 'v1';
  eventName: 'customers.whatsapp.message.upsert.v1';
  occurredAt: string;
  source: 'crm_whatsapp_ms';
  sessionId: string;
  syncMode: 'live' | 'session_backfill';
  identity: {
    customerId?: string;
    whatsappChatId: string;
    fromPhone?: string;
    toPhone?: string;
  };
  chat: {
    chatId: string;
    name?: string;
    isGroup: boolean;
    userSessionId?: string;
  };
  message: {
    messageId: string;
    fromMe: boolean;
    body: string;
    type: string;
    timestamp: number;
    hasMedia: boolean;
    mediaType?: string | null;
    mediaPath?: string | null;
    mediaMimeType?: string | null;
    mediaFilename?: string | null;
  };
}

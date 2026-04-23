/**
 * Library-agnostic normalized types for WhatsApp message/chat storage.
 * Used to keep the same data structure across whatsapp-web.js and Baileys.
 */

/** Normalized message input for storage (same shape as DB) */
export interface NormalizedMessage {
  messageId: string;
  chatId: string;
  body: string;
  type: string;
  from: string;
  to: string;
  author: string | null;
  fromMe: boolean;
  isForwarded: boolean;
  forwardingScore: number;
  isStatus: boolean;
  hasMedia: boolean;
  mediaType: string | null;
  hasQuotedMsg: boolean;
  isStarred: boolean;
  isGif: boolean;
  isEphemeral: boolean;
  timestamp: number;
  ack: number;
  deviceType?: string;
  broadcast: boolean;
  mentionedIds: string[];
  rawData: object;
}

/** Peer contact snapshot persisted on chat (from wweb.js getContact + JID fallback). */
export interface WhatsappChatContactSnapshot {
  /** WhatsApp `id.user` (digits, e.g. country + national). Used for customer-ms lookup. */
  userId: string;
  serialized?: string;
  /** Library `number` (may differ from userId on newer WA builds). */
  waNumber?: string;
  name?: string;
  pushname?: string;
  shortName?: string;
  isBusiness?: boolean;
}

/** Normalized chat input for storage */
export interface NormalizedChat {
  chatId: string;
  name: string;
  isGroup: boolean;
  unreadCount: number;
  timestamp: number;
  archived: boolean;
  pinned: boolean;
  isReadOnly: boolean;
  isMuted: boolean;
  muteExpiration: number | null;
  lastMessage: string | null;
  lastMessageTimestamp: number | null;
  lastMessageFromMe: boolean;
}

/** Normalized media for saving files (base64 data + mimetype) */
export interface NormalizedMedia {
  data: string;
  mimetype: string;
  filename?: string;
}

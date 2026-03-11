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

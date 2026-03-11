import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type WhatsAppMessageDocument = WhatsAppMessage & Document;

@Schema({ timestamps: true })
export class WhatsAppMessage {
  // WhatsApp message ID
  @Prop({ required: true, index: true })
  messageId: string;

  // Session ID to track which session the message belongs to
  @Prop({ required: true, index: true })
  sessionId: string;

  // Chat ID to filter messages by chat
  @Prop({ required: true, index: true })
  chatId: string;

  // Optional group ID (for group chats)
  @Prop({ required: false, index: true })
  groupId?: string;

  // Message body (stores the last/latest message body)
  @Prop({ type: String, default: null })
  body: string;

  // Message type (chat, audio, image, video, etc.)
  @Prop({ required: true })
  type: string;

  // From (sender) contact ID
  @Prop({ required: true, index: true })
  from: string;

  // To (recipient) contact ID
  @Prop({ required: true, index: true })
  to: string;

  // Author contact ID (for group messages)
  @Prop({ default: null })
  author: string;

  // Whether the message was sent by the current user
  @Prop({ required: true })
  fromMe: boolean;

  // Whether the message was forwarded
  @Prop({ default: false })
  isForwarded: boolean;

  // Forwarding score (number of times forwarded)
  @Prop({ default: 0 })
  forwardingScore: number;

  // Whether the message is a status update
  @Prop({ default: false })
  isStatus: boolean;

  // Whether the message has media
  @Prop({ default: false })
  hasMedia: boolean;

  // Media type if applicable
  @Prop({ default: null })
  mediaType: string;

  // Media file path (stored locally for easy access)
  @Prop({ default: null })
  mediaPath: string;

  // Media file size in bytes
  @Prop({ default: null })
  mediaSize: number;

  // Media filename (if available)
  @Prop({ default: null })
  mediaFilename: string;

  // Whether the message has a quoted message
  @Prop({ default: false })
  hasQuotedMsg: boolean;

  // Whether the message is starred
  @Prop({ default: false })
  isStarred: boolean;

  // Whether the message is a GIF
  @Prop({ default: false })
  isGif: boolean;

  // Whether the message is ephemeral (disappearing message)
  @Prop({ default: false })
  isEphemeral: boolean;

  // Timestamp when the message was created
  @Prop({ required: true, index: true })
  timestamp: number;

  // ACK status
  @Prop({ type: Number, default: 0 })
  ack: number;

  // Whether the message has been deleted
  @Prop({ default: false, index: true })
  isDeleted: boolean;

  // Timestamp when the message was deleted
  @Prop({ default: null })
  deletedAt: Date;

  // Who deleted the message (everyone or me)
  @Prop({ default: null })
  deletedBy: string;

  // Array to store message edit history
  @Prop({ type: [String], default: [] })
  edition: string[];

  // Device type the message was sent from
  @Prop({ default: null })
  deviceType: string;

  // Whether the message is a broadcast
  @Prop({ default: false })
  broadcast: boolean;

  // Mentioned contact IDs
  @Prop({ type: [String], default: [] })
  mentionedIds: string[];

  // Raw message data
  @Prop({ type: Object, default: {} })
  rawData: object;

  // Timestamps
  createdAt?: Date;
  updatedAt?: Date;
}

export const WhatsAppMessageSchema = SchemaFactory.createForClass(WhatsAppMessage);

// Create compound indexes for better query performance
WhatsAppMessageSchema.index({ sessionId: 1, chatId: 1 });
WhatsAppMessageSchema.index({ sessionId: 1, timestamp: -1 });
WhatsAppMessageSchema.index({ chatId: 1, timestamp: -1 });
WhatsAppMessageSchema.index({ sessionId: 1, isDeleted: 1 });


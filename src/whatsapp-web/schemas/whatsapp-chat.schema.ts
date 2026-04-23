import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type WhatsAppChatDocument = WhatsAppChat & Document;

@Schema({ timestamps: true })
export class WhatsAppChat {
  // Chat ID from WhatsApp
  @Prop({ required: true, index: true })
  chatId: string;

  // Session ID to track which session the chat belongs to
  @Prop({ required: true, index: true })
  sessionId: string;

  // Session owner id used to validate customer binding in multi-agent scenarios
  @Prop({ required: false, index: true })
  userSessionId?: string;

  // Linked customer from crm-omega-customers-ms
  @Prop({ type: Types.ObjectId, required: false, index: true, ref: 'Customer' })
  customerId?: Types.ObjectId;

  /** Last known peer contact (1:1); `userId` matches WhatsApp `id.user` for customer link. */
  @Prop({
    type: {
      userId: { type: String, required: false, index: true },
      serialized: { type: String, required: false },
      waNumber: { type: String, required: false },
      name: { type: String, required: false },
      pushname: { type: String, required: false },
      shortName: { type: String, required: false },
      isBusiness: { type: Boolean, required: false },
    },
    required: false,
    _id: false,
  })
  contact?: {
    userId: string;
    serialized?: string;
    waNumber?: string;
    name?: string;
    pushname?: string;
    shortName?: string;
    isBusiness?: boolean;
  };

  // Chat name
  @Prop({ required: true })
  name: string;

  // Whether it's a group chat
  @Prop({ required: true, default: false })
  isGroup: boolean;

  // Number of unread messages
  @Prop({ default: 0 })
  unreadCount: number;

  // Unix timestamp for when the last activity occurred
  @Prop({ required: true, index: true })
  timestamp: number;

  // Whether the chat is archived
  @Prop({ default: false })
  archived: boolean;

  // Whether the chat is pinned
  @Prop({ default: false })
  pinned: boolean;

  // Whether the chat is readonly
  @Prop({ default: false })
  isReadOnly: boolean;

  // Whether the chat is muted
  @Prop({ default: false })
  isMuted: boolean;

  // Unix timestamp for when the mute expires
  @Prop({ default: null })
  muteExpiration: number;

  // Last message preview
  @Prop({ type: String, default: null })
  lastMessage: string;

  // Last message timestamp
  @Prop({ type: Number, default: null })
  lastMessageTimestamp: number;

  // Whether the last message was sent by me
  @Prop({ default: false })
  lastMessageFromMe: boolean;

  // Whether the chat is deleted
  @Prop({ default: false, index: true })
  deleted: boolean;

  // Array of timestamps when the chat was deleted (supports multiple deletions)
  @Prop({ type: [Date], default: [] })
  deletedAt: Date[];

  // Timestamps
  createdAt?: Date;
  updatedAt?: Date;
}

export const WhatsAppChatSchema = SchemaFactory.createForClass(WhatsAppChat);

// Create compound indexes for better query performance
WhatsAppChatSchema.index({ sessionId: 1, timestamp: -1 });
WhatsAppChatSchema.index({ sessionId: 1, archived: 1 });
WhatsAppChatSchema.index({ sessionId: 1, pinned: 1 });
WhatsAppChatSchema.index({ sessionId: 1, deleted: 1 });
WhatsAppChatSchema.index({ sessionId: 1, chatId: 1 }, {unique: true});
WhatsAppChatSchema.index({ userSessionId: 1, customerId: 1 });


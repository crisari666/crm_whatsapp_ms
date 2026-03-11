import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { WhatsAppSession } from './whatsapp-session.schema';

export type WhatsAppAlertDocument = WhatsAppAlert & Document;

@Schema({ timestamps: true })
export class WhatsAppAlert {
  @Prop({ type: Types.ObjectId, ref: WhatsAppSession.name, required: true })
  session: Types.ObjectId;

  // Session ID as string for easier querying
  @Prop({ type: String, required: true, index: true })
  sessionId: string;

  // Type of alert: 'disconnected', 'message_deleted', 'message_edited', 'call'
  @Prop({ 
    type: String, 
    enum: ['disconnected', 'message_deleted', 'message_edited', 'call', 'chat_removed'], 
    required: true,
    index: true 
  })
  type: string;

  // Chat ID (required for message and call alerts)
  @Prop({ type: String, required: false, index: true })
  chatId?: string;

  // Message ID (required for message_deleted and message_edited alerts)
  @Prop({ type: String, required: false, index: true })
  messageId?: string;

  // Timestamp mark (Unix timestamp when the alert event occurred)
  @Prop({ type: Number, required: false, index: true })
  timestamp?: number;

  // Optional human-readable message for clients
  @Prop({ type: String, required: false })
  message?: string;

  // Whether the alert has been read by a client
  @Prop({ type: Boolean, default: false, index: true })
  isRead: boolean;

  // Timestamp when it was read
  @Prop({ type: Date, required: false })
  readAt?: Date;

  // Additional metadata for call alerts (optional)
  @Prop({ type: Object, required: false })
  callData?: {
    callId?: string;
    from?: string;
    to?: string;
    duration?: number;
    isVideo?: boolean;
    isGroup?: boolean;
  };

  createdAt?: Date;
  updatedAt?: Date;
}

export const WhatsAppAlertSchema = SchemaFactory.createForClass(WhatsAppAlert);

// Create compound indexes for better query performance
WhatsAppAlertSchema.index({ sessionId: 1, type: 1 });
WhatsAppAlertSchema.index({ sessionId: 1, isRead: 1 });
WhatsAppAlertSchema.index({ sessionId: 1, timestamp: -1 });
WhatsAppAlertSchema.index({ chatId: 1, type: 1 });
WhatsAppAlertSchema.index({ messageId: 1, type: 1 });



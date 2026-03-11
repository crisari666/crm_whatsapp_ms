# Chat and Message Synchronization Refactoring

## Overview
This refactoring implements real-time WebSocket progress events during chat and message synchronization, allowing the frontend to monitor the synchronization status.

## Changes Made

### 1. WhatsappWebGateway (`whatsapp-web.gateway.ts`)
**Added Method:**
- `emitSyncChats(sessionId, payload)`: Emits `sync_chats` events to the session room with progress information

**Event Payload Structure:**
```typescript
{
  sessionId: string;
  nChats: number;        // Total number of chats
  currentChat: number;   // Current chat being processed (0-based)
  chatId?: string;       // ID of the current chat
  messagesSynced?: number; // Number of messages synced for current chat
}
```

### 2. WhatsappStorageService (`whatsapp-storage.service.ts`)
**Modified Methods:**

#### `saveChats()`
- Added optional `onProgress` callback parameter
- Changed from bulk operation to sequential processing to enable progress callbacks
- Callback signature: `(currentIndex: number, total: number, chat: WAWebJS.Chat) => void | Promise<void>`
- Called after each chat is saved to the database

#### `saveMessages()`
- Added optional `onProgress` callback parameter
- Callback signature: `(messagesSaved: number) => void | Promise<void>`
- Called after all messages in the batch are saved

### 3. WhatsappWebService (`whatsapp-web.service.ts`)
**New Method:**

#### `syncChatsWithProgress(sessionId, limitPerChat = 100)`
Comprehensive synchronization method that orchestrates the entire process:

**Flow:**
1. Fetches all chats from WhatsApp
2. Emits initial `sync_chats` event with total chat count (currentChat: 0)
3. Saves chats to database with progress callbacks
   - Emits `sync_chats` event after each chat is saved
4. For each chat:
   - Fetches messages from WhatsApp (up to `limitPerChat`)
   - Saves messages to database
   - Emits `sync_chats` event with message count
5. Returns success response with total chats processed

**Modified Method:**

#### `getChats(sessionId)`
- Refactored to use `syncChatsWithProgress()` internally
- Now provides real-time progress updates via WebSocket
- Returns stored chats from database after synchronization

### 4. WhatsappWebController (`whatsapp-web.controller.ts`)
**New Endpoint:**

```
POST /whatsapp-web/session/:id/sync-chats?limitPerChat=100
```

Triggers the synchronization process with WebSocket progress events.

**Query Parameters:**
- `limitPerChat` (optional): Maximum messages to fetch per chat (default: 100)

**Response:**
```json
{
  "success": true,
  "chatsProcessed": 45,
  "message": "Synchronization completed successfully"
}
```

## Frontend Integration

### WebSocket Event Listener
```javascript
socket.on('sync_chats', (data) => {
  console.log(`Syncing chat ${data.currentChat}/${data.nChats}`);
  console.log(`Chat ID: ${data.chatId}`);
  console.log(`Messages synced: ${data.messagesSynced}`);
  
  // Update UI with progress
  const progress = (data.currentChat / data.nChats) * 100;
  updateProgressBar(progress);
});
```

### API Call
```javascript
// Join the session room first
socket.emit('join-session', { sessionId: 'your-session-id' });

// Trigger synchronization
const response = await fetch(
  `${API_URL}/whatsapp-web/session/${sessionId}/sync-chats?limitPerChat=100`,
  { method: 'POST' }
);

const result = await response.json();
console.log(result); // { success: true, chatsProcessed: 45, ... }
```

## Event Flow Example

For a session with 3 chats:

1. **Initial event:**
   ```json
   { "sessionId": "123", "nChats": 3, "currentChat": 0, "messagesSynced": 0 }
   ```

2. **After saving chat 1:**
   ```json
   { "sessionId": "123", "nChats": 3, "currentChat": 1, "chatId": "chat1@c.us", "messagesSynced": 0 }
   ```

3. **After syncing messages for chat 1:**
   ```json
   { "sessionId": "123", "nChats": 3, "currentChat": 1, "chatId": "chat1@c.us", "messagesSynced": 50 }
   ```

4. **After saving chat 2:**
   ```json
   { "sessionId": "123", "nChats": 3, "currentChat": 2, "chatId": "chat2@c.us", "messagesSynced": 0 }
   ```

5. **After syncing messages for chat 2:**
   ```json
   { "sessionId": "123", "nChats": 3, "currentChat": 2, "chatId": "chat2@c.us", "messagesSynced": 75 }
   ```

... and so on.

## Benefits

1. **Real-time Feedback**: Frontend can display live progress during synchronization
2. **Better UX**: Users can see which chat is being processed and how many messages are synced
3. **Error Handling**: Individual chat failures don't stop the entire process
4. **Monitoring**: Easier to debug synchronization issues with detailed progress events
5. **Scalability**: Progress events allow for long-running synchronizations without timeout concerns

## Usage Notes

- The `getChats()` endpoint now automatically triggers full synchronization with progress events
- Use the new `POST /session/:id/sync-chats` endpoint for explicit synchronization control
- Progress events are only sent to clients in the session's WebSocket room
- Synchronization continues even if individual chats fail (errors are logged)
- The `limitPerChat` parameter controls how many messages are fetched per chat (default: 100)

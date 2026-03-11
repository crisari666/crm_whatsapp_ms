# Synchronization Flow Diagram

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            FRONTEND                                      │
│                                                                          │
│  1. Join WebSocket Room                                                 │
│     socket.emit('join-session', { sessionId })                          │
│                                                                          │
│  2. Trigger Sync                                                        │
│     POST /whatsapp-web/session/:id/sync-chats                          │
│                                                                          │
│  3. Listen for Progress                                                 │
│     socket.on('sync_chats', (data) => { ... })                         │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     WHATSAPP-WEB CONTROLLER                             │
│                                                                          │
│  syncChatsWithProgress(sessionId, limitPerChat)                        │
│         │                                                                │
│         └──► WhatsappWebService.syncChatsWithProgress()                │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     WHATSAPP-WEB SERVICE                                │
│                                                                          │
│  syncChatsWithProgress(sessionId, limitPerChat)                        │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────┐        │
│  │ STEP 1: Fetch Chats from WhatsApp                          │        │
│  │   const chats = await client.getChats()                    │        │
│  └────────────────────────────────────────────────────────────┘        │
│                          │                                              │
│                          ▼                                              │
│  ┌────────────────────────────────────────────────────────────┐        │
│  │ STEP 2: Emit Initial Progress                              │        │
│  │   gateway.emitSyncChats(sessionId, {                       │        │
│  │     nChats: total,                                         │        │
│  │     currentChat: 0,                                        │        │
│  │     messagesSynced: 0                                      │        │
│  │   })                                                       │        │
│  └────────────────────────────────────────────────────────────┘        │
│                          │                                              │
│                          ▼                                              │
│  ┌────────────────────────────────────────────────────────────┐        │
│  │ STEP 3: Save Chats with Progress Callbacks                 │        │
│  │   storageService.saveChats(sessionId, chats,               │        │
│  │     onProgress: (currentIndex, total, chat) => {           │        │
│  │       gateway.emitSyncChats(sessionId, {                   │        │
│  │         nChats: total,                                     │        │
│  │         currentChat: currentIndex,                         │        │
│  │         chatId: chat.id,                                   │        │
│  │         messagesSynced: 0                                  │        │
│  │       })                                                   │        │
│  │     }                                                      │        │
│  │   )                                                        │        │
│  └────────────────────────────────────────────────────────────┘        │
│                          │                                              │
│                          ▼                                              │
│  ┌────────────────────────────────────────────────────────────┐        │
│  │ STEP 4: For Each Chat - Fetch & Save Messages              │        │
│  │   for (chat of chats) {                                    │        │
│  │     messages = await chat.fetchMessages(limit)             │        │
│  │     storageService.saveMessages(sessionId, messages,       │        │
│  │       chatId,                                              │        │
│  │       onProgress: (messagesSaved) => {                     │        │
│  │         gateway.emitSyncChats(sessionId, {                 │        │
│  │           nChats: total,                                   │        │
│  │           currentChat: i + 1,                              │        │
│  │           chatId: chatId,                                  │        │
│  │           messagesSynced: messagesSaved                    │        │
│  │         })                                                 │        │
│  │       }                                                    │        │
│  │     )                                                      │        │
│  │   }                                                        │        │
│  └────────────────────────────────────────────────────────────┘        │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                   WHATSAPP STORAGE SERVICE                              │
│                                                                          │
│  saveChats(sessionId, chats, onProgress?)                              │
│    ├─► For each chat:                                                  │
│    │     ├─► Save to MongoDB                                           │
│    │     └─► Call onProgress(currentIndex, total, chat)                │
│    │                                                                    │
│  saveMessages(sessionId, messages, chatId, onProgress?)                │
│    ├─► Bulk save all messages to MongoDB                              │
│    └─► Call onProgress(messagesSaved)                                 │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     WHATSAPP-WEB GATEWAY                                │
│                                                                          │
│  emitSyncChats(sessionId, payload)                                     │
│    ├─► Get session room: `session:${sessionId}`                        │
│    └─► Emit 'sync_chats' event to room                                │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                            FRONTEND                                      │
│                                                                          │
│  socket.on('sync_chats', (data) => {                                   │
│    // Update UI with progress                                          │
│    updateProgressBar(data.currentChat / data.nChats * 100)            │
│    displayCurrentChat(data.chatId)                                     │
│    displayMessageCount(data.messagesSynced)                            │
│  })                                                                     │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Event Timeline Example

```
Time  Event                                                    Data
────  ───────────────────────────────────────────────────────  ─────────────────────────────────
0ms   Initial sync event                                       { nChats: 5, currentChat: 0, messagesSynced: 0 }
100ms Chat 1 saved                                             { nChats: 5, currentChat: 1, chatId: "chat1@c.us", messagesSynced: 0 }
500ms Messages for chat 1 synced                               { nChats: 5, currentChat: 1, chatId: "chat1@c.us", messagesSynced: 50 }
600ms Chat 2 saved                                             { nChats: 5, currentChat: 2, chatId: "chat2@c.us", messagesSynced: 0 }
1000ms Messages for chat 2 synced                              { nChats: 5, currentChat: 2, chatId: "chat2@c.us", messagesSynced: 75 }
1100ms Chat 3 saved                                            { nChats: 5, currentChat: 3, chatId: "chat3@c.us", messagesSynced: 0 }
1500ms Messages for chat 3 synced                              { nChats: 5, currentChat: 3, chatId: "chat3@c.us", messagesSynced: 100 }
1600ms Chat 4 saved                                            { nChats: 5, currentChat: 4, chatId: "chat4@c.us", messagesSynced: 0 }
2000ms Messages for chat 4 synced                              { nChats: 5, currentChat: 4, chatId: "chat4@c.us", messagesSynced: 25 }
2100ms Chat 5 saved                                            { nChats: 5, currentChat: 5, chatId: "chat5@c.us", messagesSynced: 0 }
2500ms Messages for chat 5 synced (COMPLETE)                   { nChats: 5, currentChat: 5, chatId: "chat5@c.us", messagesSynced: 60 }
```

## Key Components

### 1. WhatsappWebGateway
- **Role**: WebSocket event emitter
- **Method**: `emitSyncChats(sessionId, payload)`
- **Emits to**: Room `session:${sessionId}`

### 2. WhatsappStorageService
- **Role**: Database operations with progress callbacks
- **Methods**: 
  - `saveChats(sessionId, chats, onProgress?)`
  - `saveMessages(sessionId, messages, chatId?, onProgress?)`

### 3. WhatsappWebService
- **Role**: Orchestration and business logic
- **Method**: `syncChatsWithProgress(sessionId, limitPerChat)`
- **Connects**: Gateway + Storage Service

### 4. WhatsappWebController
- **Role**: HTTP endpoint
- **Endpoint**: `POST /whatsapp-web/session/:id/sync-chats`

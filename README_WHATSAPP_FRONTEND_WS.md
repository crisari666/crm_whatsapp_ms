## WhatsApp WebSocket Frontend Agent Guide

This document is for the **frontend agent / developer** that needs to implement the WebSocket client that talks to `WhatsappWebGateway` (`src/whatsapp-web/whatsapp-web.gateway.ts`).

It explains **how to connect**, **how to join the correct session room**, and **which events to handle** to build a real‑time UI around WhatsApp sessions.

---

## 1. WebSocket connection

- **Protocol**: Socket.IO (WebSocket transport)
- **Namespace**: default (`/`)
- **URL**: `http://{HOST}:{APP_PORT}` (same host/port as the NestJS API)

Basic connection from a browser (using `socket.io-client`):

```ts
import { io } from 'socket.io-client';

// Recommended: pass sessionId as query so backend auto-joins the room
const sessionId = 'user-123';

export const socket = io('http://localhost:7773', {
  query: { sessionId }, // must match the WhatsApp sessionId used in REST API calls
});

socket.on('connect', () => {
  console.log('WS connected', socket.id);
});

socket.on('disconnect', () => {
  console.log('WS disconnected');
});
```

> **Important:** `sessionId` in the query must be the same ID used when calling REST endpoints like `POST /rest/whatsapp-web/session/:id`.

---

## 2. Session rooms

The gateway groups clients by WhatsApp session using **rooms**:

- Room name format: `session:<sessionId>`

On server connect (`handleConnection`), if `sessionId` is present in the query, the client is automatically added to `session:<sessionId>`.

### 2.1. Alternative: join via event

If you don’t pass `sessionId` in the query, you can join later:

```ts
const sessionId = 'user-123';

socket.emit('join-session', { sessionId }, (ack: any) => {
  if (ack?.success) {
    console.log('Joined room', ack.room);
  }
});
```

There is also a lower-level event:

```ts
socket.emit('joinRoom', 'session:user-123');
```

Use **only one** of these strategies per connection to avoid confusion.

---

## 3. Events to handle

Once connected and in the correct room, the frontend agent must subscribe to the following events.

### 3.1. `qr` – QR code for authentication

Emitted when a QR is generated for a session:

```ts
socket.on('qr', ({ sessionId, qr, roomName }) => {
  console.log('QR for session', sessionId, 'room', roomName);
  // TODO: render 'qr' string as an actual QR image (frontend responsibility)
});
```

**Expected UI behavior:**
- Show a full‑screen or modal QR view.
- Continuously replace the QR if multiple `qr` events arrive for the same session.

### 3.2. `ready` – session is ready

Emitted when the WhatsApp session is fully ready to use:

```ts
socket.on('ready', ({ sessionId }) => {
  console.log('Session is ready', sessionId);
  // Hide QR view, show chats/messages UI, trigger initial data load via REST
});
```

### 3.3. `auth_failure` – authentication failed

```ts
socket.on('auth_failure', ({ sessionId, error }) => {
  console.error('Auth failure', sessionId, error);
  // Show error banner + CTA (e.g. "Retry", "Create new session")
});
```

### 3.4. `sessionClosed` – session closed in backend

```ts
socket.on('sessionClosed', ({ sessionId, chatId }) => {
  console.log('Session closed', sessionId, chatId);
  // Disable input, mark session as offline, maybe auto-open a "Reconnect" flow
});
```

### 3.5. `new_message` – new incoming message

```ts
socket.on('new_message', ({ sessionId, message }) => {
  console.log('New message', message, 'in session', sessionId);
  // Append message to the appropriate chat view and update unread counters
});
```

`message` is a normalized structure with at least:

- `messageId`, `chatId`, `body`, `type`
- `from`, `to`, `author`, `fromMe`
- `timestamp`, `hasMedia`, `mediaType`

### 3.6. `sync_chats` – chat & message sync progress

During initial sync, progress updates are emitted:

```ts
socket.on('sync_chats', ({ sessionId, nChats, currentChat, chatId, messagesSynced }) => {
  console.log(
    `Sync [${sessionId}] ${currentChat}/${nChats}, chat=${chatId}, messages=${messagesSynced}`,
  );
  // Drive a progress bar or status text in the UI
});
```

### 3.7. `chat_removed` – chat removed

```ts
socket.on('chat_removed', ({ sessionId, chatId }) => {
  console.log('Chat removed', chatId, 'in session', sessionId);
  // Remove chat from sidebar/list or mark as deleted
});
```

### 3.8. `message_deleted` – message deleted

```ts
socket.on('message_deleted', ({ sessionId, chatId, messageId }) => {
  console.log('Message deleted', messageId, 'in chat', chatId, 'session', sessionId);
  // Replace message content in UI with “This message was deleted”
});
```

---

## 4. Typical frontend agent flow

1. **User chooses a WhatsApp session** (or you create one via REST).
2. **Connect WebSocket** with `sessionId` in query OR call `join-session` after connect.
3. **Listen for `qr`**:
   - Render QR; keep listening for updates (QR can change).
4. **When `ready` received**:
   - Hide QR, show chat UI, load initial chats/messages using REST endpoints.
5. **Handle `new_message`, `sync_chats`, `chat_removed`, `message_deleted`** to keep UI in sync in real time.
6. **Handle `auth_failure` and `sessionClosed`**:
   - Show proper UX for recovering: recreate session, re-show QR, or mark as offline.

This is the minimal contract the frontend agent must implement to integrate with `WhatsappWebGateway`.


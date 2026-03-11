# WhatsApp Web API Documentation

This document provides complete API documentation for the WhatsApp Web Microservice. Use this documentation to create a client application that consumes these endpoints.

## Base URL

```
http://localhost:{APP_PORT}/rest/whatsapp-web
```

**Default Port:** `3001`

**Full Base URL:** `http://localhost:3001/rest/whatsapp-web`

---

## WebSocket Events

The service also provides WebSocket events at namespace `/whatsapp`. Clients can listen to these events:

- `qr` - Emitted when a QR code is generated for authentication
- `ready` - Emitted when a session is ready to use
- `auth_failure` - Emitted when authentication fails

---

## API Endpoints

### Session Management

#### 1. Create Session

Create a new WhatsApp Web session.

**Endpoint:** `POST /session/:id`

**Path Parameters:**
- `id` (string, required) - Unique session identifier (e.g., "user-1", "session-abc")

**Request Body:** None

**Response Success (200):**
```json
{
  "success": true,
  "sessionId": "user-1",
  "message": "Session created successfully"
}
```

**Response Error (If session already exists):**
```json
{
  "success": false,
  "sessionId": "user-1",
  "message": "Session already exists"
}
```

**Response Error (500):**
```json
{
  "message": "Failed to create session: {error details}",
  "statusCode": 500
}
```

**Notes:**
- On successful creation, a QR code will be emitted via WebSocket (`qr` event)
- Once authenticated and ready, a `ready` event will be emitted
- If authentication fails, an `auth_failure` event will be emitted

---

#### 2. List Active Sessions

Get all currently active sessions in memory.

**Endpoint:** `GET /sessions`

**Query Parameters:** None

**Response Success (200):**
```json
[
  {
    "sessionId": "user-1",
    "isReady": true,
    "lastRestore": "2024-01-15T10:30:00.000Z"
  },
  {
    "sessionId": "user-2",
    "isReady": false,
    "lastRestore": "2024-01-15T11:00:00.000Z"
  }
]
```

**Response Success (Empty):**
```json
[]
```

---

#### 3. List Stored Sessions

Get all sessions stored in the database (includes all historical sessions with metadata).

**Endpoint:** `GET /sessions/stored`

**Query Parameters:** None

**Response Success (200):**
```json
[
  {
    "sessionId": "user-1",
    "status": "ready",
    "lastSeen": "2024-01-15T10:30:00.000Z",
    "updatedAt": "2024-01-15T10:30:00.000Z",
    "createdAt": "2024-01-15T09:00:00.000Z"
  },
  {
    "sessionId": "user-2",
    "status": "authenticated",
    "lastSeen": "2024-01-15T11:00:00.000Z",
    "updatedAt": "2024-01-15T11:00:00.000Z",
    "createdAt": "2024-01-15T10:00:00.000Z"
  }
]
```

**Session Status Values:**
- `initializing` - Session is being initialized
- `qr_generated` - QR code has been generated
- `authenticated` - Session is authenticated but not ready
- `ready` - Session is ready to use
- `disconnected` - Session is disconnected
- `auth_failure` - Authentication failed
- `error` - An error occurred

---

#### 4. Get Session Status

Get the current status of a specific session.

**Endpoint:** `GET /session/:id/status`

**Path Parameters:**
- `id` (string, required) - Session identifier

**Response Success (Session exists):**
```json
{
  "exists": true,
  "ready": true,
  "state": { /* Client info object from whatsapp-web.js */ }
}
```

**Response Success (Session does not exist):**
```json
{
  "exists": false,
  "ready": false
}
```

---

#### 5. Destroy Session

Destroy and remove a session from memory and database.

**Endpoint:** `DELETE /session/:id`

**Path Parameters:**
- `id` (string, required) - Session identifier

**Response Success (200):**
```json
{
  "success": true,
  "message": "Session destroyed successfully"
}
```

**Response Success (Session not found):**
```json
{
  "success": false,
  "message": "Session not found"
}
```

**Response Error (500):**
```json
{
  "message": "Failed to destroy session: {error details}",
  "statusCode": 500
}
```

---

### Messaging

#### 6. Send Message

Send a text message to a WhatsApp contact.

**Endpoint:** `POST /send/:id`

**Path Parameters:**
- `id` (string, required) - Session identifier

**Request Body:**
```json
{
  "phone": "5511999999999",
  "message": "Hello, this is a test message"
}
```

**Body Parameters:**
- `phone` (string, required) - Phone number in international format (digits only, e.g., "5511999999999")
- `message` (string, required) - Message text to send

**Response Success (200):**
```json
{
  "success": true,
  "messageId": "true_5511999999999@c.us_ABC123XYZ",
  "timestamp": 1705312800000
}
```

**Response Error (Session not found):**
```json
{
  "message": "Session {id} not found",
  "statusCode": 500
}
```

**Response Error (Session not ready):**
```json
{
  "message": "Session {id} is not ready yet",
  "statusCode": 500
}
```

**Response Error (500):**
```json
{
  "message": "Failed to send message: {error details}",
  "statusCode": 500
}
```

**Notes:**
- Phone numbers should be in international format without +, spaces, or dashes
- The phone number will be automatically formatted as `{phone}@c.us`

---

#### 7. Get Chats

Retrieve all chats for a session and save them to the database.

**Endpoint:** `GET /session/:id/chats`

**Path Parameters:**
- `id` (string, required) - Session identifier

**Response Success (200):**
```json
[
  {
    "id": "5511999999999@c.us",
    "name": "John Doe",
    "isGroup": false,
    "unreadCount": 2,
    "timestamp": 1705312800000,
    "archive": false,
    "pinned": false
  },
  {
    "id": "120363123456789012@g.us",
    "name": "Group Chat",
    "isGroup": true,
    "unreadCount": 5,
    "timestamp": 1705312900000,
    "archive": false,
    "pinned": true
  }
]
```

**Response Error (Session not found):**
```json
{
  "message": "Session {id} not found",
  "statusCode": 500
}
```

**Response Error (Session not ready):**
```json
{
  "message": "Session {id} is not ready yet",
  "statusCode": 500
}
```

---

#### 8. Get Chat Messages

Get messages from a specific chat. Messages are fetched from WhatsApp and stored in the database, then returned from the database.

**Endpoint:** `GET /session/:id/chats/:chatId/messages`

**Path Parameters:**
- `id` (string, required) - Session identifier
- `chatId` (string, required) - Chat identifier (e.g., "5511999999999@c.us")

**Query Parameters:**
- `limit` (number, optional) - Maximum number of messages to retrieve (default: 50)

**Example Request:**
```
GET /session/user-1/chats/5511999999999@c.us/messages?limit=100
```

**Response Success (200):**
```json
[
  {
    "id": "true_5511999999999@c.us_ABC123XYZ",
    "body": "Hello, how are you?",
    "from": "5511999999999@c.us",
    "to": "5511888888888@c.us",
    "fromMe": false,
    "timestamp": 1705312800000,
    "hasMedia": false,
    "mediaType": null,
    "hasQuotedMsg": false,
    "isForwarded": false,
    "isStarred": false,
    "isDeleted": false
  },
  {
    "id": "true_5511999999999@c.us_DEF456UVW",
    "body": "I'm doing great, thanks!",
    "from": "5511888888888@c.us",
    "to": "5511999999999@c.us",
    "fromMe": true,
    "timestamp": 1705312900000,
    "hasMedia": false,
    "mediaType": null,
    "hasQuotedMsg": true,
    "isForwarded": false,
    "isStarred": false,
    "isDeleted": false
  }
]
```

**Response Error (Session not found/not ready):** Same as endpoint #7

---

### Storage Operations

#### 9. Get Stored Messages

Retrieve messages stored in the database for a session.

**Endpoint:** `GET /session/:id/stored-messages`

**Path Parameters:**
- `id` (string, required) - Session identifier

**Query Parameters:**
- `chatId` (string, optional) - Filter messages by chat ID
- `includeDeleted` (boolean, optional) - Include deleted messages in results (default: false)
- `limit` (number, optional) - Maximum number of messages to retrieve (default: 50)
- `skip` (number, optional) - Number of messages to skip for pagination (default: 0)

**Example Requests:**
```
GET /session/user-1/stored-messages
GET /session/user-1/stored-messages?chatId=5511999999999@c.us&limit=100
GET /session/user-1/stored-messages?includeDeleted=true&skip=50&limit=25
```

**Response Success (200):**
```json
[
  {
    "messageId": "true_5511999999999@c.us_ABC123XYZ",
    "chatId": "5511999999999@c.us",
    "body": "Hello, how are you?",
    "type": "chat",
    "from": "5511999999999@c.us",
    "to": "5511888888888@c.us",
    "author": null,
    "fromMe": false,
    "timestamp": 1705312800000,
    "isDeleted": false,
    "deletedAt": null,
    "deletedBy": null,
    "edition": [],
    "hasMedia": false,
    "mediaType": null,
    "hasQuotedMsg": false,
    "isForwarded": false,
    "isStarred": false
  }
]
```

**Notes:**
- Messages are sorted by timestamp in descending order (newest first)
- By default, deleted messages are excluded
- Use `skip` and `limit` for pagination

---

#### 10. Get Deleted Messages

Retrieve messages that have been deleted (revoked) from WhatsApp.

**Endpoint:** `GET /session/:id/messages/deleted`

**Path Parameters:**
- `id` (string, required) - Session identifier

**Query Parameters:**
- `chatId` (string, optional) - Filter deleted messages by chat ID
- `limit` (number, optional) - Maximum number of messages to retrieve (default: 50)

**Example Request:**
```
GET /session/user-1/messages/deleted?chatId=5511999999999@c.us&limit=100
```

**Response Success (200):**
```json
[
  {
    "_id": "507f1f77bcf86cd799439011",
    "messageId": "true_5511999999999@c.us_ABC123XYZ",
    "sessionId": "user-1",
    "chatId": "5511999999999@c.us",
    "body": "This message was deleted",
    "type": "chat",
    "from": "5511999999999@c.us",
    "to": "5511888888888@c.us",
    "fromMe": false,
    "timestamp": 1705312800000,
    "isDeleted": true,
    "deletedAt": "2024-01-15T12:00:00.000Z",
    "deletedBy": "everyone",
    "edition": [],
    "hasMedia": false,
    "createdAt": "2024-01-15T10:00:00.000Z",
    "updatedAt": "2024-01-15T12:00:00.000Z"
  }
]
```

**Deleted By Values:**
- `everyone` - Message was deleted for everyone
- `me` - Message was deleted only for the current user

---

#### 11. Get Message by ID

Retrieve a specific message by its message ID.

**Endpoint:** `GET /session/:id/messages/:messageId`

**Path Parameters:**
- `id` (string, required) - Session identifier
- `messageId` (string, required) - WhatsApp message ID (e.g., "true_5511999999999@c.us_ABC123XYZ")

**Response Success (200):**
```json
{
  "messageId": "true_5511999999999@c.us_ABC123XYZ",
  "chatId": "5511999999999@c.us",
  "body": "Hello, this is a message",
  "type": "chat",
  "from": "5511999999999@c.us",
  "to": "5511888888888@c.us",
  "author": null,
  "fromMe": false,
  "timestamp": 1705312800000,
  "isDeleted": false,
  "deletedAt": null,
  "deletedBy": null,
  "edition": [],
  "hasMedia": false,
  "mediaType": null,
  "editionHistory": [],
  "rawData": {}
}
```

**Response Error (Message not found):**
```json
{
  "message": "Message not found",
  "statusCode": 500
}
```

---

#### 12. Get Message Edit History

Retrieve the edit history of a message (if the message has been edited).

**Endpoint:** `GET /session/:id/messages/:messageId/edits`

**Path Parameters:**
- `id` (string, required) - Session identifier
- `messageId` (string, required) - WhatsApp message ID

**Response Success (200):**
```json
{
  "messageId": "true_5511999999999@c.us_ABC123XYZ",
  "currentBody": "This is the edited message",
  "editionHistory": [
    "This was the first version",
    "This was the second version"
  ],
  "editCount": 2
}
```

**Response Success (Message never edited):**
```json
{
  "messageId": "true_5511999999999@c.us_ABC123XYZ",
  "currentBody": "This message was never edited",
  "editionHistory": [],
  "editCount": 0
}
```

**Notes:**
- The `editionHistory` array contains previous versions of the message body in chronological order (oldest first)
- The `currentBody` is the latest version of the message

---

#### 13. Get Stored Chats

Retrieve chats stored in the database for a session.

**Endpoint:** `GET /session/:id/chats/stored`

**Path Parameters:**
- `id` (string, required) - Session identifier

**Query Parameters:**
- `archived` (boolean, optional) - Filter by archived status
- `isGroup` (boolean, optional) - Filter by group chat status
- `limit` (number, optional) - Maximum number of chats to retrieve (default: 100)
- `skip` (number, optional) - Number of chats to skip for pagination (default: 0)

**Example Requests:**
```
GET /session/user-1/chats/stored
GET /session/user-1/chats/stored?isGroup=true&limit=50
GET /session/user-1/chats/stored?archived=false&skip=20&limit=25
```

**Response Success (200):**
```json
[
  {
    "_id": "507f1f77bcf86cd799439011",
    "chatId": "5511999999999@c.us",
    "sessionId": "user-1",
    "name": "John Doe",
    "isGroup": false,
    "unreadCount": 2,
    "timestamp": 1705312800000,
    "archived": false,
    "pinned": false,
    "isReadOnly": false,
    "isMuted": false,
    "muteExpiration": null,
    "lastMessage": "Hello, how are you?",
    "lastMessageTimestamp": 1705312800000,
    "lastMessageFromMe": false,
    "createdAt": "2024-01-15T10:00:00.000Z",
    "updatedAt": "2024-01-15T12:00:00.000Z"
  },
  {
    "_id": "507f1f77bcf86cd799439012",
    "chatId": "120363123456789012@g.us",
    "sessionId": "user-1",
    "name": "Group Chat",
    "isGroup": true,
    "unreadCount": 5,
    "timestamp": 1705312900000,
    "archived": false,
    "pinned": true,
    "isReadOnly": false,
    "isMuted": true,
    "muteExpiration": 1705400000000,
    "lastMessage": "Meeting tomorrow at 3pm",
    "lastMessageTimestamp": 1705312900000,
    "lastMessageFromMe": false,
    "createdAt": "2024-01-15T10:00:00.000Z",
    "updatedAt": "2024-01-15T12:00:00.000Z"
  }
]
```

**Notes:**
- Chats are sorted by timestamp in descending order (newest first)
- Use `skip` and `limit` for pagination

---

#### 14. Get Stored Chat by ID

Retrieve a specific chat by its chat ID from the database.

**Endpoint:** `GET /session/:id/chats/stored/:chatId`

**Path Parameters:**
- `id` (string, required) - Session identifier
- `chatId` (string, required) - Chat identifier (e.g., "5511999999999@c.us")

**Response Success (200):**
```json
{
  "_id": "507f1f77bcf86cd799439011",
  "chatId": "5511999999999@c.us",
  "sessionId": "user-1",
  "name": "John Doe",
  "isGroup": false,
  "unreadCount": 2,
  "timestamp": 1705312800000,
  "archived": false,
  "pinned": false,
  "isReadOnly": false,
  "isMuted": false,
  "muteExpiration": null,
  "lastMessage": "Hello, how are you?",
  "lastMessageTimestamp": 1705312800000,
  "lastMessageFromMe": false,
  "createdAt": "2024-01-15T10:00:00.000Z",
  "updatedAt": "2024-01-15T12:00:00.000Z"
}
```

**Response Success (Chat not found):**
```json
null
```

---

## Common Response Types

### Error Response Format

All error responses follow this structure:

```json
{
  "message": "Error description",
  "statusCode": 500
}
```

### HTTP Status Codes

- `200` - Success
- `400` - Bad Request (invalid parameters)
- `404` - Not Found (resource doesn't exist)
- `500` - Internal Server Error

---

## Data Types Reference

### Session ID Format
- Any string identifier (e.g., "user-1", "session-abc", "sales-team")
- Used to uniquely identify WhatsApp sessions

### Chat ID Format
- Individual chats: `{phone_number}@c.us` (e.g., "5511999999999@c.us")
- Group chats: `{group_id}@g.us` (e.g., "120363123456789012@g.us")

### Message ID Format
- WhatsApp message IDs follow the pattern: `true_{chat_id}_{unique_id}`
- Example: `true_5511999999999@c.us_ABC123XYZ`

### Timestamp Format
- Unix timestamp in milliseconds (JavaScript Date.getTime() format)
- Example: `1705312800000` represents January 15, 2024, 10:00:00 UTC

### Phone Number Format
- International format without +, spaces, or dashes
- Example: `5511999999999` (Brazil: +55 11 99999-9999)

---

## Authentication Flow

1. **Create Session**: `POST /session/:id`
   - Returns success response
   - QR code is emitted via WebSocket (`qr` event)

2. **Scan QR Code**: Use the QR code from WebSocket event
   - Scan with WhatsApp mobile app

3. **Wait for Ready**: Monitor WebSocket events
   - `authenticated` - Session authenticated
   - `ready` - Session ready to use
   - `auth_failure` - Authentication failed

4. **Check Status**: `GET /session/:id/status`
   - Verify `ready: true` before sending messages

---

## Environment Variables

```env
DATABASE_HOST=your_mongodb_host
DATABASE_PORT=27017
DATABASE_USER=your_mongodb_user
DATABASE_PASS=your_mongodb_password
DATABASE_NAME=your_database_name
APP_PORT=3001
```

---

## Notes for Client Implementation

1. **Session Management**: Always check session status before sending messages
2. **WebSocket Connection**: Connect to `/whatsapp` namespace to receive real-time events
3. **Pagination**: Use `skip` and `limit` parameters for large datasets
4. **Error Handling**: Always handle potential errors from all endpoints
5. **Phone Formatting**: Ensure phone numbers are in international format (digits only)
6. **Message Storage**: Messages are automatically stored when received; use stored endpoints for queries
7. **Auto-Reconnect**: Sessions automatically reconnect after 5 seconds on disconnection
8. **Local Storage**: Session data is stored in `.wwebjs_auth` directory on the server

---

## Example Client Implementation Flow

```javascript
// 1. Create session
POST /rest/whatsapp-web/session/my-session

// 2. Listen for QR code (WebSocket)
ws.on('qr', (data) => {
  // Display QR code: data.qr
  // data.sessionId = 'my-session'
});

// 3. Wait for ready event (WebSocket)
ws.on('ready', (data) => {
  // Session ready: data.sessionId = 'my-session'
  // Now you can send messages
});

// 4. Check session status
GET /rest/whatsapp-web/session/my-session/status

// 5. Send message
POST /rest/whatsapp-web/send/my-session
Body: {
  "phone": "5511999999999",
  "message": "Hello!"
}

// 6. Get chats
GET /rest/whatsapp-web/session/my-session/chats

// 7. Get messages
GET /rest/whatsapp-web/session/my-session/stored-messages?chatId=5511999999999@c.us
```

---

## Dependencies

- `whatsapp-web.js` - WhatsApp Web API client
- `@nestjs/mongoose` - MongoDB integration
- `puppeteer` - Browser automation
- `qrcode-terminal` - QR code display
- `socket.io` - WebSocket server

# WhatsApp Web API Documentation

## Base URL
```
http://localhost:{APP_PORT}/rest/whatsapp-web
```

---

## 1. Create Session

Creates a new WhatsApp Web session. Optionally associates the session with a group ID (MongoDB ObjectId).

### Endpoint
```
POST /session/:id
```

### Path Parameters
- `id` (string, required): Unique session identifier (e.g., 'user-1', 'sales-team')

### Request Body
```json
{
  "groupId": "507f1f77bcf86cd799439011"  // Optional: MongoDB ObjectId as string
}
```

**Request Body Schema:**
- `groupId` (string, optional): Valid MongoDB ObjectId in hex format. Will be stored as `refId` in the session document.

### Example Request
```bash
curl -X POST http://localhost:3000/rest/whatsapp-web/session/my-session-123 \
  -H "Content-Type: application/json" \
  -d '{
    "groupId": "507f1f77bcf86cd799439011"
  }'
```

### Success Response (200 OK)
```json
{
  "success": true,
  "sessionId": "my-session-123",
  "message": "Session created successfully"
}
```

### Error Responses

**Session Already Exists (200 OK)**
```json
{
  "success": false,
  "sessionId": "my-session-123",
  "message": "Session already exists and is authenticated"
}
```

**Session Already Authenticated (200 OK)**
```json
{
  "success": false,
  "sessionId": "my-session-123",
  "message": "Session is already authenticated"
}
```

**Validation Error (400/500)**
```json
{
  "statusCode": 500,
  "message": "Failed to create session: {error details}",
  "error": "Internal Server Error"
}
```

### Notes
- If session already exists and is ready/authenticated, the request will return a success: false response without creating a new session
- The `groupId` parameter is validated to ensure it's a valid MongoDB ObjectId before storing
- If `groupId` is invalid, it will be silently ignored (logged as warning) and session will be created without it
- Session status transitions: `initializing` → `qr_generated` → `authenticated` → `ready`

---

## 2. Set Message Group

Associates a group ID with a specific message in the database. This allows filtering and grouping messages by a custom group identifier.

### Endpoint
```
POST /session/:id/messages/:messageId/group
```

### Path Parameters
- `id` (string, required): Session identifier
- `messageId` (string, required): WhatsApp message ID (e.g., `true_1234567890@c.us_3EB0...`)

### Request Body
```json
{
  "groupId": "group-chat-id-123@g.us"  // Required: Group identifier (typically WhatsApp group ID format)
}
```

**Request Body Schema:**
- `groupId` (string, required): Group identifier to associate with the message. Typically a WhatsApp group chat ID (ends with `@g.us`) or any custom identifier.

### Example Request
```bash
curl -X POST http://localhost:3000/rest/whatsapp-web/session/my-session-123/messages/true_1234567890@c.us_3EB0ABCD/group \
  -H "Content-Type: application/json" \
  -d '{
    "groupId": "120363123456789012@g.us"
  }'
```

### Success Response (200 OK)
```json
{
  "success": true
}
```

### Error Responses

**Message Not Found (500)**
```json
{
  "statusCode": 500,
  "message": "Failed to set groupId: Message not found",
  "error": "Internal Server Error"
}
```

**Missing groupId (500)**
```json
{
  "statusCode": 500,
  "message": "Failed to set groupId: groupId is required",
  "error": "Internal Server Error"
}
```

**Invalid Request (500)**
```json
{
  "statusCode": 500,
  "message": "Failed to set groupId: {error details}",
  "error": "Internal Server Error"
}
```

### Notes
- The `groupId` field is indexed in the database for efficient filtering
- Updates only the specific message matching both `sessionId` and `messageId`
- If no message matches the criteria, an error is returned
- The `groupId` can be set to any string value, including WhatsApp group chat IDs (format: `{number}@g.us`)

---

## Common Error Formats

All endpoints may return standard NestJS error responses:

```json
{
  "statusCode": 400,
  "message": "Error message description",
  "error": "Bad Request"
}
```

```json
{
  "statusCode": 500,
  "message": "Error message description",
  "error": "Internal Server Error"
}
```

---

## Data Models

### Session Document
```typescript
{
  sessionId: string;              // Unique session identifier
  refId?: ObjectId;               // Optional: MongoDB ObjectId (set via groupId in API)
  sessionData?: any;              // WhatsApp session data
  status: 'initializing' | 'qr_generated' | 'authenticated' | 'ready' | 'disconnected' | 'closed' | 'auth_failure' | 'error';
  lastSeen: Date;
  qrAttempts: number;
  maxQrAttempts: number;
  closedAt?: Date;
  isDisconnected: boolean;
  disconnectedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}
```

### Message Document
```typescript
{
  messageId: string;              // WhatsApp message ID
  sessionId: string;              // Session identifier
  chatId: string;                 // Chat identifier
  groupId?: string;               // Optional: Group identifier (set via setMessageGroup endpoint)
  body?: string;                  // Message body
  type: string;                   // Message type
  from: string;                   // Sender contact ID
  to: string;                     // Recipient contact ID
  timestamp: number;              // Message timestamp
  // ... other fields
}
```


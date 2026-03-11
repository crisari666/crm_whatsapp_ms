# Destroy Session API

## URL
```
DELETE /rest/whatsapp-web/session/:id
```

## Method
`DELETE`

## Payload
**Path Parameters:**
- `id` (string, required): Session identifier

**Request Body:**
None

## Response

**Success (200 OK):**
```json
{
  "success": true,
  "message": "Session destroyed successfully"
}
```

**Session Not Found (200 OK):**
```json
{
  "success": false,
  "message": "Session not found"
}
```

**Error (500 Internal Server Error):**
```json
{
  "statusCode": 500,
  "message": "Failed to destroy session: {error details}",
  "error": "Internal Server Error"
}
```

# Reference: Event Contract and Rollout

## Suggested Event Name

`customers.whatsapp.message.created.v1`

Keep event name stable; increment version only for breaking payload changes.

## Suggested Contract Template

```ts
export interface CustomersWhatsappMessageCreatedV1 {
  eventVersion: 'v1';
  eventName: 'customers.whatsapp.message.created.v1';
  occurredAt: string; // ISO timestamp
  source: 'crm_whatsapp_ms';
  sessionId: string;
  correlationId?: string;
  identity: {
    customerExternalId?: string;
    whatsappChatId?: string;
    fromPhone?: string;
    toPhone?: string;
  };
  message: {
    messageId: string;
    chatId: string;
    from: string;
    to: string;
    author?: string;
    body?: string;
    type?: string;
    fromMe: boolean;
    timestamp: number;
    hasMedia?: boolean;
    mediaType?: string;
    hasQuotedMsg?: boolean;
    isForwarded?: boolean;
    isStarred?: boolean;
    isDeleted: boolean;
    deletedAt: string | null;
    deletedBy: string | null;
    edition: unknown[];
  };
}
```

## NestJS Implementation Notes

- Producer service in `crm_whatsapp_ms`:
  - Inject RMQ `ClientProxy`.
  - Build validated DTO from normalized message.
  - Emit event after local persistence succeeds.

- Consumer in `crm-omega-customers-ms`:
  - Use dedicated controller for RMQ events.
  - Validate payload with DTO/class-validator.
  - Run idempotent upsert transaction.
  - Ack message only after successful persistence.

## Rollout Plan

1. Deploy consumers in customers-ms first (backward compatible).
2. Deploy producer emit in whatsapp-ms.
3. Monitor queue depth, DLQ, and error logs.
4. Enable frontend endpoint consumption after data verification.

## Failure Handling

- Validation failure: reject to DLQ with error reason.
- Customer not found: store unresolved event and emit reconciliation signal.
- Transient DB failure: retry with bounded policy; avoid infinite redelivery loops.

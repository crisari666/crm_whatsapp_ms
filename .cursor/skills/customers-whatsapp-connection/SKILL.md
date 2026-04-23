---
name: customers-whatsapp-connection
description: Connect WhatsApp message events from crm_whatsapp_ms to customer records in crm-omega-customers-ms using official NestJS microservice patterns and RabbitMQ contracts. Use when implementing customer conversation sync, message-to-customer linking, cross-repo event contracts, or frontend conversation retrieval from customers-ms.
---

# Customers WhatsApp Connection

## Purpose

Implement and maintain the integration between:

- `crm_whatsapp_ms` (WhatsApp Web message ingestion)
- `crm-omega-customers-ms` (customer domain storage and query API)

Goal: when `message_create` arrives in WhatsApp service, persist or update conversation data linked to the correct customer in customers-ms so frontend can fetch both customer info and WhatsApp conversation context.

## Non-Negotiables

- Use official NestJS-supported implementations first.
- Prefer NestJS microservices package (`@nestjs/microservices`) with RabbitMQ transport.
- Keep message contracts explicit, versioned, and backward compatible.
- Keep customer domain ownership in `crm-omega-customers-ms`.
- Avoid business-logic duplication across services.

## Trigger Scenarios

Use this skill when the user asks to:

- connect WhatsApp messages to customer records
- move conversation storage/query into customers-ms
- integrate `whatsapp-web.service.ts` message events with another microservice
- introduce or update RabbitMQ communication between both repos
- expose frontend-friendly customer + conversation retrieval APIs

## Architecture Baseline

1. In `crm_whatsapp_ms`, capture normalized message from `message_create`.
2. Resolve stable identity fields for linking (phone/JID/session/agent identifiers).
3. Publish RabbitMQ event using a strict DTO contract.
4. In `crm-omega-customers-ms`, consume event with `@MessagePattern`.
5. Upsert conversation entities under the matched customer record.
6. Expose query endpoint(s) from customers-ms for frontend read models.

## Contract-First Workflow

1. Define event contract before coding handlers.
2. Include:
   - `eventVersion`
   - `occurredAt`
   - `source` (`crm_whatsapp_ms`)
   - `sessionId`
   - message payload (`messageId`, `chatId`, `from`, `to`, `fromMe`, `body`, `timestamp`, media flags)
   - correlation identity (`customerExternalId` and/or normalized phone fields when available)
3. Document required vs optional fields.
4. Add schema validation in producer and consumer DTO layers.

## Recommended RabbitMQ Pattern (NestJS)

- Producer: `ClientProxy` with `emit()` for fire-and-forget domain events.
- Consumer: dedicated controller/handler with `@EventPattern` or `@MessagePattern` (choose one pattern consistently for event semantics).
- Configure transport with NestJS RMQ options:
  - durable queues
  - acknowledgements strategy
  - dead-letter routing if available
  - retry/backoff policy

## Customer Linking Strategy

Use deterministic matching order:

1. Explicit customer identifier from trusted mapping (best).
2. Exact normalized phone match (E.164 or one canonical internal format).
3. Fallback mapping via WhatsApp chat/JID mapping table.

If no customer is found:

- Persist to an unresolved inbox table/collection in customers-ms.
- Emit a follow-up event or metric for later reconciliation.
- Do not drop messages silently.

## Frontend Retrieval Shape

When adding read APIs in customers-ms, prefer a projection optimized for CRM UI:

- customer core profile
- latest WhatsApp conversation summary
- paginated messages
- agent/ventor attribution metadata
- delivery/read/deleted/edit status when available

Keep this query model separate from raw event payload schema.

## Implementation Checklist

- [ ] Define shared event contract and version field.
- [ ] Publish event from `message_create` flow in `crm_whatsapp_ms`.
- [ ] Add consumers in `crm-omega-customers-ms` using NestJS microservice handlers.
- [ ] Add idempotency guard (by `messageId` + `sessionId`).
- [ ] Add customer matching + unresolved fallback flow.
- [ ] Add/update customers-ms API endpoint(s) for conversation retrieval.
- [ ] Add integration tests for producer/consumer contract compatibility.
- [ ] Add observability: logs, metrics, and dead-letter monitoring.

## Testing Requirements

- Contract test for payload compatibility between repos.
- Consumer idempotency test (duplicate event should not duplicate message).
- Matching tests (exact match, fallback, unresolved).
- End-to-end test: publish event -> customer conversation query returns expected data.

## Output Style When Applying This Skill

When implementing, produce:

1. Short architecture note (1-2 paragraphs).
2. List of touched files per repo.
3. Event contract snippet (DTO/interface).
4. Test plan with contract + integration coverage.
5. Migration notes if schema changes are introduced.

## Reference

For concrete contract template and rollout guidance, read `reference.md`.

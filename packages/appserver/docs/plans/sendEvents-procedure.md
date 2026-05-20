# Plan: `space.roomy.space.sendEvents` XRPC Procedure

**Date:** 2026-05-19
**Status:** Plan
**Prerequisite:** Leaf `userOverride` support (merged 2026-05-19)

## Overview

Add a new XRPC procedure `space.roomy.space.sendEvents` that lets authenticated clients send batches of Roomy events to a space stream through the appserver, rather than connecting to Leaf directly. The appserver validates authorization per-event, then proxies the batch to Leaf with a `userOverride` set to the caller's DID.

This is the first write proxy in the appserver and the foundation for the thin-client migration — eventually all client writes will flow through this endpoint.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Authorization | Per-event | Structured 403 errors per event type; appserver is the gateway, not Leaf |
| Batch semantics | Atomic (validate all → send all) | Simpler client reasoning; a single bad event rejects the whole batch |
| Leaf dispatch | `ConnectedSpace.sendEvents` via `serviceClient.ts` | Reuses existing Leaf connection pool and CBOR encoding; extended to pass `userOverride` |
| ULID generation | Client-generated | Client needs IDs for optimistic cache updates; ULIDs prevent collisions |
| Event validation | SDK `Event` arktype schema | Early 400 on malformed events; reuses the canonical schema |

## Input / Output

**NSID:** `space.roomy.space.sendEvents`
**Method:** POST (procedure)
**Content-Type:** `application/json`

### Input

```typescript
{
  spaceId: string;          // StreamDid — the space to write to
  events: object[];         // Array of raw event objects (discriminated by $type)
}
```

The `events` array is validated against the SDK's `Event` arktype schema (`parseEvent`). Each event must have an `id` (ULID) and a `$type` from the known event registry.

### Output

`200 OK` with empty body on success.

### Errors

| HTTP | XRPC Error | When |
|---|---|---|
| 400 | `InvalidRequest` | Malformed JSON, validation failure on input schema or individual events |
| 400 | `InvalidRequest` | Batch contains events not in the allowed set (see §Event Allow List) |
| 401 | `AuthRequired` | Missing or invalid Bearer token |
| 403 | `Forbidden` | Caller lacks permission for one or more events (detailed message) |
| 404 | `NotFound` | Space or room referenced in an event does not exist |
| 500 | `InternalServerError` | Leaf dispatch failed after validation passed |

Validation errors include a `message` identifying which event failed and why, so the client can fix and retry the whole batch.

## Authorization Model

The appserver's materialized SQLite DB already has all the data needed to make authorization decisions (membership edges, admin edges, role assignments, `default_access`, bans). The `src/auth/access.ts` unit provides the building blocks.

### Auth Categories

Every known event type falls into one of four categories. A new module `src/auth/writeAuth.ts` will define a pure function that categorizes and checks each event.

| Category | Required permission | Events |
|---|---|---|
| **Room write** | `roomAccess(db, roomId, did).canWrite` AND space membership | `createMessage`, `editMessage`, `deleteMessage`, `moveMessages`, `reorderMessage`, `forwardMessages`, `addReaction`, `removeReaction`, `createRoomLink`, `removeRoomLink` |
| **Room manage** | Space admin | `createRoom`, `updateRoom`, `deleteRoom`, `restoreRoom` |
| **Space manage** | Space admin | `updateSpaceInfo`, `updateSidebar` (v0/v1), `setHandleProvider`, `addAdmin`, `removeAdmin`, `banAccount`, `unbanAccount`, `createRole`, `deleteRole`, `updateRole`, `addMemberRole`, `removeMemberRole`, `setRoleRoomPermission`, `createInvite`, `revokeInvite`, `editPage`, `openmeet.configure` |
| **Space member** | Space membership (not banned) | `joinSpace`, `leaveSpace`, `updateProfile` |
| **Bridged** | Space admin (these carry their own user identity in the payload) | `addBridgedReaction`, `removeBridgedReaction` |

**Notes:**
- `roomAccess()` from `access.ts` already computes `canWrite` as: admin OR (member AND (default_access=readwrite OR role grant 'readwrite')). This is exactly what we need.
- Room write events carry a `room` field on the envelope. The auth check resolves the room → space → membership + canWrite.
- `editMessage` and `deleteMessage` additionally check that the caller is the author, *unless* the caller is a space admin (admins can moderate).
- Room manage events (`createRoom`, `updateRoom`, etc.) reference a room via `roomId` or create one at the event's own `id`. Admin check is on the parent space.

### Rejected Event Types

The following `$type` values are rejected with 400 if present in a batch — they must not be sent through this endpoint:

| `$type` | Reason |
|---|---|
| `space.roomy.space.personal.joinSpace.v0` | Targets the user's personal stream, not the space stream |
| `space.roomy.space.personal.leaveSpace.v0` | Targets the user's personal stream, not the space stream |
| `space.roomy.state.markRead.v0` | Replaced by `space.roomy.room.updateSeen` XRPC procedure |
| Any unknown `$type` | Not in the event registry |

## Event Allow List

The handler rejects events whose `$type` is not in the explicit allow list. This is a security measure — even if someone constructs a valid-looking event with an unknown type, it won't reach Leaf.

The allow list is derived from the SDK's `eventRegistry` keys, minus the rejected types above. This can be a `Set<string>` built at module load time.

## Batch Processing Flow

```
1. Parse JSON body → { spaceId, events }
2. Validate `spaceId` is present
3. Validate `events` is a non-empty array, size ≤ MAX_BATCH_SIZE (50)
4. Look up space in materialized DB → 404 if not found
5. Authenticate caller (JWT Bearer token) → did
6. For each event in the batch:
   a. Parse against SDK Event schema → 400 if invalid
   b. Check $type is in the allow list → 400 if rejected
   c. Categorize by $type → run category-specific auth check
   d. Collect any auth failure → break (don't send partial batch)
7. If any event failed validation or auth → return 400/403 with details
8. CBOR-encode all events, call leaf.sendEvents(streamDid, encoded[], userOverride=did)
9. Return 200
```

Steps 1–7 are synchronous DB reads (fast, no I/O beyond SQLite). Step 8 is the only async network call. The batch is atomic: if validation passes but Leaf rejects, we return 500.

## Implementation Plan

### 1. SDK: Extend `ConnectedSpace.sendEvents` with `userOverride`

**File:** `packages/sdk/src/connection/ConnectedSpace.ts`

Add an optional `userOverride` parameter to `sendEvent`, `sendEvents`, and `sendStateEvent`:

```typescript
async sendEvent(event: Event, userOverride?: string): Promise<void> {
  await this.#leaf.sendEvent(this.streamDid, encode(event), userOverride);
}

async sendEvents(events: Event[], userOverride?: string): Promise<void> {
  if (events.length === 0) return;
  await this.#leaf.sendEvents(
    this.streamDid,
    events.map((event) => encode(event)),
    userOverride,
  );
}

async sendStateEvent(event: Event, userOverride?: string): Promise<void> {
  await this.#leaf.sendStateEvents(this.streamDid, [encode(event)], userOverride);
}
```

This is a backwards-compatible change — existing callers that omit the parameter continue to work (Leaf will use the connection's own DID, as before).

### 2. SDK: Add procedure schema + auto-generate lexicon

**File:** `packages/sdk/src/schemas/procedures/sendEvents.ts` (new)

The generator script (`scripts/generate-lexicons.ts`) dynamically imports every `.ts` file in `src/schemas/procedures/`, reads the `NSID`, `Input`, and `Output` exports, and converts them to ATProto lexicon JSON via `arktype.toJsonSchema()`. So adding this schema file is sufficient — the lexicon is generated by running `pnpm generate:lexicons`.

```typescript
import { type } from "arktype";

export const NSID = "space.roomy.space.sendEvents" as const;

export const Input = type({
  spaceId: "string",
  events: type.array(type.object).moreThanLength(0).atMostLength(50),
});

export const Output = type({});
```

**File:** `packages/sdk/src/schemas/procedures/index.ts` — add re-export:

```typescript
export * as sendEvents from "./sendEvents";
```

**Run:** `pnpm --filter @roomy-space/sdk generate:lexicons`

This writes `packages/sdk/src/schemas/lexicons/space.roomy.space.sendEvents.json`. The generator handles the arktype → JSON Schema → lexicon conversion (object extraction, nullable handling, etc.). No hand-written lexicon JSON is needed in either the SDK or the appserver.

> **Note:** The appserver's `lexicons/` directory exists as documentation only — no code reads it at runtime. The canonical lexicons live in the SDK and are generated from schemas.

### 3. Appserver: Add `requireRoomWrite` auth guard

**File:** `packages/appserver/src/xrpc/authGuards.ts`

Add alongside the existing `requireSpaceAccess` and `requireRoomRead`:

```typescript
export function requireRoomWrite(
  db: Database,
  roomId: string,
  did: string,
): RoomAccess {
  const access = roomAccess(db, roomId, did);
  if (!access.exists) {
    throw new XrpcError(404, "NotFound", `Room not found: ${roomId}`);
  }
  if (access.isBanned) {
    throw new XrpcError(403, "Forbidden", "Caller is banned from this space");
  }
  if (!access.canWrite) {
    throw new XrpcError(
      403,
      "Forbidden",
      "Caller does not have write access to this room",
    );
  }
  return access;
}
```

### 4. Appserver: Create `writeAuth` module

**File:** `packages/appserver/src/auth/writeAuth.ts` (new)

Pure function that takes `(db, spaceId, callerDid, event)` and either returns `undefined` (allowed) or a `{ status, error, message }` object (denied). Follows the same coupling rules as `access.ts` — no XRPC imports.

```typescript
export interface WriteAuthDenial {
  status: 400 | 403 | 404;
  error: string;
  message: string;
}

export type WriteAuthResult = undefined | WriteAuthDenial;

export function checkWriteAuth(
  db: Database,
  spaceId: string,
  callerDid: string,
  event: { $type: string; [k: string]: unknown },
): WriteAuthResult;
```

Internally, this dispatches on `$type` to category-specific checks using the existing `spaceAccess()` and `roomAccess()` functions from `access.ts`.

Category dispatch table:

| `$type` prefix / pattern | Category | Auth function |
|---|---|---|
| `space.roomy.message.*` | Room write | `requireRoomWrite(db, event.room, did)` |
| `space.roomy.reaction.addReaction.v0` | Room write | `requireRoomWrite(db, event.room, did)` |
| `space.roomy.reaction.removeReaction.v0` | Room write | `requireRoomWrite(db, event.room, did)` |
| `space.roomy.reaction.addBridgedReaction.v0` | Bridged | `requireSpaceAdmin(db, spaceId, did)` |
| `space.roomy.reaction.removeBridgedReaction.v0` | Bridged | `requireSpaceAdmin(db, spaceId, did)` |
| `space.roomy.link.*` | Room write | `requireRoomWrite(db, event.room, did)` |
| `space.roomy.room.createRoom.v0` | Room manage | `requireSpaceAdmin(db, spaceId, did)` |
| `space.roomy.room.updateRoom.v0` | Room manage | `requireSpaceAdmin(db, spaceId, did)` |
| `space.roomy.room.deleteRoom.v0` | Room manage | `requireSpaceAdmin(db, spaceId, did)` |
| `space.roomy.room.restoreRoom.v0` | Room manage | `requireSpaceAdmin(db, spaceId, did)` |
| `space.roomy.space.joinSpace.v0` | Space member | `requireNotBanned(db, spaceId, did)` |
| `space.roomy.space.leaveSpace.v0` | Space member | `requireMembership(db, spaceId, did)` |
| `space.roomy.user.updateProfile.v0` | Space member | `requireMembership(db, spaceId, did)` |
| All other `space.roomy.space.*` | Space manage | `requireSpaceAdmin(db, spaceId, did)` |
| All `space.roomy.role.*` | Space manage | `requireSpaceAdmin(db, spaceId, did)` |
| `space.roomy.space.createInvite.v0` | Space member | `requireMembership(db, spaceId, did)` + invite permission check |
| `space.roomy.space.revokeInvite.v0` | Space manage | `requireSpaceAdmin(db, spaceId, did)` |
| `space.roomy.page.*` | Space manage | `requireSpaceAdmin(db, spaceId, did)` |
| `space.roomy.openmeet.*` | Space manage | `requireSpaceAdmin(db, spaceId, did)` |

Rejected `$type` values (returned as 400):
- `space.roomy.space.personal.*`
- `space.roomy.state.markRead.v0`
- Any type not in the allow list

### 5. Appserver: Create the handler

**File:** `packages/appserver/src/handlers/space.roomy.space.sendEvents.ts` (new)

```typescript
import type { ProcedureHandler, AuthCtx, QueryParams } from "../xrpc/types.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { openDb } from "../db/db.ts";
import { getConnectedSpace } from "../serviceClient.ts";
import { parseEvent, Event } from "@roomy-space/sdk";
import { checkWriteAuth } from "../auth/writeAuth.ts";

const MAX_BATCH_SIZE = 50;

interface SendEventsBody {
  spaceId?: unknown;
  events?: unknown;
}

export const sendEventsHandler: ProcedureHandler<SendEventsBody, void> = async (
  _params: QueryParams,
  auth: AuthCtx,
  body: SendEventsBody,
) => {
  // 1. Validate input
  if (typeof body.spaceId !== "string" || body.spaceId === "") {
    throw new XrpcError(400, "InvalidRequest", "Missing or empty required field: spaceId");
  }
  if (!Array.isArray(body.events) || body.events.length === 0) {
    throw new XrpcError(400, "InvalidRequest", "Missing or empty required field: events");
  }
  if (body.events.length > MAX_BATCH_SIZE) {
    throw new XrpcError(400, "InvalidRequest", `Batch size exceeds maximum of ${MAX_BATCH_SIZE}`);
  }

  const spaceId = body.spaceId;
  const callerDid = auth.did;
  const db = openDb();

  // 2. Verify space exists in materialized DB
  const spaceRow = db
    .query<{ n: number }, [string]>(
      "SELECT 1 AS n FROM entities WHERE id = ? AND stream_id = ? LIMIT 1"
    )
    .get(spaceId, spaceId);
  if (!spaceRow) {
    throw new XrpcError(404, "NotFound", `Space not found: ${spaceId}`);
  }

  // 3. Validate + authorize each event
  const parsedEvents: typeof Event.infer[] = [];
  for (let i = 0; i < body.events.length; i++) {
    const raw = body.events[i];

    // Schema validation
    const result = parseEvent(raw);
    if (!result.success) {
      throw new XrpcError(
        400,
        "InvalidRequest",
        `Event at index ${i} failed validation: ${result.error}`,
      );
    }

    // Authorization
    const denial = checkWriteAuth(db, spaceId, callerDid, result.data);
    if (denial) {
      throw new XrpcError(denial.status, denial.error,
        `Event at index ${i} ($type: ${result.data.$type}): ${denial.message}`);
    }

    parsedEvents.push(result.data);
  }

  // 4. Proxy to Leaf
  const space = await getConnectedSpace(spaceId as any /* StreamDid */);
  await space.sendEvents(parsedEvents, callerDid);
};
```

### 6. Appserver: Register the route

**File:** `packages/appserver/src/index.ts`

Add the import and registration alongside the existing procedures:

```typescript
import { sendEventsHandler } from "./handlers/space.roomy.space.sendEvents.ts";

// In the route chain:
.procedure("space.roomy.space.sendEvents", {
  handler: sendEventsHandler,
  inputSchema: schemas.procedures.sendEvents.Input,
})
```

### 7. Generate the lexicon

The lexicon JSON is auto-generated from the procedure schema added in step 2:

```bash
pnpm --filter @roomy-space/sdk generate:lexicons
```

This produces `packages/sdk/src/schemas/lexicons/space.roomy.space.sendEvents.json`. No hand-written lexicon file is needed.

## Data Flow After Write

Once the appserver sends events to Leaf with `userOverride`, the existing pipelines handle the rest:

1. **Leaf** stores the events and broadcasts to subscribers
2. **SpaceMaterializer** (already subscribed to the same Leaf stream) receives the events via its subscription callback
3. **`applyBatch`** materializes the events into SQLite (author edges, content, reactions, etc.)
4. **`inferSignals`** generates invalidation signals based on event `$type`
5. **InvalidationRouter** pushes `#messageDiff` and `#invalidate` frames to subscribed WS clients
6. **Clients** update their TanStack Query caches

No changes are needed to steps 2–6 — they already work for events from any source (backfill, Discord bridge, etc.).

## Author Validation for Edit/Delete

For `editMessage` and `deleteMessage`, we should verify that the caller is the message's original author, unless the caller is a space admin (moderation use case).

```typescript
function checkMessageAuthorOrAdmin(
  db: Database,
  messageId: string,
  callerDid: string,
  spaceId: string,
): WriteAuthResult {
  const isAdmin = isAdminCheck(db, spaceId, callerDid);
  if (isAdmin) return undefined; // Admins can edit/delete anyone's messages

  const row = db
    .query<{ tail: string }, [string]>(
      "SELECT tail FROM edges WHERE head = ? AND label = 'author' LIMIT 1"
    )
    .get(messageId);
  if (!row || row.tail !== callerDid) {
    return {
      status: 403,
      error: "Forbidden",
      message: "Only the message author or a space admin can edit/delete this message",
    };
  }
  return undefined;
}
```

This is a defense-in-depth measure — the Leaf module's authorizer may or may not enforce this, but the appserver should.

## `joinSpace` Special Handling

`joinSpace` requires additional logic beyond "not banned":

- If the space has `allow_public_join = 1` (default), any authenticated user can join
- If `allow_public_join = 0`, the user must present a valid invite token

For the initial implementation, we can defer invite validation and just check that the caller is not banned. The space's authorizer in the Leaf module already rejects duplicate joins. We can tighten this in a follow-up when we implement invite redemption as a separate concern.

## Security Considerations

1. **No privilege escalation via `userOverride`:** The `userOverride` parameter is set by the appserver to the JWT-authenticated caller's DID — the client never controls it. The Leaf server enforces that only `unsafe_auth_token` connections may use it.

2. **Event injection:** The allow list prevents unknown event types from reaching Leaf. Even if a client constructs a novel `$type`, it's rejected at validation.

3. **Batch size limit (50):** Prevents resource exhaustion from oversized batches. Individual event payloads are bounded by the HTTP body size limit (Bun default: ~128MB, but we can add a tighter limit).

4. **Rate limiting:** Not in scope for this initial implementation, but the endpoint is a natural place for per-DID rate limiting in the future.

5. **Idempotency:** Events are idempotent by design — duplicate ULIDs are ignored by Leaf. If the client retries after a network error, the worst case is a no-op on Leaf's side.

## Testing Strategy

### Unit Tests

- `src/auth/writeAuth.test.ts` — drive `checkWriteAuth` with every event type in every auth state (member, admin, banned, non-member, room-only restrictions)
- `src/handlers/space.roomy.space.sendEvents.test.ts` — test the handler with mocked `getConnectedSpace`, exercising:
  - Valid batch of room-write events → 200
  - Mixed batch (room write + space manage) as admin → 200
  - Mixed batch as non-admin → 403 on the admin-only event
  - Unknown `$type` → 400
  - Rejected `$type` (personal.*, markRead) → 400
  - Empty batch → 400
  - Oversized batch → 400
  - Schema-invalid event → 400 with index
  - Edit/delete by non-author non-admin → 403

### Integration Test

- Send a `createMessage` event via the procedure, verify the message appears in the materialized DB and that a subscribed WS client receives the `#messageDiff` frame.

## Files Changed

### SDK (`packages/sdk`)

| File | Change |
|---|---|
| `src/connection/ConnectedSpace.ts` | Add `userOverride` param to `sendEvent`, `sendEvents`, `sendStateEvent` |
| `src/schemas/procedures/sendEvents.ts` | **New** — Input/Output schemas (also drives lexicon generation) |
| `src/schemas/procedures/index.ts` | Add re-export |
| `src/schemas/lexicons/space.roomy.space.sendEvents.json` | **Generated** — by `pnpm generate:lexicons` |

### Appserver (`packages/appserver`)

| File | Change |
|---|---|
| `src/auth/writeAuth.ts` | **New** — per-event authorization logic |
| `src/auth/writeAuth.test.ts` | **New** — tests for writeAuth |
| `src/xrpc/authGuards.ts` | Add `requireRoomWrite` |
| `src/handlers/space.roomy.space.sendEvents.ts` | **New** — procedure handler |
| `src/index.ts` | Register route |

### Not Changed

- `src/materialization/*` — events from Leaf flow through existing pipeline
- `src/invalidation/*` — signals inferred from materialized events, unchanged
- `src/sync/*` — WS subscription routing, unchanged
- `src/auth/access.ts` — existing functions reused as-is

## Future Work

- **Invite-gated `joinSpace`** — validate invite tokens before allowing join
- **Per-DID rate limiting** — token bucket on the sendEvents endpoint
- **HTTP body size limit** — configurable max payload size
- **Individual per-event XRPC procedures** — `space.roomy.room.sendMessage`, `space.roomy.room.addReaction`, etc. as convenience wrappers around `sendEvents` with single-element batches and simpler input schemas
- **Move `MessageExtensionMap` author extensions into `writeAuth`** — validate that `authorOverride` is only used by admins/bridges

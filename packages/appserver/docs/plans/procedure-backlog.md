# Appserver XRPC Procedure Backlog

**Date:** 2026-05-20
**Status:** In progress — `createSpace`, `joinSpace`, `leaveSpace` implemented; reaction `myReactionId` pending
**Related:** `xrpc-interface-spec.md`, `sendEvents-procedure.md`, `../../../../docs/plans/client-migration-plan.md`

---

## Purpose

A running list of write actions that are candidates for **dedicated XRPC
procedures** on the appserver, rather than being expressed as raw Roomy events
through the generic `space.roomy.space.sendEvents` batch procedure.

This came out of `app-lite` work: several actions (creating, joining, and
leaving spaces) don't fit the `sendEvents` model cleanly. They either can't be
expressed as "append events to an existing stream" at all, or they need
server-side coordination the client can't perform.

When an item here is picked up, it should graduate into its own design doc /
section in `xrpc-interface-spec.md` and a handler under
`packages/appserver/src/handlers/`.

---

## Current write model

Today there is exactly one general write path:

- **`space.roomy.space.sendEvents`** — a batch procedure. The caller supplies
  `{ spaceId, events[] }`; the appserver validates + authorizes each event
  (`src/auth/writeAuth.ts`), then proxies the batch to Leaf with `userOverride`
  set to the caller's DID.

Everything else is modelled as an event `$type` inside that batch — including
`space.roomy.space.joinSpace.v0` and `space.roomy.space.leaveSpace.v0`.

This works well for **single-stream appends where the client already has the
context it needs**. It breaks down for the cases below.

---

## When does an action deserve a dedicated procedure?

Use a dedicated procedure (instead of an event via `sendEvents`) when **any** of
these hold:

1. **It must happen before a stream exists.** `sendEvents` requires `spaceId` to
   resolve to an existing materialized space. Bootstrapping a new space cannot
   satisfy that precondition.
2. **It needs server-side coordination across multiple streams.** e.g. writing
   to both a space stream and the caller's personal-space stream atomically.
3. **The client immediately needs data back.** `sendEvents` returns `200 OK`
   with no body. If the caller needs the new `spaceId`, or the joined space's
   metadata, a procedure with a typed response avoids a follow-up round trip.
4. **It needs server-side validation of opaque input.** e.g. resolving and
   consuming an invite token, where the client should not be trusted to
   pre-validate.

If none hold — a pure single-stream append the client already has context for —
keep it as an event through `sendEvents`.

---

## Candidate procedures

| NSID (proposed) | Priority | Why it can't stay an event | Status |
|-----------------|----------|----------------------------|--------|
| `space.roomy.space.createSpace` | High | No stream exists yet — criterion 1 + 3 | ✅ Implemented |
| `space.roomy.space.joinSpace` | Medium | Cross-stream personal-space bookkeeping + invite-token validation — criteria 2, 3, 4 | ✅ Implemented |
| `space.roomy.space.leaveSpace` | Medium | Cross-stream personal-space bookkeeping — criterion 2 | ✅ Implemented |

### `space.roomy.space.createSpace`

**Problem.** There is no XRPC path to create a space at all. `app-lite`'s home
page currently renders the "Create Space" button **disabled**. Creation cannot
go through `sendEvents` because `sendEvents` rejects any `spaceId` that isn't
already a materialized space.

**Proposed shape.**

- Input: `{ name, description?, avatar? }` (plus join-policy defaults).
- Behaviour: provision a new Leaf stream, seed it with the initial event set
  (space metadata, creator added as admin/member, optionally a default room),
  and register the space so `getSpaces` picks it up.
- Output: `{ spaceId }` so the client can navigate straight to `/{spaceId}`.

**Open points.** Stream/DID provisioning ownership; whether a default room is
created server-side or left to a follow-up `sendEvents`; rate limiting.

### `space.roomy.space.joinSpace`

**Today.** `app-lite`'s `joinSpace()` mutation sends a
`space.roomy.space.joinSpace.v0` event via `sendEvents`. `writeAuth` authorizes
it with a "not banned" check. This works for the space-side membership, but:

- **Invite tokens.** Private spaces use invite tokens. A procedure can resolve
  and consume the token server-side instead of trusting the client.
- **Personal space.** `packages/app` also writes a
  `space.roomy.space.personal.joinSpace.v0` event to the *user's personal
  space* stream so the space shows up in their list. `app-lite` has no way to
  do this — it doesn't track the personal-space DID. A procedure can perform
  both writes server-side.
- **Response.** Returning the joined space's metadata lets the client render
  the space immediately without a second `getMetadata` round trip.

**Proposed shape.**

- Input: `{ spaceId, inviteToken? }`.
- Behaviour: validate (not banned; token valid for private spaces), append the
  space-side join event, append the personal-space join event.
- Output: joined space metadata (or at minimum `{ spaceId }`).

### `space.roomy.space.leaveSpace`

**Today.** `app-lite`'s `leaveSpace()` mutation sends only
`space.roomy.space.leaveSpace.v0` via `sendEvents`. `packages/app` sends **two**
events: `leaveSpace.v0` to the space stream **and**
`space.roomy.space.personal.leaveSpace.v0` (carrying `{ spaceDid }`) to the
user's personal-space stream. `app-lite` cannot do the personal-space half.

A dedicated procedure encapsulates both writes server-side, so every client
leaves a space consistently regardless of whether it tracks the personal space.

**Proposed shape.**

- Input: `{ spaceId }`.
- Behaviour: append the space-side leave event and the personal-space leave
  event.
- Output: none needed (`200 OK`).

---

## Staying as events (for contrast)

These are **not** procedure candidates — they are single-stream appends against
an already-existing space, and the client has all the context. Keep them in
`sendEvents`:

- Room create / update / delete (`space.roomy.*` room events).
- Message send / edit / delete.
- Reactions.
- Sidebar / role / invite mutations.

---

## Related open items

- **Calendar queries** — `space.roomy.space.getCalendarLink` /
  `getCalendarEvents` are still unimplemented on the appserver (see open
  question #1 in `client-migration-plan.md`). Queries, not procedures, but
  belong in the same "next wave" planning.
- **`xrpc-interface-spec.md` is stale** — it lists "2 procedures" and does not
  mention `sendEvents`, which was added later. Refresh the endpoint summary
  when the procedures above land.

### Message DTO: surface viewer reaction identity

**Problem.** The `Message` DTO returned by `space.roomy.room.getMessages` /
`space.roomy.message.getMessage` (and carried by the `#messageDiff` WS frame)
collapses reactions to `{ emoji, dids[] }`. It carries **no reaction event id**.
`space.roomy.reaction.removeReaction.v0` requires a `reactionId` (the ULID of
the original `addReaction` event), so a client cannot remove the viewing user's
own reaction from DTO data alone.

This surfaced in `app-lite` chat parity work (see
`../../../../docs/plans/2026-05-20-app-lite-chat-parity.md`, Task 7/8):
adding a reaction works; toggling one off does not.

**Context.** `src/queries/selectMessages.ts` already batch-reads `comp_reaction`
rows (`entity, reaction, user`). `comp_reaction` also has a `reaction_id`
column (the app's legacy live query selects it). The requesting DID is known to
the handler. So the fix is a small, additive DTO change — no new table reads
beyond one extra column.

**Proposed shape.**

- Extend the reaction batch query in `selectMessages.ts` to also select
  `reaction_id`.
- Thread the requesting DID into `selectMessages` (the handler has it).
- Change the DTO reaction from `{ emoji, dids[] }` to
  `{ emoji, dids[], myReactionId: string | null }`, where `myReactionId` is the
  `reaction_id` of the reaction authored by the requesting DID for that emoji,
  or `null` if the viewer has not reacted with it.
- Mirror the change in the SDK arktype schema
  (`packages/sdk/src/schemas/queries/_message.ts`, the `Reaction` type) and
  rebuild the SDK dist. Because `#messageDiff` reuses the same `Message`
  schema, real-time reaction updates pick up `myReactionId` for free.

**Open point.** `myReactionId` is viewer-scoped, so message DTOs are no longer
identical across users — confirm nothing caches `getMessages` responses across
DIDs.

---

## Changelog

- 2026-05-20 — Initial draft. Candidates: `createSpace`, `joinSpace`,
  `leaveSpace`.
- 2026-05-20 — Added "Message DTO: surface viewer reaction identity" to related
  open items (from `app-lite` chat parity work).
- 2026-05-20 — Implemented `createSpace`, `joinSpace`, `leaveSpace` as XRPC
  procedures. SDK schemas added under `src/schemas/procedures/`; appserver
  handlers added under `src/handlers/`; routes registered in `src/index.ts`.
  Remaining: reaction `myReactionId` DTO change.

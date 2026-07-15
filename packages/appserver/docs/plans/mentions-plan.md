# Mentions Extension Plan (Web Push Phase 3)

**Status:** Implemented
**Parent doc:** `web-push-plan.md` (Phase 3 — Mentions)

## Problem

The web push plan shipped Phases 1–2 (plumbing, Busy immediate push, Engaged digest) with
mentions explicitly deferred. Until mentions exist:

- **Quiet** level behaves identically to **Silent** — no pushes at all.
- **Engaged** runs digest-only — mentioned users wait for the 5-message/1-hour threshold
  instead of getting an immediate push.

The blocker was the absence of a mention representation in the event schema. The TipTap
editor in `app-lite` already has a `@user` mention node carrying the user's DID
(`node.attrs.id`), but that DID is lost when the editor serialises to markdown
(`tiptap-markdown` renders it as `[@label](/user/{did})`), and no extension carries it
into the event.

This plan adds a `space.roomy.extension.mentions.v0` extension to `createMessage`,
populates it from the TipTap editor on send, and wires it into the push evaluator so
Quiet and Engaged levels can fire immediate pushes on mention.

## Scope

In scope:

1. **SDK schema:** `space.roomy.extension.mentions.v0` extension definition (arktype),
   added to the message extension union + map.
2. **app-lite send path:** extract user-mention DIDs from the TipTap ProseMirror doc
   before markdown serialisation, populate the `mentions` extension on the outgoing
   `createMessage` event.
3. **appserver push pipeline:** thread mentions from the raw event → `AppliedEvent` →
   `PushJob` → `evaluatePush`, where a `mentioned(userDid)` check routes Quiet and
   Engaged recipients to an immediate `message` push.
4. **Tests:** unit tests for the extension schema, the extraction helper, and the
   mention routing in `evaluatePush`.

Explicitly deferred (future phases):

- **Quiet "nudge"** — a separate user action and push path; design later.
- **Per-room overrides, granular mute, DND schedules** — Phase 4 polish.
- **Mention rendering on the read path** — the mention node already renders as a
  markdown link (`[@label](/user/{did})`); no change to the read/render path.
- **Channel/thread `#room` mentions** — those use a separate TipTap node
  (`channelThreadMention`) and are not user mentions; out of scope for push routing.
- **Mention notifications for users who aren't space members** — recipients are
  enumerated from `edges ... label in ('member','admin')`; non-members are never in the
  recipient set. Mentioning a non-member is harmless (they simply won't be notified).

## Architecture overview

```
app-lite (browser)
  TipTap editor
    userMention node: { attrs: { id: "<did>", label: "<name>" } }
    │
    ▼ on send (before markdown serialisation)
  extractMentionDids(editor.doc) → ["did:plc:alice", "did:plc:bob"]
    │
    ▼ populate extension
  createMessage event:
    extensions: {
      "space.roomy.extension.mentions.v0": {
        $type: "space.roomy.extension.mentions.v0",
        mentions: ["did:plc:alice", "did:plc:bob"]
      }
    }
    │
    ▼ sendEvents (XRPC)
appserver (Bun)
  StreamManager.sendEvents()
    │
    ▼ toAppliedEvent()
  AppliedEvent.details.mentions = ["did:plc:alice", "did:plc:bob"]
    │
    ▼ pokePushDispatcher()
  PushJob.mentions = ["did:plc:alice", "did:plc:bob"]
    │
    ▼ evaluatePush()
  for each recipient:
    mentioned = job.mentions?.includes(recipientDid)
    quiet   → mentioned ? immediate push : skip
    engaged → mentioned ? immediate push : digest path
```

## Extension schema (SDK)

Add to `packages/sdk/src/schema/extensions/message.ts`:

```ts
export const Mentions = type({
  $type: "'space.roomy.extension.mentions.v0'",
  mentions: UserDid.array().describe(
    "DIDs of users mentioned in the message body. \
Used by the push pipeline to route Quiet/Engaged immediate notifications. \
Each DID must appear at most once; order is not significant.",
  ),
}).describe("User mentions carried as structured data for notification routing.");
```

Add `Mentions` to the `messageExtension` union:

```ts
export const messageExtension = type.or(
  AuthorOverride,
  TimestampOverride,
  Attachments,
  DiscordMessageOrigin,
  Mentions, // ← new
);
```

`unionToMap(messageExtension)` automatically produces the map entry
`"space.roomy.extension.mentions.v0"?: { mentions: string[] }`, so
`MessageExtensionMap` (used as the `extensions` field on `createMessage`) picks it up
with no further change.

No lexicon JSON file is needed — extensions exist only as arktype schemas (same as
`authorOverride`, `timestampOverride`, `attachments`; none have lexicon JSON files).
The SDK's `Event` decoder validates extensions against the map, so an event with a
malformed `mentions` extension (non-array, non-DID strings) will be rejected at decode
time.

### `MessageExtensionUpdateMap` and `MessageExtensionDeleteMap`

`Mentions` is added to `messageExtension`, so `MessageExtensionUpdateMap`
(`unionToMap(messageExtension, { makeAllNullable: true })`) automatically includes it —
`editMessage` can update mentions. `MessageExtensionDeleteMap` is
`unionToMap(type.or(DiscordMessageOrigin))` and intentionally excludes `Mentions` —
there is no "delete mentions" semantics (editing a message replaces the body, and
mentions are re-derived from the new body).

## Frontend (app-lite) — extraction on send

### The problem with markdown serialisation

`ChatInput.svelte` serialises editor content to markdown on every update:

```ts
onUpdate: (ctx) => {
  content = ctx.editor.storage.markdown.getMarkdown();
}
```

`tiptap-markdown` renders the `userMention` node as `[@label](/user/{did})` — a
markdown link. The DID is embedded in the URL path, but parsing it back out of
markdown is fragile (the user could type a link with the same format, and the
`#room` mention node also renders as a link). The reliable source is the TipTap
ProseMirror document tree, which has structured `userMention` nodes with
`node.attrs.id` = DID.

### Extraction helper

New file: `packages/app-lite/src/lib/tiptap/mentions.ts`

```ts
import type { Editor } from "@tiptap/core";

/**
 * Extract the set of user DIDs mentioned in the editor's ProseMirror document.
 *
 * Walks the doc tree for `userMention` nodes (the `@user` extension) and collects
 * their `attrs.id` (the user's DID). De-duplicates — each mentioned user produces
 * one entry regardless of how many times they're mentioned in the message.
 *
 * Channel/thread `#room` mentions use a different node name (`channelThreadMention`)
 * and are intentionally excluded — they are not user mentions.
 */
export function extractMentionDids(editor: Editor): string[] {
  const dids = new Set<string>();
  editor.state.doc.descendants((node) => {
    if (node.type.name === "userMention") {
      const did = node.attrs.id;
      if (typeof did === "string" && did.startsWith("did:")) {
        dids.add(did);
      }
    }
    return true; // descend into children
  });
  return [...dids];
}
```

### Send path changes

**`ChatInput.svelte`** — expose the editor instance so the caller can extract
mentions. The editor is already stored in `tiptap` state; add an `onSend` callback
that receives both the markdown content and the mention DIDs, or expose the editor
via a bindable. The cleanest approach: change `onEnter` to accept mentions.

Current:
```ts
onEnter: (content: string) => Promise<void>;
```

Proposed:
```ts
onEnter: (content: string, mentions: string[]) => Promise<void>;
```

In `wrappedOnEnter`:
```ts
async function wrappedOnEnter() {
  const mentions = tiptap ? extractMentionDids(tiptap) : [];
  await onEnter(content, mentions);
}
```

**`ChatInputArea.svelte`** — `handleSend` receives mentions and populates the
extension. Both send paths (simple `sendMessageMutation` and inline-with-attachments)
need the mentions.

For the simple path, `sendMessage` in `mutations/message.ts` gains an optional
`mentions` param:

```ts
export async function sendMessage(
  spaceId: string,
  roomId: string,
  body: string,
  opts: { mimeType?: string; replyTo?: string; mentions?: string[] } = {},
): Promise<string> {
  // ...
  const extensions: Record<string, unknown> = {};
  if (opts.mentions && opts.mentions.length > 0) {
    extensions["space.roomy.extension.mentions.v0"] = {
      $type: "space.roomy.extension.mentions.v0",
      mentions: opts.mentions,
    };
  }
  // ... merge with attachments extension if present
}
```

For the inline-with-attachments path in `ChatInputArea.svelte`, add the mentions
extension alongside the attachments extension:

```ts
const extensions: Record<string, unknown> = {
  "space.roomy.extension.attachments.v0": { attachments },
};
if (mentions.length > 0) {
  extensions["space.roomy.extension.mentions.v0"] = {
    $type: "space.roomy.extension.mentions.v0",
    mentions,
  };
}
const event = { /* ... */ extensions };
```

### `editMessage`

`editMessage` in `mutations/message.ts` should also populate mentions, since editing
a message can add or remove mentions. The same `extractMentionDids` call happens
before `editMessage` is called. `editMessage` gains the same optional `mentions`
param and populates `MessageExtensionUpdateMap` (which now includes the mentions
key).

## Appserver — threading mentions through the pipeline

### `toAppliedEvent.ts`

`extractDetails` for `createMessage` / `editMessage` already reads
`authorOverride` and `timestampOverride` from `event.extensions`. Add `mentions`:

```ts
const mentionsExt = extensions?.[
  "space.roomy.extension.mentions.v0"
] as { mentions?: unknown } | undefined;
const mentions = Array.isArray(mentionsExt?.mentions)
  ? mentionsExt!.mentions.filter((d): d is string => typeof d === "string")
  : undefined;
```

Add `mentions` to the `base` object returned for `createMessage` (not `editMessage` —
push only fires on `createMessage`):

```ts
const base = {
  authorDid: authorOverride?.did,
  timestamp: /* ... */,
  replyTo: undefined,
  mentions, // ← new
};
```

### `PushJob` type

Add `mentions` to `PushJob` in `src/push/types.ts`:

```ts
export interface PushJob {
  spaceId: string;
  roomId: string;
  messageId: string;
  authorDid: UserDid;
  timestamp: number;
  /** DIDs mentioned in the message body (from the mentions extension). */
  mentions?: string[];
}
```

### `StreamManager.ts`

The push job construction already reads `e.details?.authorDid`. Add `mentions`:

```ts
pokePushDispatcher(
  createMessageEvents.map((e) => ({
    spaceId: streamDid,
    roomId: e.roomId!,
    messageId: e.id,
    authorDid: (e.details?.authorDid ?? e.user) as UserDid,
    timestamp: decodeTime(e.id),
    mentions: e.details?.mentions as string[] | undefined,
  })),
);
```

### `evaluatePush` — mention routing

In `src/push/evaluate.ts`, the current level routing:

```ts
if (level === "silent" || level === "quiet") {
  // quiet has no mentions path yet (Phase 3) → behaves like silent.
  continue;
}
```

Becomes:

```ts
if (level === "silent") continue;

const mentioned = job.mentions?.includes(did) ?? false;

if (level === "quiet") {
  if (!mentioned) continue;
  // Fall through to immediate message push (same as busy).
}
```

For `engaged`, the current code always takes the digest path. Add the mention
short-circuit before the participation gate:

```ts
if (level === "engaged") {
  if (mentioned) {
    // Mentioned → immediate message push, bypassing the digest path.
    // (Same payload shape as busy.)
  } else {
    // Digest path (existing logic).
  }
}
```

The immediate push for quiet/engaged-mentioned uses the same `message` payload as
busy (type: "message", count: 1, roomName, authorName, messageContent, icon). This
is correct — a mention is a single message that warrants immediate notification,
regardless of the user's digest batching.

**Important:** the mention immediate push and the engaged digest are **mutually
exclusive per recipient per message**. If a recipient is mentioned, they get an
immediate push for this message and do NOT get a digest entry for it. If they are
not mentioned, the digest path applies as before. This is enforced by the
if/else structure — the digest path is in the `else` branch.

### Refactoring the immediate push

The busy and mention immediate pushes build the same payload. Extract a helper to
avoid duplication:

```ts
function buildMessagePayload(
  job: PushJob,
  facts: MessageFacts,
  icon: string | undefined,
): PushPayload {
  const payload: PushPayload = {
    type: "message",
    spaceId: job.spaceId,
    roomId: job.roomId,
    messageId: job.messageId,
    count: 1,
    ...(facts.roomName != null ? { roomName: facts.roomName } : {}),
    ...(facts.authorName != null ? { authorName: facts.authorName } : {}),
    ...(facts.messageContent != null ? { messageContent: facts.messageContent } : {}),
  };
  if (icon) payload.icon = icon;
  return payload;
}
```

The level routing becomes:

```ts
for (const did of candidateDids) {
  if (did === authorDid) continue;
  const level = await resolveLevel(db, did, spaceId);
  if (level === "silent") continue;

  const access = await roomAccess(db, roomId, did);
  if (!access.canRead) continue;

  const subs = await selectSubscriptions(db, did);
  if (subs.length === 0) continue;

  const mentioned = job.mentions?.includes(did) ?? false;

  if (level === "busy" || (level === "quiet" && mentioned) || (level === "engaged" && mentioned)) {
    deliveries.push({ userDid: did, payload: buildMessagePayload(job, facts, icon) });
    continue;
  }

  if (level === "quiet") continue; // not mentioned → silent

  // level === "engaged", not mentioned → digest path (existing logic)
  if (!(await hasUserParticipatedInSpace(db, did, spaceId, roomId))) continue;
  const outcome = await upsertNotificationState(db, did, roomId, timestamp, messageId);
  if (!outcome.fireNow) continue;
  const digestPayload: PushPayload = { /* ... existing ... */ };
  if (icon) digestPayload.icon = icon;
  deliveries.push({ userDid: did, payload: digestPayload });
}
```

## Payload considerations

The existing `PushPayload` already carries `messageContent` (truncated plain text).
For mention pushes, the payload is identical to a busy push — the recipient sees
"<author> in <room>" with the message preview. No special "you were mentioned"
marker is added to the payload in this phase; the service worker shows the same
notification shape. A future enhancement could add a `mentioned: true` flag to the
payload so the service worker renders a different visual treatment (e.g. accent
border), but that is polish, not required for correctness.

## Tests

### SDK schema test

Add to the SDK's existing test suite (`packages/sdk`):
- Validate that a `createMessage` event with the `mentions` extension decodes
  successfully.
- Validate that a non-array `mentions` value or a non-DID string is rejected.

### Extraction helper test

New file: `packages/app-lite/src/lib/tiptap/mentions.test.ts` (if app-lite has a test
runner; otherwise, a manual test function). Since app-lite does not yet have its own
test suite (per AGENTS.md), this can be a simple assertion function run during
development, or deferred until app-lite has test infrastructure. The extraction
logic is simple enough (walk doc tree, collect `userMention` node attrs) that the
risk is low.

### `evaluate.test.ts` — mention routing tests

Add test cases to the existing `packages/appserver/src/push/evaluate.test.ts`:

1. **Quiet + mentioned → immediate push.** Seed a quiet user, send a message that
   mentions them, assert a `message` delivery.
2. **Quiet + not mentioned → no push.** Seed a quiet user, send a message without
   mentioning them, assert no delivery.
3. **Engaged + mentioned → immediate push (not digest).** Seed an engaged user
   with participation, send a message that mentions them, assert a `message`
   delivery (not `digest`). Assert no `notification_state` row was created.
4. **Engaged + mentioned, below digest threshold → immediate push fires.** Even
   with 0 prior unseen messages, a mention fires immediately.
5. **Engaged + not mentioned → digest path (unchanged).** Regression test: the
   existing digest behaviour is preserved when no mention is present.
6. **Busy + mentioned → immediate push (unchanged).** Mention doesn't change busy
   behaviour; regression test.
7. **Silent + mentioned → no push.** Mention doesn't override silent.
8. **Author mentioned → no self-push.** If the author mentions themselves, they
   are still excluded (the `did === authorDid` check runs first).
9. **Empty mentions array → no mention routing.** `mentions: []` behaves like
   `mentions: undefined` — no one is mentioned.

## Files to add / modify

**SDK (`packages/sdk`)**
- `src/schema/extensions/message.ts` — add `Mentions` type, add to `messageExtension`
  union.
- `src/schema/index.ts` — re-export if needed (check existing export pattern).
- `src/operations/message.ts` — add `mentions` to `CreateMessageOptions`, populate
  the extension in `createMessage()` (mirror the `attachments` pattern).

**app-lite (`packages/app-lite`)**
- `src/lib/tiptap/mentions.ts` (new) — `extractMentionDids(editor)` helper.
- `src/lib/components/chat/ChatInput.svelte` — pass mentions to `onEnter`.
- `src/lib/components/chat/ChatInputArea.svelte` — pass mentions to both send paths.
- `src/lib/mutations/message.ts` — `sendMessage` and `editMessage` accept optional
  `mentions` and populate the extension.

**appserver (`packages/appserver`)**
- `src/materialization/toAppliedEvent.ts` — extract `mentions` from
  `event.extensions` into `AppliedEvent.details`.
- `src/push/types.ts` — add `mentions?: string[]` to `PushJob`.
- `src/streams/StreamManager.ts` — pass `mentions` from `AppliedEvent.details` to
  `PushJob`.
- `src/push/evaluate.ts` — add `mentioned` check, route quiet/engaged-mentioned to
  immediate push, extract `buildMessagePayload` helper.
- `src/push/evaluate.test.ts` — add mention routing test cases (9 new tests).

**No changes needed:**
- `src/push/dispatcher.ts` — already calls `evaluatePush` and delivers results; no
  change for mentions.
- `src/push/level.ts` — level type and resolution unchanged.
- `src/queries/notificationState.ts` — digest state unchanged (mentions bypass it).
- `src/queries/pushPreferences.ts` — preference resolution unchanged.
- Readstate DB schema — no new tables or migrations.
- Lexicon JSON files — extensions have no lexicon JSON (same as existing extensions).
- Service worker — payload shape unchanged for mention pushes.

## Phasing

This is a single-phase change — the extension, the extraction, and the push routing
are tightly coupled and small enough to land together. The order of implementation:

1. SDK schema (`Mentions` extension + union + `createMessage` options).
2. appserver pipeline (`toAppliedEvent` → `PushJob` → `evaluatePush` + tests).
3. app-lite extraction + send path.

Steps 1 and 2 can be done in parallel with step 3 since the extension schema and the
push routing don't depend on the frontend extraction — the push evaluator just needs
`PushJob.mentions` to be populated, which `toAppliedEvent` handles from the raw event.

## Open questions / decision points

1. **Should `editMessage` populate mentions?** Yes — editing can add/remove
   mentions, and the push evaluator only fires on `createMessage` (not edit), so
   there's no push implication. But the extension should be kept in sync for future
   use cases (e.g. "who was mentioned in this message?" queries). **Decision: yes,
   populate on edit.**

2. **Should mention pushes include a `mentioned: true` flag in the payload?** Not
   for correctness — the notification shows the same "<author> in <room>" shape.
   A visual distinction (accent border, "mentioned you" text) is a nice-to-have for
   the service worker but is polish, not required. **Decision: defer to Phase 4.**

3. **Should we deduplicate mentions across the `mentions` extension and the markdown
   link path?** No — the extension is the canonical source. The markdown
   `[@label](/user/{did})` link is for rendering only. The push evaluator reads
   exclusively from `PushJob.mentions`, which comes from the extension. **Decision:
   extension is canonical; markdown is rendering only.**

4. **What about mentions of users who aren't space members?** The recipient
   enumeration (`edges ... label in ('member','admin')`) already excludes
   non-members. A mention of a non-member is stored in the extension (for future use)
   but produces no push — the non-member is never in the recipient set. This is
   correct and requires no special handling. **Decision: no special handling.**

5. **Should the `mentions` array be ordered?** No — order is not significant. The
   extraction helper returns a de-duplicated set as an array; the order is
   document-order (the order TipTap's `descendants` walks the tree). The push
   evaluator does `includes(did)` which is order-independent. **Decision: no ordering
   requirement.**
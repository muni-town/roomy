# app-lite Chat Parity Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or superpowers:subagent-driven-development) to implement this plan task-by-task.

**Goal:** Bring `packages/app-lite`'s chat message list and chat input area to full visual + feature parity with `packages/app`, by wiring the already-extracted `@roomy/design` shells to app-lite's TanStack Query / `sendEvents` data layer.

**Architecture:** The speedrun's Phase 3 left `app-lite/src/routes/[space]/[room]/+page.svelte` with inline barebones markup. This plan replaces that with a proper component tree under `app-lite/src/lib/components/chat/` — wrapper components that consume `@roomy/design` presentational shells (`MessageBubble`, `ChatInputShell`, `ReactionBar`, `ToolbarShell`, `MessageDrawer`, `ChatMessageSkeleton`) and wire data via app-lite query factories and `sendEvents`-based mutations. Real-time updates already arrive through the SDK `SyncRouter` → `createTanstackCacheAdapter`; no per-component diff wiring is needed.

**Tech Stack:** SvelteKit 2 + Svelte 5 runes, `@tanstack/svelte-query` v6, `@roomy/design` components, `@roomy-space/sdk` (transport/cache/sync), TipTap (`@tiptap/*`) for the composer, `virtua` for list virtualization.

**Reference source (port from):** `packages/app/src/lib/components/content/thread/` — `ChatArea.svelte`, `ChatInputArea.svelte`, `ChatInput.svelte`, `TimelineView.svelte`, and `message/{ChatMessage,MessageContext,MessageContextReply,MessageReactions,MessageToolbar,MobileMessageDrawer}.svelte`, plus `packages/app/src/lib/tiptap/`.

---

## Known Constraints & Decisions

1. **Message DTO is flatter than app's.** The appserver `getMessages` DTO (`packages/sdk/src/schemas/queries/_message.ts`) is: `{ id, content, authorDid, authorName, authorAvatar, timestamp, replyTo: string|null, forwardedFrom, reactions: {emoji,dids[]}[], media: {url,type,alt}[], tags: string[] }`. Notably it has **no `authorHandle`**, **no per-reaction id**, `replyTo` is a single string (not an array), and `media` is **already URL-resolved** (display is easy; upload is the work).

2. **Reaction removal is backend-blocked.** `removeReaction.v0` requires a `reactionId`, but the DTO collapses reactions to `{emoji, dids[]}` with no id. The appserver-side fix (surface a viewer-scoped `myReactionId`) is **out of scope for this plan** — it is tracked in `packages/appserver/docs/plans/procedure-backlog.md` ("Message DTO: surface viewer reaction identity") and will land with the next appserver wave. Until then app-lite ships reaction *add* only; **Task 8** wires *toggle-off* and is gated on that backlog item.

3. **Verification is type-check, not unit tests.** This codebase verifies frontend phases with `pnpm --filter app-lite check` (svelte-check, 0 errors) plus manual smoke testing — matching how migration-plan Phases 1–5 were verified. There is no component unit-test harness; do not invent one. Each task's gate is `pnpm --filter app-lite check` passing with 0 errors.

4. **Branch:** work continues on the existing `app-lite` branch. Commit after each task.

5. **`@roomy/design` changes:** Tasks that touch the design package must also pass `pnpm --filter @roomy/design check`.

---

## Phase 1 — Composer foundation

### ~~Task 1: Add TipTap deps + port the chat editor setup into app-lite~~ ✅

**Files:**
- Modify: `packages/app-lite/package.json` (dependencies)
- Create: `packages/app-lite/src/lib/tiptap/editor.ts`
- Create: `packages/app-lite/src/lib/tiptap/RichTextLink.ts`

**Steps:**

1. Add to `packages/app-lite/package.json` `dependencies` the TipTap packages used by the chat composer (already present in `@roomy/design` — copy the exact versions from `packages/design/package.json`): `@tiptap/core`, `@tiptap/starter-kit`, `@tiptap/extension-placeholder`, `@tiptap/extension-link`, `@tiptap/suggestion`, `tiptap-markdown`. Also `@tiptap/pm`.
2. Copy `packages/app/src/lib/tiptap/RichTextLink.ts` verbatim to `packages/app-lite/src/lib/tiptap/RichTextLink.ts`.
3. Copy `packages/app/src/lib/tiptap/editor.ts` to `packages/app-lite/src/lib/tiptap/editor.ts`. Read it first — it exports `initUserMention`, `initSpaceContextMention`, `initKeyboardShortcutHandler`, and the `Item` type. Adjust any `$lib/` imports to app-lite-relative paths. If it pulls in app-only utilities (icons, components for the suggestion popup), either copy those into `app-lite/src/lib/tiptap/` or substitute `@roomy/design` equivalents.
4. Run `pnpm install` at the repo root to materialize the new deps.

**Verification:** `pnpm --filter app-lite check` — 0 errors. (`editor.ts` may report unused exports until Task 2 consumes them; that is acceptable for this task only.)

**Commit:** `feat(app-lite): add tiptap chat editor setup`

---

### ~~Task 2: ChatInput composer component~~ ✅

**Files:**
- Create: `packages/app-lite/src/lib/components/chat/ChatInput.svelte`

**Approach:** Port `packages/app/src/lib/components/content/thread/ChatInput.svelte` (read in full). It is a small TipTap `Editor` instance with `StarterKit`, `Placeholder`, `RichTextLink`, `initKeyboardShortcutHandler({ onEnter })`, `Markdown`, and optional `initUserMention` / `initSpaceContextMention`. It exposes module-level `setInputFocus()` and `clearInput()`.

**Steps:**

1. Copy the app component. Keep the `module` block exporting `setInputFocus` / `clearInput`.
2. Replace `@foxui/core`'s `cn` import with `@roomy/design/utils`'s `cn` (verify it is exported there).
3. Update the tiptap imports to `$lib/tiptap/editor` and `$lib/tiptap/RichTextLink` (the app-lite copies from Task 1).
4. Props stay: `content` (bindable), `users?`, `context?`, `onEnter`, `placeholder?`, `setFocus?`, `disabled?`, `processImageFile?`.

**Verification:** `pnpm --filter app-lite check` — 0 errors.

**Commit:** `feat(app-lite): add ChatInput tiptap composer`

---

### ~~Task 3: Messaging-state machine~~ ✅

**Files:**
- Create: `packages/app-lite/src/lib/components/chat/messaging-state.svelte.ts`

**Approach:** Port the `MessagingStateManager` class + the `Normal | Replying | Threading | Commenting` union from the `module` block of `packages/app/src/lib/components/content/thread/TimelineView.svelte`.

**Steps:**

1. Extract everything in TimelineView's `<script module>` into this new file: the four state types, `MessagingState`, `MessagingStateManager`, and `export const messagingState = new MessagingStateManager()`.
2. Replace the `Message` type import with app-lite's: `import type { Message } from "$lib/queries/messages"`.
3. `renderMarkdownPlaintext` stays imported from `@roomy/design/utils`.
4. `setInputFocus` is imported from `./ChatInput.svelte`.
5. **Drop the `Commenting` state and `Comment` type** — commenting/page-editing is out of scope for the migration (the migration plan excludes page editing). Keep `Normal | Replying | Threading`. Remove `setCommenting`.

**Verification:** `pnpm --filter app-lite check` — 0 errors.

**Commit:** `feat(app-lite): add messaging-state machine`

---

### ~~Task 4: Message edit/delete mutations~~ ✅

**Files:**
- Modify: `packages/app-lite/src/lib/mutations/message.ts`

**Approach:** `sendMessage` already exists. Add `editMessage` and `deleteMessage`, both via `sendEvents`. Use app's `ChatMessage.svelte` `saveEditedMessage` as the reference for the `editMessage.v0` event shape.

**Steps:**

1. Add `editMessage(spaceId, roomId, messageId, body, opts?)` building a `space.roomy.message.editMessage.v0` event: `{ id: newUlid(), room: roomId, $type: "space.roomy.message.editMessage.v0", messageId, body: { mimeType: opts?.mimeType ?? "text/markdown", data: toBytes(new TextEncoder().encode(body)) } }`.
2. Add `deleteMessage(spaceId, roomId, messageId)`. Confirm the delete event `$type` by grepping the SDK schema events directory (`packages/sdk/src/schema*/events/message*`) for a delete/tombstone message event. If none exists, STOP and flag — deletion may need an SDK/appserver event type first.
3. Both call `sendEvents(spaceId, [event])` and return the new event id.

**Verification:** `pnpm --filter app-lite check` — 0 errors.

**Commit:** `feat(app-lite): add edit/delete message mutations`

---

### ~~Task 5: ChatInputArea wrapper~~ ✅

**Files:**
- Create: `packages/app-lite/src/lib/components/chat/ChatInputArea.svelte`
- Possibly create: `packages/app-lite/src/lib/mutations/upload.ts` (blob upload helper)

**Approach:** Port `packages/app/src/lib/components/content/thread/ChatInputArea.svelte`. It wires `ChatInputShell` (design) + `ChatInput` + `messagingState` + send/upload/reply/thread handlers. Strip app-only coupling: replace `peer`/`getAppState` with app-lite's `px()` agent, `sendMessage`/`editMessage` mutations, and route params.

**Steps:**

1. Props: `{ spaceId: string; roomId: string; canWrite: boolean }` — passed from the room page.
2. Keep the `ChatInputShell` markup/snippets (`contextPreview`, `input`, `fullscreenDropper`). `FullscreenImageDropper` is in `@roomy/design/components/helper/`.
3. `shellMode` derives from `messagingState.current.kind` — but `ChatInputShellMode` includes `"commenting"`; since Task 3 dropped commenting, only `normal | replying | threading` occur.
4. **Media upload:** app uses `peer.uploadToPds`. app-lite must upload via the authenticated agent. Add `mutations/upload.ts` exporting `uploadBlob(file: File): Promise<string>` that calls the agent's blob upload (the `blob:*/*` OAuth scope is already in `config.ts`). Investigate the SDK / `@atproto/api` agent surface for the upload call and the `atblob://` URI it should yield — grep app's `peer.uploadToPds` implementation (`packages/app/src/lib/workers/`) for the exact shape. If upload cannot be done cleanly client-side, scope media upload OUT of this task, ship text+reply send, and create a follow-up issue.
5. `sendMessage` handler builds the `createMessage.v0` event with attachments (reply attachment via `space.roomy.attachment.reply.v0`; file attachments via `space.roomy.attachment.file.v0`) — mirror app's `ChatInputArea.sendMessage`, but call app-lite's `sendEvents` directly instead of `peer.sendEvent`.
6. `contextPreview` snippet renders the reply target — defer the actual `MessageContext` component to Task 6; for now render a placeholder `{#snippet contextPreview()}{/snippet}` and wire it in Task 6.

**Verification:** `pnpm --filter app-lite check` — 0 errors.

**Commit:** `feat(app-lite): add ChatInputArea wrapper`

---

## Phase 2 — Message rendering

### ~~Task 6: MessageContext + reply preview~~ ✅

**Files:**
- Create: `packages/app-lite/src/lib/components/chat/MessageContext.svelte`
- Create: `packages/app-lite/src/lib/components/chat/MessageContextReply.svelte`
- Modify: `packages/app-lite/src/lib/components/chat/ChatInputArea.svelte` (fill the `contextPreview` snippet)

**Approach:** Port `MessageContext.svelte` + `MessageContextReply.svelte`. Drop the `commenting` branch (out of scope). The reply preview resolves the target message via `createMessageQuery` (already exists in `lib/queries/message.ts`, cache-first).

**Steps:**

1. `MessageContextReply.svelte`: takes `replyToId: string` and `roomId: string`, calls `createMessageQuery(() => replyToId, () => roomId)`, renders author + truncated content. Use the existing reply-preview snippet in `[room]/+page.svelte` as a starting point but styled to match app.
2. `MessageContext.svelte`: union of `replying | threading`. `replying` → `MessageContextReply`. `threading` → renders `renderMarkdownPlaintext(selectedMessages[0]?.content)`. The `scrollToMessage` context key is set by `ChatArea` (Task 12) — read it via `getContext("scrollToMessage")`.
3. Wire `ChatInputArea`'s `contextPreview` snippet to render `<MessageContext>` from `messagingState`.

**Verification:** `pnpm --filter app-lite check` — 0 errors.

**Commit:** `feat(app-lite): add reply/thread message context`

---

### ~~Task 7: MessageReactions wrapper (add-only)~~ ✅

**Files:**
- Create: `packages/app-lite/src/lib/components/chat/MessageReactions.svelte`

**Approach:** Wrap `@roomy/design`'s `ReactionBar.svelte`. **Mismatch:** `ReactionBar` expects `ReactionInfo[]` = `{reaction, userId, userName, reactionId}[]`, but app-lite's DTO reactions are `{emoji, dids[]}[]`. Map between them.

**Steps:**

1. Props: `{ spaceId, roomId, messageId, reactions: {emoji,dids[]}[], currentUserDid? }`.
2. Flatten DTO reactions into `ReactionInfo[]`: for each `{emoji, dids}`, emit one `ReactionInfo` per did — `{ reaction: emoji, userId: did, userName: did, reactionId: "" }`. (`userName` resolution to display name is a nice-to-have; the DTO lacks it. Leave as did for now.)
3. `onToggleReaction(emoji)`: if `currentUserDid` is NOT in that emoji's `dids` → `addReaction(spaceId, roomId, messageId, emoji)`. If it IS already present, removal needs a `reactionId` the DTO does not yet carry — leave the remove branch unhandled (early return) so the add path is fully functional. Task 8 fills the remove branch once the appserver change lands. Keep this branch a clean early `return`, not a stub.

**Verification:** `pnpm --filter app-lite check` — 0 errors.

**Commit:** `feat(app-lite): add MessageReactions (add-only)`

---

### Task 8: Wire reaction removal — GATED on appserver backlog item

**Status:** Blocked. Do **not** start until the appserver item "Message DTO:
surface viewer reaction identity" (`packages/appserver/docs/plans/procedure-backlog.md`)
has landed and the SDK `_message.ts` `Reaction` type carries `myReactionId`.

**Files:**
- Modify: `packages/app-lite/src/lib/components/chat/MessageReactions.svelte`

**Approach:** This is now an app-lite-only wiring task. The appserver + SDK
schema change is owned by the appserver backlog. Once `myReactionId` is present
on each reaction in the DTO, fill the removal branch left open in Task 7.

**Steps:**

1. Confirm `schemas.queries.getMessages.Message.infer` reactions now include `myReactionId: string | null` (rebuild the SDK dist if not yet reflected).
2. In `MessageReactions.svelte`, complete `onToggleReaction`: when `currentUserDid` is in the emoji's `dids` and `myReactionId` is non-null, call `removeReaction(spaceId, roomId, myReactionId)`.
3. `#messageDiff` reuses the `Message` schema, so real-time reaction updates carry `myReactionId` with no extra wiring.

**Verification:** `pnpm --filter app-lite check` — 0 errors; manual: add then remove a reaction.

**Commit:** `feat(app-lite): wire reaction removal`

---

### ~~Task 9: MessageToolbar + MobileMessageDrawer wrappers~~ ✅

**Files:**
- Create: `packages/app-lite/src/lib/components/chat/MessageToolbar.svelte`
- Create: `packages/app-lite/src/lib/components/chat/MobileMessageDrawer.svelte`

**Approach:** Wrap `@roomy/design`'s `ToolbarShell.svelte` and `MessageDrawer.svelte`. Both take `canEditDelete` + callbacks `onToggleReaction`, `onEdit`, `onDelete`, `onStartThreading`, `onReply`.

**Steps:**

1. `MessageToolbar.svelte`: props `{ spaceId, roomId, message, canEditDelete, keepToolbarOpen (bindable), onStartEdit }`. Wire callbacks: `onToggleReaction` → `addReaction`/`removeReaction`; `onReply` → `messagingState.setReplyTo(message)`; `onStartThreading` → `messagingState.startThreading(message)`; `onEdit` → `onStartEdit(message.id)`; `onDelete` → `deleteMessage(...)` (guard behind a confirm).
2. `MobileMessageDrawer.svelte`: props `{ spaceId, roomId, message: Message | null, open (bindable), canEditDelete, onStartEdit }`. `visible = message !== null`. Same callback wiring.
3. `canEditDelete` = `message.authorDid === currentUserDid` (current DID from `auth.svelte.ts`) OR space-admin. A space-admin check may not be cheap in app-lite — if no admin signal is readily available, use authorship only and note it.

**Verification:** `pnpm --filter app-lite check` — 0 errors.

**Commit:** `feat(app-lite): add message toolbar + mobile drawer`

---

### ~~Task 10: Media embeds~~ ✅

**Files:**
- Create: `packages/app-lite/src/lib/components/chat/embeds/MediaEmbed.svelte`

**Approach:** app-lite's DTO `media` is `{ url, type, alt }[]` — **already URL-resolved**, so this is far simpler than app's `MediaEmbed` (which resolves CDN URLs and handles HLS). Render images directly; render `video/*` with a `<video controls>`; other types as a download link.

**Steps:**

1. Props: `{ media: { url, type, alt }[] }`.
2. `image/*` → `<img>` with `alt`, object-fit, max dimensions matching app's layout.
3. `video/*` → `<video controls preload="metadata">`.
4. Other → filename + download link.
5. Skip HLS / blurhash placeholders for now (DTO carries neither) — note as a possible follow-up.

**Verification:** `pnpm --filter app-lite check` — 0 errors.

**Commit:** `feat(app-lite): add media embeds`

---

### ~~Task 11: ChatMessage wrapper~~ ✅

**Files:**
- Create: `packages/app-lite/src/lib/components/chat/ChatMessage.svelte`

**Approach:** Port `packages/app/src/lib/components/content/thread/message/ChatMessage.svelte`. It wraps `@roomy/design`'s `MessageBubble`, filling snippets `replyContext`, `content`, `linkEmbeds`, `media`, `toolbar`, `reactions`, and wraps in a `bits-ui` `ContextMenu` for the mobile drawer trigger.

**Steps:**

1. Props: `{ spaceId, roomId, message: Message, currentUserDid, editingMessageId, onStartEdit, onCancelEdit, onOpenMobileMenu }`.
2. `content` snippet: if editing → render `ChatInput` with `onEnter` → `editMessage(...)`; else `{@html renderMarkdownSanitized(message.content)}` (`renderMarkdownSanitized` from `@roomy/design/utils`). The DTO has `tags: string[]` but no Discord-mention metadata map — skip `resolveDiscordMentions` (app's version needs `{snowflake,name,handle,roomId}` objects the DTO doesn't carry). Note this as a parity gap if Discord-bridged spaces matter.
3. `replyContext` snippet: if `message.replyTo` → `<MessageContext context={{kind:"replying", replyTo:{id: message.replyTo}}}/>`.
4. `reactions` snippet → `<MessageReactions>`; `toolbar` snippet → `<MessageToolbar>`; `media` snippet → `<MediaEmbed media={message.media}/>`.
5. `linkEmbeds`: app's link embeds are effectively disabled (`linkUrls` is an empty array in app's ChatMessage). Skip — render nothing.
6. `mergeWithPrevious`: this is computed by the *list* (Task 12), passed in as a prop on `message` or separately. Add `mergeWithPrevious?: boolean` prop.
7. `isBridged` = `message.authorDid.startsWith("did:discord:")`.
8. Avatar: `MessageBubble` takes `authorAvatarUrl` / `avatarSrc`. The DTO's `authorAvatar` may be an `atblob://` URL — if so it needs CDN rewriting. Check whether app-lite has a `cdnImageUrl` helper; if not, port the minimal version from `packages/app/src/lib/utils.svelte.ts`. `authorHandle` is absent from the DTO — pass `undefined`.
9. `showToolbar` = `(!isEditing && hovered && !threading) || keepToolbarOpen`. Track `hovered` on the wrapper div; track `keepToolbarOpen` bindable from `MessageToolbar`.
10. Threading selection: when `messagingState.current.kind === "threading"`, wrap in a `bits-ui` `Checkbox` and toggle `messagingState.toggleMessageSelection(message)` — port from app.

**Verification:** `pnpm --filter app-lite check` — 0 errors.

**Commit:** `feat(app-lite): add ChatMessage wrapper`

---

## Phase 3 — List & threading

### ~~Task 12: ChatArea — virtualized list + lazy load~~ ✅

**Files:**
- Create: `packages/app-lite/src/lib/components/chat/ChatArea.svelte`
- Modify: `packages/app-lite/package.json` (add `virtua`)

**Approach:** Port `packages/app/src/lib/components/content/thread/ChatArea.svelte`'s structure (virtua `Virtualizer`, `bits-ui` `ScrollArea`, jump-to-present button, skeleton). Replace app's LiveQuery + `peer.lazyLoadRoom` with: (a) `createMessagesQuery(roomId)` for the live window, and (b) cursor-based older-message fetching via `getMessages` with `cursor` = oldest loaded message id.

**Steps:**

1. Add `virtua` to `app-lite/package.json` (copy version from `packages/app/package.json`). `pnpm install`.
2. Props: `{ spaceId, roomId }`.
3. Data: `createMessagesQuery(() => roomId)` returns newest-first `Message[]`. Reverse to chronological; compute `mergeWithPrevious` per message (same author, no `replyTo`, within 5 min) — port app's `timeline` derivation.
4. **Lazy load:** when the user scrolls near the top, fetch older messages: `agentQuery(px(), "space.roomy.room.getMessages", { roomId, limit, cursor: oldestLoadedId })`. The handler returns older rows (`e.id < cursor`) plus a `cursor` for the next page. Merge results into the TanStack cache for the `getMessages` query key (prepend, dedupe by id), so the virtualized list and SyncRouter diffs stay consistent. Track `hasMore` from whether a full batch returned (handler logic at `selectMessages.ts:356`).
5. Render the chronological list through `<Virtualizer>` with `getKey={(m) => m.id}`, `shift` enabled during prepend, `overscan={5}`.
6. Scroll management: auto-scroll to bottom on initial load and on new messages while already at bottom; `Jump to present` button when not at bottom. Port from app.
7. `setContext("scrollToMessage", scrollToMessage)` so `MessageContext` reply previews can scroll to a target.
8. Loading state → `ChatMessageSkeleton` (design); error state → an inline error with retry.
9. Render each item as `<ChatMessage spaceId roomId message currentUserDid mergeWithPrevious editingMessageId onStartEdit onCancelEdit onOpenMobileMenu/>`. Lift `editingMessageId` and the mobile-drawer state into `ChatArea`; render one `<MobileMessageDrawer>` outside the virtualizer.

**Verification:** `pnpm --filter app-lite check` — 0 errors.

**Commit:** `feat(app-lite): add virtualized ChatArea with lazy load`

---

### ~~Task 13: Threading flow~~ ✅

**Files:**
- Create: `packages/app-lite/src/lib/mutations/thread.ts`
- Verify integration in `ChatInputArea.svelte` (threading-mode `onCreateThread`)

**Approach:** Port app's `ChatInputArea.handleCreateThread`. A thread is: `createRoom(kind: "space.roomy.thread")` + a `space.roomy.link.createRoomLink.v0` event (with `isCreationLink: true`) + one `space.roomy.message.moveMessages.v0` event per selected message — all batched.

**Steps:**

1. `mutations/thread.ts` exports `createThread({ spaceId, parentRoomId, threadName, messageIds }): Promise<string>` — builds the batch and returns the new thread room id. Confirm `createRoomLink.v0` and `moveMessages.v0` `$type`s and field names against the SDK schema events directory.
2. `ChatInputArea`'s `onCreateThread` (threading mode) calls `createThread`, then navigates to `/[space]/[threadId]?parent=[parentRoomId]` and resets `messagingState` to normal.
3. `MessageToolbar` / `MobileMessageDrawer` `onStartThreading` and `ChatMessage`'s threading-checkbox selection (Task 9 / Task 11) already drive `messagingState`.

**Verification:** `pnpm --filter app-lite check` — 0 errors.

**Commit:** `feat(app-lite): add threading flow`

---

### ~~Task 14: Wire the room page~~ ✅

**Files:**
- Modify: `packages/app-lite/src/routes/[space]/[room]/+page.svelte`

**Approach:** Replace the inline `messageBubble` / `replyPreview` snippets and the plain `Input`+`Button` composer with the new component tree.

**Steps:**

1. Keep the existing topic-subscription, `setActiveRoom`, `updateSeen`, and navbar `$effect`s, and `createRoomMetadataQuery`.
2. Replace the messages `<div>` + input `<div>` with:
   ```svelte
   <div class="h-full flex flex-col bg-white dark:bg-base-950">
     <ChatArea {spaceId} {roomId} />
     <ChatInputArea {spaceId} {roomId} canWrite={roomQuery.data?.canWrite ?? false} />
   </div>
   ```
3. Delete the now-unused inline snippets, the local `draft`/`sending`/`sendError` state, `onSend`, `onKeydown`, and the direct `sendMessage`/`createMessagesQuery`/`createMessageQuery` imports that moved into the new components.
4. Keep `roomNavbar` snippet as-is.

**Verification:** `pnpm --filter app-lite check` — 0 errors.

**Commit:** `feat(app-lite): wire chat components into room page`

---

## Phase 4 — Verify

### ~~Task 15: Full verification + parity review~~ ✅

**Steps:**

1. `pnpm --filter app-lite check` — 0 errors.
2. `pnpm --filter @roomy/design check` — 0 errors (in case design was touched).
3. `pnpm --filter app-lite build` — succeeds.
4. Manual smoke test against a running appserver: open a room, verify — message bubbles render with avatars + markdown + grouping + formatted timestamps; send a message; reply to a message; add a reaction; toggle a reaction off (requires Task 8); edit/delete own message; hover toolbar + mobile drawer; create a thread; scroll up to lazy-load older messages; jump-to-present.
5. Write down any remaining parity gaps (e.g. Discord-mention resolution, link embeds, HLS video, reaction author display names) as follow-up issues.

**Commit:** `chore(app-lite): chat parity verification`

---

## Parity Gaps Deliberately Out of Scope

- **Page/document editing** — excluded by the migration plan.
- **Commenting** (`commenting` messaging state) — tied to page editing.
- **Discord-mention resolution in message content** — the DTO doesn't carry the `{snowflake,name,handle,roomId}` tag map app uses.
- **Link preview embeds** — already effectively disabled in app (`linkUrls` is empty).
- **HLS video / blurhash placeholders** — DTO carries neither.
- **Reaction author display names** — DTO reactions carry `dids` only, not names.

Track these as follow-up issues if any become required.

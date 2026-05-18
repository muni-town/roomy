# app-lite: New Thin-Client Frontend

**Date:** 2026-05-18
**Status:** Approved (Phase 0 only) — Phases 1–6 remain draft
**Related:** `appserver-architecture.md`, `xrpc-interface-spec.md`, `livequery-inventory.md`
**Reference implementation:** `packages/playground`

---

## Context

Rather than migrating the existing `packages/app` (which is tightly coupled to the LiveQuery/SQLite WASM/peer worker architecture), we create a new `packages/app-lite` — a greenfield SvelteKit frontend built from the appserver XRPC interface from day one. This avoids path dependence in the frontend architecture and eliminates migration complexity.

The existing `packages/playground` already proves the full auth → XRPC query → WS sync → reactive render lifecycle. `app-lite` is that pattern, productionised.

The `@roomy/design` package provides 26 shared UI components. Before building `app-lite`, we do a refactoring pass on `packages/app` to extract more presentational components into `@roomy/design`, so `app-lite` can consume them directly.

**Deployment:** Separate subdomain from the existing app. Full feature parity with `packages/app` (except page editing, which is excluded) before launching — but development is staged.

### What `app-lite` replaces

The entire `packages/app` runtime data path:

| Removed | No longer needed because |
|---------|--------------------------|
| `src/lib/workers/sqlite/` | Appserver owns SQLite |
| `src/lib/workers/peer/` | No client-side materialisation |
| `LiveQuery` + `sqlTemplate` | Replaced by TanStack Query |
| `AppState` / `SpaceState` classes | Replaced by direct TanStack Query + Svelte runes |
| Client-side join logic | Server returns denormalised results |
| `comp_last_read` local updates | `updateSeen` XRPC procedure |

### What `app-lite` keeps

- The same SvelteKit + Tailwind CSS stack
- UI components from `@roomy/design` (including newly extracted ones)
- OAuth flow via `@roomy-space/sdk/browser` (init, login, logout)
- The same visual design language (Tailwind theme, fonts, CSS)

---

## Architecture

```
Browser (app-lite)
  Svelte 5 runes + TanStack Query
    ↓ HTTP (via PDS proxy) + single multiplexed WebSocket
  Appserver (packages/appserver)
    ↓ (also via appserver for writes)
    sendEvents XRPC procedure (batch)
    ↓
  Leaf Server  ←→  AT Protocol PDS
```

### Data flow

1. **Auth:** `@roomy-space/sdk/browser` → `initSession` / `login` → `Agent` with PDS proxy
2. **Reads:** `agentQuery(px(), nsid, params)` → PDS proxy → appserver → JSON response → TanStack cache
3. **Writes:** `agentProcedure(px(), "space.roomy.space.sendEvents", { spaceId, events })` → PDS proxy → appserver → Leaf
4. **Real-time:** `SyncConnection` → ticket auth → CBOR frames → `#messageDiff` (setQueryData) + `#invalidate` (invalidateQueries)
5. **Read tracking:** `agentProcedure(px(), "space.roomy.room.updateSeen", { roomId })` on room open and on each `#messageDiff` while viewing

---

## Phase 0: Component Refactoring

Before writing any `app-lite` code, extract presentational components from `packages/app` into `@roomy/design`. This reduces the surface area `app-lite` needs to rebuild from scratch.

### Component audit

Components in `packages/app/src/lib/components/` fall into three categories:

#### A. Already in `@roomy/design` (26 components)

Button, Input, Alert, Badge, Popover, ToggleGroup, ScrollArea, Tooltip, Drawer, UserTypeahead, ThemeToggle, StateSuspense, LoadingSpinner, LoadingLine, etc. Nothing to do — `app-lite` imports these directly.

#### B. Pure presentational — extract to `@roomy/design` (18 components)

Audit assumption: zero `$lib/` imports. In practice the audit missed several `.ts` siblings and one cross-package type import — see status column.

| Component | Lines | Notes | Status |
|-----------|-------|-------|--------|
| `richtext/RichTextEditor.svelte` | 546 | TipTap editor — large, self-contained | ✅ Moved (whole `richtext/` folder, incl. `.ts` siblings: `RichTextLink.ts`, `index.ts`, `code.css`, `image-upload/ImageUploadNode.ts`, `slash-menu/index.ts`). `Comment` type extracted from `TimelineView.svelte` into new `design/components/richtext/types.ts`; `TimelineView` re-exports it. |
| `richtext/RichTextEditorMenu.svelte` | 238 | Editor toolbar | ✅ Moved (with folder) |
| `richtext/RichTextEditorLinkMenu.svelte` | 122 | Link insertion popover | ✅ Moved (with folder) |
| `richtext/Select.svelte` | 89 | Generic select dropdown | ✅ Moved (with folder) |
| `richtext/Icon.svelte` | 135 | Icon wrapper | ✅ Moved (with folder) |
| `richtext/image-upload/ImageUploadComponent.svelte` | 59 | Image upload with preview | ✅ Moved (with folder) |
| `richtext/slash-menu/SuggestionSelect.svelte` | 92 | Slash command picker | ✅ Moved (with folder) |
| `user/UserProfile.svelte` | 92 | User profile display | ✅ Moved |
| `user/AvatarGroup.svelte` | 60 | Stacked avatar row | ✅ Moved |
| `user/ThemeSettings.svelte` | 185 | Theme picker | ✅ Moved |
| `layout/MainLayout.svelte` | 72 | Sidebar + main panel shell | ⏳ Deferred. Has `<ThinSidebar />` fallback for unfilled `serverBar?: Snippet`; every current call site relies on the fallback. Also uses `$app/navigation`. Needs decision: drop fallback + update ~9 routes, or leave in app. |
| `layout/MainPanel.svelte` | 53 | Main content area | ⏳ Deferred. Uses `$app/navigation` / `$env/static/public`; design package has no SvelteKit setup. |
| `layout/ToggleTabs.svelte` | 73 | Tab switcher | ⏳ Deferred (same SvelteKit dep). |
| `content/thread/boardView/BoardView.svelte` | 30 | Board grid layout | ⏳ Deferred. Imports `BoardViewItem` (category C with `$lib`). Move BoardViewItem first. |
| `content/thread/message/ChatMessageSkeleton.svelte` | 63 | Loading skeleton | ✅ Moved |
| `content/thread/message/embeds/MediaEmbed.svelte` | 30 | Media embed wrapper | ⏳ Deferred. Imports `ImageUrlEmbed` (`$lib/utils.svelte`) and `VideoUrlEmbed` (`$lib/actions/hls`). Move siblings first. |
| `modals/Error.svelte` | 51 | Error alert | ✅ Moved |
| `modals/WaitingForJoinModal.svelte` | 17 | Join pending state | ✅ Moved (was dead code — no import sites) |

Added to `@roomy/design` `dependencies`: `@iconify/svelte`, `@tiptap/core`, `@tiptap/pm`, `@tiptap/starter-kit`, `@tiptap/extension-{bubble-menu,image,link,placeholder,typography,underline}`, `@tiptap/suggestion`, `svelte-tiptap`, `tippy.js`.

#### C. Coupled to legacy data layer — refactor to accept props

These components import from `$lib/workers`, `$lib/queries`, `$lib/mutations`, or `$lib/utils/liveQuery.svelte`. They cannot move to `@roomy/design` as-is. The refactoring strategy is to **split them**: extract the presentational shell (accepts props, renders DOM) into `@roomy/design`, and keep the data-wiring wrapper in `packages/app`.

| Component | Legacy coupling | Refactoring strategy | Status |
|-----------|----------------|---------------------|--------|
| `sidebars/SidebarItem.svelte` | `$lib/config`, `$lib/queries`, `$lib/utils.svelte`, `$lib/services/atprotoFeedService` | Extract `SidebarItemShell` (name, unreadCount, active state, click handler) to design; keep data-fetch wrapper in app | ✅ Shell extracted. Props: `variant` (`"channel" \| "page"`), `name`, `href?`, `active?`, `hasUnreadDot?`, `unreadCount?`, `showUnreadCount?`, `icon?` snippet, `trailing?` snippet, `children?` snippet. |
| `sidebars/SidebarCategory.svelte` | `$lib/queries` | Already mostly presentational — extract with props | |
| `sidebars/SpaceSidebar.svelte` | `$lib/queries`, `$lib/workers`, `$lib/config` | Extract `SidebarLayout` (category list shell) to design; data wiring stays | |
| `sidebars/SpaceSidebarHeader.svelte` | `$lib/queries`, `$lib/workers` | Extract header shell to design | |
| `sidebars/LinkedRoomsList.svelte` | `$lib/config`, `$lib/queries`, LiveQuery | Extract `LinkedRoomList` (room items with unread badges) to design | |
| `spaces/SpaceButton.svelte` | `$lib/queries` | Extract presentational `SpaceCard` to design | ✅ Shell extracted. Props: `name`, `description?`, `href`, `avatar` (snippet). `SpaceAvatar` passed in as snippet (kept in app). |
| `spaces/SpaceAvatar.svelte` | `$lib/utils.svelte` | Small — extract `SpaceAvatar` (avatar + fallback) | |
| `content/thread/message/ChatMessage.svelte` | `$lib/queries`, `$lib/workers`, `$lib/utils/markdown` | Extract `MessageBubble` (author, content, reactions, timestamp) to design; data/reactions wiring stays | ✅ Shell extracted. Props: `authorDid`, `authorName?`, `authorHandle?`, `authorAvatarUrl?`, `avatarSrc?`, `profileUrl?`, `timestamp`, `isBridged?`, `mergeWithPrevious?`, `isSelected?`, `showToolbar?`, `onAvatarClick?`. Snippets: `replyContext`, `content`, `media`, `linkEmbeds`, `toolbar`, `reactions`. |
| `content/thread/message/MessageReactions.svelte` | `$lib/mutations/reaction`, `$lib/queries` | Extract `ReactionBar` (render emoji + count, click callback) to design | |
| `content/thread/message/MessageToolbar.svelte` | `$lib/mutations`, `$lib/queries`, `$lib/workers` | Extract `ToolbarShell` (icon buttons with callbacks) to design | |
| `content/thread/message/MobileMessageDrawer.svelte` | `$lib/mutations`, `$lib/queries`, `$lib/workers` | Extract `MessageDrawer` to design | |
| `content/thread/ChatInputArea.svelte` | `$lib/mutations`, `$lib/queries`, `$lib/workers` | Extract `ChatInputShell` (rich text editor + send button) to design | ✅ Shell extracted. State props: `canWrite`, `isSendingMessage`, `previewImages`, `mode` (normal/replying/threading/commenting), `actionMenuOpen`, `threadName`, `threadSelectedCount`, `canSend`, `showContextPreview`. Callbacks: `onActionMenuOpenChange`, `onClearContext`, `onSend`, `onUploadMedia`, `onCreateThreadFromMenu`, `onCreateThread`, `onRemoveImage`, `onThreadNameChange`, `onFileInput`, `bindFileInput`. Snippets: `contextPreview`, `input`, `fullscreenDropper`. |
| `content/thread/boardView/BoardViewItem.svelte` | `AvatarGroup` import | Already close to pure — just uses design AvatarGroup | |
| `content/thread/boardView/ChannelBoardView.svelte` | LiveQuery, `$lib/queries` | Extract `ChannelBoard` (thread grid) to design | |
| `modals/EditRoomModal.svelte` | LiveQuery, `$lib/queries`, `$lib/mutations`, `$lib/workers` | Extract `RoomEditForm` to design | |
| `modals/RoleModal.svelte` | `$lib/queries`, `$lib/workers` | Extract `RoleManager` to design | |
| `modals/CreateRoleModal.svelte` | `$lib/queries`, `$lib/workers` | Extract `RoleCreateForm` to design | |
| `modals/InviteModal.svelte` | `$lib/queries`, `$lib/workers` | Extract `InviteManager` to design | |
| `modals/JoinSpaceModal.svelte` | `$lib/mutations/space`, `$lib/workers` | Extract `JoinDialog` to design | |
| `modals/RestoreRoomModal.svelte` | `$lib/mutations`, `$lib/queries`, `$lib/workers` | Extract `RestoreDialog` to design | |
| `user/LoginForm.svelte` | `$lib/workers` | Extract `LoginScreen` to design | ✅ Shell extracted. Bindable: `handle`, `email`, `password`, `tab`. Plain: `loading`, `error`, `lastLogin`, `handleSuffix`. Callbacks: `onLogin`, `onRegister`, `onLastLoginClick`. |
| `user/UserProfileButton.svelte` | `$lib/workers` | Extract `UserMenu` to design | |
| `ui/ChannelPermissions.svelte` | LiveQuery, `$lib/workers` | Extract `PermissionEditor` to design | |

#### D. Utilities to extract

| Utility | Location | Extract to | Status |
|---------|----------|-----------|--------|
| `cn()` (clsx + twMerge) | `$lib/utils.svelte.ts` | `@roomy/design/utils` (already there) | n/a |
| `navigate()` / `NavigationTarget` | `$lib/utils.svelte.ts` | App-specific — keep in `app-lite` |
| `markdown.ts` | `$lib/utils/markdown.ts` | Consider `@roomy/design/utils/markdown` if generally useful |
| `reactions.ts` | `$lib/utils/reactions.ts` | Consider `@roomy/design/utils` if generally useful |

### Phase 0 execution order

1. Move all category B components (pure presentational) to `@roomy/design`. Update `packages/app` imports. Verify.
2. Extract shells from high-value category C components:
   - `ChatMessage` → `MessageBubble` (most reused component)
   - `SidebarItem` → `SidebarItemShell`
   - `SpaceButton` → `SpaceCard`
   - `ChatInputArea` → `ChatInputShell`
   - `LoginForm` → `LoginScreen`
3. Extract utilities (`markdown`, `reactions`) if generally useful.
4. Remaining category C shells can be extracted opportunistically during `app-lite` development — don't block on them.

**Deliverable:** `@roomy/design` contains ~40+ components. `packages/app` still works via updated imports. `app-lite` has a rich component library to build from.

---

## Package Scaffold

### `packages/app-lite/` structure

```
packages/app-lite/
  package.json
  svelte.config.js
  vite.config.ts
  tsconfig.json
  src/
    app.html
    app.css                        ← Tailwind theme (copy from playground)
    routes/
      +layout.svelte               ← QueryClientProvider + auth gate + sync init
      +page.svelte                  ← Login screen / space list
      [space]/
        +layout.svelte              ← Space layout, sidebar, topic sub
        +page.svelte                ← Space index (threads board)
        [room]/
          +page.svelte              ← Room view (messages + input)
        settings/
          +page.svelte              ← Space settings (roles, members, invites)
        calendar/
          +page.svelte              ← Calendar events view
    lib/
      config.ts                     ← Env vars, appserver DID, feature flags
      auth.svelte.ts                ← Session state + login/logout helpers
      client.ts                     ← QueryClient singleton + proxied agent helper
      sync.svelte.ts                ← SyncConnection/SyncRouter/TopicManager lifecycle
      queries/                      ← TanStack Query factories
        spaces.ts                   ← createSpacesQuery()
        space-metadata.ts           ← createSpaceMetadataQuery(spaceId)
        room-metadata.ts            ← createRoomMetadataQuery(roomId)
        messages.ts                 ← createMessagesQuery(roomId) + diff application
        threads.ts                  ← createSpaceThreadsQuery, createRoomThreadsQuery
        message.ts                  ← createMessageQuery(messageId, roomId)
        roles.ts                    ← createRolesQuery(spaceId)
        members.ts                  ← createMembersQuery(spaceId)
        invites.ts                  ← createInvitesQuery(spaceId)
        calendar.ts                 ← createCalendarLinkQuery, createCalendarEventsQuery
      mutations/
        send-events.ts              ← sendEvents() batch procedure wrapper
        update-seen.ts              ← updateSeen() procedure wrapper
        room.ts                     ← create/update/delete room via sendEvents
        message.ts                  ← send/edit/delete message via sendEvents
        reaction.ts                 ← add/remove reaction via sendEvents
        space.ts                    ← join/create space via sendEvents
        invite.ts                   ← create/revoke invite via sendEvents
      components/                   ← app-lite-specific wiring (not in @roomy/design)
        sidebar/
          SpaceList.svelte          ← Wires createSpacesQuery → SpaceCard from design
          ChannelList.svelte        ← Wires createSpaceMetadataQuery → SidebarItemShell from design
        chat/
          ChatArea.svelte           ← Wires createMessagesQuery → MessageBubble from design
          ChatInput.svelte          ← Wires ChatInputShell from design + sendMessage mutation
        modals/
          EditRoomModal.svelte
          RoleModal.svelte
          InviteModal.svelte
```

### On query file organisation

Each query file is a thin wrapper (~10–20 lines) that calls `createQuery` with the SDK's `agentQuery`, `queryKey`, and NSID from the schema. They are colocated in `lib/queries/` rather than scattered in components because:

1. Multiple components use the same query (e.g. `room.getMetadata` is used in room header, linked rooms panel, and edit modal)
2. The query factories encapsulate the agent resolution and NSID wiring, keeping components clean
3. It mirrors the SDK's schema namespace (`schemas.queries.*`)

Components import the query factory and call it in a `{@const}` block — exactly as the playground does.

### NSID constants

The SDK already exports NSID constants from each schema file:

```typescript
import { schemas } from "@roomy-space/sdk";
const { NSID: GET_SPACES } = schemas.queries.getSpaces;
const { NSID: UPDATE_SEEN } = schemas.procedures.updateSeen;
```

These are available at the schema level — no need to duplicate them in `app-lite`. Query factories reference them directly (or inline the string, since the SDK's `agentQuery` takes the NSID as a string argument and the registry validates it at the type level).

---

## Dependencies

### `package.json`

```json
{
  "name": "app-lite",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite dev --host 127.0.0.1 --port 5180",
    "build": "vite build",
    "preview": "vite preview",
    "check": "svelte-kit sync && svelte-check --tsconfig ./tsconfig.json"
  },
  "dependencies": {
    "@atproto/api": "^0.14.22",
    "@roomy-space/sdk": "workspace:*",
    "@roomy/design": "workspace:*",
    "@tanstack/svelte-query": "^6.1.29"
  },
  "devDependencies": {
    "@iconify-json/heroicons": "^1.2.3",
    "@iconify-json/lucide": "^1.2.68",
    "@sveltejs/adapter-static": "^3.0.0",
    "@sveltejs/kit": "^2.49.3",
    "@sveltejs/vite-plugin-svelte": "^5.0.0",
    "@tailwindcss/vite": "^4.1.13",
    "svelte": "^5.40.0",
    "svelte-check": "^4.0.0",
    "tailwind-variants": "^3.2.2",
    "tailwindcss": "^4.2.0",
    "typescript": "^5.8.3",
    "unplugin-icons": "^22.3.0",
    "vite": "^6.3.6"
  }
}
```

This is essentially the playground's dependency list — the same stack, productionised.

### Workspace registration

Add `packages/app-lite` to `pnpm-workspace.yaml`.

### Subpath exports

Not needed. Unlike `@roomy-space/sdk` (which has multiple consumers needing granular imports), `app-lite` is a leaf application. Standard SvelteKit file resolution via `$lib/` aliases is sufficient. The `@roomy/design` package already uses subpath exports for components — `app-lite` consumes them as `@roomy/design/components/ui/button/Button.svelte`.

---

## Configuration

### `src/lib/config.ts`

```typescript
export const CONFIG = {
  // Appserver identity — used for PDS proxy routing and WS ticket fetch
  appserverDid: import.meta.env.VITE_APPSERVER_DID || "did:web:appserver.roomy.chat",

  // OAuth handle resolver
  handleResolver: "https://resolver.roomy.chat",

  // Feature flags (all default on — app-lite has no legacy path)
  flags: {
    threadsList: true,
    unreadNotifications: true,
    roles: true,
    inviteOnly: true,
  },
};
```

### OAuth scopes

`app-lite` uses explicit `rpc:` scopes with `aud=*` for each appserver XRPC method — following the same pattern as the existing `packages/app` (which uses `rpc:town.muni.leaf.authenticate?aud=*` for Leaf auth). We do **not** use `transition:generic`.

The scope string is built programmatically from the appserver NSIDs:

```typescript
// src/lib/config.ts

const APPSERVER_RPCS = [
  // Queries
  "space.roomy.space.getSpaces",
  "space.roomy.space.getMetadata",
  "space.roomy.space.getThreads",
  "space.roomy.space.getRoles",
  "space.roomy.space.getMembers",
  "space.roomy.space.getInvites",
  "space.roomy.room.getMetadata",
  "space.roomy.room.getMessages",
  "space.roomy.room.getThreads",
  "space.roomy.message.getMessage",
  // Procedures
  "space.roomy.auth.getConnectionTicket",
  "space.roomy.room.updateSeen",
  "space.roomy.space.sendEvents",
  // Calendar (in scope)
  "space.roomy.space.getCalendarLink",
  "space.roomy.space.getCalendarEvents",
];

export const OAUTH_SCOPE = [
  "atproto",
  "rpc:app.bsky.actor.getProfiles?aud=did:web:api.bsky.app%23bsky_appview",
  "rpc:app.bsky.actor.getProfile?aud=did:web:api.bsky.app%23bsky_appview",
  "blob:*/*",
  ...APPSERVER_RPCS.map((nsid) => `rpc:${nsid}?aud=*`),
].join(" ");
```

This means the `@roomy-space/sdk/browser` `createOAuthClient` needs a `scope` option added to `CreateOAuthClientOptions` (currently it hardcodes `buildScope` → `transition:generic`). The `app-lite` auth module passes the constructed `OAUTH_SCOPE`.

**Note:** The playground can keep using `transition:generic` for its debug use case. `app-lite` is the production client with properly scoped access.

### Environment variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `VITE_APPSERVER_DID` | Appserver DID for PDS proxy | `did:web:appserver.roomy.chat` |
| `VITE_FEATURE_FLAGS` | Feature flag overrides (comma-separated) | (none) |

---

## Core Modules

### Auth (`src/lib/auth.svelte.ts`)

Uses the SDK's `createOAuthClient` but with explicit `rpc: ... ?aud=*` scopes (not `transition:generic`). Requires adding a `scope` option to the SDK's `CreateOAuthClientOptions`.

```typescript
import {
  createOAuthClient,
  makeProxiedAgent,
} from "@roomy-space/sdk/browser";
import { Agent } from "@atproto/api";
import { CONFIG, OAUTH_SCOPE } from "./config";

let agent = $state<Agent | null>(null);
let authenticated = $state(false);

export async function init() {
  const client = createOAuthClient(CONFIG.appserverDid, {
    port: 5180,
    scope: OAUTH_SCOPE,
  });
  const result = await client.init();
  if (result?.session) {
    agent = new Agent(result.session as any);
    authenticated = true;
  }
}

export async function signIn(handle: string) {
  const client = createOAuthClient(CONFIG.appserverDid, {
    port: 5180,
    scope: OAUTH_SCOPE,
  });
  await client.signIn(handle);
}

export async function signOut() {
  // TODO: session.signOut() + reload
}

/** Proxied agent for XRPC calls via PDS → appserver */
export function px(): Agent {
  return makeProxiedAgent(agent!, CONFIG.appserverDid);
}
```

### Client (`src/lib/client.ts`)

```typescript
import { QueryClient } from "@tanstack/svelte-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  },
});
```

### Sync (`src/lib/sync.svelte.ts`)

Mirrors the playground's `createSyncContext`. Manages `SyncConnection` + `SyncRouter` + `TopicManager` from the SDK:

```typescript
import { sync } from "@roomy-space/sdk";
import { createTanstackCacheAdapter } from "@roomy-space/sdk/browser";
import { queryClient } from "./client";
import { agentProcedure } from "@roomy-space/sdk/transport";
import { px } from "./auth";
import { CONFIG } from "./config";
import { transport } from "@roomy-space/sdk";

const { SyncConnection, SyncRouter, TopicManager } = sync;
const { resolveAppserverWsOrigin } = transport;

// ... (full implementation mirrors playground/src/lib/queries/sync.svelte.ts)
```

Key integration points:
- `fetchTicket`: calls `agentProcedure(px(), "space.roomy.auth.getConnectionTicket", {})`
- `SyncRouter` routes `#invalidate`/`#messageDiff` into `queryClient` via `createTanstackCacheAdapter`
- `TopicManager` tracks viewport subscriptions (space + active room)
- `onMessageDiff` callback triggers `updateSeen` for the active room

---

## Query Factories

### Pattern

Every query follows the same pattern:

```typescript
import { createQuery } from "@tanstack/svelte-query";
import { agentQuery } from "@roomy-space/sdk/transport";
import { queryKey } from "@roomy-space/sdk/cache";
import { px } from "$lib/auth";

export function createSpacesQuery() {
  return createQuery(() => ({
    queryKey: queryKey("space.roomy.space.getSpaces"),
    queryFn: () => agentQuery(px(), "space.roomy.space.getSpaces", {}),
  }));
}
```

### Query index

| Factory | NSID | Returns |
|---------|------|---------|
| `createSpacesQuery()` | `space.roomy.space.getSpaces` | `{ spaces: Space[] }` |
| `createSpaceMetadataQuery(spaceId)` | `space.roomy.space.getMetadata` | Full sidebar + metadata |
| `createRoomMetadataQuery(roomId)` | `space.roomy.room.getMetadata` | Room + recentThreads |
| `createMessagesQuery(roomId)` | `space.roomy.room.getMessages` | `{ messages, cursor }` |
| `createSpaceThreadsQuery(spaceId)` | `space.roomy.space.getThreads` | `{ threads }` |
| `createRoomThreadsQuery(roomId)` | `space.roomy.room.getThreads` | `{ threads }` |
| `createMessageQuery(messageId, roomId)` | `space.roomy.message.getMessage` | Single message (cache check first) |
| `createRolesQuery(spaceId)` | `space.roomy.space.getRoles` | `{ roles }` |
| `createMembersQuery(spaceId)` | `space.roomy.space.getMembers` | `{ members, externalAdmins }` |
| `createInvitesQuery(spaceId)` | `space.roomy.space.getInvites` | `{ invites }` |
| `createCalendarLinkQuery(spaceId)` | `space.roomy.space.getCalendarLink` | Calendar integration config |
| `createCalendarEventsQuery(spaceId)` | `space.roomy.space.getCalendarEvents` | Calendar events list |

---

## Mutations

### Write operations via appserver

All writes go through `space.roomy.space.sendEvents` — a batch XRPC procedure on the appserver. The mutation helper accepts an array of events:

```typescript
// src/lib/mutations/send-events.ts
import { agentProcedure } from "@roomy-space/sdk/transport";
import { px } from "$lib/auth";
import { newUlid } from "@roomy-space/sdk";

export async function sendEvents(
  spaceId: string,
  events: Array<Record<string, unknown>>,
): Promise<void> {
  const withIds = events.map((e) => ({ id: newUlid(), ...e }));
  // Returns 200 OK, no body
  await agentProcedure(px(), "space.roomy.space.sendEvents", {
    spaceId,
    events: withIds,
  });
}
```

Higher-level mutation helpers build on this:

```typescript
// src/lib/mutations/message.ts
import { sendEvents } from "./send-events";

export async function sendMessage(spaceId: string, roomId: string, content: string) {
  return sendEvents(spaceId, [{
    $type: "space.roomy.message.create.v0",
    room: roomId,
    body: content,
  }]);
}
```

### `updateSeen` (`src/lib/mutations/update-seen.ts`)

Fires on two triggers:
1. **Room open:** `updateSeen(roomId)` — marks all current messages as read
2. **Message received while viewing:** `updateSeen(roomId, lastMessageId)` — marks up to the received message

```typescript
import { agentProcedure } from "@roomy-space/sdk/transport";
import { px } from "$lib/auth";

export async function updateSeen(roomId: string, seenUpTo?: string) {
  return agentProcedure(px(), "space.roomy.room.updateSeen", {
    roomId,
    ...(seenUpTo ? { seenUpTo } : {}),
  });
}
```

The sync module's `onMessageDiff` callback calls this for the active room.

---

## Component Architecture

### Layout hierarchy

```
+layout.svelte
  ├── QueryClientProvider
  ├── Auth gate (if !authenticated → login screen)
  ├── Sync init ($effect: connect when authenticated)
  └── children

[space]/+layout.svelte
  ├── Sidebar (SpaceList + ChannelList)
  ├── Topic sub for active space
  └── children

[space]/[room]/+page.svelte
  ├── Room header (room metadata query)
  ├── Message list (messages query + messageDiff)
  ├── Chat input (send message mutation)
  ├── Topic sub for active room
  └── updateSeen on open + on messageDiff
```

### Component data flow

Components use `{@const}` blocks for queries (matching the playground pattern):

```svelte
{@const spacesQuery = createSpacesQuery()}

{#if spacesQuery.isPending}
  <LoadingSpinner />
{:else if spacesQuery.isError}
  <p>Error: {spacesQuery.error.message}</p>
{:else if spacesQuery.data}
  {#each spacesQuery.data.spaces as space}
    <SpaceCard {space} />
  {/each}
{/if}
```

No intermediate state classes (`AppState`, `SpaceState`). Each component owns its data via TanStack Query. Shared state (current space, current room) lives in route params or layout `$state`.

### Topic subscriptions

The root layout manages the `SyncContext`. Route layouts and pages use `useTopicSubscription` from `@roomy-space/sdk/svelte`:

```svelte
<!-- [space]/+layout.svelte -->
<script>
  import { useTopicSubscription } from "@roomy-space/sdk/svelte";
  import { syncCtx } from "$lib/sync";

  let { params } = $props();

  useTopicSubscription(
    () => syncCtx.topicManager,
    () => [{ kind: "space", id: params.space }],
  );
</script>
```

### Design components

Import from `@roomy/design` for shared UI primitives:

```svelte
import Button from "@roomy/design/components/ui/button/Button.svelte";
import Input from "@roomy/design/components/ui/input/Input.svelte";
import { IconHashtag, IconHome } from "@roomy/design/icons";
import MessageBubble from "@roomy/design/components/content/message/MessageBubble.svelte";
```

Feature-specific wiring (query integration, mutation handlers) lives in `app-lite/src/lib/components/`. The presentational shells come from `@roomy/design`.

---

## Implementation Phases

### Phase 0: Component refactoring (prerequisite)

**Goal:** Enrich `@roomy/design` with components extracted from `packages/app`.

- [ ] Move all 18 pure presentational components (category B) to `@roomy/design`
- [ ] Update `packages/app` imports — verify it still builds and runs
- [ ] Extract shells from 5 high-value coupled components (category C):
  - `ChatMessage` → `MessageBubble`
  - `SidebarItem` → `SidebarItemShell`
  - `SpaceButton` → `SpaceCard`
  - `ChatInputArea` → `ChatInputShell`
  - `LoginForm` → `LoginScreen`
- [ ] Extract utilities (`markdown`, `reactions`) to `@roomy/design/utils` if generally useful

**Verification:** `packages/app` still works. `@roomy/design` has ~40+ components.

### Phase 1: Scaffold + auth + space list

**Goal:** Login, show spaces, open a space sidebar.

- [ ] Create `packages/app-lite/` with SvelteKit + Tailwind + `@tanstack/svelte-query`
- [ ] Add to `pnpm-workspace.yaml`
- [ ] Copy `vite.config.ts` / `svelte.config.js` / `app.css` from playground (port 5180)
- [ ] `src/lib/config.ts` — env vars, appserver DID
- [ ] `src/lib/auth.svelte.ts` — init/login/logout via SDK
- [ ] `src/lib/client.ts` — QueryClient singleton
- [ ] `src/routes/+layout.svelte` — QueryClientProvider + auth gate
- [ ] `src/routes/+page.svelte` — Login screen → space list
- [ ] `src/lib/queries/spaces.ts` — `createSpacesQuery()`
- [ ] Space list component showing joined spaces

**Verification:** Can log in, see list of spaces.

### Phase 2: Sync + space sidebar

**Goal:** Open a space, see the sidebar with channels, real-time updates.

- [ ] `src/lib/sync.svelte.ts` — SyncConnection + SyncRouter + TopicManager
- [ ] `src/lib/queries/space-metadata.ts` — `createSpaceMetadataQuery(spaceId)`
- [ ] `[space]/+layout.svelte` — sidebar layout with channel list
- [ ] Topic subscription for active space
- [ ] Sidebar renders categories + channels with unread badges

**Verification:** Open a space, see sidebar with channels, real-time sidebar updates via WS.

### Phase 3: Room view + messages

**Goal:** Open a room, see messages, send messages, real-time updates.

- [ ] `src/lib/queries/room-metadata.ts` — `createRoomMetadataQuery(roomId)`
- [ ] `src/lib/queries/messages.ts` — `createMessagesQuery(roomId)` + diff application
- [ ] `src/lib/mutations/send-events.ts` — sendEvents batch wrapper
- [ ] `src/lib/mutations/update-seen.ts` — updateSeen with room-open + on-diff triggers
- [ ] `src/lib/mutations/message.ts` — sendMessage
- [ ] `[space]/[room]/+page.svelte` — room header + message list + chat input
- [ ] Topic subscription for active room
- [ ] `updateSeen` on room open + on each `#messageDiff` while viewing
- [ ] Message diff application (add/update/remove via `setQueryData`)

**Verification:** Open a room, see messages, send a message, see it appear via WS, unread badge clears.

### Phase 4: Threads + message details

**Goal:** Thread board view, thread listing per channel, reply previews.

- [ ] `src/lib/queries/threads.ts` — space + room thread queries
- [ ] `src/lib/queries/message.ts` — single message query with cache lookup
- [ ] `[space]/+page.svelte` — thread board view
- [ ] Channel board view component
- [ ] Reply preview in message bubbles

**Verification:** Browse threads in space index, browse threads per channel, see reply previews.

### Phase 5: Settings + calendar

**Goal:** Space settings pages + calendar view — full feature parity (pages excluded).

- [ ] `src/lib/queries/roles.ts` / `members.ts` / `invites.ts`
- [ ] `src/lib/queries/calendar.ts` — calendar link + events queries
- [ ] `src/lib/mutations/room.ts` — create/update/delete room via sendEvents
- [ ] `src/lib/mutations/reaction.ts` — add/remove reaction
- [ ] `src/lib/mutations/space.ts` — join space
- [ ] `src/lib/mutations/invite.ts` — create/revoke invite
- [ ] Settings pages: general, roles, members, invites
- [ ] Calendar events page
- [ ] EditRoomModal
- [ ] RoleModal / CreateRoleModal
- [ ] InviteModal
- [ ] JoinSpaceModal

**Verification:** Full feature parity with `packages/app` (minus page editing). Calendar integration displays events.

### Phase 6: Polish + deployment

**Goal:** Production-ready on separate subdomain.

- [ ] Error boundaries and loading states
- [ ] Responsive layout (mobile)
- [ ] Dark mode
- [ ] OAuth client metadata for production subdomain
- [ ] Static adapter build
- [ ] Deploy to separate subdomain
- [ ] E2E smoke tests

---

## Relationship to Existing Packages

| Package | Relationship to app-lite |
|---------|------------------------|
| `packages/app` | Legacy — continues to run on the main domain. `app-lite` deploys to a separate subdomain. Eventually replaces it. |
| `packages/playground` | Reference implementation. `app-lite` productionises the same patterns. Playground remains for debugging. |
| `packages/design` | Shared UI components. `app-lite` imports from `@roomy/design`. Phase 0 enriches it. |
| `packages/sdk` | Transport, schemas, sync primitives, cache adapters, Svelte runes. `app-lite` is a thin consumer. |
| `packages/appserver` | Backend. `app-lite` is its primary client. `sendEvents` procedure is the write path. |

---

## Remaining Open Questions

1. **Calendar queries on appserver:** The calendar queries (`getCalendarLink`, `getCalendarEvents`) are listed in `livequery-inventory.md` as `#15`/`#16` but are not yet implemented as XRPC endpoints on the appserver. These need to be added to the appserver's handler registry and lexicons before `app-lite` Phase 5 can include calendar support.

2. **`sendEvents` schema in SDK:** The SDK's schema registry and transport need a `space.roomy.space.sendEvents` entry (input schema for `{ spaceId, events }`, output schema for empty/void). The appserver lexicon JSON also needs to be created.

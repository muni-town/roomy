# Presentational-UI migration: app-lite → @roomy/design

**Date:** 2026-09-25
**Status:** Phase 1 complete (TASK-208) — phase 2 dispatchable from the triage below
**Umbrella:** "refactor presentational UI code from app-lite to `design` and set up
storybook stories" (Meri, `#coordination`, 2026-09-25T11:52Z)

## Goal

app-lite owns the thin client; `@roomy/design` owns the presentational layer.
The pattern already exists and is the one to extend:

> **design owns the presentational shell; app-lite wraps it with data.**

Examples that predate this plan: `MessageReactions.svelte` → `design/content/thread/message/ReactionBar.svelte`,
`MessageToolbar.svelte` → `design/content/thread/message/ToolbarShell.svelte`,
`SpaceSidebar`'s header → `design/sidebars/SpaceHeaderShell.svelte`.

Phase 1 moved the pure presentational leaves and established the Storybook
coverage pattern. This document records what moved, what stays, and what needs a
design decision, so phase 2 needs no re-derivation.

## What already existed (not added by phase 1)

`packages/design` shipped with Storybook fully wired:

- `.storybook/main.ts` — `@storybook/svelte-vite`, addons `docs`/`themes`/`svelte-csf`,
  docgen deliberately **off**, `$app` aliased to `.storybook/app-stubs`, Tailwind +
  `unplugin-icons` + svelte plugins injected in `viteFinal`.
- `.storybook/preview.ts` — light/dark theme toggle via `withThemeByClassName`.
- `.storybook/app-stubs/` — `$app/environment` and `$app/navigation` stubs. There is
  **no `$app/paths` stub** (see "Stays in app-lite" for why that matters).
- Scripts `storybook` / `storybook:build`.
- Component categories: `ui/ helper/ layout/ content/ modals/ spaces/ user/ richtext/
  marketing/ sidebars/`; components imported by path
  (`@roomy/design/components/<category>/<Name>.svelte`), and `src/index.ts` is
  **intentionally empty** — no barrel exports.

Phase 1 added only: 8 moved components, 7 `.stories.svelte` files, and this plan.

## Naming and placement conventions used by phase 1

- New components go in the **existing** category that matches them. No new
  top-level category was invented.
- Story titles use the existing scheme: `"<Category>/<Name>"`, with nested
  categories mirroring the directory (`Content/Thread/Message/Embeds/LinkCard`).
- Stories are `addon-svelte-csf` CSF files: `<script lang="ts" module>` +
  `defineMeta`, a `{#snippet template(args)}` wrapper for layout, and one
  `<Story>` per meaningful prop state.
- Moves are **pure `git mv` renames** — no content edits — so a reviewer can diff
  the file against its app-lite original. Only import paths at call sites changed.

## Phase 1 outcome: the 12 candidates triaged

The coordinator's scan ("no `$lib/` import") is necessary but not sufficient.
Every candidate was checked for `$app/*`, `$env/*`, browser-global use, and
app-lite coupling. `$lib/utils` counts as coupling.

| # | Component | Verdict | Reason |
|---|---|---|---|
| 1 | `RoomyMark.svelte` | **moved** → `marketing/RoomyMark.svelte` | Pure SVG, one prop (`sizeClass`), zero imports. |
| 2 | `sidebar/ChannelIcon.svelte` | **moved** → `sidebars/ChannelIcon.svelte` | Pure branch on `channel.federated`; already imported design icons. |
| 3 | `sidebar/EditableChannelItem.svelte` | **moved** → `sidebars/EditableChannelItem.svelte` | Pure shell over design's `SidebarItemShell`; `onedit` callback keeps it data-free. Call sites only changed for the `ChannelIcon` relative import. |
| 4 | `feed/ActivityFeedSkeleton.svelte` | **moved** → `content/feed/ActivityFeedSkeleton.svelte` | Zero imports; one `count` prop. |
| 5 | `chat/embeds/LinkCard.svelte` | **moved** → `content/thread/message/embeds/LinkCard.svelte` | Real render logic (rich card vs plain link, video/image/thumb fallback) over SDK types + design `Button`. 5 call sites. |
| 6 | `welcome/WelcomeActions.svelte` | **moved** → `marketing/WelcomeActions.svelte` | Zero props; design `Button` with `href`. |
| 7 | `welcome/FeatureDemoCards.svelte` | **moved** → `marketing/FeatureDemoCards.svelte` | Zero props; static scoped CSS. |
| 8 | `settings/HandleDomainDialog.svelte` | **moved** → `modals/HandleDomainDialog.svelte` | Static dialog: `open` bindable + `did` prop, **copy handler injected by the app**. Renders in isolation. |
| 9 | `chat/MessageContent.svelte` | **deferred — not presentational in its current form** | Imports sibling *app-lite* modules: `./enrich-internal-links` (which `mount()`s app-coupled `SpaceRoomBadge`, and calls `location.origin`) and `./message-body`. Moving it requires first making internal-link enrichment injectable. |
| 10 | `chat/BlocksRenderer.svelte` | **deferred — blocked by `MessageContent`** | Imports `enrichInternalLinks` from the same app-coupled module. Largest render-logic prize (262 lines: UTF-8→UTF-16 facet offsets, facet nesting, anchor non-nesting). Blocked on the same injection seam. |
| 11 | `seo/SeoMeta.svelte` | **rejected — not presentational** | Uses `$app/paths` `base` and `<svelte:head>`. It is route/head metadata, not a component in a design system, and Storybook has no `$app/paths` stub. |
| 12 | `auth/HandleTypeahead.svelte` | **rejected — data-coupled** | Hardcodes a live `fetch` to `https://api.bsky.app/xrpc/app.bsky.actor.searchActorsTypeahead` plus 200 ms debounce; it is a Bluesky AppView client, not a presentational primitive. design already has `ui/user-typeahead/UserTypeahead{,List}.svelte` — the right end state is app-lite wrapping that shell. |

## Move next (phase 2 candidates, in dependency order)

1. **`chat/embeds/SpaceRoomBadge.svelte` is the keystone.** It is coupled via
   `$lib/client`, `$lib/auth.svelte`, `$lib/components/layout/current-space.svelte`,
   `$lib/utils`. Proposed seam: give the badge (and `enrichInternalLinks`) an
   injected XRPC query function + a `resolveBlobUrl`, instead of importing the
   client. Once that lands, `enrich-internal-links.ts` becomes portable and
   **`MessageContent` + `BlocksRenderer` unblock together** — do them in one PR.
   `parseInternalLinkHref` and the `data-roomy-internal-link` contract already
   match `design/src/utils/markdown.ts`, so the link-marking rules stay in one place.
2. **Thin wrappers over data accessors** — each imports only a query or mutation
   hook and can take its result as a prop:
   - `chat/MessageContext.svelte` (`$lib/queries/messages`)
   - `chat/MessageToolbar.svelte` (`$lib/mutations/reaction`, `$lib/queries/messages`)
   - `welcome/DiscoverSpacesSection.svelte` (`$lib/queries/spaces`)
   - `thread/ThreadsTab.svelte`, `thread/ChannelBoardView.svelte`, `thread/LinksView.svelte`
     (`$app/state` + `$lib/queries/*`) — move the `$app/state` room-param read up to the
     calling page, keep the presentational body.
   - `chat/embeds/MediaEmbed.svelte`, `chat/ForwardContext.svelte`, `welcome/SpaceCards.svelte` —
     these import only `resolveBlobUrl` from `$lib/utils` (a pure URL helper). Moving
     `resolveBlobUrl` into `design/src/utils` (or accepting it as a prop) unblocks all
     three at once.
3. **`auth/LoginModal.svelte` after the `HandleTypeahead` decision** — it owns
   `$env/dynamic/public` + `$lib/auth.svelte` + `$lib/last-login.svelte`; a
   prop-driven shell is feasible, but only once the typeahead question is settled.

## Stays in app-lite (data-coupled) — do not move

Every component below imports `$lib/` queries/mutations/auth/state (or `$env`), and
several read `$app/state` route params and call `$app/navigation` `goto`. They are
containers: moving them would drag the app's data layer into the design system.

- Layout/route shells: `layout/MainLayout.svelte`, `layout/SearchBar.svelte`,
  `layout/SyncStatusBanner.svelte`, `layout/EnableNotificationsBanner.svelte`,
  `layout/NavbarSpaceInfo.svelte`, `layout/JoinSpaceModal.svelte`
- Sidebar containers: `sidebar/SpaceSidebar.svelte`, `sidebar/ServerBar.svelte`,
  `sidebar/SidebarUserCard.svelte`, `sidebar/SpaceSidebarButtons.svelte`,
  `sidebar/RoomyHomeCard.svelte`
- Chat/feed containers: `chat/ChatArea.svelte`, `chat/ChatInput.svelte`,
  `chat/ChatInputArea.svelte`, `chat/ChatMessage.svelte`,
  `chat/MessageContextReply.svelte`, `chat/MessageReactions.svelte`,
  `chat/RoomPickerModal.svelte`, `feed/ActivityFeed.svelte`,
  `search/SearchResultsList.svelte`
- Modals/forms bound to mutations: `sidebar/EditRoomModal.svelte`,
  `sidebar/RestoreRoomModal.svelte`, `layout/JoinSpaceModal.svelte`,
  `InviteModal.svelte`, `ui/ChannelPermissions.svelte`,
  `welcome/DiscoverSpaces.svelte`, `welcome/WelcomeContent.svelte`

## Needs a design decision (not just a code move)

1. **Internal-link enrichment seam** — where does "fetch the space/room summary for
   a badge" live? Options: (a) design takes an injected async resolver prop;
   (b) design ships a context object the client provides at mount; (c) the badge
   stays in app-lite and design ships only the visual shell. Recommend (a)/(c):
   it keeps design free of any XRPC client and still lets `MessageContent` move.
2. **`resolveBlobUrl` ownership** — it is a pure blob→URL helper used by at least
   three presentational components. Decide whether it becomes `design/src/utils/`
   (with an origin parameter) or a required prop everywhere.
3. **`$app/paths` in the design stub set** — `SeoMeta` is the only user today. If the
   answer is "design components may read `base`", add an `app-stubs/paths.ts`;
   if not (recommended), keep `SeoMeta` in app-lite and say so explicitly.
4. **`HandleTypeahead` vs `ui/user-typeahead/UserTypeahead`** — design already owns a
   typeahead shell. Decide whether `HandleTypeahead` is retired in favour of the
   design component (with the Bluesky `searchActorsTypeahead` call injected), or
   whether the Bluesky-specific fetch stays in app-lite. Do not copy it over.
5. **`marketing/` scope** — phase 1 parked the logo and the welcome/feature cards
   there. If that category is meant for pricing/landing only, decide whether
   brand assets get their own category rather than accreting in `marketing/`.

## Verification for a phase-2 PR

Baseline measured on a clean `next` checkout (2026-09-25, `5b5fb375`), so "no new
errors" is checkable rather than assumed:

- `pnpm --filter app-lite check` → **0 errors, 19 warnings** (the AGENTS.md
  "3 errors" baseline is stale).
- `pnpm --filter app-lite build` and `pnpm --filter @roomy/design build`.
- `pnpm --filter @roomy/design storybook:build` — must include the new stories.
- `pnpm --filter @roomy/design test` (Vitest).

## Component counts

| | before (phase 1) | after (phase 1) |
|---|---|---|
| `design` components | 75 | 83 |
| `design` stories | 76 | 83 |
| `app-lite` components | 49 | 41 |

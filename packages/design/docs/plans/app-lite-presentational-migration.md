# Presentational-UI migration: app-lite → @roomy/design

**Date:** 2026-09-25 (phase 2 outcome added 2026-10-13; the `MessageContent` +
`BlocksRenderer` move added 2026-10-14)
**Status:** Phase 2 complete — the remaining candidates are wrapped data accessors
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
| 9 | `chat/MessageContent.svelte` | **moved** → `content/thread/message/MessageContent.svelte` | Markdown body + the `BlocksRenderer` branch, over `renderMarkdownSanitized` and the SDK's `RICHTEXT_MIME` test. Its remaining app-side imports (`./message-body`, the tile stack) move with it; the enrichment action takes injected lookups. See "This PR". |
| 10 | `chat/BlocksRenderer.svelte` | **moved** → `content/thread/message/BlocksRenderer.svelte` | Largest render-logic prize (262 lines: UTF-8→UTF-16 facet offsets, facet nesting, anchor non-nesting). Import-path changes only. |
| 11 | `seo/SeoMeta.svelte` | **rejected — not presentational** | Uses `$app/paths` `base` and `<svelte:head>`. It is route/head metadata, not a component in a design system, and Storybook has no `$app/paths` stub. |
| 12 | `auth/HandleTypeahead.svelte` | **rejected — data-coupled** | Hardcodes a live `fetch` to `https://api.bsky.app/xrpc/app.bsky.actor.searchActorsTypeahead` plus 200 ms debounce; it is a Bluesky AppView client, not a presentational primitive. design already has `ui/user-typeahead/UserTypeahead{,List}.svelte` — the right end state is app-lite wrapping that shell. |

## Phase 2 outcome: the keystone seam (settled)

`chat/embeds/SpaceRoomBadge.svelte` **moved** → `design/content/thread/message/embeds/SpaceRoomBadge.svelte`,
and the two decisions the plan parked are settled as follows.

1. **Internal-link enrichment seam — injected async resolver props (option a).**
   The badge takes `resolveSpace: (spaceId) => Promise<SpaceSummary | undefined>`,
   optional `resolveRoom`, and `isCurrentSpace: () => boolean`; the contract lives
   in that directory's `types.ts`. Rejected the context object (b): the badge is
   mounted **imperatively** by `enrichInternalLinks` (`mount()`, one instance per
   link), so a context the app provides "at mount" would have to be threaded
   through the mount call anyway — the props are the same wiring with no
   `getContext`/`setContext` indirection, and they keep the component readable in
   isolation (which the stories are). Rejected (c) because the badge is
   presentational once the lookups are injected.
   The **request policy stays in app-lite**: `$lib/queries/badge-summaries.ts`
   exports `resolveSpaceSummary` / `resolveRoomSummary`, both of which resolve
   `undefined` for a key that has already errored. That is load-bearing — a
   stale internal link 404s deterministically and its badge is remounted on every
   row recycle, so the "ask at most once per session" rule must survive the seam.
   `prefetch-link-summaries.ts` now calls those same two resolvers instead of
   `ensureQueryData` directly, so the pass and the badges cannot drift apart.

2. **`resolveBlobUrl` ownership — moved to `design/src/utils/blob.ts`.** It is pure
   string work, so it belongs with the presentational layer that needs it. Its one
   impure input (the appserver origin behind the `/blob/` proxy) is injected once at
   boot through `setBlobOrigin`, exactly as `setInternalLinkOrigins` already
   configures the markdown renderer — the app-lite call site is
   `setAppserverOrigin`, which already had the value. The app-lite copy is deleted,
   not aliased, and all 31 import sites point at `@roomy/design/utils`.

### This PR: `MessageContent` + `BlocksRenderer` (moved)

Both moved as pure `git mv` renames, plus the minimum dependency closure they
cannot render without. Each file's diff against its app-lite original is an
import-path change and nothing else.

| from (app-lite) | to (design) |
|---|---|
| `chat/MessageContent.svelte` | `content/thread/message/MessageContent.svelte` |
| `chat/BlocksRenderer.svelte` | `content/thread/message/BlocksRenderer.svelte` |
| `chat/message-body.ts` | `utils/message-body.ts` |
| `chat/enrich-internal-links.ts` | `content/thread/message/enrich-internal-links.ts` |
| `components/tiles/MessageTiles.svelte` | `content/thread/message/tiles/MessageTiles.svelte` |
| `components/tiles/TileEmbed.svelte` | `content/thread/message/tiles/TileEmbed.svelte` |
| `lib/tiles/{at-uri,message-tiles,mothership}.ts` | `content/thread/message/tiles/` |

The tile stack comes along because `MessageContent` renders `MessageTiles` in
its body: it is presentational (a tile is a record fetched from the tile's own
PDS, with no path into the app's data model), so it is the closure's own edge
rather than a data coupling. The three `node:test` files moved with their
modules and were converted to Vitest, which is the only runner `design` has.

**The enrichment seam, applied.** `enrichInternalLinks` mounts a badge per
link imperatively, so its three app-owned inputs are injected once at boot
rather than passed as props:

```
app-lite: chat/enrich-internal-links.ts   (the wiring)
    configureInternalLinks({ origins, resolveSpace, resolveRoom, isCurrentSpace })
design:   content/thread/message/enrich-internal-links.ts   (the action)
          content/thread/message/types.ts                   (the contract)
```

`origins` also feeds `setInternalLinkOrigins`, so the markdown renderer and the
action read one list. Unconfigured, the renderer degrades to a badge labelled
with the target's own id rather than throwing — which is what keeps the stories
renderable without a boot step.

The design-side `internalLinkOrigins` is one array mutated in place by the
setter, not a `let` reassigned by it: `BlocksRenderer` captures the reference at
import time for its facet walk, and a reassignment would leave it reading the
empty array.

## What moves next (remaining phase 2 candidates)

1. **Thin wrappers over data accessors** — each imports only a query or mutation
   hook and can take its result as a prop:
   - `chat/MessageContext.svelte` (`$lib/queries/messages`)
   - `chat/MessageToolbar.svelte` (`$lib/mutations/reaction`, `$lib/queries/messages`)
   - `welcome/DiscoverSpacesSection.svelte` (`$lib/queries/spaces`)
   - `thread/ThreadsTab.svelte`, `thread/ChannelBoardView.svelte`, `thread/LinksView.svelte`
     (`$app/state` + `$lib/queries/*`) — move the `$app/state` room-param read up to the
     calling page, keep the presentational body.
   - `chat/embeds/MediaEmbed.svelte`, `chat/ForwardContext.svelte`, `welcome/SpaceCards.svelte` —
     their only coupling was `resolveBlobUrl`, which now comes from design, so each
     moves as soon as its own remaining props are named.
2. **`auth/LoginModal.svelte` after the `HandleTypeahead` decision** — it owns
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

> Decisions 1 and 2 were settled by the phase-2 PR — see "Phase 2 outcome"
> above; the entries below record what was asked, not open questions.

1. **Internal-link enrichment seam** — where does "fetch the space/room summary for
   a badge" live? Options: (a) design takes an injected async resolver prop;
   (b) design ships a context object the client provides at mount; (c) the badge
   stays in app-lite and design ships only the visual shell. Recommend (a)/(c):
   it keeps design free of any XRPC client and still lets `MessageContent` move.
   **Settled: (a).**
2. **`resolveBlobUrl` ownership** — it is a pure blob→URL helper used by at least
   three presentational components. Decide whether it becomes `design/src/utils/`
   (with an origin parameter) or a required prop everywhere. **Settled:
   `design/src/utils/blob.ts`, origin injected once via `setBlobOrigin`.**
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

| | before (phase 1) | after phase 1 |
|---|---|---|
| `design` components | 75 | 83 |
| `design` stories | 76 | 83 |
| `app-lite` components | 49 | 41 |

The phase-2 seam moved one component in each direction: `design` gains
`content/thread/message/embeds/SpaceRoomBadge.svelte` plus its story file, and
app-lite loses its copy. (The absolute counts above are the phase-1 record; the
tree has gained components from other changes since, so they are not restated.)

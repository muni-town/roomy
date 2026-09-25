# app-lite E2E UI coverage — plan

**Status:** phase 1 landed (harness + first coverage). Phase 2 dispatchable from
this document.
**Updated:** 2026-09-25 (TASK-207)
**Suite:** `packages/app-lite/e2e/` · run with `pnpm --filter app-lite test:e2e`

Meri's goal: "set up playwright and begin testing of app-lite behaviours, with a
goal of ultimately capturing most UI actions." This document is the map for that
destination — what exists, what is covered, and what remains — so each later
phase can be dispatched without re-deriving the surface.

---

## 1. The harness (done)

| Piece | File | What it does |
|---|---|---|
| Playwright config | `playwright.config.ts` | `testDir: e2e`, chromium project, `webServer` waits on the app-lite origin, traces/screenshots retained on failure. |
| Stack launcher | `e2e/launch-stack.ts` | Boots the whole stack hermetically: stub PDS → appserver (in-process, test mode) → seed → `vite dev`. |
| Stub PDS | `e2e/pds-stub.ts` | Answers `createSession` + `getServiceAuth` (with CORS) so the client's **real** `AtpAgent` login path runs with no account and no network. |
| Seeder | `e2e/seed.ts` | Seeds user/space/membership directly; creates the room + message through the **real** `sendEvents` write path. |
| Fixtures | `e2e/fixtures.ts` | Fixed IDs, ports, origins — shared by the Bun launcher and the Node specs. |
| Spec helpers | `e2e/spec-helpers.ts` | Injects `X-Test-Did` on appserver requests; `waitForAuthenticated`; composer/message-list locators. |

### Why this shape

- **No docker, no real PDS, no network.** Playwright's `webServer` drives the
  launcher; the appserver runs in-process under Bun with `APPSERVER_TEST_MODE`
  (`X-Test-Did` auth) and a throwaway `DATA_DIR`. The alternative — driving
  `scripts/dev-local` — would need docker for PLC and, because
  `space.roomy.space.createSpace` provisions a `did:plc` through
  https://plc.directory, network access as well.
- **The browser cannot set `X-Test-Did`.** Playwright injects it on requests to
  the appserver origin (`spec-helpers.ts`), so the appserver authenticates on
  the header while the client still runs its genuine login/token code against
  the stub PDS. This also keeps the bypass visible in the trace.
- **`RATE_LIMIT_DISABLED=true`** is set in `webServer.env`. Every request in a
  run comes from 127.0.0.1; the default 100-requests/60s per-IP limiter is
  exhausted partway through a suite, which surfaced as 429s mid-run.
- Those two env vars are set in `playwright.config.ts`, not in the launcher:
  the appserver reads them at module-load time, before a launcher's own body
  would run. The launcher asserts they are present so a config regression fails
  loudly.

### Known constraints (not defects — design facts phase 2 must respect)

- **`space.roomy.search.messages` needs Qdrant and 503s without it.** The
  stack leaves `QDRANT_URL` unset, so message search is unavailable here (as it
  is in any self-hosted deployment without Qdrant). Room/thread search
  (`space.roomy.search.rooms`) is pure SQLite and *is* covered.
- **app-lite has exactly one `data-testid`** (`send-message-button`, in
  `packages/design/.../ChatInputShell.svelte`). Everything else must key on
  ARIA labels, `id`, `title`, `href`, `data-current`, or visible text. Two
  gaps worth fixing *in app-lite* when phase 2 needs them:
  - **Message rows carry no identifying attribute** — no id, no `data-*`. Rows
    can only be addressed positionally or by their text. Adding
    `data-message-id` to the row would make reply/edit/delete/react assertions
    precise rather than text-scraping.
  - The composer is reachable only via `#chat-input [contenteditable="true"]`.

---

## 2. Covered now (21 tests)

Every test below states the observable behaviour it defends.

### `auth.spec.ts` — app shell and authentication
| Test | Defends |
|---|---|
| authenticates and renders the signed-in user | Client auth → session → service token → appserver `getProfile` → rendered name, i.e. the whole chain. |
| loads a space's channel and exposes the composer | The room route resolves, the caller has write access, the editor mounts. |
| reports no client-side errors while loading | No uncaught `pageerror` during boot + room render. |
| keeps the signed-in identity across a reload | The session survives a reload instead of falling back to a logged-out shell. |

### `navigation.spec.ts` — space list and room navigation
| Test | Defends |
|---|---|
| lists the joined space in the sidebar | `getSpaces` + the space switcher render the seeded space. |
| navigating into the space shows its channel | The sidebar's `getMetadata` assembly lists the channel with its name. |
| entering the channel renders its messages and composer | The seeded message survived the real write path + materialisation and is read back. |
| a deep link to an unknown space does not render a space shell | The `[space]` layout's DID guard 404s non-DID segments (no stray `getMetadata`). |

### `send-message.spec.ts` — the write path
| Test | Defends |
|---|---|
| the sent message appears in the room | Typing + Send puts the message in the room (optimistic or persisted). |
| **a sent message survives a reload** | **The load-bearing one:** after reload only the appserver can supply the row, so it proves `sendEvents` → materialisation → read persisted it. |
| submitting clears the composer | The composer hands the text off rather than re-holding it. |

### `search.spec.ts` — search affordances
| Test | Defends |
|---|---|
| the navbar exposes a search entry point | The `search` flag is honoured and the navbar searchbar renders. |
| the directory search page renders its results UI | `/search` renders past the flag gate to its empty-term state. |
| the space search route finds a channel by name | Route → query → appserver → rendered row, for room search. Also covers graceful degradation: it passes while the Qdrant-backed message query alongside it is 503ing. |
| shows no channel section for an absent term | The results section is genuinely result-driven, not always-rendered. |
| the space search bar is scoped to that space | The route resolved the space (its name is the placeholder). |

### `settings.spec.ts` — settings pages
| Test | Defends |
|---|---|
| space settings renders the admin form with the space's data | Admin branch renders and the name input is bound to materialised metadata. |
| space settings exposes its navigation tabs | The settings tab links render. |
| the members page lists the space's members | The members route + `getMembers` render. |
| user settings renders its sections | `/user/settings` renders Theme and Left Spaces. |
| the space index route renders instead of the settings panel | `/[space]` is the board, not a redirect into settings. |

### Deliberate-break evidence (acceptance criterion 2)

Demonstrated, not asserted, on 2026-09-25:

1. **Stubbed out `sendEvents`** (the client's only write path).
   → `a sent message survives a reload` **failed**.
   → `the sent message appears in the room` and `submitting clears the composer`
   still **passed** (they only observe the optimistic placeholder).
   This is the discriminating result: it proves the persistence test is the one
   defending real end-to-end delivery, and that a "passing" optimistic test is
   not mistaken for coverage of the write path.
2. **Emptied `getSpaces`' result** in the appserver handler.
   → `lists the joined space in the sidebar` and `navigating into the space
   shows its channel` **failed**.
   → `entering the channel renders its messages and composer` and the 404-guard
   test still **passed** (direct room navigation does not go through the space
   list).

Both breaks were reverted; the suite is green.

---

## 3. Not covered yet — the phase-2 backlog

Ordered by value-per-effort. "Blocked by" names what must exist first.

### A. Message lifecycle (highest value — this is what the app *is*)
Requires the `data-message-id` hook noted above for precise addressing.
- Edit a message → edited body renders, `edited` marker shows. — *blocked by: row hook*
- Delete a message (author + admin paths) → row disappears, survives reload. — *blocked by: row hook*
- Reply to a message → reply context renders on the new row. — *blocked by: row hook*
- React to a message → reaction appears and persists. — *blocked by: row hook*
- Forward a message to another room → embed renders in the target room.
- Move messages (admin) → rows relocate, originals gone.
- Send with Enter vs Send button → identical bodies (both route through `submit()`).
- Failed send → "Not sent" marker + retry/discard affordances.
- Multi-line / markdown-ish input → blocks render (bold, code, lists, links).
- Composer draft recall per room (keyed remount on room switch).

### B. Room kinds and board views
- Thread room: creation from the composer menu, then chat renders.
- Channel tabs: Chat / Threads / Links (Links is `links-view`-flagged).
- Space index board (`/[space]`) lists threads with activity — currently only
  asserted to render, not that it lists the seeded channel.
- Unread indicators: unread badge on a room with unseen messages.

### C. Space administration
- Create a space (`/new`) — note this needs PLC or an arbiter stub, so it is a
  harness extension, not just a spec.
- Space settings edit: rename, change description, toggle join policy → persists.
- Leave space → space disappears from the sidebar.
- Rejoin from `Left Spaces` in user settings.
- Roles/permissions: create role, assign member, restrict a channel.
- Members: invite, ban, unban.
- Invites: create an invite link.
- Handle settings, federations, Discord bridge, integrations — each is
  flag-gated, so each needs the flag enabled in the seeder's fixture.

### D. Search depth
- Message search — *blocked by: a Qdrant instance (or a stub) in the harness.*
- Room search within a room-scope (`/[space]/[room]/search`).
- Result click navigates to the message (`?message=` deep link + highlight).
- Scope-expansion link ("Search in all your spaces").

### E. Profile & identity
- Profile page `/user/[user]` renders display name/handle; edit own profile.
- Mention typeahead in the composer inserts a DID mention and renders it.
- User-menu actions: theme toggle, settings link, log out.
- Log out → login modal returns; log back in works.

### F. Shell / cross-cutting
- Mobile viewport project (the sidebar is a drawer below 640px; the navbar
  search collapses to the icon). Currently only desktop Chromium.
- Sync WebSocket: a live `#messageDiff` from a second client updates the room
  without a reload (needs a second browser context).
- Deep links / share URLs.
- Service-worker & offline behaviour.
- Push notification permission flows (browser-permission dependent).

---

## 4. Phase-2 dispatch notes

- **One spec file per area** (A–F), mirroring the current layout.
- **Add fixtures, not sleeps.** The suite forbids `waitForTimeout` as
  synchronisation; wait on locators or `expect.poll`. If a new area needs
  something that is not yet observable, add the hook to app-lite rather than
  weakening the assertion.
- **Keep the stack hermetic.** Anything requiring a new external service
  (Qdrant for message search, PLC for space creation) must be stubbed in
  `launch-stack.ts` the way the PDS is — not reached over the network.
- **Each new test must name the behaviour it defends**, and phase 2 should
  repeat the deliberate-break check for any test that claims to cover a write
  path: an assertion that would still pass with the feature deleted is not
  coverage.

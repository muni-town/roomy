# Merge `docs` + `appserver-admin` into one interactive docs site

**Date:** 2026-09-09
**Status:** Draft
**Related:** `appserver-architecture.md`, `client-migration-plan.md`
**Packages:** `packages/docs` (deleted), `packages/appserver-admin` (renamed → `packages/docs`)

---

## Context

Roomy currently ships two small SvelteKit sites:

- **`packages/docs`** — a static, prose-heavy API reference (Overview, Architecture, Authentication, Sync Protocol, Database Schema, and a hand-maintained endpoint catalogue in `src/lib/endpoints/registry.ts`). No auth, no live calls.
- **`packages/appserver-admin`** — an authenticated admin tool: a dashboard (activity/system/per-space stats) and an XRPC playground (typed call helpers, WebSocket sync console, push diagnostics, feature-flag management). Login is gated to an admin allowlist (`PUBLIC_APPSERVER_ADMIN_DIDS`).

We want one site, named **`docs`**, that is an *interactive documented catalogue* of the Roomy API: anyone can log in with any ATProto identity and try any endpoint; admin-only endpoints simply fail with the server's 403 for non-admins. The dashboard stays, moved to `/dashboard`. The appserver-admin codebase is the better starting point (auth, XRPC client, playground, design-system styling); the docs content moves into it, then the package is renamed `docs` and the old `packages/docs` is deleted.

**Why this is the right shape:** the docs' endpoint registry is already stale — it documents ~38 of the ~56 NSIDs actually registered in the appserver router (missing `sendEvents`, `updatePolicy`, `reorderSpaces`, `getUserAccess`, bridge tokens, `federation.*`, `search.*`, `mention.getMentions`, `embed.getLinkMetadata`, `sync.getEvents`, `user.getMembershipStatus`, `admin.getSpaceMembership`, …). A hand-maintained catalogue cannot keep up. The merged site should derive the catalogue from the appserver itself (see "Registry generation" below), and the interactive "Try it" panel makes the catalogue self-verifying: if an endpoint is documented, it can be called.

---

## Goals

1. One site, one package (`packages/docs`), one deployment.
2. Anyone with an ATProto identity can log in and call any endpoint from its documentation page. Admin endpoints return the server's 403 for non-admins — surfaced gracefully in the UI.
3. Dashboard preserved as-is at `/dashboard`, admin-gated.
4. Readable, explorable, concept-first documentation that explains *how Roomy works*, not just what the endpoints are.
5. Good DX for two audiences: contributors (appserver internals, materialisation, invalidation) and hackers building their own clients/integrations (concepts, auth, sync, quickstart).
6. The endpoint catalogue stops being hand-maintained drift: generated skeleton + hand-written prose, with a CI check that the catalogue matches the router.

## Non-goals

- No changes to the appserver's XRPC surface (the interface is the contract; this plan only documents and exercises it).
- No changes to app-lite.
- No new auth mechanism: reuse the existing OAuth + service-auth flow from appserver-admin.

---

## Information architecture

### Site map

```
/                          Home — what Roomy is, the mental model, quick links
/quickstart                Build your first client in ~10 minutes (curl + SDK)
/concepts                  Concept hub
  /concepts/spaces         Spaces, membership, admin ⊥ membership, invites
  /concepts/rooms          Channels, threads, pages, read state, unread counts
  /concepts/messages       Messages, reactions, media, forwarding, mentions
  /concepts/real-time      The sync protocol: one multiplexed WebSocket, CBOR frames
  /concepts/auth           Service-auth JWTs, WebSocket tickets, scopes
  /concepts/data-model     Events → materialised views (was /schema)
/endpoints                 The interactive catalogue (grouped index)
/endpoints/<nsid>          Endpoint page: docs + "Try it" panel
/playground                Raw power tools (WS console, push diagnostics, flags)
/dashboard                 Admin dashboard (admin-gated)
/contributing              Appserver internals for contributors
```

### Rationale

- **Concept-first, not endpoint-first.** The current docs lead with architecture and a flat endpoint list. New developers need the *model* first: spaces contain rooms; rooms contain messages; everything is an event; the appserver materialises events and pushes diffs over one WebSocket. Concepts are grouped under one hub so the sidebar stays shallow and new concept pages (e.g. federation, search, embeds) slot in without restructuring.
- **`/endpoints/<nsid>` is the heart of the site.** Each endpoint page is both reference and playground: the documentation (description, auth requirements, params, input/output schema, notes, invalidation) plus a live "Try it" panel. This is what makes the docs *interactive* — the catalogue is the playground, per-endpoint.
- **`/playground` stays** as the power-user surface: raw NSID picker, arbitrary params, the WebSocket sync console, push diagnostics, feature flags. It is the "advanced" tool; the endpoint pages are the guided tool.
- **`/dashboard` is unchanged** in function, moved from `/`. It is admin-gated (see Auth below).
- **`/contributing`** absorbs the implementation-detail content (materialisation, invalidation, DB schema, the transitional-Bun/Rust note) for contributors, keeping the public-facing docs concept-focused.
- **URL stability:** the old docs site is deleted, so old `/architecture`, `/auth`, `/sync`, `/schema` URLs are not preserved. (If a redirect is wanted, a static `_redirects`/Caddy rewrite from the old paths to the new concept pages is a one-liner — recommended for a short grace period.)

### Navigation

Left sidebar (docs-style, from `packages/docs/src/lib/components/Sidebar.svelte`), restructured:

```
Roomy Docs
├── Home
├── Quickstart
├── Concepts
│   ├── Spaces
│   ├── Rooms
│   ├── Messages
│   ├── Real-time
│   ├── Auth
│   └── Data model
├── Endpoints            (grouped, collapsible — registry-driven)
│   ├── Auth
│   ├── Spaces
│   ├── Rooms
│   ├── Messages
│   ├── Users
│   ├── Sync
│   ├── Push
│   ├── Feature Flags
│   └── Admin
├── Playground
├── Dashboard            (admin only — hidden for non-admins)
└── Contributing
```

Top bar (appserver-admin style): brand, search (see below), auth state (sign in / DID / sign out), dark-mode toggle.

### Search

Add client-side search over the endpoint catalogue (NSID, description, group) and concept pages. The repo already has `flexsearch` as a root devDependency (used by the legacy app) — reuse it, or a simple index built at build time from the registry. Search is a first-class DX feature for a catalogue of 50+ endpoints.

---

## Auth model

### Current (appserver-admin)

`src/lib/auth.svelte.ts` calls `initSession()` from `@roomy-space/sdk/browser`, then **rejects any DID not in `PUBLIC_APPSERVER_ADMIN_DIDS`** (`authError = "DID … is not on the admin allowlist"`). The OAuth client metadata (`scripts/build-prod.sh`) requests scopes for read queries + admin RPCs, and is named "Roomy Admin".

### Target

- **Anyone can log in.** Remove the allowlist gate from `init()`. Any valid ATProto identity authenticates.
- **Admin detection becomes a capability, not a gate.** Keep `ADMIN_DIDS` (from `PUBLIC_APPSERVER_ADMIN_DIDS`) as an `isAdmin` flag on the auth store. It drives UI only: show/hide the Dashboard nav item, badge admin endpoints, and pre-fill admin-only tool sections. It must never be the security boundary — the appserver's own admin allowlist (`APPSERVER_ADMIN_DIDS`) is.
- **Admin endpoints fail naturally for non-admins.** The appserver returns 403 (`AuthRequired`/`Forbidden`) for non-allowlisted callers. The "Try it" panel and playground already render errors; add a friendly "This endpoint is admin-only — you'll get a 403 unless your DID is on the appserver's admin allowlist" hint on admin endpoint pages.
- **OAuth scope must cover every endpoint** so "try any endpoint" works: add the write procedures (`sendEvents`, `createSpace`, `joinSpace`, `leaveSpace`, `setHandle`, `updatePolicy`, `reorderSpaces`, `updateSeen`, push procedures, bridge-token procedures) and the remaining queries to the scope string in `build-prod.sh`. **Derive the scope string from the registry** (see below) so it can't drift. Rename the OAuth client to "Roomy Docs" (`client_name`, `client_uri`, `logo_uri`).
- **Tradeoff to note:** requesting write-procedure scopes widens what the PDS consent screen shows. Acceptable for a developer tool; the scope is the client's own declared scope, and the appserver still enforces per-endpoint authz.

### Dashboard gating

`/dashboard` calls admin endpoints (`getDashboardStats`, `listSpaces`). For non-admins: either gate the route client-side on `isAdmin` (show an "admin only" screen) or let the calls 403 and render the error state. **Recommendation:** gate client-side on `isAdmin` for a clean UX, but keep the 403 error state as the fallback (the server is the real boundary). The dashboard itself is unchanged.

---

## The interactive endpoint catalogue

### Registry generation (kills the drift)

The current `registry.ts` is 871 lines of hand-maintained data, already missing ~18 endpoints. Replace it with a **hybrid registry**:

1. **Generated skeleton** — a build-time script (`scripts/generate-registry.ts` in the docs package) that:
   - imports `getRegisteredNsids()` from the appserver (or, simpler and dependency-free, reads the router registration list from a checked-in JSON emitted by the appserver build), giving the authoritative NSID + kind list;
   - reads the SDK's `schemas` module (`packages/sdk/src/schemas/queries|procedures/*`) for each NSID's `Params`/`Input`/`Output` arktype schemas and introspects them (arktype supports schema introspection) to emit params/input/output structure;
   - emits `src/lib/endpoints/registry.generated.ts`.
2. **Hand-written prose** — `src/lib/endpoints/prose.ts` keyed by NSID: description, notes, invalidation, examples, "Try it" hints. The existing registry's prose is the seed; the ~18 missing endpoints get prose written once.
3. **Merge at build time** — generated skeleton + prose → the `endpoints` array the UI consumes.
4. **CI check** — a script that fails if any registered NSID lacks prose or if the generated skeleton is stale (compare against a committed snapshot). This is the mechanism that keeps the catalogue complete.

**Fallback (simpler):** if importing appserver code into the docs build is undesirable, commit the generated skeleton JSON and regenerate it in CI (a workflow step that runs the generator and fails on diff). Either way the catalogue stops being hand-maintained.

### Endpoint page anatomy

```
/endpoints/space/roomy/space/getSpaces
├── Header: NSID, kind badge (query/procedure/sync), auth badge (public/authenticated/admin)
├── Description (prose)
├── Auth requirements (from registry)
├── Parameters / Input schema (generated, rendered as a form or table)
├── Response schema (generated)
├── Notes (prose)
├── Invalidation signals (prose)
└── "Try it" panel
    ├── Form generated from params/inputSchema (typed inputs; JSON editor for complex bodies)
    ├── Run button → calls the endpoint via the existing DirectXrpcClient with the logged-in agent
    ├── Response viewer: pretty JSON, latency, error rendering (incl. 403 for admin endpoints)
    └── "Copy as curl" / "Copy as SDK call" snippet
```

The "Try it" panel reuses the playground's call machinery (`src/lib/xrpc.ts`): a generic `callEndpoint(agent, nsid, params, body)` helper replaces the hand-rolled per-endpoint helpers for the catalogue (the typed helpers stay for the dashboard/playground where they're convenient).

### Playground

Keep the existing playground page largely as-is (it is the power tool), with two changes:
- the NSID picker becomes registry-driven (all endpoints, not the current 8-entry `NSIDS` constant);
- admin-only sections (push diagnostics, feature flags) get the `isAdmin` treatment: visible to admins, hidden or clearly marked for non-admins.

---

## Content plan

### Move from `packages/docs` (with reframing)

| Old page | New home | Change |
|---|---|---|
| `/` Overview | `/` Home | Rewrite: what Roomy is, the mental model, quick links. Keep the API-surface table (now registry-driven). |
| `/architecture` | `/concepts/*` + `/contributing` | Split: system diagram + data flow → concepts; implementation stack, directory structure, migration status → `/contributing`. |
| `/auth` | `/concepts/auth` | Keep, reframe for client authors (how to get a token, scopes, ticket flow). |
| `/sync` | `/concepts/real-time` | Keep, reframe: frames, topics, cursor, reconnection. |
| `/schema` | `/concepts/data-model` | Reframe: events → materialised views → queries. DB table details move to `/contributing`. |
| `/endpoints` + `/endpoints/[...nsid]` | `/endpoints` + `/endpoints/<nsid>` | Add "Try it" panel; registry becomes generated+prose. |

### New content

- **`/quickstart`** — the DX hook: "log in, call `getSpaces`, subscribe to a room, send a message" in ~10 minutes, with curl and SDK snippets. Links into concepts and the endpoint pages.
- **`/concepts/spaces`, `/concepts/rooms`, `/concepts/messages`** — the domain model, written for client authors: what the objects are, how access control works (admin ⊥ membership, roles, invites, bans), what unread counts mean.
- **`/contributing`** — appserver internals: materialisation pipeline, invalidation signals, DB schema, the transitional Bun→Rust note, how to run the stack locally (`dev-local`), how to add an endpoint (and therefore how the catalogue stays in sync).

### Tone

- Concept pages: plain-language, diagram-first (ASCII/mermaid), "why" before "how".
- Endpoint pages: reference-dense but with a working example in the "Try it" panel — the example *is* the documentation.
- Fun/DX: working examples everywhere, copyable snippets, a "you can do this right now" energy. No marketing copy.

---

## Implementation plan

### Phase 0 — Baseline (no user-visible change)

1. `git mv packages/appserver-admin packages/docs` (rename the package; keep git history).
2. Update `package.json`: name → `docs`, dev port → 5300 (match the old docs port; update `scripts/run-docs` and `scripts/dev-admin` accordingly — or keep 5200 and update `run-docs`; pick one, standardise).
3. Merge dependencies: docs brings `@tailwindcss/typography` (prose plugin) and `@iconify-json/*`; appserver-admin brings `@roomy/design`, `@roomy-space/sdk`, `@tanstack/svelte-query`, `@atcute/cbor`, `@atproto/api`. Merged package needs all.
4. Merge `app.css`: appserver-admin's theme (pink accent, `@source "../node_modules/@roomy/design"`) + docs' typography plugin and `.prose` styling. Keep the appserver-admin theme as the base (per the task: its styling is the starting point).
5. Delete old `packages/docs` (its content moves in Phases 1–2).
6. Update references: `pnpm-workspace.yaml`, `turbo.json` (`build-docs` task now builds the merged package; drop `build-appserver-admin`), `Dockerfile.docs` (now needs SDK + design + typography deps — mirror `Dockerfile.appserver-admin`'s multi-package build), `.dockerignore`, `scripts/wt-setup` (env packages list), `AGENTS.md` structure notes.
7. `pnpm install` + `pnpm --filter docs build` green.

### Phase 1 — Auth: anyone can log in

1. `auth.svelte.ts`: remove the allowlist gate; add `isAdmin` derived from `ADMIN_DIDS`.
2. `build-prod.sh`: scope string derived from the registry (all endpoints); client metadata renamed "Roomy Docs".
3. Dashboard route: gate on `isAdmin` (client-side) with 403 fallback.
4. Playground: admin sections gated on `isAdmin`.

### Phase 2 — Catalogue: generated registry + "Try it"

1. `scripts/generate-registry.ts` (skeleton from appserver `getRegisteredNsids` + SDK schemas) + `prose.ts` (seed from current registry, write prose for the ~18 missing endpoints).
2. `EndpointDetail.svelte` + new `TryIt.svelte`: form from params/inputSchema, run via `callEndpoint`, response/error viewer, copyable snippets.
3. Generic `callEndpoint(agent, nsid, params, body)` in `xrpc.ts`; registry-driven NSID picker in the playground.
4. CI check: catalogue completeness + staleness.

### Phase 3 — IA: routes, nav, content

1. Restructure routes per the IA above; rewrite `Sidebar.svelte`; top bar with search + auth state.
2. Move/reframe docs content (table above); write `/quickstart`, `/concepts/*`, `/contributing`.
3. Home page rewrite (registry-driven API-surface table).

### Phase 4 — Polish & deploy

1. Search (flexsearch), dark mode, empty/error states, 403 hints on admin endpoints.
2. Deploy: one Dockerfile, one domain (docs.roomy.space or the existing docs domain), Caddyfile unchanged (SPA fallback).
3. Old-docs redirects (optional, short grace period).

---

## Risks & decisions

- **Registry drift is the main risk** — solved by generation + CI check (Phase 2). Without it, the merged site inherits the current staleness.
- **OAuth scope breadth** — requesting all RPC scopes widens the consent screen. Accepted tradeoff for a dev tool; the appserver still enforces authz.
- **`isAdmin` is UI-only** — must be documented in code so nobody treats it as a security boundary.
- **Port choice** (5200 vs 5300) — trivial; standardise on one and update the dev scripts.
- **SSR vs CSR** — prose pages can stay SSR (prerendered by adapter-static); interactive pages keep `ssr = false`. Mixed works with the existing `fallback: "index.html"` adapter config.
- **Admin endpoints in the catalogue** — they stay documented and callable; non-admins see the 403 with a hint. This matches the task ("admin only endpoints won't work for non-admins").

## Verification

- `pnpm --filter docs check` (svelte-check) and `pnpm --filter docs build` green.
- CI catalogue check passes with the full 56-endpoint surface.
- Manual: log in as a non-admin, call a public endpoint (200), call an admin endpoint (403 rendered), open `/dashboard` (admin-only screen), open `/playground` (WS console works).
- Old `packages/docs` gone; no dangling references (`grep -r "appserver-admin"` clean except historical plan docs).

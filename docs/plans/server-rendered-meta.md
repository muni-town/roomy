# Server-Rendered Metadata — Design Plan

**Date:** 2026-10-14
**Status:** M1 + M1b (the server-side read path for `[space]`, `[space]/[room]`,
`user/[user]` and `join/[[spaceRef]]`) merged as `#456` and reverted by PR #495:
a `+*.server.ts` load in an `adapter-static` build makes every navigation fetch
`__data.json`, the static host answers with the HTML shell, and the navigation
never completes. The loads land with the server build. M2 onward is not started:
nothing here has been deployed as a server build.
**Next:** M2 (§7) — a server build that runs and is deployed. M1 is not
observable in production until M2 exists, so the two ship as one delivery; M3a
and M3 follow, M4 and M5 alongside.
**Scope:** Server-rendered `<head>` for public spaces and their rooms (short
term), plus the groundwork for an anonymous read-only view (medium term).
"SSR everywhere" is out of scope.
**Verified against:** `origin/next` @ `7d2b64b9` (the working tree the probe
ran on was `0e39b3cb`; the files this plan names are unchanged between them).
**Packages:** `packages/app-lite` (M1–M4), `packages/appserver` (M1 helpers,
M5 registry). No new service.

---

## 0. What this document is

**The question.** To what extent can Roomy be server-rendered? Answer: the
appserver already serves public-space reads to anonymous callers, and the
SvelteKit app already compiles and runs a server pass — but every view fetches
through an authenticated client that does not exist until the browser has
booted, so today's server pass renders a login overlay and nothing else. The two
goals that follow from that are:

1. **Short term — better OG metadata.** Per-space (and per-room) unfurls.
   Today `https://roomy.space/<space-did>` unfurls with the site-wide
   `roomy-og.png` card and the title "Roomy"; a chat client or crawler sees no
   space name, description or avatar. `packages/app-lite/src/app.html:11-33`
   records this as a known gap in a comment.
2. **Medium term — improved initial load.** A visitor (signed in or not) gets a
   real document for the space they asked for instead of a shell plus an auth
   overlay, and the boot work that is not needed to paint is deferred.

**Out of scope.** Full SSR everywhere. Rendering the timeline, the sidebar, the
composer, or any authenticated view on the server is not attempted and this
plan builds nothing toward it. The root layout stays `ssr = false`; the app
remains a client-rendered SPA that gains a server-rendered head and, later, a
read-only content path for public spaces.

**What was verified, not assumed.** A throwaway worktree (branch off
`0e39b3cb`, all `ssr = false` removed from the `[space]` subtree, a stub
`adapter-node`) was built and driven with real requests, anonymously, against
the production appserver. Results, all reproduced:

- `vite build` with SSR enabled **succeeds** and emits a real server bundle
  (`.svelte-kit/output/server/{index.js,manifest-full.js,nodes/,entries/}`). It
  needs `NODE_OPTIONS=--max-old-space-size=4096`; the default 2 GB heap OOMs.
  `netlify.toml` already sets 4096.
- A `[space]/+page.server.ts` doing a plain `fetch` to
  `https://api.roomy.space/xrpc/...` **with no Authorization header** returned a
  public space's metadata, and the server-rendered head carried it:
  `<title>Roomy Space - Roomy</title>`,
  `og:description="The official Roomy space for Roomy itself!"`.
- The same shape works at `[space]/[room]`: `og:title="general"` for a channel
  in an open space, and the invite-only space's room resolved to nothing (403
  from the appserver, so the tags fell back). The public/invite-only boundary is
  therefore enforced by the appserver, not by app code.
- Without any `load()`, the SSR pass renders the root layout's auth overlay
  (`Signing you in…`) over an empty main — confirming that turning SSR on alone
  buys nothing for content.

---

## 1. The two layers, and why they differ

| Layer | State | Anchor |
|---|---|---|
| **Appserver** — anonymous reads of public spaces | Exists, unchanged | `src/xrpc/auth.ts` (no `Bearer` → `{ did: null }`), `src/xrpc/authGuards.ts:81` |
| **Appserver** — enumerating public spaces | Does not exist | `handlers/space.roomy.space.getSpaces.ts` returns `{ spaces: [] }` for `did === null` |
| **app-lite** — data on the server | Does not exist | no `load()` in the repo returns data; `px()` throws until `init()` (`lib/auth.svelte.ts:713-714`) |
| **app-lite** — deployability | Static only | `svelte.config.js` uses `adapter-static`; `Caddyfile` is `file_server` + `try_files`; `netlify.toml` publishes a directory |

The appserver half is done. The work is a server-side read path in app-lite and
a document-serving target for it.

### 1.1 The anonymous read surface, measured

Verified against `api.roomy.space`, no `Authorization` header, with a public
space (`did:plc:gnwy2zbm3hu4gfdawzxmpb2s`, Roomy Space) and an invite-only one
(`did:plc:drzgt2m6lmcel62gfbzjeap3`):

| NSID | Anonymous, public | Anonymous, invite-only |
|---|---|---|
| `space.roomy.space.getMetadata` | 200 — name, description, avatar, joinPolicy | 200 — same fields, `allowPublicJoin: false` |
| `space.roomy.space.getSpaceSummary` | 200 — name, avatar | 200 — name, avatar |
| `space.roomy.space.getThreads` | 200 — channel/thread list with names | 403 |
| `space.roomy.room.getMetadata` | 200 — `canRead: true` | 403 |
| `space.roomy.room.getMessages` | 200 | 403 |
| `space.roomy.user.getProfile` | 200 | 200 |
| `space.roomy.space.getSpaces` | `{"spaces":[]}` | `{"spaces":[]}` |

The gate is `allowPublicJoin`, and NULL is treated as open
(`src/auth/access.ts:209`: `coalesce(allow_public_join, 1)`). Read access is
`(publicJoin || isMember) && defaultAccess !== 'none'` (`access.ts:479-483`).
`getMetadata` is deliberately ungated on membership so the join UI can render
for invite-only spaces — its comment at `handlers/space.roomy.space.getMetadata.ts:110-117`
says so — which is why a private space's name, description and avatar are
already public. **No new endpoint is required for M1.**

---

## 2. M1 — Server-rendered meta for spaces and rooms

**Goal.** A crawler, chat unfurl or non-JS client fetching
`/<space-did>` or `/<space-did>/<room-ulid>` receives HTML whose `<head>` names
the space (or room) and whose `og:image` is that space's avatar.

**Shape.** Per-route `+page.server.ts` loads that read the appserver
anonymously. No adapter change, no change to the client-side app.

### 2.1 A shared anonymous fetch module

New file `packages/app-lite/src/lib/server/public-space.ts` — `$lib/server`,
which SvelteKit forbids from the client bundle, so the seam is enforced by the
bundler rather than by convention:

```ts
/** Anonymous XRPC GET — the public-space read path, no Authorization header. */
async function xrpc<T>(nsid: string, params: Record<string, string>): Promise<T | null>;
```

Two rules it must carry:

- **Never forward the caller's cookies or Authorization.** A server `fetch` with
  no explicit headers is already credential-free, and this is why the module
  must not be given the authenticated client: the whole point is that the
  response is safe for anyone, and `cache-control: public` on the document
  downstream depends on it.
- **Degrade to `null`, never throw.** A space that does not exist, an
  invite-only space, a rate limit and a network failure are one outcome for the
  head: fall back to the site defaults in `app.html` and serve the SPA. The
  document must be served in every case.

Add the appserver origin to the resolved config rather than re-deriving it:
`CONFIG.appserverHttpOrigin` is currently `null` in production and the origin is
only known after DID resolution (`lib/appserver-origin.ts`). The server needs a
value at request time, so M1 adds a server-side resolver — `APP_SERVER_HTTP_ORIGIN`
env, then DID resolution, cached per process. This is the one piece of M1 that
is genuinely new plumbing.

### 2.2 `[space]` — the primary target

`packages/app-lite/src/routes/[space]/+page.server.ts` (new), and remove
`export const ssr = false;` from `+layout.ts:5`.

The existing `load` in `+layout.ts` already rejects a non-DID first segment
with a 404 before the layout mounts. Keep it. The server load then:

1. `space.roomy.space.getMetadata` → `name`, `description`, `joinPolicy`.
   `getSpaceSummary` is the cheaper alternative (one row, no access fan-out) and
   returns name + avatar, but not the description; the description is what makes
   an unfurl readable, so M1 uses `getMetadata` and takes the
   `CACHEABLE_NSIDS` entry (`src/cache/index.ts:42`) as the cost ceiling — it is
   already cached for 60 s by default.
2. `og:image` from the avatar. `resolveBlobUrl` (`lib/utils.ts:20`) is pure and
   already maps `atblob://<did>/<cid>` to
   `https://cdn.bsky.app/img/feed_fullsize/plain/<did>/<cid>`; that CDN answered
   200 `image/webp` for a real space avatar when checked. A relative or
   unresolvable avatar falls back to `roomy-og.png` — an `og:image` must be
   absolute.
3. `og:url` from the request origin, not the document: the SvelteKit server
   knows the deployment origin, which is what `share-url.ts:48` (`resolveShareOrigin`)
   does for the client. Reuse that rule rather than re-inventing it.

**Emit the tags server-side, and keep SeoMeta too.** `SeoMeta`
(`lib/components/seo/SeoMeta.svelte`) already owns the tag shapes, and the
comment at `app.html:11-33` documents why the site defaults are static: a
crawler never runs the bundle. M1 keeps both — the server emits a
per-space set, and `SeoMeta` keeps updating the head on client-side navigation
(the sidebar's `SeoMeta` at `[space]/+layout.svelte:107` is what makes a title
change when you switch spaces without a reload). Do not remove the static
defaults from `app.html`; a head with two `og:title` tags is already how the
static-default and runtime pair behaves today, and crawlers take the first.

**A gotcha worth writing down.** During the probe, the space route rendered its
server title correctly while the room route's `<title>` was overwritten back to
`Roomy` — a static `<title>Roomy</title>` in `app.html` and a later
`<svelte:head>` from the client disagreeing about which tag wins. M1 should
assert the *rendered document*, not the component: a test that fetches the built
route and reads `</head>` (M4) is the only thing that catches this class of bug.

### 2.3 `[space]/[room]` — the secondary target

`+page.server.ts` (new), plus `og:title`/`og:description` for the room.

The room needs the space for context (`"general — Roomy Space"`), so the load
takes `parent()` for the space fields and adds
`space.roomy.room.getMetadata` for the room. The appserver answers 403 for a
room in an invite-only space and 404 for a nonexistent ULID, so the tags fall
back and the client renders as it does today. Room URLs are ULIDs, not names —
there is no slug route, and `[room]/+layout.ts` rejects a non-ULID before the
page mounts. A shareable room URL that reads as words is a separate question and
is not solved here.

### 2.4 `user/[user]`, `join/[[spaceRef]]`

- **`user/[user]`** — profile unfurls. `space.roomy.user.getProfile` takes no
  auth at all (its handler ignores `_auth`), so the server load is the same
  shape. Worth folding into M1: a profile link is shared as often as a space
  link, and the code is a copy of §2.2 with a different NSID. Note that the
  avatar for a Bluesky-native profile is already an `https://cdn.bsky.app/...`
  URL and needs no mapping.
- **`join/[[spaceRef]]`** — invite links. The ref may be a handle, and resolving
  a handle needs `resolveSpaceRef` (`lib/space-ref.ts`), which calls the Leaf
  resolver `https://resolver.roomy.chat/xrpc/town.muni.leaf.resolveHandle` —
  reachable server-side with no credentials (`access-control-allow-origin: *`).
  A join link's unfurl is the invitation's first impression, so this is the
  third-highest-value route. It is also the one with a real failure mode: an
  invite link for an invite-only space *should* name the space (that is the
  point of the link), and `getMetadata` gives it to us for exactly that reason
  (§1.1). Keep it as a follow-on inside M1 rather than expanding the first slice.

---

## 3. M2 — Serve the document

M1's loads only matter if something runs them. The build has to stop being a
directory of files.

### 3.1 Two builds, one source tree

`adapter-static` and `adapter-node` cannot both own `svelte.config.js`. The
choices, in order of how much they disturb the current pipeline:

1. **`ADAPTER` env switch in `svelte.config.js`.** `process.env.ADAPTER === "node"
   ? nodeAdapter() : staticAdapter({...})`. `build-prod.sh` already branches on
   env (`OAUTH_HOST`, `HAPPYVIEW_JWKS_URI`), so this fits the existing shape, and
   the Tauri build keeps taking the static branch. Cost: one config file with
   two modes, and every existing assertion in `build-prod.sh` about
   `build-staging/index.html` has to know which mode produced the directory.
2. **A second SvelteKit config** (`svelte.config.server.js`) and a separate
   build script. More files, but each config stays honest about what it emits —
   which matters because the two artifacts are genuinely different products
   (see §3.3).

**Recommendation: (2).** The static build is not a fallback for the server
build; it is the Tauri payload and the Netlify deploy, and it should keep
failing loudly if a route stops being prerenderable. An `ADAPTER` switch makes
the static path's guarantees conditional on an env var nobody sets locally.

### 3.2 The runtime

`adapter-node` emits a Node server; the repo's servers are Bun. Both work
(`node build/index.js` under the existing `node:22` image), but the cheaper
answer is to keep the container the same shape: build with `adapter-node`,
serve with `node`. Do not try to host this inside `packages/appserver`: its
`Bun.serve` fetch handler has no HTML path (`src/appserver.ts:1115-1307` is
health, metrics, blob, webhooks, then the XRPC router), and mixing a SvelteKit
handler into it would put the appserver's release cadence and the client's in
the same binary. They are deployed separately today and should stay that way.

### 3.3 What changes in the deploy path

| Target | Today | With the server build |
|---|---|---|
| Railway / `Dockerfile.app-lite` → Caddy | `FROM caddy:alpine`, `file_server`, `try_files {path} /index.html` | `node build/index.js` behind Caddy, or replace the Caddy stage with a Node stage. `/oauth-client-metadata.json` becomes a served route rather than a file in the image. |
| Netlify (`netlify.toml`) | `publish` a directory, `/* → /index.html 200` | Netlify Functions, or keep Netlify on the static build and let Railway carry the server. The `[[redirects]]` SPA fallback must not swallow the server routes. |
| Tauri (`src-tauri/tauri.conf.json`, `frontendDist: ../build-staging/`) | local assets | **Unchanged** — the native shell keeps the static build. Its `navigation.rs` policy and the `space.roomy:` OAuth deep link are unaffected. |
| Service worker (`src/service-worker.ts`) | precaches the build manifest; network-first for same-host documents, `404` on a cache miss | Needs review. It was written for a static shell: a server-rendered document is a same-host response it will cache network-first, which is fine, but its miss path answers `404` and the precache list is the static manifest. |

Build time is the quiet cost: the probe's SSR-enabled build took 6m50s and
needs a 4 GB heap. `netlify.toml` sets `NODE_OPTIONS=--max-old-space-size=4096`
already; the CI job's `timeout-minutes: 20` (`.github/workflows/netlify.yml`)
has room but has to be re-checked.

---

## 4. M3 — Initial load

M2 alone does not improve load. With SSR on and no `load()` returning data, the
first paint is still the auth overlay over an empty shell — measured, §0. The
gains available, in increasing complexity:

**a. Boot work off the critical path.** The root layout's `onMount`
(`routes/+layout.svelte:55-129`) does eleven things before the app is usable:
error recovery, Faro, `init()`, last-login, push listeners, scroll restore,
sidebar preload, external-link handler, updater. Only `init()` gates the first
paint. The rest can be sequenced — after first paint, or after auth settles
(some already are: `preloadSpaceSidebars` waits behind a 250 ms interval). This
is the cheapest real win and needs no server.

**b. The boot closure.** Measured from the built manifest, the root-layout chunk
closure is **1882 KB raw / 521 KB gzip across 68 chunks**; the space index is
1838 KB / 506 KB gzip. The initial document preloads only 11 modules (35 KB over
the wire), so the large closure is fetched lazily as route nodes import — the
cost lands as a delay before the space renders, not before first byte. The two
large chunks are the app's own bundled vendor code (atproto, arktype, Svelte
runtime, query client), and `livekit-client`, Faro, TipTap and virtua are
already dynamically imported, so they are not the problem. The next step is a
measurement (M3a), not a guess.

**c. Server-rendered content for public spaces.** The real improvement: a
visitor — signed in or not — gets the space's name, description, channels and
first messages in the HTML. This needs:

- A **guest read path** in the client: `px()` (`lib/auth.svelte.ts:713`) throws
  until `directXrpc` exists; `pxUnauth()` (`lib/client.ts:41`) already returns a
  credential-free `DirectXrpcClient` and is used today only for
  `space.roomy.auth.getLoginScope`. 22 of the 24 query modules call `px()`
  directly, so this is a real refactor: a `readClient()` that resolves to the
  authenticated client when there is a session and the anonymous one otherwise,
  with the anonymous path restricted to the NSIDs in §1.1.
- **Suppressing the auth overlay** for a server-known public view.
  `requireAuth` (`lib/components/layout/auth-guard.svelte.ts`) already exists as
  an opt-out seam, but `+layout.svelte:152` sets it back to `true` on *every*
  navigation, so an opt-out has to be re-established per route.
- **Hydration agreement.** The server-rendered content must be what the client
  renders first, or Svelte discards and re-renders it — which costs more than
  not rendering it.

Each of these is a design question of its own. M3 is deliberately left as a
direction with a measurable first step, not a specced slice: its size depends on
what M3a measures.

---

## 5. M4 — Testing, and what guards each milestone

The repo's rule is that a test earns its place by failing on a plausible bug.
The bug class here is specific: **a tag that exists in a component but not in
the served document.** `lib/og-tags.test.ts` already tests exactly this for the
static defaults, and its comment records the incident — the og image shipped in
`SeoMeta` and `https://roomy.space/` served zero og tags, because the tags never
reached the static shell.

- **M1/M2 (source level, cheap).** Extend the existing pattern: assert that
  `[space]/+page.server.ts` and `[space]/+layout.ts` exist with the right
  `ssr` posture and that the server loads name the expected NSIDs. This catches
  a route losing its server load; it is a structural test, in the same spirit as
  `og-tags.test.ts:18` ("Reads the tree, not a build").
- **M1/M2 (artifact level).** `build-prod.sh` already asserts the shipped
  `index.html` carries the og tags. The server build needs the equivalent:
  boot the emitted server, fetch `/<space-did>`, and assert the response's
  `</head>` carries the space's name. That is the only test that would have
  caught the room-title regression in §2.2.
- **M1 appserver side.** `packages/appserver/src/e2e/endpoints.test.ts` already
  has `anonymous → 200` cases and the `seedSpace` helper takes
  `allowPublicJoin` (`src/e2e/helpers.ts:150`). Add the pair that pins the
  contract M1 depends on: anonymous `getMetadata` 200 for
  `allowPublicJoin: 1`, `getThreads`/`getMessages` 200 for public and 403 for
  invite-only. This is the boundary the whole plan rests on, and it is currently
  tested only incidentally.
- **Not worth a test.** That a `load` returns an object, that a tag setter was
  called, or that the client falls back — all covered by the render and the
  appserver tests above.

---

## 6. M5 — Optional: a public space index

Out of scope for the short term, recorded because it is the one thing the
appserver does not already provide.

`space.roomy.space.getSpaces` returns `{ spaces: [] }` for anonymous callers
(`handlers/space.roomy.space.getSpaces.ts:29-33`), and that list is the caller's
*joined* spaces, not a directory. A public "browse spaces" page — the natural
front door for a server-rendered Roomy — needs a source that does not exist.

The parts are present but not assembled: `space_stats` holds member counts
(kept current by `applyBatch`), `entity_space` maps rooms to spaces,
`comp_info` holds names and avatars, and `space_roomy.admin.listSpaces` does the
enumeration already behind `requireAdmin`. What is missing is (a) a queryable
"is this space publicly joinable" list at scale — `allow_public_join` lives in
each space's own DB, so a directory needs a global projection, the same shape
`space_stats` already is — and (b) a product decision about whether Roomy should
have a public directory at all. Do not build (a) before deciding (b).

---

## 7. Milestones

| # | Deliverable | Packages | Evidence of done |
|---|---|---|---|
| **M1** | Server-rendered head for `[space]` and `[space]/[room]` | app-lite | Fetching `/<space-did>` on a running server build returns HTML whose `</head>` names the space and images its avatar; an invite-only space falls back to the site defaults |
| **M1b** | Same for `user/[user]` and `join/[[spaceRef]]` | app-lite | Same, for a profile URL and a handle-form join link |
| **M2** | A server build that runs, deployed | app-lite, infra | The production origin serves a rendered document; the Tauri and Netlify static builds still build and still pass `build-prod.sh` |
| **M3a** | Measurement, no behavior change | app-lite | A load trace for `/<space-did>` on a cold cache, splitting boot into "paint", "auth", "sync", "content" |
| **M3** | Read-only anonymous view of a public space | app-lite, appserver (tests only) | A signed-out visitor to an open space's channel sees its messages in the first HTML, and the same URL signed in behaves exactly as today |
| **M4** | Tests + `build-prod.sh` assertions per §5 | app-lite, appserver | Each milestone's assertion fails when its route is reverted |
| **M5** | *(optional)* public space directory | appserver, app-lite | Gated on the product decision in §6 |

Ordering: **M1 → M2 → M3a → M3**, with M1b and M4 alongside. M1 has no
dependency on M2 — the loads can be written and unit-tested against a dev server
before any adapter decision is made — but M1 is not *observable* in production
until M2 exists, and the OG goal is a production goal. Treat M1+M2 as one
delivery.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| **A server load in a static build breaks navigation.** `adapter-static` ships an SPA; a `+*.server.ts` load makes the client fetch `<route>/__data.json` on every navigation, the static host answers it with the SPA fallback, and the load rejects — the document stays put and the click appears to do nothing. | The loads land with the server build (M2), not before: the static artifact keeps `ssr = false` and no server loads, so nothing fetches `__data.json`. Both artifacts need an assertion that no route in the static build carries a server-only load, and that a client navigation into every `[space]`, `[room]`, `user/[user]` and `join` route completes. |
| **Rate limiting.** `src/xrpc/rateLimit.ts:43` allows 100 requests / 60 s per IP with a 120 s block, counted before the appserver's own response cache. An SSR origin is one IP for every visitor; a per-request fan-out of 1–2 calls exhausts the budget at ~50–100 page views/minute, and the 120 s block then degrades every head for two minutes. | The read-through cache (`src/lib/server/read-cache.ts`, M1) holds a successful read for the appserver's own 60 s window and folds concurrent renders of one URL into one request, so a hot space costs one request per minute rather than one per document; failures are not held. What remains is breadth across many distinct spaces in one minute, which is a deploy decision: raise `RATE_LIMIT_POINTS`, or key anonymous reads on a forwarded client IP (`RATE_LIMIT_TRUST_PROXY`, already a supported env). Decide before M2 ships, not after. |
| **The response cache may hold nothing for anonymous callers.** `CACHEABLE_NSIDS` (`src/cache/index.ts:42`) covers the NSIDs M1 needs, but the probe's anonymous `getMetadata`/`getThreads` calls each took 0.5–6 s, which is cold. | Measure the anonymous hit rate on the cache in production before sizing the fan-out; the `/health/cache` endpoint reports `byNsid`. |
| **Two build outputs drift.** The static build and the server build can disagree about what is prerenderable, and only one of them is exercised by CI's existing checks. | M4's artifact assertions run against both; the Tauri build keeps `build-prod.sh`'s existing assertions unchanged. |
| **Private-space metadata is already public.** `getMetadata` returns name, description and avatar for invite-only spaces by design (§1.1). M1 widens where that is *rendered*, not what is exposed. | This is a pre-existing property of the appserver, not a new exposure. If a space's description is considered sensitive, that is a change to `getMetadata`, which this plan does not make. |
| **The `<title>` regression in §2.2.** A static `<title>` and a runtime `<svelte:head>` can disagree; the room route lost its server title in the probe. | Assert the rendered document, not the component (M4). |

---

## 9. What this plan does not do

- Does not render the timeline, sidebar, composer, or any authenticated view on
  the server.
- Does not change `getMetadata` or any handler's authorization.
- Does not add a public space directory (M5 is recorded, not scheduled).
- Does not change the Tauri shell, the OAuth flow, the service worker's
  strategy, or `app.html`'s static defaults.
- Does not attempt slug-based room URLs — room URLs stay ULIDs.

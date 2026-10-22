# Web Tiles Integration — Design Plan

**Date:** 2026-10-09
**Status:** Milestone A shipped (`7aef4ba2c`, #440) — a standalone tile renders
from its AT-URI, through a `TileMothership` and an `ATTileLoader` against the
DASL project's shared loading server, with no loading domain of Roomy's own
(§8.1, §11.3). Step B0 of Milestone B is in flight: the message DTO becomes one
`attachments` list (§4.6, §11.1). This is the current plan for Web Tiles in
Roomy. `docs/plans/web-tiles-roomy-feasibility.md` is the earlier feasibility
read, kept as a historical record; §0 below states which of its conclusions
still hold.
**Next:** Milestone B (§11.1) — the tile attachment, once its step B0 has
landed: `space.roomy.attachment.tile.v0` carries the tile's AT-URI and a
payload; the create and edit materialisers write it, the `attachments` list B0
introduces carries it to the client, and a renderer loads it.
**Scope of the funded stint:** two weeks, two features (§5, §6), plus a
30-day engagement write-up (§10).
**Verified against:** `origin/next` @ `4276631e`.
**Packages:** `packages/app-lite`, `packages/design`, `packages/appserver`,
`packages/sdk`, and no new service of Roomy's own (see §8.1).

**Path choice.** This document lives at `docs/plans/web-tiles-integration.md`.
The root `docs/plans/` directory holds cross-package plan documents
(`richtext-migration-plan.md`, `voice-chat-plan.md`, `bluesky-publishing.md`);
this work spans four packages and a deployment question, so the root directory is
correct.

---

## 0. What this document is

Three sources are collated here:

1. **`docs/plans/web-tiles-roomy-feasibility.md`** (2026-08-31) — a
   feasibility read on the DASL Web Tiles spec. Accurate about the spec and the
   security model; written against the deleted `packages/app` (SQLite-WASM +
   Leaf) architecture, so its §3 ("Mapping onto Roomy's architecture"), its
   integration points and its phase plan are stale. §2 of this document is
   that document's spec summary, corrected to the current spec; §4 replaces
   its architecture section; §11 replaces its phase plan.
2. **A design discussion thread** on room context, custom rooms, tile data
   storage, and the tension between tile capabilities and OAuth scopes. §6, §7
   and §9 draw on it.
3. **A funded implementation proposal** — a two-week stint against the spec
   and the `@dasl/tile-*` tooling, with upstream issues/PRs filed as rough
   edges are hit, and a 30-day engagement write-up. §1 and §11.
4. **A later refinement to the sequencing** — that rendering support comes
   first, in two self-contained checkpoints: standalone tiles whose assets are
   entirely in the manifest and which need no host data, then tiles that accept
   only data attached to the message. §11.1 is that plan; it sits ahead of
   feature 1 and does not depend on it. The message-attached data is carried as
   a new `Attachment` variant, not as an extension key (§5.3), and the second
   checkpoint opens with the read-path change that lets a tile be an attachment
   at all: one `attachments` list on the message DTO, step B0 (§4.6).

The old document's headline conclusion survives: Web Tiles are a good
conceptual fit for Roomy, and the hard parts are infrastructural and
governance-related rather than conceptual. Two of its three stated blockers
have since changed:

| Old claim | Now |
|---|---|
| "The spec does not yet define the room-context / query-capability channel… that's presently a stub." | **Partly resolved.** Tiles Protocols is now specified and the **Data Passing** protocol (`data.js`) is written, with a concrete `postMessage` contract (§2.4). The self-editing-tiles protocol (`store.js`) is still an `XXX` stub. The old document's "you'd be designing this yourselves" is now "you'd be implementing a published protocol, and only the store half is unclaimed". |
| "You need to run a tile-loading server." | **Resolved the other way: Roomy runs none.** The loader defaults to the DASL project's own shared loading server, which serves the mandated header set and redirects per load; `loadDomain` is left unset (§8.1). Running Roomy's own is a later, one-value change that needs a wildcard certificate. |
| "The main trust decision is administrative: which tiles a space may load, with what capabilities." | **Unchanged**, and the mechanism is the deployment's hardcoded OAuth scope ceiling plus manual review of public writes (§6.4, §9.3) — *not* a per-space setting, and *not* an OAuth scope a space administers (§9). |

**What has not changed:** the tile path is app-lite's alone. `@dasl/tile-loader`
(`packages/app-lite/package.json`) is the repo's only declared `@dasl/*`
dependency, and a `grep` for `dasl` across `packages/appserver/src` and
`packages/sdk/src` returns nothing: no tile is fetched, materialised, projected
or resolved outside the browser.

---

## 1. The stint

A focused two-week stint using the Web Tiles spec to build extensibility
features in Roomy, testing both the spec and the `@dasl/tile-*` tooling.
Rough edges that surface in the spec or the packages get upstream issues or
PRs.

Two features, in order:

1. **Rich ATProto embeds via Web Tiles** (§5). Roomy today does basic link
   previews for ATProto-resolvable links, from OpenGraph/oEmbed metadata that
   ignores the record entirely. The target is the full pipeline: resolve an
   AT-URI → tile manifest → tile-loading-server → sandboxed render. First
   content type is a Bluesky-compatible post, so a link renders a rich card
   instead of a flat preview. The same pattern then extends to profiles,
   standard.site docs, Semble cards, and other Atmospheric content types.
2. **A room-context tile** (§6). Rooms gain arbitrary context metadata — a
   link to an ATProto calendar event, a task, a code issue — with a mapping
   from particular context data to a Web Tile rendered in a navbar slot, and
   dynamic response to changes in the room's state.

**Within the two weeks:** one context type end to end (calendar events), with
feature 1 landed first. Other context types are a stretch goal.

**Sequencing.** Before either feature, two smaller milestones prove the render
pipeline on their own (§11.1): **A**, a standalone tile whose assets are all in
its manifest and which needs no host data, and **B**, a tile that receives
arbitrary JSON attached to the message as a new `Attachment` variant carrying the
tile's AT-URI. Both are self-contained checkpoints — the first isolates the
loading domain and the sandbox, the second isolates the message-payload path —
and both render a tile from an AT-URI that is already known, so neither depends
on feature 1's link-to-tile resolution work. B opens with **B0**, a read-path
change with nothing rendered by it on its own: the message DTO becomes a single
`attachments` list, which is also what makes a link embed and a tile the same
kind of thing from the client's side (§4.6).

**Deliverables.** A working Bluesky-post tile in Roomy; a first version of the
room-context tile; a short write-up of the experience with the spec and the
limitations encountered; links to upstream issues and PRs.

**Longer term, not this stint.** Third-party and user-built tiles, an in-app
tiles marketplace, and the other patterns sketched in the design thread
(custom rooms with full-screen tiles, §6.2; composer takeover, §7.5). The
stint's purpose is to establish what tile-based UX in a chat context actually
needs.

**Additional request.** A short write-up at the **30-day mark** on how users
are actually engaging with tiles: how often they are used, what they are used
for, what is ignored, what surprised us. This needs light,
privacy-respecting instrumentation in Roomy (§10).

---

## 2. Web Tiles, as of 2026-10-01

The DASL project publishes the spec at `https://dasl.ing/tiles.html`
("stabilising"). Everything below is from that document and its companions.

### 2.1 What a tile is

A tile is a bundle of web content — HTML, JS, CSS, data — described by a
**manifest**. The manifest is a MASL document in Bundle Mode: it needs a
`name` and a `resources` map, and `resources` must include a `/` entry for the
root document. That is the whole requirement.

Two publication mechanisms:

- **On AT Protocol.** Every entry in `resources` is uploaded as a blob to the
  relevant PDS, and the manifest is posted as a record (lexicon `ing.dasl.masl`,
  key `tid`). Because a PDS tracks uploaded blobs rather than arbitrary CIDs,
  each `resources[path].src` must use **`$type: "blob"`** with a `ref.$link`,
  a correct `size` in bytes, and a `mimeType` — not a bare CID link. The spec
  recommends `application/octet-stream` for `mimeType` wherever possible, and
  warns it may not match the entry's separate `content-type`.
- **As a CAR file** (conventionally `.tile`), self-contained, for offline or
  non-AT distribution. All resources live in the CAR and the CAR header is the
  MASL metadata.

Optional manifest fields that matter for a catalogue: `description`,
`categories`, `icons`, `screenshots`, `sizing` (declared width and height),
`theme_color`, `short_name`, and `prev` (the previous version's CID).

The lexicon cannot describe `resources` — it is declared `"type": "unknown"` —
because it is an open path→resource map. The record `main` requires `cid`
(the DRISL CID of the MASL), `tile` (the MASL content) and `createdAt`.

### 2.2 The execution context

A tile runs in a context that must meet a mandated header set. The load-bearing
parts:

```
content-security-policy:
    default-src 'self' blob: data:;
    script-src  'self' blob: data: 'unsafe-inline' 'wasm-unsafe-eval';
    script-src-attr 'none';
    style-src   'self' blob: data: 'unsafe-inline';
    form-src 'self';
    manifest-src 'none';
    object-src 'none';
    base-uri 'none';
    sandbox allow-downloads allow-forms allow-modals allow-popups
            allow-popups-to-escape-sandbox allow-same-origin allow-scripts
cross-origin-opener-policy: same-origin
cross-origin-resource-policy: cross-origin
origin-agent-cluster: ?1
permissions-policy: interest-cohort=(), browsing-topics=()
referrer-policy: no-referrer
x-content-type-options: nosniff
x-dns-prefetch-control: off
```

The design move is that **there is no network access beyond what the manifest
pre-declares**: `default-src` and `script-src` admit only `'self'`, `blob:`
and `data:`, so there is no external origin a tile could `fetch` to. Exfiltration
is closed by construction rather than by trust. The spec explicitly frames tiles
as therefore suitable for **private data contexts** — chat, agents — where an
ordinary `<iframe>` would be too dangerous to point at arbitrary third-party
content. That framing is why the spec's own motivating example is "a poll tile
in a group chat app".

`allow-same-origin` alongside `allow-scripts` normally defeats `sandbox`, and
here it is safe only because the CSP has already removed the escape hatch. This
is load-bearing and is the subject of an open upstream dispute (§3.2).

### 2.3 Why a per-tile origin, and what it costs the deployer

Browsers give no way to sandbox strongly enough *within* one origin, so each
tile instance gets **its own origin** — today a random subdomain; the spec notes
it may later be derived from the CID. That is the entire job of the **tile
loading server**: it serves the loader runtime under the hardened headers and
redirects each load onto a fresh random subdomain.

`@dasl/tile-server` implements exactly this, and its README states the
operational consequences plainly: you point `load.<host>` and `*.<host>` at it
(**wildcard DNS + wildcard TLS**), and you set `loadDomain: "load.<host>"` on
the mothership. It never sees or stores tile content; it serves fixed runtime
assets only.

### 2.4 Tiles Protocols — the capability channel, now specified

Tiles Protocols are how a tile reaches capabilities the host chooses to expose.
A protocol is loaded from a reserved path, `/.well-known/web-tiles/<name>.js`,
by the same convention in every tile:

```js
try {
  const protocolApi = await import("/.well-known/web-tiles/some-protocol.js");
  // use it
} catch (err) {
  // the environment doesn't support this protocol
}
```

The host environment supplies the implementation, so the tile uses it as a
black box and never assumes a given environment. In web contexts the transport
is `postMessage` across the tile boundary, with an `action` field prefixed
`tiles-protocol-up-` (tile → host) or `tiles-protocol-down-` (host → tile), and
a `payload` field carrying structured-cloneable data.

Registered resource names: `index.html`, `shuttle.js`, `worker.js` (all
reserved, loader-internal), **`data.js`** (Data Passing), and **`store.js`**
(Self-Editing Tiles).

**Data Passing** (`tp-data`, "hot new stuff") is written and is the one protocol
Roomy needs first. Its interface:

- `addDataHandler(handler)` / `removeDataHandler(handler)` — receive host data.
- `listen()` — tell the host the tile is ready.
- `sendData(payload)` — send data back to the host.

On the web runtime the mapping is: `listen()` sends
`tiles-protocol-up-data-ready` with no payload; host data arrives as
`tiles-protocol-down-data-payload`; `sendData()` emits
`tiles-protocol-up-data-payload`.

**Self-Editing Tiles** (`tp-editable`) is a stub — its body is `XXX` prose. This
is the protocol a tile would use to read and write "the tile's store", and it is
directly relevant to §6's room-state question and to §7.4's storage design. It is
unclaimed.

### 2.5 The client toolkit

`@dasl/tiles` is a meta-package (2.0.0) re-exporting the focused packages under
the original `@dasl/tiles/*` paths; the packages' READMEs recommend depending on
the smaller packages directly.

| Package | Provides |
|---|---|
| `@dasl/tile-loader` | `TileMothership`, `Tile`, the loader classes; browser-only |
| `@dasl/tile-server` | `createTileLoadingRouter(baseHost)` (Express router) and the `tiles-loading-server` CLI |
| `@dasl/tile-writer` | Write tiles into `.tile` (CAR) files |
| `@dasl/tile-car-reader` | Read tiles from a CAR |
| `@dasl/tile-lexicon` | MASL schema and shared types |
| `@dasl/atile` | The tile-publishing CLI |

The loader's shape, verbatim from its README:

```js
const tl = new TileMothership({ loadDomain: 'load.webtiles.example' });
tl.init();
tl.addLoader(new ATTileLoader());

const tile = await tl.loadTile('at://did:plc:…/ing.dasl.masl/3mcjwwoqjqs2v');
document.body.append(await tile.renderCard());   // metadata-only, cheap
document.body.append(tile.renderContent());      // sandboxed iframe
```

`renderCard()` is metadata-only and is explicitly safe to render in bulk;
`renderContent()` spins up the sandboxed context and should be deferred until
the user expands or interacts.

Three layers cooperate over `postMessage`:

- **Mothership** — in the host page. Holds every privileged capability
  (fetching, file access) and resolves the worker's `resolve-path` requests
  against the manifest. The README states the contract: it answers with
  `{ status, headers, body }` and never anything else.
- **Shuttle** — a sandboxed iframe on a fresh random origin, served by the tile
  server. It installs the service worker and hosts the tile's own inner iframe,
  relaying messages. It exists only because a service worker needs a real page
  origin.
- **Worker** — a service worker that intercepts the tile's resource requests
  and defers each to the mothership.

Loaders are tried in order: `ATTileLoader` (`at://…`), `CARTileLoader` and
`WebXDCTileLoader` (`http(s)://…`), `MemoryTileLoader` (`memory://<id>`, for
tests), with `ContentSchemeTileLoader` as the base class for HTTP-fetching
loaders. `TileLoader` and `TilePathLoader` are exported so Roomy can write its
own if needed.

### 2.6 The AT vocabulary already exists in the tree

`@dasl/tile-loader` depends on `@atcute/car@^6` and `@atcute/cid@^2.4.1`.
`@atcute/cid` is already a transitive dependency of this repo (via the ATProto
stack), and `@atcute/cbor` is used directly in `packages/sdk` (for example
`import { fromBytes } from "@atcute/cbor"` in `packages/sdk/src/schema/events/page.ts:4`).
So the CID/CAR/CBOR layer is not a new dependency category for Roomy.

---

## 3. The security model, and what is still open

### 3.1 What you trust

Only two things: the **tile-loading server** (to attach the correct headers and
to not itself misbehave), and **Roomy's own mothership code** (to expose only
the capability surface it intends). The tile's JavaScript is explicitly not
trusted, which is the point of the design.

The spec states the loading server should be "a server trusted by the user…
that cannot learn more than what the embedding context already knows". It is a
redirect-and-headers service that never sees tile content — a good fit for a
small separately-deployed service, and explicitly not something that belongs
inside the appserver's trust boundary.

### 3.2 Open upstream dispute: the mandated header set

`darobin/dasl.ing#98` **"Unsafe sandbox"** (open, opened 2026-03-23, last
updated 2026-08-06) argues the published headers "allow side channel attacks and
possibly sandbox escape", citing the Peergos implementation as prior art, and
lists:

1. Missing `Cross-Origin-Embedder-Policy: require-corp`, so no cross-origin
   isolation.
2. `blob:` and `data:` as `script-src` sources are dangerous.
3. The same for `default-src`.
4. `allow-popups-to-escape-sandbox` is dangerous and can bypass the CSP to make
   arbitrary network requests.
5. `form-src` is not a valid CSP directive.
6. Recommendation: add `connect-src: self` or `none`.

This is unresolved. It does not block the stint — Roomy is *consuming* the
model, not certifying it — but it does mean the security story in §3.1 is the
spec's claim, not an independently verified property, and it is exactly the kind
of thing the stint's write-up and upstream issue list should carry. If Roomy
ships a `loadDomain`, this is the header set it serves, deliberately, and the
document should say so rather than imply the model is settled.

A second thread, `darobin/dasl.ing#43` (bnewbold), is directly about the AT
publishing path: it proposes reserving or profiling `atproto-ref` (an AT-URI
alongside the CID) and `atproto-blob` norms, since for a **record** you usually
want the AT-URI too, and for a **blob** only a `$type: "blob"` reference keeps
the blob from being garbage-collected. The reply suggests this may belong in a
tutorial/profile rather than the core spec. §5.2 depends on the AT-URI question.

### 3.3 The remaining trust question

Because a tile is otherwise network-dead, **the capability channel is the entire
attack surface**. That is a good property: the security review concentrates on
one boundary (the protocol surface Roomy implements) instead of on "what could
this arbitrary JavaScript do". It also means every capability Roomy exposes must
be decided deliberately, and §7 is where those decisions live.

---

## 4. Roomy's integration surface today

Thin client, no client-side materialisation. `packages/app-lite` (SvelteKit,
Svelte 5 runes, TanStack Query) reads the appserver over XRPC HTTP
(`DirectXrpcClient`) and receives row-level diffs over a single WebSocket
(`#messageDiff` and friends). The appserver materialises ATProto events into
per-space SQLite and serves XRPC. `packages/app` no longer exists.

Four surfaces matter for this work.

### 4.1 Message rendering — where a tile block would attach

A message body is one of two things: legacy `text/markdown`, or
`application/vnd.roomy.richtext+json` — a base64-encoded JSON document
`{ $type: "space.roomy.richtext.document", blocks: [...] }` carried inside the
event's `body.data` bytes. The event schema was deliberately not changed for
rich text; the document's own `$type` lives inside the bytes, and validation
happens only at `deserializeBody`, which checks `Array.isArray(parsed.blocks)`.

- **Dispatcher:** `packages/app-lite/src/lib/components/chat/MessageContent.svelte:22-34`
  branches on `mimeType === RICHTEXT_MIME` and renders either `<BlocksRenderer>`
  or sanitized markdown.
- **The block switch:**
  `packages/app-lite/src/lib/components/chat/BlocksRenderer.svelte:190-223` is a
  flat `{#if block.$type === …}` chain over text, header, blockquote, small,
  code, orderedList, unorderedList, image and horizontalRule. **An unmatched
  `$type` renders nothing.**
- **The open union:**
  `packages/sdk/src/schema/richtext/index.ts:203-207` defines
  `UnknownBlock = { $type: string, text?: string }`, and `Block`
  (`:213-224`) ends with it. This is the only sanctioned way a non-standard
  block survives decoding, and it is documented as being dropped by renderers.
- **Wrapper:** `BlocksRenderer`'s root is `display: contents`
  (`:188`, style `:230-235`), so block margins come from
  `packages/app-lite/src/lib/message-typography.css`, shared with the composer.
- **Host and slots:** `packages/design/src/components/content/thread/message/MessageBubble.svelte`
  declares snippet slots `replyContext | content | media | linkEmbeds |
  forwardEmbed | toolbar | reactions | actions | deliveryActions |
  selectionIndicator` (`:47-56`) and renders them at `:373-387`. `ChatMessage.svelte`
  supplies them at `:498-564`; `ActivityFeed.svelte` and `SearchResultsList.svelte`
  supply the same shape.

**Consequence for tiles.** A tile block needs an explicit arm in
`BlocksRenderer`; the open union makes it *survive* the wire, not *render*.
If a tile arrives instead as a new message field (like `linkEmbeds`), the
change reaches `MessageContent`/`MessageBubble` instead. §5.3 picks between
these.

### 4.2 The embed pipeline — what a tile replaces or extends

Link previews are a **server-produced read projection**, not a client fetch:

1. Message materialisation yields URLs (`detectAndStoreLinks`,
   `packages/appserver/src/embed/enricher.ts:578`, called from
   `materialization/applyBatch.ts:605-635`) into `comp_embed_link`, dual-written
   to the global `pending_links` queue. Richtext `#link` facets take the
   sibling path (`detectAndStoreLinksFromUrls`, `enricher.ts:614`).
2. A single process-wide sweeper (`packages/appserver/src/embed/sweeper.ts`,
   started once at `packages/appserver/src/appserver.ts:800`) drains the queue
   and enriches with OpenGraph + oEmbed discovery
   (`packages/appserver/src/embed/metadata.ts:372`, 8s timeout), retrying on a
   1m/5m/30m/2h → 6h schedule with an attempt ceiling.
   The plan replaces the drain with demand-driven re-enrichment at write and
   read time (§11.2); the sweeper itself, its retry schedule and its ceiling
   stay.
3. Results land in `comp_embed_link_data.embed_json`
   (`packages/appserver/src/db/schema-space.sql:248-256`) as a JSON-serialised
   `EmbedV1`; `embed_json = NULL` means definitive no-data or abandoned.
4. `selectMessages` hydrates the row into the DTO:
   `linkEmbeds: LinkEmbedDto[]` (`packages/appserver/src/queries/selectMessages.ts:100`,
   assembled `:470-515`, returned `:562`).
5. Live delivery: `emitEnrichmentInvalidation`
   (`packages/appserver/src/embed/sweeper.ts:1527-1604`) resolves
   link → message → room and emits `#messageDiff` updates plus
   `room.getLinks` / `space.getLinks` invalidations.
6. The client just renders the array. The DTO field is
   `Message.linkEmbeds: LinkEmbed[]` (`packages/sdk/src/schemas/queries/_message.ts:128`),
   drawn by `packages/design/src/components/content/thread/message/embeds/LinkCard.svelte`,
   whose call sites are `ChatMessage.svelte:619-635`, `ActivityFeed.svelte:229-235`,
   `SearchResultsList.svelte:434-443`, and the Links view
   (`design/…/linkView/LinkViewItem.svelte`).

There is also a **synchronous** enrichment path for the composer and the
in-place editor: `space.roomy.embed.getLinkMetadata` (registered at
`packages/appserver/src/appserver.ts:490-493`; handler
`packages/appserver/src/handlers/space.roomy.embed.getLinkMetadata.ts`; schema
`packages/sdk/src/schemas/queries/getLinkMetadata.ts`), called from
`packages/app-lite/src/lib/embed/embed-service.ts:56-64`.

**The seam.** `metadata.ts`'s own doc comment says the pipeline is
"deliberately self-contained… so ATProto-native enrichment can later be layered
on top of the same endpoint without changing the interface". That is precisely
what feature 1 is: the current enrich path learns only what a URL's HTML says.
Neither path knows the URL is an AT-URI.
The DTO fields this pipeline feeds, and what the rest of the attachment union
does on the way to the client, are §4.6.

### 4.3 UI slots a tile can occupy

| Slot | Owner | How a tile attaches |
|---|---|---|
| Navbar (right-hand content) | `layout/navbar.svelte.ts` `setNavbar` (`:39`); region `layout/MainLayout.svelte:150-153` | Room page already calls `setNavbar(roomNavbar)` at `routes/[space]/[room]/+page.svelte:161`, snippet at `:384-412` |
| Navbar (space-info, right of the breadcrumb) | `setSpaceInfoExtra` (`navbar.svelte.ts:56`), rendered `MainLayout.svelte:135-141`; in settings at `routes/[space]/settings/+layout.svelte:81-83` | Precedent: the Discord bridge status badge |
| Sidebar | `layout/sidebar.svelte.ts` (`setSidebarContent:34`, `setSidebar:48`, `setSidebarHeader:63`); region `MainLayout.svelte:188-238` | A pinned custom room (§7.3) |
| Composer | `ChatInputArea.svelte:513-596` assembles the design shell; shell contract `design/…/ChatInputShell.svelte:85-92` (`contextPreview`/`input`/`linkEmbedPreview`/`fullscreenDropper`) | A new snippet, not a forked editor |
| Room tab panel | `routes/[space]/[room]/+page.svelte:417-434`, tab list `:320-329` (precedent: the `links-view`-flagged Links tab) | A tile panel beside Chat/Threads/Links |

Note the room page mounts `ChatArea` and `ChannelBoardView` simultaneously and
toggles visibility — a tile panel should follow that pattern so its state
survives tab switches.

### 4.4 What does not exist yet, and the two that bite

- **No iframe anywhere.** `grep` for `iframe|srcdoc|sandbox=` across
  `packages/app-lite/src` and `packages/design/src` returns zero matches. The
  only iframe-adjacent code is server-side *string parsing*
  (`embed/metadata.ts:194-197` pulls `src` out of oEmbed `html`), and video is
  rendered as a plain `<video src>` (`LinkCard.svelte:89-99`), never a frame.
  The sandbox host is new code.
- **No CSP anywhere in app-lite's delivery path.** `src/app.html` declares none,
  `packages/app-lite/svelte.config.js` sets no `kit.csp`, `Caddyfile` has no
  `header` directive and `netlify.toml` has no `[[headers]]` block. So a tile
  iframe's `sandbox` attribute would be the *only* containment, with no
  host-page CSP to lean on — and, more sharply, an `allow-same-origin` tile
  served from the `roomy.space` origin would be same-origin as the app. **The
  load domain must be a different origin.** See §8.1.
- **The app already registers a service worker.**
  `svelte.config.js` sets `serviceWorker.register: true` and
  `packages/app-lite/src/service-worker.ts:88` installs a fetch handler scoped
  by URL. A tile's shuttle/worker is registered by the tile server under the
  *load* origin, so the two do not collide — but the loader's architecture
  exists because of service-worker origin rules, and the app's SW is a
  pre-existing moving part to keep in mind when debugging.
- **The appserver is `Bun.serve`, not Express.** `@dasl/tile-server` ships an
  Express router. Serving the tile-loading role from the appserver process
  would mean porting the router or hosting an Express app inside Bun; §8.1
  recommends a separate service instead.
- **`getLinkMetadata` returns only the embed shape.** The response is
  `LinkEmbedData` (`getLinkMetadata.ts:41-52`) and an empty object for a URL
  with no metadata. Anything a tile needs (the resolved AT-URI, the manifest's
  name/description/sizing) has no field to travel in today.

### 4.5 Adding things to the appserver, for reference

- **XRPC query/procedure:** register in the `.query()/.procedure()` chain in
  `packages/appserver/src/appserver.ts:207-546` (exemplar: the room-metadata
  query at `:432-436`); handler in `packages/appserver/src/handlers/`; SDK
  schema in `packages/sdk/src/schemas/{queries,procedures}/` plus its `index.ts`
  re-export and a `transport/registry.ts` entry; then
  `pnpm --filter @roomy-space/sdk generate:lexicons`, which CI enforces
  (`check:lexicons`).
- **Non-XRPC HTTP route** (the shape a tile endpoint or proxy would take): the
  `Bun.serve` fetch in `appserver.ts:1024-1250`. The existing precedent is
  `/blob/<did>/<cid>` (`:1236-1245`), backed by `proxyBlob`
  (`packages/appserver/src/blob.ts:25-79`), which resolves DID → PDS via
  `resolvePdsEndpoint` and forwards `Range`, with
  `cache-control: public, max-age=31536000, immutable`. It is unauthenticated
  by design.
- **New event type:** schema file in `packages/sdk/src/schema/events/`, added to
  that family's variant union, to `envelope.ts`, and to `eventRegistry`
  (`events/registry.ts:61-108`, whose `satisfies` makes a missing registration a
  type error) — plus, in the appserver, `auth/writeAuth.ts` `ALLOWED_TYPES`
  (hand-maintained) and an auth category, or the event is rejected at runtime
  with a 400. Missing any of these produces the known
  `no materializer for event` failure mode, where the event is skipped but the
  cursor still advances.
- **Outbound ATProto fetching to reuse:** `blob.ts` (blob proxy),
  `identity.ts` `resolvePdsEndpoint` (`:142-153`, 1h-stale/24h-max DID cache),
  and exactly one `com.atproto.repo.getRecord` call
  (`materialization/roomyProfile.ts:88-108`, hardcoded to
  `space.roomy.user.profile/self`). **There is no general AT-URI → record
  resolver**, so resolving `at://did/ing.dasl.masl/<tid>` is new code — though
  it is a small, direct use of `com.atproto.repo.getRecord` plus the existing
  DID→PDS resolution and timeout helpers (`fetchTimeout.ts:38-46`).

### 4.6 The attachment read path — one list on the write side, one on the DTO

The write side already treats an attachment as one thing. A message carries
`extensions["space.roomy.extension.attachments.v0"].attachments: Attachment[]`,
a closed union of seven variants (`extensions/message.ts:105-113`), and the
composer already builds a single list, merging uploaded media with the reply
attachment (`mutations/message.ts:65-91`). The SDK's `createMessage` option is
generic over that union (`operations/message.ts:24`), so anything the union
admits can be attached without a new operation.

The read side used to split it by kind, projecting each variant into its own DTO
field. Step B0 (§11.1) gives the DTO the list back — one `attachments` entry per
attachment, each tagged with its `$type` — and keeps the per-kind fields as
derived views of it, for the reads that are not attachment rendering:

| Variant | `$type` on `attachments` | Derived field it still feeds |
|---|---|---|
| reply | `space.roomy.attachment.reply.v0` | `replyTo`, the target message id as a bare string |
| forward | `space.roomy.attachment.forward.v0` | `forwardedFrom`, `{ messageId, roomId, name, message? }` with the original denormalised |
| image | `space.roomy.attachment.image.v0` | `media` |
| video | `space.roomy.attachment.video.v0` | `media` |
| file | `space.roomy.attachment.file.v0` | `media` |
| link | `space.roomy.attachment.link.v0` | `media` (as a `text/uri-list` row) **and** `linkEmbeds` |
| comment | — | nothing: `comp_comment` is written by the materialiser and read by no query in the tree |

Three properties followed, and each is what a tile would collide with — all
three are what milestone B meets. B0 answers the first; the other two are open:

1. **No `$type` on the wire.** *Answered by B0 for the read path: `attachments`
   carries one per entry, and the renderers dispatch on it. `media` itself still
   does not — it is a derived view kept for the reads that are not attachment
   rendering.* `Media` is `{ url, type, alt?, width?, height?, … }`
   (`queries/_message.ts:21-31`) where `type` is the MIME type, overloaded as the
   kind: a link row is `text/uri-list` (`selectMessages.ts:366-374`), and the
   client drops `type.startsWith("text/")` from the media renderer so the same
   link is not drawn twice (`ChatMessage.svelte:640`). A renderer cannot
   dispatch on kind.
2. **No order and no identity.** `attachments` is assembled from the reply and
   forward edges followed by the four-branch UNION in kind order
   (`selectMessages.ts:333-374`), so the order the author attached things in is
   lost; an attachment has no id of its own — the row is keyed by its URL,
   synthesised as `uri?message=<msgId>` on the explicit path
   (`events/message.ts:149-160`) and left bare on the detected path
   (`enricher.ts:586-603`). A link is addressable by URL; nothing else is
   addressable at all.
3. **No general edit protocol.** `MessageExtensionUpdateMap` replaces the whole
   attachment set, and `MessageExtensionDeleteMap` admits only
   `DiscordMessageOrigin` (`extensions/message.ts:152-163`) — the one attachment
   the protocol can delete is the Discord origin. The edit materialiser's
   link-only fast path (`events/message.ts:236-286`) is the sole per-attachment
   update, and it is keyed on the URL. B0 does not touch this: it is a read-path
   change, and the write path a tile attachment needs is milestone B's.

**Two producers write one row per link, and they do not agree on the key.** An
explicit `LinkAttachment` writes `uri?message=<msgId>`; the body scan
(`applyBatch.ts:589-632` → `detectAndStoreLinks`, `enricher.ts:578`) writes the
bare URL with `show_preview = 1`. Both are entities scoped to the message, so a
message that attaches a link *and* mentions that URL in its text produces two
rows and two `linkEmbeds` entries for one card — verified against the
materialiser. The enricher's own doc comment ("Skips URLs that already exist in
`comp_embed_link` (via explicit LinkAttachment or a previous scan…)",
`enricher.ts:569`) does not hold across the two encodings. It is unreachable
from the composer today, because the composer attaches no links on create
(`ChatInputArea.svelte:103-109`); it is the first thing a composer that *does*
express embed intent will hit.

**The target shape.** `Message.attachments: AttachmentDto[]` — one entry per
attachment, each carrying its `$type` and whatever its renderer needs — with
`media`, `linkEmbeds`, `replyTo` and `forwardedFrom` kept as derived views over
it while consumers migrate. The per-kind component tables already hold the data;
the change is the projection and its consumers, not the materialiser. §5.3
decides the tile's place in that list, and §11.1 makes the change a step of its
own.

---

## 5. Feature 1 — rich ATProto embeds via Web Tiles

### 5.1 The gap

A Roomy message containing `https://bsky.app/profile/<handle>/post/<rkey>`
renders whatever the page's OpenGraph tags say. The ATProto record behind it is
never consulted. The result is a flat preview at best and, for sites that block
bots or serve less metadata to non-browser agents, nothing.

### 5.2 What "rich" means concretely

Resolve an AT-URI to a record; render that record with a tile. The first content
type is a Bluesky post, which means:

1. **Recognise** that a URL is ATProto-resolvable (a `bsky.app` post link, an
   `at://` URI, and later a profile link, a standard.site doc, a Semble card).
2. **Resolve** the AT-URI to an `ing.dasl.masl` record — `com.atproto.repo.getRecord`
   against the DID's PDS, reusing `resolvePdsEndpoint` and the existing timeout
   helpers. Cache, because PDS round-trips are the cost this pipeline pays.
3. **Load** the manifest's resources through the tile loading server, and
   **render** it sandboxed.

Note that (2) is a **tile** lookup, not the post lookup: the pipeline is
"an AT-URI (a post link) → which tile renders this content type → that tile's
manifest". The mapping from "content type" to "tile" is the interesting design
question and is §5.4.

Two AT-publishing details carry over from `darobin/dasl.ing#43`: for a *record*
reference the AT-URI is wanted alongside the CID, and the manifest's blob
entries must use `$type: "blob"` or the PDS will garbage-collect the resources.

### 5.3 Where the result lands

The question is how a tile reaches a message. Three candidate shapes, in
increasing order of blast radius:

- **(a) Extend the existing embed projection.** The AT-URI resolution becomes a
  second enrichment source feeding `comp_embed_link_data`, and
  `LinkEmbedData` grows the fields a tile card needs; the client's `LinkCard`
  renders a `TileCard` when those fields are present. Keeps the current
  rendering, the `#messageDiff` delivery, the retry/backoff machinery and the
  live-update path for free. Requires an SDK DTO change and a projection change.
- **(b) A tile attachment** — a new variant in the `Attachment` union carrying
  the tile's AT-URI and a payload. This is the composed-with-the-message shape,
  it survives edits, and it rides the read path messages already have. It is
  what milestone B builds (§11.1), and it is the shape that generalises: the
  same attachment carries a Bluesky renderer's tile, a Mermaid renderer's
  source, or a poll's options.
- **(c) A richtext block** (`space.roomy.richtext.blocks#tile`), so a tile is
  authored into the message body. This is the "tile block" idea from the design
  thread — drop an AT-URI into the editor and it renders. It requires an
  explicit arm in `BlocksRenderer` and a new block type in the SDK's open union.

These are not exclusive. The thread's own conclusion is worth recording: it
distinguishes an **attachment** from a **block**, and lands on attachment as the
better home for a tile produced by interacting with an input tile in the
composer ("you drop an 'input tile', and by interacting with it you produce
metadata attached to the message, which a renderer tile then renders").
`Attachment` is also the more natural carrier for *data*: a block is part of the
message body and is edited as text, whereas an attachment is a structured
sidecar with its own materialised row, its own entry in the message's attachment
list and its own renderer — which is what a tile with a payload needs.

So the division of labour is: **(b) is how a tile is attached to a message**,
**(a) is how a resolvable link is turned into a card** without the author
attaching anything, and **(c) remains open** for composing a tile inline as
message content. Feature 1's first cut is (b) plus (a); (c) is not needed for
either funded feature.

Two facts about the attachment route that a reader should not have to rediscover,
both verified against the built SDK and detailed in §11.1: the `Attachment`
union is **closed**, so an unknown `$type` is rejected at `parseEvent` — a tile
attachment is a real schema change, not a passthrough; and `updateRoom`'s sibling
gap does not apply here, because the message edit path *does* carry attachments
but must be given an explicit branch for the new variant.
**What (b) needs first: one read path.** A tile attachment has to reach the
client, and today "reaching the client" means a per-kind projection (§4.6):
seven variants in, four differently-shaped fields out and one that never
surfaces, with no `$type` to dispatch on. A tile added as a fifth special case
would be the fifth shape; added to a unified `Message.attachments` list it is
one variant with one arm in one renderer switch. The plan therefore makes the
unified list milestone B's step 0 (§11.1) and places the tile in it, rather than
giving the tile a parallel `Message.tiles` field. That also settles what
`linkEmbeds` is for: it is the per-kind field that made "where does the tile go"
a question in the first place.

**Intent, and what the plan needs from it.** Embed intent is not expressible at
create today. `LinkAttachment.showPreview` is the only intent carrier in the
union, and the create path never sees one — the appserver scans the body and
writes `show_preview = 1` (`applyBatch.ts:589-632`). The composer's dismiss
button is deliberately client-only (`ChatInputArea.svelte:103-109`); dismissal
round-trips as an `editMessage` carrying link attachments, through the
non-destructive fast path (§4.6). So the write path has *implied* intent on
create and *explicit* intent on edit.

Making create-time intent explicit is compatible with history, because the read
rule is "no row ⇒ shown" — which is also the only rule every message ever sent
has been read under. An old message with no link row keeps the implied default;
a new message that carries one is read by the same projection. What makes it a
change rather than a flag flip is the two-encoding problem above: the moment the
composer attaches a link whose URL is also in the body, the create path writes
two rows for one card. Settle the row key first, then let the composer attach.

**Neither is on feature 1's critical path**, and the plan does not take them on.
The part of the current design worth keeping is the other direction: because the
rich embed is a read projection computed from the link row, AT-URI resolution
applies **retroactively** — every historical post link in a space becomes a rich
embed when the resolver lands, with no event rewritten and nothing asked of the
author. Two conditions: the resolved tile is cached against the link URL, so one
post's tile serves every message that links it, and there is a way to re-enqueue
rows that have already been enriched, since `pending_links` only ever holds work
not yet done (§11.2, §13 item 14).

### 5.4 The content-type → tile mapping

**By convention.** Roomy publishes a default set of content-type → tile pairs —
the Bluesky-post renderer first — and every space uses it. The mapping is data,
not code: it turns a recognised AT-URI into the AT-URI of the tile that renders
it, and nothing else in the pipeline depends on where the default came from.

Two alternatives were considered and are not chosen:

- **By publisher allowlist.** A per-space list of publishers or handles whose
  tiles may render. As a *mapping* it makes the common case into configuration —
  a space that has named nothing renders no link richly — and the question it
  actually answers, which tiles a deployment may load at all, is not a space
  setting in this plan (§6.4).
- **By explicit AT-URI.** The space pins specific tiles. Maximum control, minimum
  flexibility, and the same failure at the limit — a space that has configured
  nothing renders nothing.

The thread's framing is that a first cut can be less of an open extension point
and more a proof of the system: inject the tile ref we want to load, resolve it,
render it, and learn what the pipeline needs. By convention is how that injected
ref becomes a product default without an extension point to design first. It is
also what a marketplace (§12) eventually replaces: the default set becomes a
catalog, and installing a tile becomes a choice made somewhere.

**No per-space configuration, for now.** A space does not choose its tile
mapping, and per-space tile configuration is out of scope for this plan (§6.4).
That is also what keeps the feature cheap: a space that has configured nothing
still renders a Bluesky link richly.

### 5.5 Where resolution happens

**The appserver resolves; the client renders.** Recognition of an AT-proto
resolvable URL, the content-type → tile lookup (§5.4), and the manifest fetch all
happen server-side, against a cache keyed by link URL, and land in the message
projection next to the embed metadata that is already there. The client receives
a tile reference and loads it; it resolves nothing itself.

- **Appserver-side, and that is the decision.** The card then renders with
  everything else the read path already returns, survives `#messageDiff`
  delivery, and is shared by every message that links the same URL. The server
  already has DID→PDS resolution, HTTP caching and timeouts, and the cost this
  avoids is a PDS round-trip per viewer.
- **Client-side, rejected.** The mothership holds the fetch capability and the
  loader is client code, so this is the smaller-looking option — but it needs the
  same PDS round-trips with no shared cache, it leaks each viewer's
  link-following to the PDS from the browser, and a card that exists only after a
  client fetch cannot ride the diff-driven updates the read path already
  delivers.

The client still holds the mothership: the sandboxed content has to load where
the DOM is, with the loader's own fetch path for the tile's resources. That is
also how the existing embed pipeline divides — the server enriches, the client
renders.

---

## 6. Feature 2 — the room context tile

### 6.1 The idea

Rooms gain arbitrary **context metadata**: a link to an ATProto calendar event,
a task, a code issue. Particular context data maps to a Web Tile rendered in a
navbar slot, and the tile responds dynamically to changes in the room's state.

Concrete motivating cases from the design thread:

- **Bridged rooms** — show bridge/backfill status, especially useful to admins.
- **Linked work** — a room tied to a Tangled or GitHub issue or PR, showing
  relevant data and a link.
- **Agent rooms** — display the current state of the agent and what thread it is
  working in, plus controls (a stop button, a model selector).
- **Events** — the calendar case, chosen as the stint's first context type.

### 6.2 The shapes the thread settled on

- **Room context metadata** — arbitrary, per-room, and it **overlaps and
  expires**: several independent context declarations can be active at once.
- **Room context tile** — a tile rendered in a navbar slot and driven by that
  metadata.
- **Chat input tile** — a tile that *overrides or augments the composer*: a game
  claims the room context and replaces the input with game-relevant UI.
- **Custom rooms** (formerly "data rooms") — a room whose data is tile-managed,
  which the thread also imagines pinned to the sidebar with a full-screen tile
  (a document you can scrub through history; a graph view of the space's data).

### 6.3 The partitioning problem, and how it resolves

The thread's sharpest observation is about **partitioning**. If "user A started
a chess game" and "user B created a poll" coexist in one room, those are
independent state dimensions — and the user is the *wrong* partition. The
application is the right one.

The resolution reached: **a top-level key-value store per room, keyed by NSID**.
A tile application owns a key namespace; the value is arbitrary JSON and it is
the tile's job to manage it. This maps cleanly onto three things:

- **`space.roomy.room.updateRoom` gains an optional `extensions` field.**
  `UpdateRoomSchema` (`packages/sdk/src/schema/events/room.ts:91-100`) has no
  `extensions` field today; only `CreateRoomSchema` does (`:47-56`), carrying
  the single-variant `RoomExtensionMap` (`extensions/room.ts:31-37`). The change
  mirrors the message path exactly: `editMessage` takes
  `MessageExtensionUpdateMap` (`extensions/message.ts:152-159`), which is the
  same map built with `unionToMap(…, { makeAllNullable: true })`, so a key set to
  `null` removes that extension and an absent key leaves it alone. No new event
  type is involved.
- **The `extensions` map is the existing mechanism.** `unionToMap`
  (`primitives.ts:111-140`) derives a `$type`-keyed optional map from an
  extension union, so a new extension type is added to the union and the map
  field picks it up with no change to any event schema. Extensions exist only as
  ArkType schemas — no lexicon JSON — so the whole change is one file plus its
  union membership.
- **Storage: a JSON column on `comp_room`.** Room metadata is SQL columns, not a
  record — `comp_room` (label, default_access, deleted) and `comp_info` (name,
  avatar, description, banner, pronouns, website) — and there is no generic JSON
  column on a room. The nearest precedent is
  `comp_space.sidebar_config text not null default '{"categories": []}'`
  (`packages/appserver/src/db/schema-space.sql:113`), written by
  `space.roomy.space.updateSidebar.v0/v1` and parsed in
  `handlers/space.roomy.space.getMetadata.ts:137-165`. A nullable text column
  holding the extension map, keyed by NSID, mirrors that 1:1.

**What the change costs.** The column is one structural per-space schema version:
an entry in `SPACE_MIGRATIONS` (`db/spaceVersions.ts`) of the form
`{ kind: "structural", up(db) { alter table … } }`, plus the column in
`schema-space.sql` for freshly created DBs. Per-space DBs upgrade in place — the
blue-green rebuild is the fallback for a migration that fails, not the default.
On the read side, `space.roomy.room.getMetadata` grows the field, and
`updateRoom` already invalidates `space.roomy.space.getMetadata` and the room
(`invalidation/inferSignals.ts:851-865`), so connected clients refetch with no
new signal. On the write side, `updateRoom` is already space-admin
(`auth/writeAuth.ts` `ROOM_MANAGE_TYPES`), so the new field inherits that gate,
and `operations/room.ts` gains the option beside the ones it already takes.
There is no obstacle on the schema, auth or invalidation side.

### 6.4 Governance: the ceiling, not a config surface

Tiles are content-addressed and network-dead, so the trust decision is
administrative — but in this plan it is not a per-space setting. Nothing here
adds a space-level or user-level configuration surface for what tiles may
access. A space's members do not administer tile permissions, and per-space tile
configuration is out of scope.

What governs instead is the deployment's **OAuth scope ceiling** —
`FULL_SCOPE_CEILING` in `packages/app-lite/src/lib/scopes.ts`, the hardcoded set a
tile's requested scopes are checked against, plus the matching registration on
the HappyView API client. A capability a tile cannot be granted is one the
ceiling does not list, and changing that list is a code change with a deploy,
not a space setting. The second gate is human: the whitelisted public writes of
§9.3 are manually reviewed before their scopes are added.

Two things worth recording alongside that:

- **The default permission is "a tile may write to its own namespaced store"**,
  which is unobjectionable because the host enforces the namespace. The contested
  case is a tile that must write to *public* records — RSVPs, votes, board-game
  moves — which is the capability grant of §9.
- **Where an admin-gated write does exist, it follows the existing pattern**:
  `space.roomy.space.updatePolicy.ts:52-60` (`requireSpaceAccess` +
  `access.isAdmin` → 403).

The per-room data a tile manages is a different thing entirely, and is §6.3:
that is the tile's own namespaced state, not a permission.

### 6.5 The calendar case, concretely

Roomy already has a calendar-shaped event and no consumer for it. `space.roomy.openmeet.configure.v0`
(`packages/sdk/src/schema/events/calendar.ts:14-24`) writes `comp_calendar_link`
(`schema-space.sql:279`), is in `writeAuth.ALLOWED_TYPES`, and has an
`inferSignals` entry — but there is **no handler, no SDK query schema, and no
client code**. Two calendar NSIDs appear in `packages/app-lite/src/lib/scopes.ts:112-113`
(`space.roomy.space.getCalendarLink`, `space.roomy.space.getCalendarEvents`)
with no implementation behind them.

That makes calendar events a good forcing function: the room context has
somewhere to come from, the RPC shape is already imagined in the scope list, and
an ATProto calendar event (an event record with a time, a location and an RSVP
surface) is a realistic first tile — including the RSVP write, which is where
§9's capability question gets its first concrete instance.

---

## 7. Roomy's tile protocol surface

The spec's decision tree deliberately does not make "prompt the user" the
load-bearing gate for dangerous capabilities, on the grounds that asking users
to evaluate permission requests has repeatedly failed. Capabilities are
something the host grants, not something the tile obtains.

That means every capability Roomy exposes is a design decision here. The
candidates, with the current state of each:

1. **Data in** (§7.1) — required for every use case. `tp-data` is published.
2. **Room reads** (§7.2) — "make specified queries against the room".
3. **Room writes** (§7.3) — send to a custom room; send to the space proper.
4. **Storage** (§7.4) — the per-tile KV store. `tp-editable` is an `XXX` stub.
5. **Composer takeover** (§7.5) — the chat input tile.
6. **Live media** (§7.6) — streaming video, which the model cannot express.

### 7.1 Data in

`tp-data` (§2.4) is the whole answer for passing the host's data into the tile
and getting results back. For feature 1 the payload is the resolved record; for
feature 2 it is the room context and the room's derived state. `addDataHandler`
on the tile side, `tiles-protocol-down-data-payload` on the wire, and the
mothership implements the host half.

### 7.2 Room reads

The thread's shape: a small set of **read-only query verbs** the mothership
implements against the appserver's materialised views —
`getRecentMessages(n)`, `getMembers()`, `getThread(id)` — never direct
database or event-log access.

Two observations sharpen this. First, the thread debates whether tiles need room
message access at all, and concludes it is not a security concern: tiles are
already sandboxed and cannot exfiltrate. The question is therefore about
*design cleanliness and cost*, not safety. Second, and this matters for the
stint: **the extra compute should happen mostly on the client**. The appserver's
API is deliberately denormalised to the frontend's needs rather than being
general-purpose, and the thread's conclusion is that this is fine — the Roomy
API may stay specific to the Roomy client, and anything needing to *index*
extended data can use another AppView. So a room-read capability is best served
by handing the tile data the client already has, rather than by inventing new
appserver endpoints per capability.

### 7.3 Room writes

Two tiers, with a clear line between them:

- **Sandbox writes** — a tile posts into a **custom room** scoped to that tile
  application. If custom rooms map one-to-one onto permissioned spaces, and a
  tile's writes are confined to its own custom room, then the tile effectively
  has a sandbox and needs no explicit user consent. This is the tier the stint
  should build against.
- **Public writes** — a write outside the room: an RSVP to a public record, a
  vote, a board-game move. This needs a grant, and §9 is where that lands.

### 7.4 Storage

The thread converges on "re-implementing browser `localStorage`, but for the
PDS": arbitrary data, namespaced by the tile application, with the host
enforcing that a tile can only write records in its own namespace. The
`store.js` protocol is the spec's name for exactly this, and it is unwritten
(§2.4) — so a Roomy implementation of tile storage is simultaneously a feature
and a candidate upstream contribution, and the stint's write-up should say which
it turned out to be.

The data model the thread sketched: a generic **MASL record** that tiles write
to, with the application's NSID as the record key. This supports arbitrary
functionality, with the remaining constraint being integration with third-party
lexicons.

### 7.5 Composer takeover

Not required by either feature, and the riskiest of the surfaces, because a tile
that controls the composer controls what the user appears to be saying. Worth
noting that the thread's own risk assessment separates it from the others: a
full-screen tile in the sidebar is chosen by an admin and will not be stumbled
into, whereas an interactive embed is more exposed. The composer is further
along that axis still.

### 7.6 Live media

Recorded as a limitation rather than a plan. Streaming video into a chat room
(for example a Streamplace stream) is a good room-context use case, but a tile
cannot stream video — it is network-dead, so the media would have to be piped in
by the host, which is a **new tiles protocol**, not an application of an
existing one. Also noted in the thread: the spec's own packaging discussion
observes that manifest-like loading makes large content (parquet, video)
awkward, which is the same constraint from the other direction.

---

## 8. Infrastructure

### 8.1 The tile loading server

The one genuinely new operational surface. Requirements, per `@dasl/tile-server`:

- Wildcard DNS (`load.<domain>` and `*.<domain>`) and a **wildcard TLS
  certificate**. The spec and the package README both say this is the deployer's
  job.
- The app must know the request's true host behind a proxy
  (`app.set("trust proxy", "loopback")` in the Express example), so the
  redirect target is right.
- The mothership's `loadDomain` points at it.

**Shape.** A small, separately-deployable service. It never sees tile content,
so it does not belong inside the appserver's trust boundary, and it must be a
**different origin** from app-lite (§4.4) — a tile origin that is same-origin
with the app would defeat the sandbox while looking like it worked. Two
implementation options:

- **Run the CLI/service as-is** (`tiles-loading-server <host> <port>`,
  default port 1503) as its own deployment target. Least code; adds a Node/Express
  process to the estate.
- **Re-implement the router** against the appserver's `Bun.serve` fetch handler.
  It is a redirect plus a header set plus serving a fixed set of runtime
  assets, so this is not large — but it is a security-relevant re-implementation
  of someone else's header policy, and any drift is a silent hole.

**Decision: a centralised service, and for now it is the DASL project's own.**
Self-hosting is not a goal — a second deployment target, a wildcard certificate
and a second process in the estate buy nothing a shared service does not — so
Roomy uses `load.webtil.es` and leaves `loadDomain` unset.

That is the loader's hardcoded fallback, not a convenience:
`TileMothership.getLoadSource()` returns
`https://${this.#conf?.loadDomain || 'load.webtil.es'}/.well-known/web-tiles/`
(`@dasl/tile-loader@2.0.0`). Verified against the live service:

```
GET https://load.webtil.es/.well-known/web-tiles/
  => 303, location: https://<random>.webtil.es/.well-known/web-tiles/
  => 200 with the mandated header set, service-worker-allowed: /,
     HSTS preload, referrer-policy: no-referrer, Caddy
```

The random subdomain is per request, and the headers are the spec's own set —
including `sandbox … allow-popups-to-escape-sandbox`, the part disputed in
`darobin/dasl.ing#98` (§3.2). **The limits, stated plainly:**

- **It is someone else's deployment.** No SLA, no published quota, no
  versioning contract, and one shared dependency for every Roomy instance that
  leaves `loadDomain` unset. If it is down, tile *content* does not load anywhere
  (cards still render — they need no network).
- **The header policy is theirs and can change without notice.** Roomy cannot
  pin it, and the containment a tile gets is exactly what that server sends,
  including the disputed sandbox flag. Anywhere Roomy needs a different policy,
  it needs its own server.
- **It sees loads, not tiles.** The shuttle's own assets come from the load
  origin; the tile's resources are fetched by the mothership from the tile's
  PDS. So it learns timing, volume and the requesting IP, not which tile was
  loaded — which matches the spec's "a server that cannot learn more than what
  the embedding context already knows".
- **It does not host tiles.** Publishing stays on AT (`atile`, §8.2); the
  loading server is a redirect, a header set and the shuttle runtime.
- **Leaving is one config value.** `loadDomain` points at Roomy's own
  `load.roomy.space` when there is one; the wildcard certificate that needs is a
  deploy-time change to however `roomy.space` TLS is issued today, and is the
  only part of §8.1 that has an outside-the-repo dependency.

### 8.2 Publishing tiles

`atile` covers publishing from a command line: upload each resource as a blob,
post the manifest as an `ing.dasl.masl` record. Whether tile *publishing* should
also be admin-facing inside Roomy — so community managers can author simple
embeds without touching a CLI — is open, and is the difference between a
"bring your own tile" model and a product. Not in the two weeks.

### 8.3 Build and delivery facts that constrain the deployment

- **app-lite is a static SPA** built by `scripts/build-prod.sh` and served by
  Caddy (`Caddyfile`) or Netlify (`netlify.toml`); the service worker is
  registered and caches assets.
- **`app.bsky.feed.getAuthorFeed` against the public AppView needs no OAuth
  scope** — it is unauthenticated. Reading public Bluesky data is a *fetch*, not
  a *grant*. The repo already calls `api.bsky.app` directly for profile lookups
  (`packages/appserver/src/materialization/profiles.ts:170`), and
  `packages/app-lite/src/lib/last-login.ts:101` calls the AppView from the
  client.
- **`blob:*/*` is already in `BASE_SCOPES`** (`packages/app-lite/src/lib/scopes.ts:192`),
  so a tile fetching its own manifest and blobs from a PDS needs no new scope.

---

## 9. Scopes, consent, and the capability question

This is where the thread spent most of its energy, and where the funded features
must not accidentally overreach.

### 9.1 How Roomy's scopes work today

Two independently-deployed gates, and **neither is enforced by the appserver**:

1. **The PDS metadata ceiling** — `FULL_SCOPE_CEILING`
   (`packages/app-lite/src/lib/scopes.ts:310-348`) is served as
   `oauth-client-metadata.json`. A request for a token missing from it fails
   with `invalid_scope`. It is rebuilt on every deploy from that file.
2. **The HappyView API client's scope allowlist**, provisioned on the HappyView
   instance and read from its database per request. After consent, the client
   posts the granted set to `POST /oauth/sessions`, and HappyView rejects the
   **whole** set if any one token is absent — so one unregistered token blocks
   every login, and the browser surfaces it as
   `OAuthCallbackError: Failed to register session`.

`APPSERVER_RPCS` (`scopes.ts:84-150`) becomes `rpc:<nsid>?aud=*` and rides the
`base` tier. `UNREGISTERED_SCOPES` (`:175-178`), `REQUESTABLE_SCOPE_SETS`
(`:262-272`) and `check-oauth-scopes.mjs` (run in CI at
`.github/workflows/ci.yml:287-288`) enforce that no requestable tier asks for an
unregistered token.

The appserver's scope handling is **storage only**: it records the raw granted
string, serves it back pre-login, and stores change *intents* for the settings
page. No handler checks a scope, and there is no `invalid_scope` path in the
appserver.

### 9.2 The tile-scope problem, stated precisely

The thread's problem: if a tile needs to write to the user's PDS, that is a new
scope. But `oauth-client-metadata.json` is static, so it bounds what *any* tile
could ever request — the ceiling is the union of everything every tile might
need, which is untenable for third-party integrations, and the alternative
(every tile's needs in Roomy's metadata) is what makes the file hard to keep in
sync in the first place.

The consequence identified in the thread is the important one: if Roomy's
metadata says "all write access" so some tile can write a collection not
enumerated there, the user gets an opaque "write access to PDS" consent prompt —
which is precisely the user-evaluates-the-permission failure mode the spec's
decision tree exists to avoid.

### 9.3 The resolution

The thread lands on a **middle ground**, and it is the recommendation here:

- **Default: a namespaced MASL store.** A tile writes only to records namespaced
  by its own application; the host enforces the namespace. This needs no
  expanded consent, and it covers polls, board games, and tile-local state.
- **Exception: whitelisted public writes.** Some tiles genuinely need to write
  to public records — RSVPs being the canonical case. Roomy **whitelists those
  scopes**, in the sense that a tile requesting a PDS write is **manually
  reviewed** before its scopes are added to the metadata and registered with
  HappyView. The thread's own description of this is "like Apple App Store
  review", and it is a governance mechanism rather than a protocol one.
- **Rejected: tiles running their own OAuth flow.** The thread considers it —
  each tile already has its own subdomain, so it could hold a session on the
  tile's host domain — and rejects it, because it "ruins some of the otherwise
  nice sandboxing": a tile with network access and a session is just an iframe,
  and can exfiltrate.

The related upstream wish, recorded for the write-up rather than acted on: it
would be nice if OAuth client metadata could declare `transition:generic` while
requesting narrower scopes at login, but the ceiling is a deliberate PDS-side
constraint and the thread expects it to stay.

### 9.4 The arbiter path, and a live blocker

Roomy spaces are real ATProto accounts on the Roomy PDS, reached through the
arbiter's policy proxy. A write to the space's own repo goes one of two ways:

- **Server-driven** — through the appserver's built-in route.
- **Client-driven** — through `ArbiterClient.proxy` → the scoped route
  (`space.roomy.authComplete.arbiter.proxy`).

The scoped route runs the published permission set's Rego **over the inner
request alone, with no caller identity**, and it **denies `putRecord` of
`app.bsky.feed.post`** — pinned by `packages/appserver/src/arbiter/provision.test.ts:187-218`.
That is an existing, unrelated blocker recorded in
`docs/plans/bluesky-publishing.md` §0.4, and it is worth restating here because
a tile that wants to post on the space's behalf hits exactly the same wall. It
is *not* feature 1's problem: feature 1 **reads** records and renders them, and
reading public Bluesky data needs no scope and no arbiter call.

---

## 10. Instrumentation for the 30-day write-up

The request is for early signal on how users actually engage with tiles: how
often, for what, what is ignored, what surprised us. That needs "light,
privacy-respecting instrumentation".

What exists:

- **`packages/app-lite/src/lib/telemetry/faro.ts`** — Grafana Faro browser
  telemetry, gated on `PUBLIC_FARO_URL` and a **no-op when unset** (the dev and
  default-build configuration). The SDK is dynamically imported so a deployment
  without telemetry pays no payload cost. Its v1 scope is deliberately narrow:
  console interception plus error instrumentation, **no web vitals, no
  tracing**.
- **`packages/app-lite/src/lib/telemetry/scrub.ts`** — every item passes
  through `beforeSend`, which replaces absolute URLs with their host. This
  exists because logged errors routinely carry a request URL, and a
  `com.atproto.server.getServiceAuth` URL carries a signed capability that
  would otherwise be stored permanently.
- **Prometheus metrics** — `packages/appserver/src/metrics.ts`, a
  dependency-free text-format registry served at `/metrics`, with per-endpoint
  latency, pool queue depth, cache hit rate, and embed backlog
  (`roomy_embed_pending`, `roomy_embed_enriched_null`, and the rest, wired at
  `appserver.ts:950-975`).

The gap: **Faro's v1 scope records errors and console output, not product
events.** Counting "how often is a tile expanded" is not something the current
telemetry can answer. Two honest options, and the choice should be made
explicitly rather than drifting into one:

- **Client events via Faro** — a small set of structured events (tile card
  rendered, tile content expanded, tile interaction, tile errored), sent through
  the existing Faro transport and the existing scrubber. No new infrastructure;
  needs a deliberate decision about what identifies an event (a tile CID is
  content, not a person — but a DID or a room id is a person and a place).
- **Server-side counters** — the appserver already counts embed enrichment;
  the same shape would cover manifest resolution and cache behaviour, which is
  operational rather than product signal.

Privacy constraints that should be stated in the instrumentation's own
documentation, not just decided here: no per-user event streams, no message
content, no DIDs in event properties, and the existing `scrub.ts` invariant
holds for anything new. The write-up should report what was measured, what was
deliberately not, and why.

---

## 11. Plan

Two classes of work, sequenced so the self-contained checkpoints land first.

### 11.1 The rendering path (milestones A and B)

These are small, standalone checkpoints that prove the render pipeline before any
of the resolution machinery in §5 exists. Both render a tile from an AT-URI that
Roomy already has — a hand-placed one for A, the tile attachment's own field for
B. Neither needs the *link*-to-tile resolution of feature 1, the content-type
mapping, or the embed projection. B does carry one prerequisite that is not a
rendering step at all, called out as B0 below: the message DTO becomes a list of
attachments before a tile can be one of them (§4.6).

**Milestone A — standalone tiles.** A tile whose assets are all in its manifest
and which takes no data from the host: a static web page, an interactive WebGL
scene. The whole shape is:

1. `TileMothership` in app-lite with `loadDomain` left unset, so it uses the
   shared loading server (§11.3), and `addLoader(new ATTileLoader())`.
2. A component that takes a tile AT-URI, calls `tl.loadTile(uri)`, appends
   `renderContent()`, and shows the manifest's card via `renderCard()` while
   loading.

Nothing else is needed: `ATTileLoader` fetches the manifest from the PDS and its
`ATPathLoader` (`@dasl/tile-loader/at`) serves each manifest path from that same
PDS. There is no host data channel in the path at all.

This is worth doing first because it isolates the variables most likely to waste
a fortnight: whether the sandbox behaves as the spec claims, and whether the
mothership/shuttle/worker wiring works from inside a Svelte app. It is also the
first test of the upstream concern in §3.2 — if the iframe or worker wiring
misbehaves, that is evidence for `darobin/dasl.ing#98`, not a Roomy bug.

**A tile reaches a message as its AT-URI in the body.** Written into the
composer, the address is ordinary text in an ordinary message: there is nothing
to attach, no schema change, and no extension key. `MessageContent` resolves the
addresses it finds and renders a tile beside the text for each, so a message
carries a tile the way it carries a link — the renderer is where the resolution
happens, and the message stays a message.

Two properties of a body decide how that scan reads it, and both are load
bearing:

- **The address may be in a link facet rather than in the text.** A typed or
  pasted bare address stays plain text — the composer's autolink is `linkifyjs`
  and matches `scheme://host`, which `at://` is not — but a markdown link
  (`[label](at://…)`) puts its target only in the facet. Both sources are read.
- **Code is skipped.** A `#code` block, or a fenced block in a legacy markdown
  body, renders its text verbatim; an address quoted inside one is a sample, not
  a tile.

The render is capped (`MAX_TILES_PER_MESSAGE`) and deduplicated per message,
because each tile costs every reader of the room a `plc.directory` lookup plus a
record and blob fetches against a PDS the message chose. Nothing is loaded while
the address is being typed: half an address is a well-formed address, so a live
preview would settle on an error card for each keystroke of the last one.

The tile's box stops its clicks from propagating. Two surfaces render a message
inside a row that is itself a `role="link"` control, where an unstopped click
would mount the tile and navigate away in the same gesture.

This is not milestone B and does not pre-empt it: an attachment carries a tile
*plus structured data* (§5.3), which is what the Mermaid renderer and the room
context need, and which a body string cannot express. What the body form buys
first is the demo and test path — any published tile can be exercised by typing
its address — and the retroactive case the resolution work also wants: a message
that already spells an address renders a tile with nothing rewritten.

**Step B0 — the unified attachment read path.** Before a tile attachment has
anywhere to land, the DTO becomes `Message.attachments: AttachmentDto[]`: one
entry per attachment, each carrying its `$type`. No materialiser change — the
per-kind component tables already hold every row and `selectMessages` already
reads them all (`selectMessages.ts:333-374`); what changes is that the
projection emits one list instead of four shapes. It is a step rather than a
milestone because nothing renders differently on its own; it is the shape the
tile is added to.

The renderers that draw a message's attachments — the `media` and `linkEmbeds`
snippets in `ChatMessage`, `ActivityFeed`, `SearchResultsList` — read that list
through one module, `attachment-views.ts`, the single place a rendered message
switches on an attachment's `$type`, rather than each filtering a per-kind
field. The optimistic placeholder in `mutations/message.ts` builds the list the
server will return instead of hand-building `media` and `linkEmbeds`, and the
activity feed projection emits it for the latest message of each item
(`activityFeed.ts`). The Links view turned out to have nothing to migrate: its
rows come from `getLinks`, never from a message.

`media`, `linkEmbeds`, `replyTo` and `forwardedFrom` stay on the DTO as derived
views of the list, for the reads that are not attachment rendering — the reply
context line, the forward embed, and the edit-time preview toggle, which is
keyed on the URL rather than on an attachment.

**Milestone B — the tile attachment.** A tile receives arbitrary JSON attached
to the message alongside the tile's AT-URI. The motivating case is a Mermaid
renderer: the attachment carries the tile's AT-URI and the diagram source, and
the tile renders it.

The carrier is a new variant in the existing `Attachment` union —
`space.roomy.attachment.tile.v0`, carrying the tile's AT-URI and a payload —
inside the existing `space.roomy.extension.attachments.v0` extension. This is
the "Roomy-native" home for it, and it is the shape that survives edits, is
discoverable in the union, and rides the read path messages already have. The
cost is that it is a **real schema change**, in a fixed set of places.

**The union is closed, so this is not optional — verified, not assumed.** An
attachment whose `$type` is unknown is *rejected* outright. Against the built
SDK:

```
"UNKNOWN tile att, no schema change"
  => FAIL: extensions["space.roomy.extension.attachments.v0"].attachments[0].$type
          must be "space.roomy.attachment.comment.v0", "space.roomy.attachment.file.v0", …
```

So a tile attachment cannot be smuggled through as an unrecognised attachment;
the variant has to be added. (The inverse of this is what made the earlier
`at://`-keyed design a zero-schema-change option. Attachments trade that for a
shape the read path already understands.)

**The touch points, all five of them.** Skipping any one is a silent failure at a
different layer:

| # | Where | What |
|---|---|---|
| 1 | `extensions/message.ts:105-113` | Add `TileAttachment` to the `Attachment` union |
| 2 | `events/message.ts:76-77` (create) | A branch writing the attachment to storage |
| 3 | `events/message.ts:305-386` (edit) | The same branch, or edits drop the tile |
| 4 | `queries/selectMessages.ts:333-374` + DTO | The projection branch, and the entry it adds to `Message.attachments` |
| 5 | `app-lite` / `design` | The component that loads and renders the tile |

`createMessage`'s `attachments` option (`operations/message.ts:24`, `:78-83`) is
already generic over the union, so the SDK operation needs no change — an agent
passing a tile attachment writes it with no new operation and no composer work.

**The edit path is the trap, and it has a precedent for the bug.** The edit
materialiser iterates attachments and, for an unrecognised `$type`, falls
through silently — so a tile attachment would vanish the first time the message
was edited. That is not hypothetical: `space.roomy.attachment.forward.v0` is
handled in the create path (`events/message.ts:161`) and has **no branch in the
edit path** (`events/message.ts:305-386`), so a forward's edge is not rewritten
on edit. Milestone B must not repeat that. There is a second,
narrower trap: an edit carrying *only* link attachments takes a non-destructive
"preview toggle" fast path (`events/message.ts:236-262`), so a tile attachment
must not be swept into a destructive full-replace by that branch.

**Storage and the read path — the reason to prefer this over the key.** The
materialised message tables are per-kind components behind `entities`
(`comp_embed_image`, `comp_embed_video`, `comp_embed_file`, `comp_embed_link` —
`db/schema-space.sql:199-242`), and the read path is that set UNIONed into a
flat media list (`queries/selectMessages.ts:333-374`), surfaced as
`Message.media: Media[]` (`queries/_message.ts:21-33`, `:126`) and rendered by
`MediaEmbed.svelte`. A `comp_embed_tile` row on that precedent gets the tile to
the client through `getMessages`, `getThreads`, the activity feed and search with
**no new endpoint, no admin-gated query, and no duplication of the projection**.

The DTO is where this lands, and it is why B0 comes first. `Media` is flat and
renderer-agnostic (one URL, an optional mime type, dimensions) and carries no
`$type`, so a tile row would be indistinguishable from an image row; giving the
tile a second parallel field (`Message.tiles`, the narrower move) would
reproduce for the tile exactly the split that makes today's read path hard to
extend (§4.6). One list, one variant, one arm in the renderer.

**Payload size.** The tile payload rides inside the event, so its cost is the
event log's cost. There is no per-event or per-message byte check anywhere on
the appserver's write path — `sendEvents` validates the batch count only
(`handlers/space.roomy.space.sendEvents.ts:71-78`, capped at `MAX_BATCH_SIZE = 50`
at `:30`) and the XRPC router parses the JSON body without a size check
(`xrpc/router.ts:236-238`).

The one real ceiling is the runtime's: **Bun caps a request body at 128 MiB by
default** (`maxRequestBodySize`), and this appserver does not override it
(`appserver.ts:1024-1026` sets only `port`, `idleTimeout`, `fetch` and
`websocket`). Measured against Bun 1.3.14:

```
1MB -> 200   64MB -> 200   100MB -> 200   127MB -> 200   129MB -> 413   140MB -> 413
```

That ceiling is far too coarse to be a design constraint, because the real cost
is not whether one request fits — it is that **the event log is the source of
truth and is replicated in full** (`litestream.yml` replicates
`roomy-events.sqlite` continuously), so every byte of payload is a byte in every
backup, for the life of the space. A megabyte per message is a megabyte per
message forever.

The guidance worth writing down now: **what travels in the event is a reference,
not content.** The tile's AT-URI (and CID) plus a small structured payload; the
tile itself is an `ing.dasl.masl` record on a PDS, with its resources as ATProto
blobs the tile fetches through its own manifest — which milestone A already
proves works, and which costs the event log nothing. Worth an explicit bound in
the new variant's `.describe()` plus an appserver-side rejection, rather than
discovering the problem at scale. This is item 12 in §13.

**What this does not change.** The tile still receives its payload over
`tp-data` (§7.1): the attachment is the *transport* into Roomy's own data model,
and the mothership is what hands it to the sandboxed tile. Nothing here requires
`data.js` to be implemented differently, and nothing here changes milestone A.

### 11.1a Not chosen: the `at://`-keyed extension map

Recorded because it was the first candidate and because the verification is worth
keeping.

The alternative was an extension keyed directly by the tile's AT-URI, with
arbitrary JSON as the value:

```json
{ "extensions": { "at://did:plc:abc/ing.dasl.masl/3abc": { "mermaid": "graph TD; A-->B" } } }
```

**This passes `parseEvent` and is preserved verbatim** — ArkType's
`onUndeclaredKey: "ignore"` default over `MessageExtensionMap`'s derived keys
accepts and retains unknown keys:

```
"at:// key": { "at://did:plc:abc/ing.dasl.masl/3abc": { "mermaid": "graph TD; A-->B" } }
  => PASS, preserved: {"at://did:plc:abc/ing.dasl.masl/3abc":{"mermaid":"graph TD; A-->B"}}
```

It is genuinely zero-schema-change on the write side: `writeAuth.ts:856-863`
gates on the event `$type` alone, and `createMessage` is in `ALLOWED_TYPES`.

It was set aside for three reasons, all of them read-path:

1. **Nothing reads it.** The DTO carries no extensions field
   (`schemas/queries/_message.ts:92-130`) and the projection reads none —
   `comp_content` holds mime type, bytes, last-edit and timestamp
   (`db/schema-space.sql:153-162`). The raw event is durable in `stream_events`
   (`db/eventsSchema.sql`), so nothing is lost, but rendering would need a new
   read path; `space.roomy.sync.getEvents` can supply the event
   (`StreamManager.ts:479-489`) but is **admin-only** today
   (`handlers/space.roomy.sync.getEvents.ts:4`, `requireAdmin` at `:32`).
2. **It loses per-kind semantics.** Every existing attachment type has a row, a
   UNION branch, a DTO entry and a renderer. An `at://`-keyed blob has none, so
   the read path would have to be built anyway — at which point the union variant
   is the same amount of work in a shape the codebase already recognises.
3. **It is undiscoverable.** `unionToMap` (`primitives.ts:111`) enumerates the
   extension map's legal keys; an `at://` key is one only by accident of
   ArkType's default, and `MessageExtensionUpdateMap`/`DeleteMap` give it no
   place in the edit or delete protocol.

The verification stands, and if a future need is genuinely "arbitrary keyed
metadata that must not be modelled", this is the escape hatch and it already
works. It is not the right shape for a *tile*, which is a modelled thing.

### 11.2 The resolution path (feature 1, then feature 2)

**Phase 1 — a Bluesky-post tile end to end.** AT-URI recognition → manifest
resolution (appserver-side, cached) → a tile entry in the unified attachment
projection → sandboxed card. Lands the first funded feature, on top of
milestones A and B. Expected upstream friction: what the embed shape does and
does not carry (§5.3), and the record-vs-blob reference question (§3.2,
`darobin/dasl.ing#43`).

Because the resolution is a projection over the link row, it applies
retroactively: once the resolver runs, every post link already in a space
renders richly, with no event rewritten and nothing asked of the author. That
falls out of two things, both of which are decisions rather than consequences.

**One: the resolver's cache is per instance.** One map in the appserver process,
keyed by link URL, shared across the spaces that instance serves, so a post
resolved for one space answers every message that links it. The existing embed
metadata cache is per space (`comp_embed_link_data`, in each space's own DB);
this one deliberately is not, because the expensive part — a PDS round-trip for
the tile manifest — is a property of the URL and not of the space. The cost is
that the process holds one entry for a link that several spaces contain: cache
state is shared where the rest of the read path is per space. Nothing renders
differently, because the resolver's output reaches a message only through that
message's own link row. The cache carries a resolver version, so rows enriched
by an older resolver are recognisable as stale.

**Two: enrichment is demand-driven, not a backfill.** Write time and read time
are the only two points that enqueue work. A write already scans the body and
inserts link rows (`applyBatch.ts:589-632`); a read finds rows whose embed data
is missing, null, or stamped with an older resolver version, and re-enqueues
them. There is no separate pass over the log and nothing to run at deploy time —
the first read of an old message is what triggers its resolution. The requeue is
`insert or ignore` into `pending_links`, so a page of 50 messages with the same
link asks once, and the sweeper's existing retry schedule and attempt ceiling
still bound the work.

That reuses a shape the read path already has: `selectMessages` hydrates author
profiles on demand for the rows it is about to return, with
`skipProfileHydration` for internal readers
(`queries/selectMessages.ts`). The difference is that profile hydration blocks
the read and resolution does not — a card renders from whatever the resolver
cache holds and fills in on a later read, which is what the `#messageDiff`
update path is for.

**Phase 2 — room context metadata.** A room-context extension added to the room
extension union, stored in `comp_room`'s new JSON column and written through the
`extensions` field `updateRoom` gains (§6.3) — set at room creation or changed
after it. Renders a tile in a navbar slot from room state.

**Phase 3 — the calendar context tile.** The first context type end to end:
calendar event → context metadata → tile → RSVP. The RSVP is where §9.3's
whitelisted-public-write question gets its first concrete instance, and it may
turn out to be the point at which the feature stops and an upstream conversation
starts.

**Stretch, only if feature 1 has landed:** additional context types; a richtext
tile block (§5.3c); a `store.js` implementation (§7.4); more than one entry in the
conventional content-type → tile mapping (§5.4).

**Deliverables at the end:** the working Bluesky-post tile, the first room
context tile, the spec-and-tooling write-up, and links to the upstream issues
and PRs that came out of it.

**Thirty days after:** the engagement write-up (§10).

### 11.3 The loading server the stint uses

There is nothing to deploy and nothing to decide here: `loadDomain` is left
unset, so the mothership uses `load.webtil.es` (§8.1), and a tile already
published on AT is enough to exercise the whole path. That decouples "does the
render pipeline work" from "do we have wildcard DNS", and it removes the second
of the two variables milestone A was meant to isolate — the loading domain's
configuration is now proven by the server being up, not by Roomy configuring it.

What remains for milestone A to isolate is the sandbox itself and the
mothership/shuttle/worker wiring in app-lite: whether a tile's content loads
under those headers, whether the service worker registers on a foreign origin,
and whether `renderCard()`/`renderContent()` behave as documented. If iframe or
worker wiring misbehaves there, that is evidence for `darobin/dasl.ing#98`, not a
Roomy bug.

The consequence to accept deliberately is that every tile load in a dev run
touches a third-party server under someone else's header policy. That is the
same trade §8.1 already makes for production; the difference is that a
production replacement is one config value away and needs only the wildcard
certificate.


---

## 12. Upstream risks and opportunities

Carried forward into the write-up and the issue list:

1. **The sandbox header set is disputed** (`darobin/dasl.ing#98`) — six specific
   concerns, including a missing `COEP` and `allow-popups-to-escape-sandbox`.
   Roomy shipping these headers is a decision to consume the model as published.
2. **`tp-editable` / `store.js` is unwritten.** A Roomy tile-store
   implementation would be a real contribution, and the thread's "localStorage
   for the PDS" framing is a concrete proposal.
3. **AT references in MASL** (`darobin/dasl.ing#43`) — an AT-URI field alongside
   the CID, and blob-reference norms. Feature 1 depends on the first.
4. **Live media cannot be expressed.** Streaming video needs a new protocol; the
   spec's own packaging discussion acknowledges large-content awkwardness.
5. **Chat-channel and tile-to-tile invocation** remain unimplemented in the spec
   ("a future version of this specification will add…"). Roomy's poll/RSVP and
   room-sync work may produce the first real implementation of that pattern, and
   is worth raising with the DASL project rather than only building privately.

---

## 13. Decisions and open questions

Where the plan stands, item by item: several are decisions, recorded in full in
the section each points at, and the rest are open. Nothing here is a blocker for
milestone A.

1. **Content-type → tile mapping** (§5.4): settled as by convention — a
   Roomy-published default set of content-type → tile pairs, used by every space,
   with no per-space configuration in this plan. Who curates the default set is a
   product question for whenever there is more than one entry in it.
2. **Embed shape** (§5.3): the tile attachment is settled as the carrier for an
   attached tile, and the unified `Message.attachments` list is settled as the
   read shape both it and a resolved link land in (§4.6, §11.1 B0). What is not
   settled is whether a resolvable link becomes an entry in that list by
   extending the existing embed projection (the recommendation for the first
   cut) or by auto-attaching a tile attachment on send.
3. **Resolution site** (§5.5): settled as appserver-side resolution with
   client-side tile loading, and a resolver cache that is per instance, not per
   space (§11.2). What that costs is recorded there: cache state is shared across
   the spaces one appserver serves, where the rest of the read path is per space.
4. **Which loading server** (§8.1): settled — the shared `load.webtil.es`, with
   `loadDomain` left unset. The open part is only Roomy's own replacement, which
   needs a wildcard certificate and is a config change away.
5. **Room-context storage** (§6.3): settled as a JSON column on `comp_room`,
   written through the `extensions` field `updateRoom` gains. What is open inside
   it is the extension's own shape — one extension per application namespace,
   keyed by NSID, with the tile managing its value.
6. **Whether the context is editable after room creation** (§6.3): yes, and that
   is what the `updateRoom` extensions field exists for. `createRoom` already
   takes the same map, so context can be set at creation and changed after it,
   with `null` removing a namespace.
7. **Room-read capabilities** (§7.2): none in the first cut, or a small
   read-only verb set? The thread's conclusion that the compute belongs mostly
   on the client argues for handing the tile data the client already has.
8. **The unified list's own protocol gaps** (§4.6): B0 settles `$type` — an
   entry now says what kind it is, which is what lets a renderer dispatch on
   it. What is still open is id and order: an entry has no id of its own (a row
   is keyed by its URL, which only a link is addressed by) and the list is
   assembled in kind order, not the order the author attached things in. A tile
   lands in that list either way; how much of ordering, identity and
   per-attachment editing comes with it is not settled. Ordering and identity
   are DTO-only changes; per-attachment editing is not, because
   `MessageExtensionUpdateMap` replaces the whole set.
9. **The first public-write capability** (§9.3): is the calendar RSVP the right
   forcing function, and what does the manual-review process actually look like
   on the Roomy side?
10. **What the 30-day instrumentation measures** (§10), and what it is forbidden
    from measuring.
11. **Whether tile use is behind a feature flag**: no. A flag here would be
    redundant friction — a tile is either in the message or it is not, which is
    not discoverable UI in the sense a flag protects against, and the sandbox
    being new is not something a flag mitigates. The comparable flags
    (`voice-chat`, `semble-integration`, `links-view`, `user-blocks` —
    `packages/appserver/src/featureFlags.ts:20-60`) all gate UI that changes the
    shape of a room or a message; a tile attachment is content, like an image.
12. **Whether the tile payload needs a declared size bound**: yes, and the point
    is what travels at all. Only *references* belong in the event log — a tile's
    AT-URI (and CID) plus a small structured payload; the tile's own content lives
    in an `ing.dasl.masl` record on a PDS, with its resources as ATProto blobs
    (§2.1, §8.2). The log is the source of truth and is replicated in full, so a
    bound in the new variant's `.describe()` plus an appserver-side rejection is
    cheap insurance against the one case where someone attaches the content
    itself.
13. **Explicit embed intent at create** (§5.3): the create path is implied today
    — the body is scanned and every URL gets `show_preview = 1`, and
    `showPreview` is only ever seen on the edit path. Attaching link attachments
    on send is compatible with history (no row still means "shown"), but it needs
    the row key settled first: an explicit link attachment and a body-scanned URL
    for the same link currently produce two rows (§4.6). Out of scope for this
    stint; it is the natural follow-up to B0.
14. **Re-enriching links that have already been enriched** (§11.2): solved by
    demand, not by a backfill. Reads re-enqueue rows whose embed data is missing
    or stamped with an older resolver version, so the first read of an old message
    is what resolves it. The wider rule this settles: enrichment happens at write
    time and read time only, and nothing sweeps the log looking for work.

---

## 14. References

**DASL / Web Tiles**

- Web Tiles — `https://dasl.ing/tiles.html` (stabilising; 2026-10-01)
- Tiles Protocols — `https://dasl.ing/tiles-protocols.html` (hot new stuff)
- Tiles Protocol: Data Passing — `https://dasl.ing/tp-data.html`
- Tiles Protocol: Self-Editing Tiles — `https://dasl.ing/tp-editable.html` (stub)
- MASL — `https://dasl.ing/masl.html`; CAR — `https://dasl.ing/car.html`;
  CIDs — `https://dasl.ing/cid.html`
- `@dasl/tiles` 2.0.0 (2026-07-03), `@dasl/tile-server` 2.1.0 (2026-07-14)
- Issues: `darobin/dasl.ing#98` (unsafe sandbox, open), `#43` (MASL/ATProto
  blobs and AT-URIs)

**Roomy, current tree** (`origin/next` @ `4276631e`)

- Client embedding: `packages/app-lite/src/lib/embed/embed-service.ts`;
  `packages/design/src/components/content/thread/message/embeds/LinkCard.svelte`
- Message rendering:
  `packages/app-lite/src/lib/components/chat/{MessageContent,BlocksRenderer,ChatMessage,ChatInputArea,ChatArea}.svelte`;
  `packages/design/src/components/content/thread/message/MessageBubble.svelte`;
  `packages/design/src/components/content/thread/ChatInputShell.svelte`
- Slots: `packages/app-lite/src/lib/components/layout/{navbar.svelte.ts,sidebar.svelte.ts,MainLayout.svelte}`;
  `packages/app-lite/src/routes/[space]/[room]/+page.svelte`
- SDK schemas: `packages/sdk/src/schema/richtext/index.ts`;
  `packages/sdk/src/schema/extensions/message.ts` (the `Attachment` union and
  the `Attachments` extension); `packages/sdk/src/schema/events/message.ts`
  (the create and edit materialisers that branch per attachment `$type`);
  `packages/sdk/src/operations/message.ts` (the `createMessage` constructor and
  its `attachments` option); `packages/sdk/src/schema/events/room.ts`;
  `packages/sdk/src/schema/events/registry.ts`; `packages/sdk/src/schema/envelope.ts`;
  `packages/sdk/src/schemas/queries/_message.ts` (the `Message`, `Media` and
  `LinkEmbed` DTOs); `packages/sdk/src/schemas/procedures/sendEvents.ts`
- Appserver: `packages/appserver/src/embed/{sweeper,enricher,metadata,types}.ts`;
  `packages/appserver/src/queries/selectMessages.ts`;
  `packages/appserver/src/handlers/space.roomy.embed.getLinkMetadata.ts`;
  `packages/appserver/src/blob.ts`; `packages/appserver/src/identity.ts`;
  `packages/appserver/src/auth/writeAuth.ts`;
  `packages/appserver/src/db/schema-space.sql`;
  `packages/appserver/src/appserver.ts`; `packages/appserver/src/featureFlags.ts`
- Scopes: `packages/app-lite/src/lib/scopes.ts`;
  `packages/app-lite/scripts/check-oauth-scopes.mjs`
- Telemetry: `packages/app-lite/src/lib/telemetry/{faro,scrub}.ts`;
  `packages/appserver/src/metrics.ts`
- Deployment: `Dockerfile.app-lite`, `Dockerfile.appserver`, `Caddyfile`,
  `netlify.toml`, `packages/appserver/litestream.yml`, `scripts/dev-local`
- Related plans: `docs/plans/bluesky-publishing.md` (the arbiter write-path
  blocker), `packages/appserver/docs/plans/arbiter-integration.md`,
  `docs/rich-text-representation-research.md` (the `standard.site` note),
  `docs/plans/web-tiles-roomy-feasibility.md` (the earlier feasibility read)

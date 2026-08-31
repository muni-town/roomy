# Web Tiles × Roomy — Feasibility Research

## TL;DR

Web Tiles (the `dasl-tiles` toolbox implementing the DASL "Web Tiles" spec) are a good conceptual fit for both of your use cases, and the spec was clearly designed with exactly this kind of application in mind — the spec text literally uses "a poll tile in a group chat app" as its motivating example. The hard parts are not conceptual, they're infrastructural and governance-related:

1. You need to run (or depend on) a **tile-loading server** — a small piece of always-on, wildcard-DNS-backed server infrastructure, independent of Leaf/appserver, whose only job is to hand tiles a fresh random origin.
2. The spec's security model gives you strong protection against **exfiltration** (tiles can't touch the network) but it does **not yet define** the "room context" / query-capability channel you want for use case 2 — that's presently a stub ("a future version of this spec will add support for..."). You'd be designing and owning that protocol extension yourselves, at least initially.
3. Because tiles are content-addressed and sandboxed, the main trust decision is administrative: **which tile CIDs/handles is a given space allowed to load, and with what capabilities.** This maps cleanly onto Roomy's existing arbiter/steward authorization thinking.

Below is the detail behind each of these.

---

## 1. What a Web Tile actually is

- A **tile manifest** is a MASL document (DASL's metadata format) in "Bundle Mode." It needs a `name` and a `resources` map, where `resources["/"]` is required (the root document).
- Tiles can be published two ways:
  - **On ATProto**: each resource is uploaded as a **blob** to the account's PDS, and the manifest itself is posted as a record (lexicon `ing.dasl.masl`, NSID record type `main`, keyed by `tid`). Critically, on AT the manifest's `resources[path].src` must use the `blob` type (not a bare CID), because PDSs only track uploaded blobs, not arbitrary CIDs. This is the part your publishing pipeline (`atile publish`, or your own equivalent) has to get right.
  - **As a CAR file** (`.tile`), fully self-contained, for local/offline or non-AT distribution.
- Optional manifest fields cover the useful admin/UX metadata you'd want for a tile catalog: `description`, `categories`, `icons`, `screenshots`, `sizing` (declared width/height), `theme_color`, and a `prev` CID link for versioning.

## 2. The execution/security model (this is the part that matters most for you)

The spec mandates a specific header set for any context that loads tile content:

```
content-security-policy:
    default-src 'self' blob: data:;
    script-src 'self' blob: data: 'unsafe-inline' 'wasm-unsafe-eval';
    script-src-attr 'none';
    style-src 'self' blob: data: 'unsafe-inline';
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

The key design move: **no network access beyond what's pre-declared in the manifest's `resources` map.** `default-src` and `script-src` only allow `'self'`, `blob:`, `data:` — there's no external origin a tile could fetch from, so classic script-injection exfiltration paths (beacon to attacker server, fetch to attacker API) are closed by construction, not by trust. The `allow-same-origin` + `allow-scripts` combination inside a sandboxed iframe looks alarming on its own (it's normally the combination that defeats `sandbox`), but it's safe here specifically *because* CSP has already removed the escape hatch (no arbitrary `connect-src`) — same-origin is needed so the tile's own service worker / storage works, not so it can reach out.

Because of this, "safety" here is really "no cross-origin egress," and it's why the spec explicitly frames tiles as suitable for **private data contexts** (chat, agents) where a normal iframe/webview would be too dangerous to embed arbitrary third-party content in.

### Why you need a random/unique origin per tile, and what that implies operationally

Browsers don't give you a way to sandbox *within* an origin strongly enough for this model, so each tile instance needs its own origin (today: random subdomain; the spec notes this may become CID-derived later). That's what the **Tiles Loading Server** does:

- Client hits `https://load.yourdomain.example/.well-known/web-tiles/…`
- Server 302s to `https://<20-random-letters>.yourdomain.example/.well-known/web-tiles/…` with the correct header set attached
- `@dasl/tile-server` ships exactly this as an Express router (`createTileLoadingRouter(domain)`) or a standalone CLI (`tiles-loading-server`)

Operationally this means:
- **Wildcard DNS** (`*.yourdomain.example`) and a **wildcard TLS cert** for whatever domain you dedicate to tile loading. You've already done cert/Traefik work for multiple domains on the infra side, so this is an incremental extension of something you already operate, not a new category of problem.
- This server is intentionally dumb — the spec explicitly recommends it be "a server trusted by the user... that cannot learn more than what the embedding context already knows." It doesn't need to know what a tile *is*, only redirect + attach headers. Good candidate for a small, separately-deployable service (fits your existing pattern of small Railway/Docker services), not something that needs to live inside the Leaf/appserver trust boundary.
- Because every tile load touches this network hop, it's a mild latency/availability dependency. Caching the redirect target briefly and/or running it geographically close to your appserver is worth doing, but this is a solved shape of problem for you already (Traefik + multi-domain cert issuance).

### The three-tier loader architecture

`@dasl/tile-loader` structures the client side as:

- **Mothership** — lives in your actual app context (i.e., your Svelte 5 frontend). Has real-world access (network fetch, filesystem where relevant) and is configured with one or more `TileLoader`s (`ATTileLoader`, `CARTileLoader`, `WebXDCTileLoader`, `MemoryTileLoader`). You call `tl.loadTile(url)` and get back a `Tile` with `renderCard()` (safe, metadata-only, fine to render hundreds of these) and `renderContent()` (heavier, spins up the actual sandboxed context).
- **Shuttle** — an iframe the mothership creates in the isolated random-origin context, whose only job is hosting a service worker + the tile's own nested iframe, and relaying messages between worker and mothership. It exists purely because of a browser limitation (you need a real page origin to host a service worker in).
- **Worker** — a service worker dispatched into the shuttle that intercepts all resource requests for the tile and defers them upward through the shuttle to the mothership, which resolves them against the manifest's `resources` map (fetching the actual blob from the PDS, CAR, or memory depending on loader).

For Roomy specifically: your mothership integration point is naturally inside the Svelte 5 `app` package, most likely as a component wrapping `TileMothership`, configured with an `ATTileLoader` pointed at whatever PDS/AppView resolves the relevant `did`/`ing.dasl.masl` records, `loadDomain` pointed at your tiles-loading-server deployment.

## 3. Mapping onto Roomy's architecture

Relevant existing pieces (from what's on file about Roomy):

- Event-sourced architecture: ATProto is the durability/identity layer, **Leaf** is the sync server, the **appserver owns a local SQLite event store** that a materializer builds from the event stream, and the Svelte 5 UI runs reactive queries against that.
- The `sdk` package already "holds shared schemas for events and defines how they are materialised" — this is exactly where a new event type (e.g. `roomy.embed.tile` or similar) and its materializer would live.
- You already have prior art in shipping an ATProto-integrated permission model (the arbiter/steward architecture, formalized in Quint) — this is the natural place to hang "which tiles can this space load, and with what capability grants" governance.
- Discord bridging and rich-text/reactions/threads already exist as message-adjacent features, so "custom embed type" is an extension of a pattern you already have, not a new concept.

### Use case 1 — custom embeds / message-type tiles

This is the easier case and maps almost directly onto the spec's built-in model:

- A message (or a dedicated embed sub-record) carries a reference to a tile — most simply, the AT-URI of the tile record (`at://did:plc:.../ing.dasl.masl/<tid>`), analogous to how you'd reference any other ATProto record.
- The materializer resolves that into whatever your event schema needs (tile name/description/sizing for the "card" preview, deferring the actual tile load to render time).
- Rendering: `renderCard()` for the collapsed/inline preview in the message list (cheap, safe to render at scale — the spec explicitly calls this out), `renderContent()` only when a user expands/interacts with it.
- **Admin-configured allowed types**: since resources are fully declared in the manifest and the tile is otherwise inert (no network), the main admin control here is a per-space (or per-org) **allowlist of tile publishers/handles or specific tile AT-URIs/CIDs** permitted to be rendered as embeds — this is a straightforward extension of the steward/arbiter model, expressed as space config rather than a new protocol.
- Data flow into the tile for this use case can be nearly nil — most "custom embed" tiles just need their own manifest-declared resources plus perhaps small parameters (e.g., poll options) passed in at instantiation, which the loader API supports via whatever init payload you choose to hand `renderContent()`.

### Use case 2 — room-context-aware tiles with query access

This is the genuinely open part of the spec. Today, the spec explicitly says:

> "Because the lack of network access is restrictive, tiles can be granted additional contextual access. A future version of this specification will add support for chat channels (to sync between tile instances in a chat) and an intent-based way for tiles to call one another."

That hasn't shipped yet. What exists conceptually (and is gestured at via the poll-tile example) is a **capability-channel pattern**: the embedding context (your mothership) exposes a message-passing channel to the tile, and the tile can post/receive on it — but only what the embedding app chooses to expose, since "the embedding app or context mediates all communication." Nothing in the current tile sandbox lets a tile reach out on its own; every capability is something *you* hand it.

For a "make specified queries against the room" feature, you'd be defining a protocol layer on top of tiles, e.g.:

- A capability-scoped RPC surface exposed to `renderContent()`'s postMessage bridge — something like a small set of read-only query verbs (`getRecentMessages(n)`, `getMembers()`, `getThread(id)`) that the mothership implements by querying Roomy's own materialized SQLite view, never handing the tile direct DB or event-log access.
- A per-tile-type **capability grant declared by the admin at install time** (which queries this tile class is allowed to make), stored the same way you'd store any other space-level permission grant — this again leans on the arbiter/steward work you've already done rather than requiring new primitives.
- Because tiles are otherwise network-dead, this channel *is* the entire attack surface for context-aware tiles — which is good, because it means your security review effort concentrates on one well-defined boundary (the RPC surface) instead of "what could this arbitrary JS do."
- Worth doing as a Roomy-specific extension for now, but also worth raising with the DASL project (`darobin/dasl.ing` issues) — you'd plausibly want to influence what the spec's own "chat channel" and "intent-based invocation" primitives end up looking like, since Roomy is likely to be one of the earliest real deployments of that part of the model.

## 4. Server-side infrastructure inventory

| Component | Purpose | Notes |
|---|---|---|
| Tiles Loading Server | Issues a fresh random-subdomain origin per tile load, attaches mandated headers | `@dasl/tile-server`'s `createTileLoadingRouter`; needs wildcard DNS + wildcard cert on a dedicated domain (or subdomain) |
| Tile resolution/caching | Resolve AT-URI → manifest → blob fetches from PDS | Can likely piggyback on whatever AppView/PDS-fetching infra you already have for other ATProto records; worth caching manifests + blobs given PDS round-trip cost |
| Tile publishing tooling | Upload resources as blobs + post the manifest record | `atile` CLI covers this for humans; you may want a programmatic equivalent if you ever let admins publish tiles through the Roomy UI itself rather than via CLI |
| Capability/allowlist store | Which tile CIDs/handles/publishers a space permits, and what capability grants (use case 2) | Space-level config, natural extension of arbiter/steward permission model, materialized the same way other space settings are |
| RPC bridge (use case 2 only) | Mediates room-context queries from a loaded tile to Roomy's materialized views | Lives in the mothership-hosting app code; read-only, capability-scoped, no direct event-log/DB access from the tile side |

Notably **absent** from this list: anything that needs to sit inside Leaf or the event-sourcing core itself. Tiles are a rendering/embedding-layer concern; the event schema/materializer changes for use case 1 are the only touchpoint into `sdk`.

## 5. Cross-origin security — the specific questions you asked about

- **Why cross-origin matters here at all**: the whole point of the tile sandbox is that a malicious or buggy tile cannot exfiltrate anything, including things a normal `<iframe>` embed *could* leak (referrer info, ambient cookies, timing side channels against same-site resources). The mandated header stack closes each of those: `referrer-policy: no-referrer`, `cross-origin-opener-policy: same-origin`, a `default-src`/`script-src` with no external origins at all, and a fresh random origin per load so there's no persistent identity to correlate across sessions or tiles.
- **What you're trusting**: only the tiles-loading server (to attach correct headers and not itself do anything malicious) and your own mothership code (to only expose the RPC/capability surface you intend). You are explicitly *not* trusting the tile's own JS, which is the point.
- **What's still an open design question for you**: the query/capability channel for use case 2 is un-speced, so its cross-origin safety is entirely a function of what you implement — postMessage-based bridges are safe if and only if you validate origin/source rigorously on every message and keep the exposed verb surface minimal and read-only (at least initially, before you'd consider any tile-initiated writes).
- **Multi-tenancy / self-hosting implication**: if Roomy spaces can be self-hosted or the tile-loading domain varies per deployment, each deployment needs its own wildcard cert + DNS for its tile-loading domain — this is a deployment-config item, not a code item, and fits the "gardenable"/credible-exit ethos (an instance's tile infra is self-contained, doesn't require depending on a central Roomy-operated service) if you want that property.

## 6. Suggested phased rollout

1. **Phase 1 — read-only embed tiles, use case 1 only.** Ship the tiles-loading-server, wire `TileMothership`/`ATTileLoader` into the Svelte app, add one `sdk` event/materializer for "message references tile at `<AT-URI>`," admin allowlist by publisher/handle. No custom RPC surface yet — this alone gets you rich custom embeds (polls, small widgets) with the security model fully covered by the existing spec.
2. **Phase 2 — capability-scoped room context.** Design and implement your own postMessage RPC bridge with a small, explicit, read-only verb set; gate it behind per-tile-type capability grants in space config, reusing the arbiter/steward model.
3. **Phase 3 (optional, longer horizon)** — feed learnings back into the DASL spec's still-unspecified "chat channel sync" / "intent-based tile-to-tile invocation," since you'll likely have a more complete real-world implementation of that pattern than the spec authors do yet.

## Open questions to resolve internally

- Do you want a **central, Muni-Town-operated** tiles-loading server that all Roomy instances use by default (simpler for the OSS/Discord-migrant ICP, less infra for each self-hoster), or push every self-hosted instance to run its own (more consistent with credible-exit/collective-sovereignty positioning, more setup burden)? Possibly: ship a sane default with an easy override.
- Should tile **publishing** be admin-facing inside Roomy (so community managers can author simple embeds without touching `atile` CLI), or purely a "bring your own tile" model where communities reference tiles published elsewhere?
- For use case 2, what's the actual first query verb worth shipping — something concrete like "read the last N messages in this thread for a summarization tile" would be a good forcing function for the RPC surface's design.

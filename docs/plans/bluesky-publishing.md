# Publishing to Bluesky as the Space Account — Plan

**Date:** 2026-09-16 (scope corrected by Meri 2026-09-29; revised 2026-10-01)
**Status:** Phase 1 shipped; Phases 2–3 not started. Phase 0's decisions (§6)
remain open and block Phases 2–3. The §3 exporter shipped as #341 (`fb936a74`)
— `roomyMessageToBskyPost` in `packages/sdk/src/bluesky/post.ts`. No code
publishes or reads a post yet.
**Next:** Phase 2 — feature 1, sharing an own message (the share affordance,
the composer, the appserver post procedure, and the message↔post mapping).
Blocked on §6.1 (which write path) and §6.2 (who may share). Not dispatched.
**Verified against:** `origin/next` @ `2dbf7d8a`. §0.3, §0.4, §1.4, §2.5 and §4 were re-read there; §3's `convert.ts` citations too. Other `file:line` citations date from the original pass and shift with `next`.
**Slots into:** `packages/appserver/docs/plans/arbiter-integration.md` (Phases 0–4) — read that first. This plan is a *new* phase that consumes that plan's shipped machinery; it does not replace or restate it. Its account of the arbiter is itself partly stale (§4.1 says where).

**Path choice.** This document lives at `docs/plans/bluesky-publishing.md`. Rationale: the root `docs/plans/` directory holds the cross-package plan documents (`richtext-migration-plan.md`, `voice-chat-plan.md`, `client-migration-plan.md`), while `packages/appserver/docs/plans/` holds appserver-scoped ones. This work touches `packages/sdk` (exporter, arbiter client), `packages/appserver` (the feed query, opt-in, mapping table) and `packages/app-lite` (the share action, the space page) — three packages, so the root directory is correct.

---

## 0. Scope

### 0.1 The two features

Per Meri, 2026-09-29:

1. **Share an individual message.** A user clicking "share" on *their own* message gets the option to make a Bluesky post, with that message as a starting point.
2. **The space's Bluesky page.** A page in a space — "perhaps comparable to 'index'" — that is essentially a mini Bluesky client, scoped to the profile feed of the space's account. Admins may post to the space's account from it (if enabled); non-admins may view it.

**Automatic mirroring is explicitly not a goal.** The earlier draft of this document recommended a per-room auto-mirror phase; that is out of scope and §0.2 records what it was carrying.

### 0.2 What the correction removes

Dropping automatic mirroring removes more than a phase — it removes the entire apparatus the draft built *for* it. Both remaining features have a human in the loop at the moment of posting, so:

| Draft section | Status now |
|---|---|
| Per-room mirror toggle, `mirror_from` watermark, persisted publish queue, publish sweeper | **Removed.** These existed to make an unattended publish safe. Neither feature publishes unattended. |
| §3.3 "the replay problem" (TASK-151's shape) | **Moot for now**, but the design rule it produced is kept as a standing invariant (§3.3) — it applies again the moment any automatic path is added. |
| Per-space opt-in event + `comp_space.publish_enabled` (§1.2–1.3) | **Narrowed.** It gated automatic publishing. What remains is a smaller question: whether a space's page has posting enabled at all (§2.4). |
| The grapheme limit as a *terminal* failure mode | **Becomes a composer constraint.** A human reviews the post before it goes out, so an over-length message is something the UI tells them about, not a queue item that settles. |
| The `definitive` / `transient` outcome model, backoff, delete-on-settle | **Removed.** Failure is a synchronous error on a user action, surfaced like every other failed mutation (the `space.roomy.space.updatePolicy` error-surfacing precedent). |

What survives is the part that is genuinely load-bearing:

- the **exporter** (Roomy message → `app.bsky.feed.post`) — §3;
- the **message ↔ post mapping**, needed to answer "has this message been shared?" and to retract a post when the message is deleted — §1.5;
- the **route and policy analysis** — §4, which is where the one hard blocker lives.

### 0.3 What is built today; what is absent

**The space already has a Bluesky identity.** A Roomy space *is* a real ATProto account on the Roomy PDS, reachable through the arbiter's policy proxy.

| Capability | Evidence |
|---|---|
| Provision a space as a real PDS account | `packages/appserver/src/arbiter/provision.ts:46` (`provisionSpace` → `createArbiter`, `resetConfig`, `proxy`) |
| Act as the space on its PDS (client-driven) | `packages/sdk/src/atproto/arbiter.ts:97` (`ArbiterClient`), `:156` (`proxy`), posting to `space.roomy.authComplete.arbiter.proxy` with a per-request single-use serviceAuth token (`:140-148`) |
| Act as the space on its PDS (server-driven) | `packages/appserver/src/arbiter/client.ts:145` (`proxy`), posting to `town.muni.arbiter.proxy`; used today only by provisioning (`arbiter/provision.ts:60-75`) |
| Write a record under the space's repo | `packages/sdk/src/atproto/bluesky-profile.ts:101` — `putRecord` of `app.bsky.actor.profile`; the only `app.bsky.*` write in production code |
| Write a `network.cosmik.*` record under the space's repo | `packages/sdk/src/atproto/cosmik-card.ts` (`createCosmikCard`) via the scoped route; wired from the message toolbar at `packages/app-lite/src/lib/mutations/space-card.ts` |
| Upload a blob to the space's repo | `packages/sdk/src/atproto/bluesky-profile.ts:41` (`uploadBlobToSpace`) |
| Set the space's handle | `packages/sdk/src/atproto/space-handle.ts:77` |
| UI surface | `packages/app-lite/src/routes/[space]/settings/integrations/+page.svelte:101` — "Create/Update Bluesky Profile", gated by the `space-account-management` flag (`:18-20`) and `isAdmin` (`:14`) |
| OAuth scopes for all of the above | already in the `base` tier (`packages/app-lite/src/lib/scopes.ts:146`, `:156`) — this plan adds none (§2.5) |

**Absent, and required by this plan:**

- **Post-publishing code.** Only the exporter exists:
  `packages/sdk/src/bluesky/post.ts` (`roomyMessageToBskyPost`, shipped as
  #341). Nothing writes an `app.bsky.feed.post`: the only reference to one in
  production code is the **negative** fixture at
  `packages/appserver/src/arbiter/provision.test.ts:203`, asserting the scoped
  route denies `putRecord` of it.
- **Any Bluesky *read* path.** `git grep -n "app\.bsky\.feed"` over `packages/` finds only that same fixture — no `getAuthorFeed`, no feed or thread fetch anywhere. The repo's only Bluesky reads are profile/handle lookups against `api.bsky.app` (`packages/app-lite/src/lib/components/auth/HandleTypeahead.svelte:50`, `packages/app-lite/src/lib/last-login.ts:41`). Feature 2's client is new work.
- **No message ↔ post mapping** of any kind, and no retraction path.
- **No message-length limit on the message schema**: no `maxGraphemes`/`maxLength`
  on any message schema. The exporter enforces Bluesky's own 300-grapheme
  ceiling (`packages/sdk/src/bluesky/post.ts`, `BSKY_POST_MAX_GRAPHEMES`); the
  composer of §1.2 does not exist yet.

### 0.4 Arbiter review, 2026-09-29 — the one finding that shapes this plan

`next` moved 85 commits between the original pass (`c7087ea9`) and this review. Four touch the arbiter:

| Commit | Effect |
|---|---|
| `d32d84a5` — add Roomy's arbiter policy and tests | Put the policy **in this repo** at `packages/appserver/policy/`. §4 is written against it as fact rather than speculation. |
| `9e70ffbd` — provision via the arbiter's built-in proxy route | The precedent for §4.1(c): a scoped route denies by *request shape*, and no admin authorization can rescue it. |
| `d01b02c3` — use the new scoped arbiter endpoint | Renamed the proxy route to `space.roomy.authComplete.arbiter.proxy` repo-wide. The rename is what makes the blocker visible. |
| `1b052a98` — docs/comment minimisation | Stripped task ids and incident framing repo-wide. |

**The finding: the two publish paths are gated differently, and the *client-driven* one is the one that is blocked.**

- The **scoped** route (`space.roomy.authComplete.arbiter.proxy` — what `ArbiterClient.proxy` uses, i.e. any client-driven post) runs the published permission set's embedded Rego over the inner request alone, with **no caller identity**. It **denies `putRecord` of `app.bsky.feed.post`** — pinned by `packages/appserver/src/arbiter/provision.test.ts:187-218` (`403 request denied by scope policy`). A post cannot be made through this route by anyone, admin included.
- The **built-in** route (`town.muni.arbiter.proxy` — what the appserver's own `proxy()` helper uses) has no scope gate; the installed policy admits the appserver as the space's recovery admin and forwards **any** non-management request. A post through this route is permitted **today**.

Details, and what each feature must do about it, are in §4.1. This is the plan's critical path.

---

## 1. Feature 1 — sharing an individual message

### 1.1 The product shape

A user acts on **their own message**. The share affordance leads to a composer pre-filled with that message's content, targeting the space's Bluesky account. The user edits if they want, sees what will be posted, and confirms. The post is created as the space, on the space's PDS.

Two consequences of "as a starting point" that shape everything below:

- **The user reviews the text before it is public.** So the exporter is a *draft generator*, not a publisher: its output is editable, and every lossy decision it makes (dropped typography, flattened headings, a dropped link card) is visible to the person about to publish it.
- **The post may not be the message.** A user may rewrite, add context, or trim. So "the post for message X" is a *human-authored derivative*, which is why §1.5 keeps a mapping the user can reason about rather than assuming post ≈ message.

### 1.2 Where the share action lives

The per-message hover toolbar already carries forward/move/delete (`packages/app-lite/src/routes/[space]/[room]/+page.svelte`, which owns those modals), and the same toolbar already hosts the Semble "save as space card" action (`packages/app-lite/src/lib/mutations/space-card.ts`). "Share to Bluesky" is a sibling of that, on the author's own messages.

The composer itself is new UI. It is not the message composer: it targets `app.bsky.feed.post`, enforces Bluesky's limit, and previews the facet mapping.

### 1.3 Who may share

Meri's framing is "users clicking 'share' on their own messages" — so the *author* of the message, not only admins. That is a different question from who may post to the space's feed from the page (§2.3), and it is worth stating separately because it is the more permissive of the two: it lets any member put one of their own messages on the space's public account.

That is a real authority question, not a UI detail — the post is authored by the *space*, so a member's words appear under the community's identity. §6.2 asks it directly. The draft of this plan assumed admin-only; Meri's clarification reverses that, and the two readings are different products.

### 1.4 The write path — and its blocker

A client-driven post goes through `ArbiterClient.proxy` → the **scoped** route → **denied** (§0.4, §4.1). So feature 1 cannot be built as a client-driven arbiter call until the permission set admits `app.bsky.feed.post`.

The options, in §4.1(c), are: widen the published permission set (a change outside this repo), or have the client call an **appserver procedure** that performs the post through the built-in route. The second works today and is the recommendation for v1 — it also gives the appserver the natural place to record the message ↔ post mapping (§1.5) and to enforce the author/admin check (§1.3) server-side, where it cannot be bypassed.

Note what the second option costs: the actor on the wire becomes the appserver, not the human. The *authorization* is still the human (the appserver checks that the caller authored the message and has access to the space), but the accountable identity for the published record is the operator. §4.2.

### 1.5 Idempotency and retraction

Without an automatic path there is no replay hazard and no queue — but two things still need durable state, and both live in the **global** DB:

- **"Has this message already been shared?"** drives the toolbar's state and prevents a double-submit from creating two posts.
- **"Which post is this message's?"** is what makes retraction possible: deleting a Roomy message deletes its post (a post can also simply be un-shared).

Shape: `(space_did, message_id) → (post_uri, post_cid, rkey, state)`, plus a `deleted_at` marker.

- **Home: the global DB, not the per-space DB.** A `SPACE_SCHEMA_VERSION` bump wipes and re-derives every per-space DB (`packages/appserver/src/db/db.ts:28-31`), so a mapping table there would lose every "already posted" record on the next schema change. The global DB is explicitly never wiped (`packages/appserver/src/db/globalVersions.ts:1-10`); new tables go in `schema-global.sql` with a manifest entry (`globalVersions.ts:50-73`, current tip `"10": { kind: "structural" }` at `:70`). Use `kind: "structural"` — the schema exec is idempotent on every open (`packages/appserver/src/db/worker.ts:154-157`).
- **A second, independent reason it cannot live per-space:** `deleteMessage` removes the row outright (`delete from entities where id = …`, `packages/sdk/src/schema/events/message.ts:429`) and `comp_content` cascades (`schema-space.sql:119-120`). After a delete there is no row left recording that the message existed, let alone that it was posted.
- **Deterministic rkey (optional, recommended).** `app.bsky.feed.post`'s key is `tid`, and `putRecord` on an existing rkey upserts — the property the profile write already relies on (`bluesky-profile.ts:93`). Deriving the rkey from the message ULID makes a re-share of an edited message an **upsert** rather than a second post. A ULID is *not* a valid TID (26 Crockford base32 chars including `0`/`1`/`9`; a TID is 13 chars from `234567abcdefghijklmnopqrstuvwxyz`), so the derivation is a real encode step, and it must be total, deterministic and collision-free. This is a nicety, not a correctness requirement, once the user is in the loop.
- **Retraction** uses `com.atproto.repo.deleteRecord`. `ProxyOperation` already supports `"DELETE"` (`packages/sdk/src/atproto/arbiter.ts:27-31`), so no SDK change is needed. Keep the mapping row with a `deleted` marker rather than removing it — a delete event can be delivered more than once, and a retained marker makes the second delivery recognisable as already handled. (The bridge keeps its row in one direction and removes it in the other; `packages/discord-bridge/src/services/message-edit-delete.ts:221` — "Keep mapping row — delete is recorded"). Once retracted, a re-share is a **new** post, not a resurrection.

---

## 2. Feature 2 — the space's Bluesky page

### 2.1 The surface

A space-level page listing the space account's own posts, rendered Roomy-side. Structurally it is a peer of the space index, not a room: it has no messages of its own, no write access rules beyond post/not-post, and it is the same for every member.

- **Route:** a space-level page (e.g. `/[space]/bluesky`), alongside the existing space pages.
- **Visibility:** members. Viewing is the default affordance; posting is the gated one (§2.3).
- **Empty and unavailable states matter here.** A space with no stewarded account cannot have a feed at all, and today that is indistinguishable from "no posts yet" (§6.4). The page must distinguish *no steward*, *stewarded but nothing posted*, and *failed to load*.

### 2.2 Reading the space's feed

**Reading public Bluesky data needs no OAuth scope** — `app.bsky.feed.getAuthorFeed` against the public AppView (`https://public.api.bsky.app`) is unauthenticated. The repo already calls `api.bsky.app` directly for handle and profile lookups. So this feature has no scope prerequisite; it is a *fetch*, not a *grant*.

Two placements, and this plan recommends the first:

- **(a) An appserver XRPC query** (e.g. `space.roomy.space.getBlueskyFeed`) that fetches and caches the feed for a space's DID. Consistent with the thin-client architecture (app-lite holds no third-party credentials and makes no unsanctioned external calls), and with the appserver's existing appview-fetch precedent (`getProfilesRoomyFirst` / Bluesky fallback). It also gives the appserver the one place that knows the space's DID → its stewarded account.
- **(b) Direct from the client** to the public AppView. Less work, no appserver round-trip — but it makes a third-party API call from the browser, leaks the space DID to it on every page view, and puts rendering-coupled fetch logic in the client.

Pagination, thread expansion and profile hydration all follow from whichever is chosen; none is required for v1 beyond a first page of posts.

### 2.3 Posting from the page

An admin composes a post as the space, from the page itself. This is the second human-in-the-loop surface, and it routes the same way feature 1 does (§4.1) — so **the same blocker applies**, and the recommended v1 answer is the same: an appserver procedure performing the post via the built-in route.

Gating: the existing precedent is `space-account-management` flag **AND** `isAdmin` (`packages/app-lite/src/lib/components/sidebar/SpaceSidebar.svelte:156-161`, applied at `:167`; the integrations page gates identically at `:14`, `:18-20`, `:67`/`:73`). The read view is *not* gated — non-admins see the page.

Note what a compose box implies that a share does not: an arbitrary post has no originating message, so it has no mapping row and no retraction-by-provenance. Deleting it is a direct `deleteRecord` against the post's own rkey.

### 2.4 Is a per-space opt-in still needed?

Yes, but it is a smaller thing than the draft's. It no longer gates *automatic* publishing; it gates whether a space's page accepts posts at all. Two shapes:

- **Implicit:** the space has a stewarded account and the caller is an admin → posting is available. No new event, no new column, no schema bump.
- **Explicit:** a per-space flag, stored as an event materialised into `comp_space`.

**Recommendation: implicit for v1.** The draft's argument for an event-sourced, default-closed flag was that a default-open flag would turn every space into an automatic publisher on first deploy. With no automatic path, that argument does not apply — the gate is already "the caller is an admin", which is enforced server-side on the write path. Adding an event, a column, a `SPACE_SCHEMA_VERSION` bump, three registration sites and an invalidation signal to express "admins of this space may post" is weight the feature does not need. If Meri wants a per-space switch (e.g. for communities that want the identity but not the posting), that is a small, well-precedented addition later — the checklist for adding a space-config event is at §6.4 of the draft's history, and the schema-bump asymmetry that decides where its state lives is unchanged (`db.ts:28-31` vs `globalVersions.ts:1-10`).

### 2.5 Progressive scope expansion — shipped, and a fresh precedent that bites here

Meri asked that this build on the progressive-scope work. That work has since **shipped**: `scopes.ts` is now the single source of truth (`SCOPE_SETS.base` for the per-login request, `FULL_SCOPE_CEILING` for `oauth-client-metadata.json`), with server-side grant tracking, an editable user settings page (`packages/app-lite/src/routes/user/settings/scopes/`), and the reactive consent dialogue (`scope-consent-dialogue.ts`, `scope-guard.ts` — `guardedXrpc` + `isInsufficientScopeError`). The plan document at `packages/app-lite/docs/plans/progressive-scope-extension.md` is now a record of what shipped, not a proposal.

**Two facts decide this feature's relationship to it:**

**(1) A post needs no new scope, because the scopes are already in `base`.** `BASE_SCOPES` carries `include:space.roomy.authComplete` and `rpc:com.atproto.server.getServiceAuth?aud=*` (`scopes.ts:146`, `:156`) — the two that gate *every* space-account write Roomy ships today (handle, profile, Semble cards). This feature adds nothing. **Therefore it adds no tier, and requests no new consent.** A tier would only be needed if Roomy ever wrote Bluesky records to a *user's own* repo — e.g. cross-posting to a personal account — which is not in scope. The plan's own comment marks that boundary: the Semble *space* path "goes through the arbiter proxy under `space.roomy.authComplete` and needs none of these", which is why the *personal* collection is the first real expansion (`scopes.ts:161-172`).

**(2) The proxied `com.atproto.repo.*` scopes are load-bearing, and the precedent is a bug fixed today.** Commit `b95e7cd8` (#329): an image send failed on OAuth with *"this session is not authorized for `com.atproto.repo.putRecord`: it needs `rpc:com.atproto.repo.putRecord?aud=<did>#atproto_pds`"*. The cause generalises — a call carrying an `atproto-proxy` header is an **RPC to that audience**, authorized by `rpc:<nsid>?aud=<did>#<service>`, **not** by the `repo:<collection>` grant that covers the same write sent directly. Declaring only the `repo:` half "looks correct in review while failing at runtime".

**This feature posts through exactly that shape.** A client-driven post is `com.atproto.repo.putRecord` sent to the space's arbiter with an `atproto-proxy` header naming the space's PDS — the same envelope as the profile and handle writes. So §4.1's recommendation matters twice over, and in a way that is easy to miss:

- Under the **recommended server-driven path**, the call is made appserver→arbiter with the appserver's own serviceAuth and never passes through the user's OAuth session — so this constraint does not apply to it.
- Under the **client-driven path**, it applies exactly: the session must authorize `rpc:com.atproto.repo.putRecord?aud=<arbiter>`. The four proxied NSIDs are declared in `base` today (`PROXIED_REPO_RPCS`, `scopes.ts:124-129`), so this is satisfied — but it is satisfied *incidentally*, by a scope added for a different bug, and a future narrowing of `base` would break posting without breaking anything else.

**Adopt the coverage test as the guard.** `packages/app-lite/src/lib/proxied-repo-scopes.test.ts` (added with that fix) scans for proxied `com.atproto.repo.*` calls and asserts the requested scope authorizes each, using `@atproto/oauth-scopes`'s real matcher rather than string-matching. Any client-driven post path must be covered by it. That test — not this document — is the thing that will catch the regression.

---

## 3. The exporter (shared by both features)

One pure function serves both: feature 1 seeds a composer with it, feature 2 needs the same post-shaping rules for its compose box (limit, facets, preview).

### 3.1 Roomy message → `app.bsky.feed.post`

**Source shape.** A Roomy message is a DRISL event, `space.roomy.message.createMessage.v0`, not an ATProto record, with two wire formats discriminated by mime type:

- **Legacy:** `text/markdown` / `text/plain`, decoded by `decodeContent` (`packages/appserver/src/db/content.ts:20`).
- **Current:** `application/vnd.roomy.richtext+json` (`convert.ts:32`), UTF-8 JSON of `{ $type: "space.roomy.richtext.document", blocks }`, parsed by `deserializeBody` (`convert.ts:1136`) or the appserver-side `decodeRichTextBody` (`packages/appserver/src/db/content.ts:45`).

Facets are generated **client-side** by `proseMirrorDocToBlocks` (`convert.ts:304`). **The exporter must handle both mime types**; `markdownToBlocks` (`convert.ts:838`) is the existing legacy→blocks bridge.

**Target shape.** `app.bsky.feed.post`: `text` (required, ≤3000 chars / **300 graphemes**), `createdAt` (required), `facets?`, `embed?`, `reply?`, `langs?`, `labels?`, `tags?`; key `tid`. `app.bsky.richtext.facet`: `index: #byteSlice` (`byteStart` inclusive, `byteEnd` exclusive, **UTF-8 bytes, post-global**) and a **closed** feature union of `#mention{did}` / `#link{uri}` / `#tag{tag}`.

### 3.2 Feature mapping

This implements what `docs/plans/richtext-migration-plan.md:160` already researched:

| Roomy feature | → Bluesky | Note |
|---|---|---|
| `#link { uri }` | `#link { uri }` | Direct: same field, same byte semantics. |
| `#didMention { did }` | `#mention { did }` | Direct. The *text* is display-only; upstream says the facet reference is what counts. |
| `#bold` `#italic` `#strikethrough` `#underline` `#code` `#highlight` | **dropped** | Bluesky's union has no typography. Text survives. |
| `#roomRef { spaceId, roomId? }` | **dropped** | No Bluesky equivalent. Text survives. |
| `#atMention { uri }` | **dropped** | Producer-less and consumer-less in Roomy today. |
| unknown `$type` | **dropped** | Roomy's union is open; Bluesky's is closed. |

**Drop at feature granularity, not facet granularity.** One Roomy facet can carry several features — `marksToFeatures` (`convert.ts:160`, module-private) pushes all of a run's marks into one facet, and an internal link mark produces `#link` **and** `#roomRef` on the same range. Rule: map the features, keep the facet if ≥1 survived, drop the whole facet if none did. Never emit a facet with an empty `features` array — the union requires at least the declared shape.

A `channelThreadMention` emits **only** `#roomRef`, so a channel mention becomes plain `#label` text on Bluesky. An internal link becomes a public `https://<app-origin>/<spaceId>/<roomId>` URL, which works — `parseInternalLinkHref` (`convert.ts:97`) accepts absolute URLs on any host with that path shape.

### 3.3 Flattening and rebasing

Roomy facets index into **one block's** `text`; Bluesky facets index into the **whole post's** `text`. So:

1. Flatten all blocks to one string with a **deterministic, documented separator** (`"\n"` between blocks and between list items). Headings, quotes and code lose their structure — accepted, and the same posture the repo takes for unknown blocks.
2. Rebase each surviving facet by the running **UTF-8 byte length** of the emitted prefix (`utf8ByteLength`, `convert.ts:37`) — not character count, not UTF-16 code units.
3. Emit `createdAt` from the **canonical** message timestamp, not the event ULID — `canonicalMessageTimestamp` (`packages/appserver/src/materialization/sortIdx.ts:241`), which honours `space.roomy.extension.timestampOverride.v0` (how bridged messages carry their true send time).

**Do not use `blocksToPlaintext` as the flattening substrate.** It collapses whitespace and trims (`convert.ts:676-698`, ending `parts.join(" ").replace(/\s+/g, " ").trim()`), destroying the exact text↔offset correspondence the rebase depends on. It is right for push bodies and search text, wrong here. The exporter needs its own offset-preserving flatten, and it must be **pure** so it can be tested against a corpus without a network.

**Standing invariant (kept from the draft).** Do *not* attach any publish side effect to a materialisation path (`applyBatch` / `applyBundle`). Boot re-materialisation replays from `idx 0` after any schema wipe (`packages/appserver/src/streams/reMaterialize.ts`, `isBackfill: true` at `:263-264`), and the bridge's backfill replays history through the live `sendEvents` path with no replay marker (there is none on that path — `push-freshness-gate.md:67-70`). Neither path can distinguish a replay from live traffic. This is inert for the current scope, and it is the first thing that breaks if an automatic path is ever added.

### 3.4 Character limit: 300 graphemes

**Roomy has no message-length limit of any kind** — no `maxGraphemes`/`maxLength` on any message schema, no composer `maxlength`, and `Intl.Segmenter` appears nowhere in the repo. So the exporter introduces the limit with no existing behaviour to match.

Because both features route through a human-reviewed composer, **refuse** (the draft's recommendation) is now a UI property rather than a queue outcome: the composer enforces the limit, shows the count, and will not submit over it. Count with `Intl.Segmenter` (`granularity: "grapheme"`) — available in the runtime; a family emoji segments to 1, `e`+combining acute to 1. Count the **flattened post text**, not the blocks.

Truncation remains wrong for the same reason as before: it is the only option that can silently publish something the author did not write. Thread-splitting stays out of scope.

### 3.5 Not in scope for v1

- **Media embeds** (images, video) — see §6.3.
- **Link-card thumbnails** — a card publishes `uri`/`title`/`description`; a thumbnail needs a blob upload.
- **Reply threading and quote posts** — Bluesky's `reply` needs `root` + `parent` strongRefs of *Bluesky* posts, which only exist if the Roomy message being replied to was itself published.
- **`langs`** — nothing in the repo detects language.
- **Bluesky-side moderation tooling** (labels, reports, blocks) — outside this repo.
- **Publishing from a space without an arbiter** — the legacy did:plc path (`packages/appserver/src/streams/did.ts:21`) has no PDS account and no credentials.

---

## 4. Policy and accountability

### 4.1 The three gates

**The policy is in this repo.** `packages/appserver/policy/default.rego` (167 lines, plus 673 lines of behavioural tests at `policy/tests/default_test.rego`), validated by the arbiter CLI per `policy/README.md`. The published record the reference config points at (`at://did:plc:cyqufxsezk33hqulcilckna6/town.muni.arbiter.policy/default`, `arbiter/provision.ts:35`, mirrored by `scripts/migrate-arbiter-configs.ts:102`) is its published form.

**(a) The community pipeline admits the appserver, for any collection.** The policy resolves adminship from three sources, first match wins:

1. the space account itself — `input.callerDid == input.arbiterDid`;
2. **the recovery admin named in the space's `town.muni.arbiter.recovery/self` record — the appserver (`did:web:api.roomy.space`)**. The policy's own comment calls this "load-bearing";
3. a Roomy admin, via `space.roomy.service/self` → `space.roomy.space.getUserAccess` (which authorizes on `auth.did === spaceId`).

For any admin, the final rule forwards **any** non-`town.muni.arbiter.*` request to `input.target` as the steward — **no NSID or collection allowlist**:

```rego
result := xrpc({ "target": input.target, "method": input.method, "nsid": input.nsid, ... })
  if { is_admin; not startswith(input.nsid, "town.muni.arbiter.") }
```

The appserver authenticates as *itself* (`mintServiceAuth` sets `iss = sub = ownDid`, `packages/appserver/src/auth/serviceAuth.ts:112-128`), so source 2 matches. **A server-driven post is permitted today.**

**(b) The server-side helper uses the built-in route.** `arbiter/client.ts:145` posts to `town.muni.arbiter.proxy` — no scope gate (the module comment at `:15-23` says why). A change from baseline: `d01b02c3` moved the appserver onto the scoped route, and `9e70ffbd` reverted it after the scoped route denied the provisioning write.

**(c) The scoped route — the client-driven path — denies a post.** Two gates run before any policy layer: (1) the account's `trustedScopes` must contain the prefix (`space.roomy.authComplete` — it does, `provision.ts:34`); (2) the **permission set's embedded Rego, over the inner request alone, with no caller identity**. It admits `space.roomy.*`, `network.cosmik.*`, `uploadBlob`, `updateHandle`, `putRecord`/`createRecord` of `network.cosmik.*`, and `putRecord` of `app.bsky.actor.profile` or `space.roomy.service` (`provision.test.ts:61-83`) — and **denies `putRecord` of `app.bsky.feed.post`** (`:187-218`). No admin authorization can rescue it: the caller DID is not visible to the scope policy at all.

| Path | Route | Status | What must change |
|---|---|---|---|
| **Client-driven** (`ArbiterClient.proxy`) | scoped | **blocked** — scope policy denies `app.bsky.feed.post` | widen the published permission set (outside this repo; update the in-repo transcription at `provision.test.ts:61-83`) |
| **Server-driven** (`arbiter/client.ts:145`) | built-in | **permitted** — recovery admin, any collection | nothing on the arbiter side |

**Recommendation for v1: server-driven, with the client calling an appserver procedure.** It works today, it keeps the author/admin check server-side where it cannot be bypassed (§1.3), and it gives the mapping table (§1.5) a natural home. Revisit (i) if Meri wants the human to be the accountable actor on the wire (§6.2).

### 4.2 Who is accountable

- The space's posts are published under the space's stewarded account, which is a real PDS account provisioned by the arbiter.
- **The appserver DID is the recovery admin of every stewarded account** and may act on any space unconditionally. That is what makes the recommended v1 path work, and it is worth stating plainly: for a post made through it, the visible author is the space, and the actor with unconditional capability is Roomy-the-operator.
- Moderation is outside Roomy. A deleted Roomy message retracts its post only if this path is built to do it (§1.5); once retracted, the post may already have been indexed or reposted. Rate limits and content rules apply to the space's PDS account, so one careless sharer degrades the *space's* standing.
- Banning a member does not remove what they already posted, and — with no automatic path — a banned member's share fails at the write path's existing ban check rather than at publish time.

---

## 5. Phases

Each phase states an **observable completion criterion**. Phase 1 is shipped;
Phases 2–3 are not implemented.

### Phase 0 — Decisions (this document; no code)

**Completion criterion:** §6's open questions have answers recorded here. §6.1 (the route) and §6.2 (who may share) block Phases 2–3.

### Phase 1 — The exporter (no network) — shipped (#341, `fb936a74`)

**Deliverables**

- A **pure** `roomyMessageToBskyPost(message) → { text, facets, createdAt }` in the SDK, implementing §3.2–§3.4. No I/O.

**Completion criterion**

- A corpus — plain text, `#link`, `#didMention`, bold/italic, internal links, code blocks, ordered/unordered lists, emoji — round-trips with **every emitted facet's byte range slicing the emitted text to exactly the annotated substring** (assert by slicing UTF-8 bytes, not the JS string).
- A message whose only facet is `#roomRef` emits **zero** facets; `#link` + `#roomRef` on one range emits exactly one.
- A 301-grapheme message is rejected; a 300-grapheme message is not.

### Phase 2 — Feature 1: share an own message

**Deliverables**

- The share affordance on the author's own messages, and the composer (§1.2) — pre-filled, editable, limit-enforcing.
- The appserver procedure performing the post via the built-in route (§4.1), with the author/admin check server-side (§1.3).
- The message ↔ post mapping in the global DB (§1.5), used for "already shared" state and retraction.
- Retraction on message delete, and an explicit un-share.

**Completion criterion**

- A user shares their own message; a post exists at the space's account whose text matches what the composer showed, and the toolbar then reports it as shared.
- Sharing the same message twice creates one post.
- Editing the message and re-sharing updates that post rather than creating a second.
- Deleting the message removes the post; replaying the delete does not error and does not re-attempt.
- A user sharing someone else's message is refused by the appserver, not merely hidden in the UI.

### Phase 3 — Feature 2: the space's Bluesky page

**Deliverables**

- An appserver feed query for a space's account (§2.2).
- The page: post list, profile header, empty/steward-missing/error states (§2.1).
- Admin-only compose, gated by `space-account-management` AND `isAdmin`.

**Completion criterion**

- A non-admin member sees the page and the space's posts, with no compose affordance and no way to reach one.
- An admin posts from the page and it appears.
- A space with no stewarded account renders the "no account" state, not an empty feed.

---

## 6. Open questions for Meri

Decisions, not gaps in research.

**6.1 Which write path do we ship?** *This is the critical path.* (a) **Server-driven** — the appserver posts via the built-in route; works today, no outside-repo change, but the accountable actor on the wire is the operator. (b) **Client-driven** — requires widening the published `space.roomy.authComplete` permission set (a record outside this repo) so it admits `putRecord` of `app.bsky.feed.post`; then a human admin's own credentials drive the post, and the human is the accountable actor. (c) Both, sequenced (a) then (b). **The plan is written so both features are deliverable under (a) alone.**

**6.2 Who may share a message to the space's account — its author, or only admins?** Meri's framing is "users clicking 'share' on their own messages", which is more permissive than admin-only: any member could put their own words on the community's public account. Admin-only is the safer default and matches every other space-level setting; author-only is the better product if the community's account is understood as a shared voice. The two are different products, not two settings of one.

**6.3 May a space re-host a member's media under the space's identity?** Attachments are blobs on the *author's* PDS; publishing them under the *space's* account copies a user's file into another repo. That is a consent question, not a technical one.

**6.4 What does the page do for a space with no stewarded account?** Steward resolution fails opaquely today — `getSpaceProfileRecord` swallows every error and returns `null` (`packages/sdk/src/atproto/bluesky-profile.ts:83-87`), so "no steward" and "no profile" are indistinguishable. The policy now resolves the appserver via the space's `space.roomy.service/self` record, and the migration script skips spaces whose `town.muni.arbiter.service/self` names a different arbiter — so "stewarded by another arbiter" is a third state with no UI today. Options: surface steward state in `getMetadata`; stop swallowing the error; or leave it. Needed before Phase 3's page states.

**6.5 Should a space be able to disable posting while keeping the identity?** §2.4 recommends implicit gating (admin + stewarded account, no new state) for v1. If some communities want the account to exist without a compose box, that is a small event-sourced flag added later, not now.

**6.6 What is the retraction promise?** When a message is deleted, does Roomy *guarantee* the post is removed (best-effort with a visible failure), or only attempt it? Deleting a message in Roomy is permanent and local (`packages/sdk/src/schema/events/message.ts:429`); a partial publish failure leaves the two out of sync, and the plan must say what the user is told.

---

## 7. References

**In-repo**

- `packages/appserver/policy/default.rego` + `policy/tests/default_test.rego` + `policy/README.md` — the installed arbiter policy and its behavioural tests. The authoritative answer to "may the appserver write this?"
- `packages/appserver/src/arbiter/provision.test.ts:61-83` — the in-repo transcription of the published `space.roomy.authComplete` permission set; `:187-218` the negative fixture pinning that a `putRecord` of `app.bsky.feed.post` is denied on the scoped route.
- `packages/appserver/src/arbiter/client.ts:15-23` — why the appserver uses the built-in route.
- `packages/appserver/scripts/migrate-arbiter-configs.ts` — one-time `resetConfig` backfill; mirrors `REFERENCE_ARBITER_CONFIG`.
- `packages/app-lite/src/lib/scopes.ts` — **shipped.** `SCOPE_SETS.base` / `FULL_SCOPE_CEILING`, the tier definitions, and `PROXIED_REPO_RPCS` (§2.5).
- `packages/app-lite/src/lib/proxied-repo-scopes.test.ts` — **shipped.** The coverage test that asserts every proxied `com.atproto.repo.*` call the client makes is authorized by the requested scope, using the real `@atproto/oauth-scopes` matcher. The guard for any client-driven post path (§2.5).
- `packages/app-lite/src/lib/scope-guard.ts` + `scope-consent-dialogue.ts` — **shipped.** `guardedXrpc` + `isInsufficientScopeError`, and the reactive consent dialogue (§2.5).
- `packages/app-lite/docs/plans/progressive-scope-extension.md` — the design record for the above; now a description of what shipped, not a proposal.
- `docs/plans/richtext-migration-plan.md:160` — the export mapping, already researched.
- `docs/rich-text-representation-research.md:136-183` — the Bluesky post/facet lexicon analysis and the byte-index footgun.
- `packages/appserver/docs/push-freshness-gate.md` — the freshness gates; the bridge-replay hazard is in its framing, and the replay-marker follow-up is at `:67-70`.
- `packages/appserver/docs/plans/arbiter-integration.md` — the arbiter integration plan. Partly stale: its Phase 2 says `space.roomy.space.isAdmin` does not exist (the shipped equivalent, `getUserAccess`, is what the policy calls), and its Phase 1 step 3 names the scoped route the provisioning code no longer uses.

**External (fetched 2026-09-16; not in this repo)**

- `lexicons/app/bsky/feed/post.json` — required `text` + `createdAt`; `maxLength 3000` / `maxGraphemes 300`; `key: "tid"`; the `embed` union.
- `lexicons/app/bsky/richtext/facet.json` — `#byteSlice` (UTF-8, start inclusive / end exclusive) and the closed `mention | link | tag` union. Its `byteSlice` description explicitly warns UTF-16 languages to convert to byte arrays — the constraint `convert.ts:22-25` already encodes.
- `lexicons/app/bsky/embed/external.json` — `uri`/`title`/`description` required, `thumb` a ≤1 MB blob.
- `lexicons/app/bsky/embed/images.json` — ≤4 images, ≤2 MB each, `alt` required.

---

## 8. Verification notes

- §0.3, §0.4, §1.4, §2.5 and §4 were read at `origin/next` @ `2dbf7d8a`. §3's `convert.ts` symbols were re-located at the same commit (`utf8ByteLength:37`, `parseInternalLinkHref:97`, `marksToFeatures:160`, `proseMirrorDocToBlocks:304`, `blocksToPlaintext:676-698`, `markdownToBlocks:838`, `deserializeBody:1136`). Citations elsewhere date from the original pass at `c7087ea9` and shift with `next`; the symbols hold.
- The absence of the publish half and of any Bluesky read path was verified by grep against `origin/next` (§0.3), and each grep is runnable as written.
- Runtime facts checked rather than assumed: `Intl.Segmenter` grapheme segmentation (family emoji → 1 grapheme; `e` + combining acute → 1; vs 7 and 2 code points) and the TID alphabet/length (13 chars from `234567abcdefghijklmnopqrstuvwxyz`; a ULID is 26 Crockford base32 chars including `0`/`1`/`9`, so it is **not** a valid TID).
- §4.1's finding rests on three artefacts read at `2dbf7d8a`: `policy/default.rego`, the transcription at `provision.test.ts:61-83`, and the negative fixture at `:187-218`.
- No production code was changed by this task.

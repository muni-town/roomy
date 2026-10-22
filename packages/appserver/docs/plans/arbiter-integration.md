# Arbiter Integration (leaf-0.4)

**Date:** 2026-08-13
**Status:** Phases 0, 1, 2 and 4a shipped. Phase 0 (appserver signing key +
self-signed serviceAuth) and Phase 1 (new spaces provisioned as real ATProto
accounts via the arbiter) are implemented. Phase 2's policy is **live**: every
stewarded space's `town.muni.arbiter.config/self` names the layer at
`at://did:plc:cyqufxsezk33hqulcilckna6/town.muni.arbiter.policy/default`, whose
source and tests are in this package (`policy/default.rego`), and it asks the
appserver's `space.roomy.space.getUserAccess` — **not** the
`space.roomy.space.isAdmin` endpoint §Phase 2 proposed, which was never built
and is not needed. Phase 4a's migration ran: stewarded space DIDs' `#atproto_pds`
points at the Roomy PDS (`scripts/migrate-spaces-to-pds.ts`, with
`scripts/migrate-arbiter-configs.ts` bootstrapping the config record).
**Next:** Phase 3 (proxying appserver actions under a space account) — its only
piece, the `proxy()` helper (`src/arbiter/client.ts`), already exists and
provisioning uses it, so the phase is deferred rather than dispatchable. Phase 4b
is rejected in the plan; 4a's runbook is done.

## Purpose

Move Roomy's space (stream) DID hosting from the appserver to the new arbiter
server (`zicklag/leaf-0.4`). The arbiter hosts stewarded ATProto accounts,
evaluates every XRPC request against a per-account Rego policy, and either
denies it or proxies it to the account's PDS authenticated as that account.

This document records what was researched, the proposed target architecture,
the concrete phases, and the migration strategy for existing DIDs.

## Context — the two systems today

### Appserver identity today (`packages/appserver`)

- **Appserver's own DID:** `APPSERVER_DID` (default `did:web:api.roomy.space`),
  served at `/.well-known/did.json` (`src/appserver.ts:348-370`). Its DID doc
  declares a service (`#space_roomy_appserver`) and, since Phase 0, a
  `Multikey` `verificationMethod` (`#atproto`) backed by a persisted signing
  key (`src/auth/serviceAuth.ts`). It has no `#atproto_pds`. Used as the JWT
  audience (`OWN_DID` in `src/xrpc/auth.ts:68`) and as the `iss` of
  self-signed serviceAuth tokens to the arbiter.
- **Per-space "stream DIDs":** `createStreamDid` (`src/streams/did.ts:21`)
  generates a fresh secp256k1 keypair, builds a `did:plc` create op, POSTs it
  to `PLC_DIRECTORY_URL`, and sets the op's `pds` to `appserverUrl` — so each
  space DID's `#atproto_pds` points **at the appserver**. The private key is
  stored in the events DB (`src/streams/keys.ts` → `dids`/`did_keys`/`did_owners`
  tables). **This is the only did:plc creation site.** The space's entity id
  (`comp_space.entity`) **is the stream DID** (see `StreamManager.createStream`,
  `src/streams/StreamManager.ts:247`), so `spaceId == space DID`.
- **Auth flow:** inbound ATProto inter-service JWTs (signed by the caller's
  PDS, `aud=APPSERVER_DID`) are verified against the caller's DID-doc key;
  `AuthCtx { did }` is produced; handlers enforce per-space access. There is
  **no dedicated "is user admin of space" XRPC endpoint** — the closest is
  `space.roomy.space.getMetadata` returning `isAdmin`. Per-space admin is an
  in-DB edge (`src/auth/access.ts`, label `'admin'`) with helpers `isAdmin(db,
  spaceId, did)`.
- **Outgoing signing:** did:plc PLC ops (new space DIDs), VAPID web-push
  JWTs, and (since Phase 0) self-signed ATProto serviceAuth JWTs to the
  arbiter (`src/auth/serviceAuth.ts`).

### Arbiter today (`zicklag/leaf-0.4`)

- **Model:** one arbiter = one **stewarded account** (a real PDS account). The
  arbiter holds the account's PDS **password** (in a local Turso/SQLite store),
  not a PLC signing key. It is a **policy proxy**, not a did:plc key custodian.
- **Bootstrap XRPCs:**
  - `town.muni.arbiter.createArbiter` — provisions a brand-new account on a
    configured default PDS (random password, invite code). The **caller** is
    recorded as the **recovery admin**.
  - `town.muni.arbiter.createAppPasswordArbiter{arbiterDid, appPassword}` —
    imports an **existing** account by proving control via app password.
  - `town.muni.arbiter.resetPolicy{arbiterDid, policy}` — recovery-admin-only
    install of the root Rego policy.
  - `space.roomy.authComplete.arbiter.proxy{arbiterDid, target, method, nsid, parameters, body}`
    — the catch-all: evaluate the Rego policy over the inner request; on allow,
    proxy to `target` (`did#service`) authenticated as the steward.
- **Authn:** caller authenticates with a **serviceAuth JWT** (`aud` =
  arbiter-server DID, `lxm` = path NSID), signed by the caller's PDS signing
  key resolved from its DID doc. The verified caller DID is the token **`iss`**
  claim (canonical ATProto serviceAuth tokens carry no `sub` claim — see
  `crates/arbiter-server/src/auth.rs`); it becomes `input.callerDid`.
- **Policy model:** Rego, loaded from the steward's public PDS records
  (`town.muni.arbiter.policy.root/self`, `.policy.sub/<name>`), hot-reloaded via
  Jetstream (monotonic rev gating, fail-closed onboarding). Policy input:
  `{method, nsid, parameters, body, arbiterDid, pdsEndpoint, callerDid,
  xrpcEndpoint}`. Result envelope `{ok, output}` / `{ok:false, error}`. Two
  host functions:
  - `xrpc({did, method, nsid, parameters, body})` — issue an authenticated
    remote XRPC to an **arbitrary** `did#service` (policy-supplied target). The
    proxy executes it via the steward's session with an atproto-proxy header.
    **This is how the policy can call an appserver admin-check endpoint.**
  - `policy({name, ...})` — invoke a named sub-policy.
- **DID import/migration exists** via `createAppPasswordArbiter`.

## Target architecture

```
Browser (SvelteKit)
  TanStack Query
    ↓ XRPC (via PDS proxy) + WebSocket
Appserver (Bun/TS)  ───  Arbiter (Rust)  ───  Roomy PDS
   │                        │                     │
   │  calls createArbiter / │  evaluates Rego     │  hosts per-space
   │  resetPolicy / proxy   │  policy, proxies    │  accounts/repos
   │  (serviceAuth)         │  as the space DID   │
   │                        │  xrpc() → appserver │
   │  <─ admin-check XRPC ──┘   isAdmin endpoint  │
```

- **Space = stewarded account.** For each Roomy space, the appserver asks the
  arbiter to provision (or import) a stewarded account on the Roomy PDS. The
  appserver registers **itself** as the recovery admin of that DID.
- **The appserver remains the source of truth for space admin membership**
  (edges in its DB). It exposes an XRPC "is user admin of space" endpoint that
  the arbiter policy calls via the `xrpc` host function to authorize Roomy
  admins.
- **The appserver's own DID** (`did:web:api.roomy.space`) is the recovery admin
  identity; it gains a signing key so it can mint serviceAuth tokens to the
  arbiter.

## Phase 0 — Appserver needs an identity it can sign with

**Status: implemented.** The appserver now has a signing key and a
`verificationMethod` in its DID doc, and can self-mint serviceAuth JWTs
(`src/auth/serviceAuth.ts`). The rationale and verification below are recorded
for reference.

**Decision:** give the appserver DID a signing key so it can self-mint
serviceAuth JWTs (`aud` = arbiter-server DID, `lxm` = NSID, `iss` = appserver
DID). The arbiter reads the caller from the `iss` claim, not `sub` (see
`crates/arbiter-server/src/auth.rs`).

- Add a `verificationMethod` to the DID doc served at
  `/.well-known/did.json` (`src/appserver.ts`). **No `assertionMethod` is
  needed**: the arbiter's `atproto-identity` `Document` model only parses
  `verificationMethod` (an `assertionMethod` would be ignored), and
  `resolve_pds_signing_key` reads keys from `verification_method` only.
- Hold the private key (env `APPSERVER_SIGNING_KEY`, or a generated
  keypair persisted like space keys).
- Add a small `mintServiceAuth(arbiterDid, lxm)` helper producing a signed JWT
  (ES256K/secp256k1) with the right `aud`/`lxm`/`iss`/`exp` (60s default),
  mirroring `packages/sdk/src/transport/service-auth.ts`.
- **Verified:** the arbiter accepts `did:web` issuers. Its auth path
  (`resolve_pds_signing_key`) resolves the caller DID doc and reads only
  `verification_method` — it does **not** require `#atproto_pds` on the
  caller. (`#atproto_pds` is only required by `resolve_pds_endpoint`, used for
  proxying/policy loading, not caller authentication.)

This is a prerequisite for every phase below.

## Phase 1 — New spaces: provision through the arbiter

**Status: implemented.** New spaces are provisioned as real ATProto accounts
via the arbiter when `ARBITER_URL` + `ARBITER_DID` are configured. The legacy
self-provisioned did:plc path is retained as a fallback (and as a migration
shim until Phase 4).

- **Current:** `StreamManager.createStream` → `createStreamDid` (PLC POST +
  key storage in appserver DB).
- **Implemented:** the appserver calls the arbiter to provision a stewarded
  account for the new space (`src/arbiter/`):
  1. `town.muni.arbiter.createArbiter` (authenticated as the appserver DID via
     the Phase 0 token). The arbiter creates a real account on the Roomy PDS,
     records the appserver DID as recovery admin, and writes the
     `town.muni.arbiter.service/self` + `recovery/self` records.
  2. The arbiter returns the new DID. The appserver stores the mapping
     `spaceId ↔ space DID` (still the entity id) and proceeds with the
     `addAdmin` seed event as today.
  3. The appserver installs the default policy via `resetPolicy` (it is the
     recovery admin). The default policy (`src/arbiter/policy.ts`) allows only
     the space itself and the appserver (the owner) to act on the space DID.
  4. The appserver proxies a `com.atproto.repo.putRecord` of
     `space.roomy.service/self` (did = appserver) under the new account via the
     arbiter's **built-in** `town.muni.arbiter.proxy` route, marking it as a
     Roomy space hosted by the appserver. It must NOT use a scoped
     `<scope>.arbiter.proxy` route: those apply the permission-set lexicon's
     scope policy over the inner request alone (no caller DID), and the
     published `space.roomy.authComplete` policy admits only `space.roomy*` /
     `network.cosmic*` NSIDs plus `uploadBlob`, `updateHandle`, and a
     `putRecord` of `app.bsky.actor.profile` — so a `space.roomy.service`
     `putRecord` is denied outright, before any policy layer sees the caller.
- **Retain** `createStreamDid` and the `did_keys` storage only as a migration
  shim until Phase 4 completes, then remove.
- The Roomy PDS is a new deployment requirement (the arbiter's "default PDS"
  or a dedicated Roomy PDS). The space account's repo lives there.

**Open question (resolved):** whether a space needs a *real* PDS repo with the
full ATProto event log, or whether the arbiter can proxy to the
appserver-as-PDS. The arbiter's `execute_remote` logs into the steward's
`#atproto_pds` with a password and proxies. If the appserver remains the
space's PDS, it must implement `createSession` + repo serving for space DIDs
(significant). The simpler and more standard path is a real Roomy PDS hosting
space repos — **chosen** for Phase 1.

## Phase 2 — Policy: Roomy admins may act on the space DID

Install, via `resetPolicy` (as recovery admin), a root Rego policy that:

- Always allows `input.callerDid == input.arbiterDid` (the space itself).
- Allows any Roomy space admin, determined by an appserver XRPC call through
  the `xrpc` host function.

**Shipped, with one deviation from the sketch below.** The policy lives in
`policy/default.rego` and asks `space.roomy.space.getUserAccess` (already
published, and the AppView is authoritative for adminship), not the
`space.roomy.space.isAdmin` endpoint this section proposed — that endpoint was
never built. The policy also reads the space's `space.roomy.service/self`
record to find the hosting appserver, and treats the `recovery/self` DID as an
admin, neither of which the sketch below has. The Rego that shipped is the
authority; the sketch is kept only as the decision record.

Because `spaceId == space DID`, the policy can query the appserver with
`spaceId = input.arbiterDid` and the caller DID:

```rego
package arbiter

import rego.v1

default result := {"ok": false, "error": {"status": 403, "error": "ErrPermissionDenied"}}

result := xrpc({
    "did": concat("#", [input.arbiterDid, "atproto_pds"]),
    "method": input.method, "nsid": input.nsid,
    "parameters": input.parameters, "body": input.body,
}) if allow

allow if input.callerDid == input.arbiterDid
allow if is_admin(input.callerDid)

is_admin(caller) := resp if {
    resp := xrpc({
        "did": concat("#", ["<APPSERVER_DID>", "space_roomy_appserver"]),
        "method": "GET",
        "nsid": "space.roomy.space.isAdmin",
        "parameters": {"spaceId": input.arbiterDid, "did": caller},
    }).output
}
default is_admin(_) := {"isAdmin": false}
```

### Not built: `space.roomy.space.isAdmin`

This endpoint was never needed: the shipped policy reuses the published
`space.roomy.space.getUserAccess`. The design below is kept only so a future
reader does not re-propose it — `getUserAccess` already answers the same
question for the same caller identity.

The original sketch:

There is no dedicated endpoint today. Add one so the policy can make a single
cheap check (it is not secret — `getMetadata` already exposes `isAdmin`):

- **Query:** `space.roomy.space.isAdmin`
- **Params:** `{ spaceId: string, did: string }`
- **Output:** `{ isAdmin: boolean }`
- **Impl:** `isAdmin(openSpaceDb(spaceId), spaceId, did)` from
  `src/auth/access.ts`. Add a handler file
  `src/handlers/space.roomy.space.isAdmin.ts` and register it in
  `buildRouter` (`src/appserver.ts`), plus the lexicon + SDK schema.
- **Access:** readable by the arbiter's proxied call (authenticated as the
  space DID). Since it's a public-ish boolean, it may be a public read (like
  `getMetadata`'s admin exposure). Confirm it cannot be abused to leak
  membership beyond what `getMetadata` already reveals.

> **Trust note:** the `xrpc` host function proxies the admin-check call
> authenticated **as the steward** (space DID), so the appserver sees
> `did = space DID`, not the human caller. The caller's DID must therefore be
> passed **in the params**, and the policy is what binds `input.callerDid` to
> the `did` param. The appserver endpoint must not rely on the auth subject
> for this check.

## Phase 3 — Proxying appserver actions under a space account

Per the user's note, the appserver doesn't act *under* its ATProto accounts
today, so proxying is not yet needed. When it is, the appserver calls
`town.muni.arbiter.proxy{arbiterDid: <space DID>, target: "<spaceDID>#atproto_pds", ...}`
with a Phase 0 serviceAuth token, and the arbiter's policy gates it. No new
appserver work beyond a `proxy` helper + Phase 0 auth.

## Phase 4 — Migrating existing DIDs

The hard problem. Existing space DIDs are did:plc DIDs whose `#atproto_pds`
points at the appserver, with their secp256k1 private keys held in the
appserver's `did_keys` table. They are **not** PDS accounts with a password, so
`createAppPasswordArbiter` cannot import them directly.

Two viable strategies (need a Roomy PDS either way):

### 4a. Repoint PDS then import (preferred)

1. The appserver, holding each space DID's rotation key, issues a PLC **update**
   operation changing `#atproto_pds` from the appserver to the Roomy PDS
   (reuse the key from `did_keys` via `getStreamSigningKey`).
2. Create a repo + app password for the space DID on the Roomy PDS.
3. Call `town.muni.arbiter.createAppPasswordArbiter{arbiterDid, appPassword}`
   to import it. The appserver DID is set as recovery admin (verify the import
   path sets recovery_admin to the caller).
4. Install the Phase 2 policy via `resetPolicy`.
5. Stop materializing the space in the appserver (or keep it as the appview
   reading from the space repo / its own events DB — see open question below).

### 4b. Appserver implements PDS session/repo serving for space DIDs

Keep `#atproto_pds` pointing at the appserver; implement `createSession` +
repo read/write for space DIDs so the arbiter can `createAppPasswordArbiter`
and proxy to the appserver. This avoids a Roomy PDS deployment but is
substantial appserver work and deviates from the standard ATProto layout.
**Not recommended** unless a Roomy PDS is unacceptable.

### Migration runbook requirements

- Backfill the `spaceId ↔ DID` mapping (entity id == DID already).
- Idempotency / resumability: track per-DID migration state (pending / PLC
  updated / imported / policy set / done) in a table.
- Rollback: PLC registration is irreversible; the old key remains valid, so an
  aborted migration can be resumed, not undone.
- Test-mode (`APPSERVER_TEST_MODE=true`) currently skips PLC (`createStreamDid`
  is not exercised in E2E); decide whether test mode routes through a mock
  arbiter.

## Prerequisites / external dependencies

1. **A Roomy PDS** hosting space accounts/repos (arbiter "default PDS").
2. **Appserver signing key + verificationMethod** in its DID doc (Phase 0) —
   **done** (`src/auth/serviceAuth.ts` + `src/appserver.ts`).
3. **Arbiter `did:web` caller support** — **confirmed** (Phase 0 verification):
   the arbiter's auth resolves the caller DID doc and reads only
   `verification_method`; no `#atproto_pds` required on the caller.
4. New XRPC **`space.roomy.space.isAdmin`** endpoint + lexicon + SDK schema
   (Phase 2 — not yet implemented).
5. **Arbiter deployment** (URL + DID) with `createArbiter`/`resetPolicy`/`proxy`
   enabled for the appserver — **required for Phase 1** (`ARBITER_URL` +
   `ARBITER_DID`).

## Open questions

- ~~Does a space need a full PDS repo, or can the arbiter proxy to the
  appserver as the space's PDS?~~ **Resolved (Phase 1):** a real Roomy PDS
  hosting space repos.
- Should Roomy admins be enumerated in the Rego policy (policy data) or via the
  live appserver `isAdmin` call? The latter keeps the appserver authoritative
  but couples the arbiter's authorization to appserver availability.
- Who is the arbiter's recovery admin for a space — the appserver DID, or the
  human space owner? User's intent: the appserver registers itself as
  owner/recovery admin, so the appserver DID.
- Whether `space.roomy.space.isAdmin` should be a public read or restricted to
  the space DID / authenticated callers.

## Not in scope (this plan)

- Proxying appserver actions under space accounts (Phase 3 deferred until an
  action under an ATProto account exists).
- Arbiter multi-instance, encryption-at-rest, recovery escape hatch — all
  deferred by `leaf-0.4` SERVER_PLAN.md and out of scope here.

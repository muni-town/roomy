# Appserver formal specs (Quint)

Initial-scope authorisation model for the appserver. Mirrors the rules in
`docs/plans/xrpc-interface-spec.md` § Authorization Model.

## Files

- `auth.qnt` — single-space authorisation model: members, admins (orthogonal),
  roles (with soft-delete), member-role assignments, role-room grants,
  channel `default_access`, thread inheritance via `parentOf`, and invites.

## Invariants

These are the invariants actually defined in `auth.qnt`. `quint run
--invariant=<name>` reports a violation trace; run all four with `--invariants`
(space-separated).

| Name | Property | Status |
|---|---|---|
| `bannedNotMembers` | A banned user is never a member of the space. | holds |
| `threadParentIsChannel` | A thread's parent, when it has one, is a channel — no thread-of-thread. | holds |
| `adminsNotBanned` | No admin is ever in the bans set. | **violated** — reachable: `addAdmin` does not check the bans set, so an admin (or any user) can be banned and then re-added as admin. |
| `roleMembersAreMembers` | Every role member is a member of the space. | **violated** — reachable: `leaveSpace` removes membership but not the user's role assignments. See "Dangling role grants" below. |

There are currently **no witness properties** in the spec.

## Running

```bash
# Type-check
quint typecheck specs/auth.qnt

# Replay the invariant checks (one name, or several with --invariants)
quint run specs/auth.qnt --invariant=bannedNotMembers --max-steps=30 --max-samples=200
quint run specs/auth.qnt --invariants=bannedNotMembers threadParentIsChannel --max-steps=30 --max-samples=200

# Show the violating execution for an invariant that fails
quint run specs/auth.qnt --invariant=roleMembersAreMembers --max-steps=30 --max-samples=200 --verbosity=3

# Exhaustive verify (requires a Java runtime for Apalache; the simulator above
# is enough to produce MBT traces, so this is optional)
quint verify specs/auth.qnt --invariant=bannedNotMembers --max-steps=5
```

## Traces and the MBT parity check

`src/auth/mbt/mbt.test.ts` is a model-based test: for every state of every ITF
trace in `specs/traces/`, it projects the spec state into a fresh in-memory
SQLite DB, calls `spaceAccess()` / `roomAccess()`, and compares every field
against the trace's `oracleSnapshot`. Any disagreement fails the suite with the
trace file, state index, and the (user, room) pair.

**Traces are generated, not committed** (`specs/traces` is in
`packages/appserver/.gitignore`). Generate them with:

```bash
pnpm --filter @roomy/appserver mbt:traces
```

That script pins Quint (`@informalsystems/quint@0.32.0`), the seed
(`0x195`), and the trace shape (48 traces × 80 steps), so a regeneration
reproduces the same traces byte-for-byte. Quint is fetched via `npx` rather
than added to the lockfile — a model checker is not a runtime dependency of the
appserver. CI runs this step before `bun test`, so the parity check runs there
instead of skipping.

The test skips (with a pointer to the generator) when `specs/traces/` is empty,
so a contributor without Quint still gets a green suite.

### Current parity result

Clean pass: 48 traces, 3888 states, 124416 comparisons — no divergence between
the spec oracle and `access.ts`. That covers:

- both read paths: single-room `roomAccess()` and the batched
  `roomAccessMany()` the sidebar / getThreads handlers use;
- all 21 spec actions (`--n-traces=48` with `--max-steps=80` reaches every one);
- 46656 (user, room) cells, of which 6584 are thread-with-parent cells and 215
  are cells where a role grant is the *only* reason for a read/write decision.

The `room_access` projection is on the read path for both:
the first touch of a room in a fresh DB is a cold miss (live compute, then the
projection is warmed), and later touches hit the projection. Cold and warm
reads were compared directly over 5832 pairs — identical.

Worth stating plainly: the parity check is a pass, but it is a *sampled* pass.
`quint run` explores random traces from one seed, not the reachable state
space; `quint verify` (Apalache) would be the exhaustive check and needs a Java
runtime. Treat a pass as evidence, not proof.

### Dangling role grants (known gap)

`roleMembersAreMembers` is violated by the model, and the same hole exists in
the implementation: nothing deletes `member_roles` rows when a user leaves a
space or is banned, so a user who left can still read any room their old role
granted (including in a public space, where the space gate passes for
non-members). Bans still deny, because `computeRoomAccess` short-circuits on
`space.isBanned`.

This is a policy question rather than a clear bug — hence the model keeps the
permissive behaviour and the invariant is documented as violated instead of the
spec being quietly changed to match. If the intended contract is "leaving or
being banned revokes role grants", the fix belongs in `leaveSpace` /
`banAccount` plus this invariant.

## Scope and known gaps

Modelled:
- Single space, bounded universes (4 users, 2 role ids, 3 room ids; how many
  of those rooms are channels vs threads is chosen nondeterministically).
- Member edge, admin edge, role lifecycle, role assignments, role-room
  permissions (incl. clear), channel `default_access` updates, invite
  create/revoke with creator-or-admin authority.
- The `allow_public_join` gate on reads (`specPassesSpaceGate`) and the
  `allow_member_invites` gate on invite creation (`canCreateInvite`).

Not yet modelled (candidates for next iteration):
- Multiple spaces (most authz logic is space-scoped, so the single-space
  model captures the interesting properties; multi-space is mostly clerical).
- Sidebar visibility predicate (the model defines `canRead` per room; the
  sidebar invariant — "exactly the rooms with `canRead = true` are
  returned" — is not asserted here, and the `getMetadata` / `getThreads`
  handlers that would be the implementation side now exist).
- Token-based join: validating an invite token at join time and consuming /
  not-consuming it. The model tracks the invite *set* and checks membership
  of the token, but does not model single-use consumption.
- `roomAccessMany`'s *batched* SQL is not the same code as `computeRoomAccess`'s
  per-room path, but both are now driven against the same oracle by
  `mbt.test.ts`, so a decision-logic drift in either fails CI. What the harness
  cannot see is a drift in the *projection maintenance* (upsert vs invalidate)
  — traces are projected fresh into an empty DB, so `room_access` is always
  warmed from live data and never exercised as a stale cache.

Exploration gap (model supports it, the generator never picks it):
- `createInviteAny` draws its sender from `state.admins` only, so the
  `allowMemberInvites` member path is never exercised by generated traces even
  though `canCreateInvite` models it.
- `setRoleRoomPermissionAny` draws its room from `currentChannels`, and
  `setRoleRoomPermission` throws on a thread — so role grants on threads are
  never explored. (Contrary to an earlier note here, the model does *not*
  permit them.)

## Why this exists

Treat the model as the source of truth for the authorisation contract. The
replayer now exists: `quint run --mbt` emits ITF traces, `src/auth/mbt/`
projects each spec state into an in-memory SQLite DB, and drives the
appserver's `auth/access.ts` predicates against the trace's oracle snapshot.
Any divergence between the spec and the implementation fails
`src/auth/mbt/mbt.test.ts` in CI.

Regenerate traces with `pnpm --filter @roomy/appserver mbt:traces`; see
"Traces and the MBT parity check" above for the pinned versions and the
current parity result.

# Appserver formal specs (Quint)

Initial-scope authorisation model for the appserver. Mirrors the rules in
`docs/plans/xrpc-interface-spec.md` § Authorization Model.

## Files

- `auth.qnt` — single-space authorisation model: members, admins (orthogonal),
  roles (with soft-delete), member-role assignments, role-room grants,
  channel `default_access`, thread inheritance via `parentOf`, and invites.

## Invariants

| Name | Property |
|---|---|
| `AdminAlwaysCanReadAndWrite` | An admin always has read+write on every room, regardless of any other state. |
| `AccessIsUnion` | `canRead` equals the spec's three-way union (admin ∨ default_access ∨ role grant). Locks the definition against drift. |
| `ThreadInheritsParentWhenNoRoleGrants` | A non-admin user with no role grants has identical access to a thread and its parent channel. |
| `SoftDeletedRolesConferNothing` | Deleted roles never grant access; only admin or `default_access` paths remain. |
| `WriteImpliesRead` | `canWrite` is strictly stronger than `canRead`. |
| `AtMostOneGrantPerRoleRoom` | The SDK delete-then-insert pattern never leaves both `Read` and `ReadWrite` tuples for the same `(role, room)`. |

## Witness properties (reachability)

| Name | Property |
|---|---|
| `AdminWithoutMembership` | Some reachable state has an admin who is not a member. |
| `MemberWithoutAdmin` | Some reachable state has a member who is not an admin. |

Witnesses confirm the orthogonality is a *reachable* design choice, not an
accident of the initial state.

## Running

```bash
# Type-check
quint typecheck auth.qnt

# Simulate (random execution traces)
quint run auth.qnt --invariant=AccessIsUnion --max-steps=10 --max-samples=200

# Find a witness (negate the property — simulator reports the violating trace)
quint run auth.qnt --invariant='not(AdminWithoutMembership)' --max-steps=10 --max-samples=500 --verbosity=3

# Exhaustive verify (requires Java runtime for Apalache)
quint verify auth.qnt --invariant=AccessIsUnion --max-steps=5
```

## Scope and known gaps

Modelled:
- Single space, bounded universes (3 users, 2 roles, 2 channels, 1 thread).
- Member edge, admin edge, role lifecycle, role assignments, role-room
  permissions (incl. clear), channel `default_access` updates, invite
  create/revoke with creator-or-admin authority.

Not yet modelled (candidates for next iteration):
- Multiple spaces (most authz logic is space-scoped, so the single-space
  model captures the interesting properties; multi-space is mostly clerical).
- `allow_public_join` / `allow_member_invites` join-policy gating on
  `joinSpace` and `createInvite`. The current model permits any
  member-or-admin to create an invite.
- Sidebar visibility predicate (the model defines `canRead` per room; the
  sidebar invariant — "exactly the rooms with `canRead = true` are
  returned" — should be added once the appserver handler exists).
- Token-based join: validating an invite token at join time and consuming /
  not-consuming it.
- Roles targeting threads directly: the model permits this (grants on any
  room) but the spec doc doesn't yet say whether the UI exposes it.

## Why this exists

Treat the model as the source of truth for the authorisation contract. As
the implementation lands, we wire it back via ITF-trace replay: the
simulator emits JSON traces, a thin TS replayer drives the appserver's
`auth/authorize.ts` predicates, and any divergence between the spec and
the implementation is a CI failure. Until the replayer exists, the spec
serves as a paste-into-context artefact for LLM agents and a checked
companion to the prose docs.

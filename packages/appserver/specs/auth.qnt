// ─────────────────────────────────────────────────────────────────────────────
// auth.qnt — Roomy appserver authorisation model (initial scope)
//
// Models the per-room read/write authorisation logic specified in
// docs/plans/xrpc-interface-spec.md § Authorization Model.
//
// Key facts being captured:
//   1. Admin and membership are orthogonal: admin is a separate edge that
//      survives leave/rejoin. A user may be admin without being a member.
//   2. Per-room access = union of: admin edge ∨ default_access ∨ role grant.
//   3. Threads inherit default_access from their parent channel via the
//      `link` edge (we model the link statically with `parentOf`).
//   4. Soft-deleted roles confer no permissions.
//
// Scope: a single space, bounded universes for users / roles / rooms.
// ─────────────────────────────────────────────────────────────────────────────

module auth {

  // ─── Domain types ─────────────────────────────────────────────────────────
  type Permission = Read | ReadWrite
  type DefaultAccess = AccessNone | AccessRead | AccessReadWrite

  // ─── Bounded universes (kept small for model checking) ───────────────────
  pure val USERS: Set[str] = Set("alice", "bob", "carol")
  pure val ROLE_IDS: Set[str] = Set("r1", "r2")
  pure val CHANNELS: Set[str] = Set("c1", "c2")
  pure val THREADS: Set[str] = Set("t1")
  pure val ROOMS: Set[str] = CHANNELS.union(THREADS)

  // Static room topology: which channel each thread links to.
  pure val parentOf: str -> str = Map("t1" -> "c1")

  // ─── State ────────────────────────────────────────────────────────────────
  // Membership and admin are orthogonal sets — a user may be in either,
  // both, or neither.
  var members: Set[str]
  var admins: Set[str]

  // Roles that have been created and not soft-deleted.
  var rolesAlive: Set[str]

  // (userDid, roleId) — only meaningful if the role is alive.
  var memberRoles: Set[(str, str)]

  // (roleId, roomId, permission) — explicit grants. Absence = no grant.
  var roleGrants: Set[(str, str, Permission)]

  // Total map: every channel has a default_access. Threads inherit.
  var channelDefault: str -> DefaultAccess

  // (token, creatorDid) — currently-active invite tokens (revoked tokens
  // are removed from the set). We do not model token uniqueness; tokens
  // are opaque strings drawn from a small set.
  var invites: Set[(str, str)]

  // ─── Pure derivations ─────────────────────────────────────────────────────

  pure def effectiveDefault(chanDef: str -> DefaultAccess, room: str): DefaultAccess =
    if (CHANNELS.contains(room)) chanDef.get(room)
    else chanDef.get(parentOf.get(room))

  pure def defaultAllowsRead(d: DefaultAccess): bool =
    d == AccessRead or d == AccessReadWrite

  pure def defaultAllowsWrite(d: DefaultAccess): bool =
    d == AccessReadWrite

  pure def hasReadGrant(
      mr: Set[(str, str)],
      rg: Set[(str, str, Permission)],
      alive: Set[str],
      u: str,
      room: str): bool =
    ROLE_IDS.exists(r =>
      mr.contains((u, r))
        and alive.contains(r)
        and (rg.contains((r, room, Read)) or rg.contains((r, room, ReadWrite))))

  pure def hasWriteGrant(
      mr: Set[(str, str)],
      rg: Set[(str, str, Permission)],
      alive: Set[str],
      u: str,
      room: str): bool =
    ROLE_IDS.exists(r =>
      mr.contains((u, r))
        and alive.contains(r)
        and rg.contains((r, room, ReadWrite)))

  // canRead = admin ∨ default_access ≥ Read ∨ matching role grant.
  // For threads, default_access is inherited from parent channel.
  // Role grants can target either the channel directly or the thread itself
  // (the SDK currently stores grants per-room; threads can have their own
  // grants in addition to inheriting parent default_access).
  pure def canRead(
      adm: Set[str], mr: Set[(str, str)], rg: Set[(str, str, Permission)],
      alive: Set[str], chanDef: str -> DefaultAccess,
      u: str, room: str): bool =
    adm.contains(u)
      or defaultAllowsRead(effectiveDefault(chanDef, room))
      or hasReadGrant(mr, rg, alive, u, room)
      or (THREADS.contains(room)
            and hasReadGrant(mr, rg, alive, u, parentOf.get(room)))

  pure def canWrite(
      adm: Set[str], mr: Set[(str, str)], rg: Set[(str, str, Permission)],
      alive: Set[str], chanDef: str -> DefaultAccess,
      u: str, room: str): bool =
    adm.contains(u)
      or defaultAllowsWrite(effectiveDefault(chanDef, room))
      or hasWriteGrant(mr, rg, alive, u, room)
      or (THREADS.contains(room)
            and hasWriteGrant(mr, rg, alive, u, parentOf.get(room)))

  // ─── Init ─────────────────────────────────────────────────────────────────
  action init = all {
    members' = Set(),
    admins' = Set(),
    rolesAlive' = Set(),
    memberRoles' = Set(),
    roleGrants' = Set(),
    // Every channel starts at the SDK default: readwrite.
    channelDefault' = CHANNELS.mapBy(_ => AccessReadWrite),
    invites' = Set(),
  }

  // ─── Actions (events) ─────────────────────────────────────────────────────

  action addMember(u: str): bool = all {
    USERS.contains(u),
    not(members.contains(u)),
    members' = members.union(Set(u)),
    admins' = admins,
    rolesAlive' = rolesAlive,
    memberRoles' = memberRoles,
    roleGrants' = roleGrants,
    channelDefault' = channelDefault,
    invites' = invites,
  }

  action removeMember(u: str): bool = all {
    members.contains(u),
    members' = members.exclude(Set(u)),
    // Dropping membership does NOT drop role assignments — the appserver
    // treats role grants as effective only when joined+role+grant align,
    // but the underlying member_roles table is independent. We keep the
    // tuples around so we can verify the union semantics are correct
    // even when the user is not a member (admins-without-membership case).
    admins' = admins,
    rolesAlive' = rolesAlive,
    memberRoles' = memberRoles,
    roleGrants' = roleGrants,
    channelDefault' = channelDefault,
    invites' = invites,
  }

  action addAdmin(u: str): bool = all {
    USERS.contains(u),
    not(admins.contains(u)),
    admins' = admins.union(Set(u)),
    members' = members,
    rolesAlive' = rolesAlive,
    memberRoles' = memberRoles,
    roleGrants' = roleGrants,
    channelDefault' = channelDefault,
    invites' = invites,
  }

  action removeAdmin(u: str): bool = all {
    admins.contains(u),
    admins' = admins.exclude(Set(u)),
    members' = members,
    rolesAlive' = rolesAlive,
    memberRoles' = memberRoles,
    roleGrants' = roleGrants,
    channelDefault' = channelDefault,
    invites' = invites,
  }

  action createRole(r: str): bool = all {
    ROLE_IDS.contains(r),
    not(rolesAlive.contains(r)),
    rolesAlive' = rolesAlive.union(Set(r)),
    members' = members,
    admins' = admins,
    memberRoles' = memberRoles,
    roleGrants' = roleGrants,
    channelDefault' = channelDefault,
    invites' = invites,
  }

  action deleteRole(r: str): bool = all {
    rolesAlive.contains(r),
    rolesAlive' = rolesAlive.exclude(Set(r)),
    // Note: we do NOT clean up memberRoles or roleGrants. The SDK soft-deletes
    // the role row and authz queries filter on `roles.deleted = 0`. The model
    // mirrors this so we can verify "soft-deleted roles confer no access".
    members' = members,
    admins' = admins,
    memberRoles' = memberRoles,
    roleGrants' = roleGrants,
    channelDefault' = channelDefault,
    invites' = invites,
  }

  action addMemberRole(u: str, r: str): bool = all {
    USERS.contains(u),
    ROLE_IDS.contains(r),
    not(memberRoles.contains((u, r))),
    memberRoles' = memberRoles.union(Set((u, r))),
    members' = members,
    admins' = admins,
    rolesAlive' = rolesAlive,
    roleGrants' = roleGrants,
    channelDefault' = channelDefault,
    invites' = invites,
  }

  action removeMemberRole(u: str, r: str): bool = all {
    memberRoles.contains((u, r)),
    memberRoles' = memberRoles.exclude(Set((u, r))),
    members' = members,
    admins' = admins,
    rolesAlive' = rolesAlive,
    roleGrants' = roleGrants,
    channelDefault' = channelDefault,
    invites' = invites,
  }

  action setRoleRoomPermission(r: str, room: str, p: Permission): bool = all {
    ROLE_IDS.contains(r),
    ROOMS.contains(room),
    // The SDK first deletes any existing grant for (role, room) then inserts
    // the new one. We mirror that: drop both existing tuples for this pair.
    roleGrants' =
      roleGrants
        .exclude(Set((r, room, Read), (r, room, ReadWrite)))
        .union(Set((r, room, p))),
    members' = members,
    admins' = admins,
    rolesAlive' = rolesAlive,
    memberRoles' = memberRoles,
    channelDefault' = channelDefault,
    invites' = invites,
  }

  action clearRoleRoomPermission(r: str, room: str): bool = all {
    ROLE_IDS.contains(r),
    ROOMS.contains(room),
    roleGrants' =
      roleGrants.exclude(Set((r, room, Read), (r, room, ReadWrite))),
    members' = members,
    admins' = admins,
    rolesAlive' = rolesAlive,
    memberRoles' = memberRoles,
    channelDefault' = channelDefault,
    invites' = invites,
  }

  action updateChannelDefault(c: str, d: DefaultAccess): bool = all {
    CHANNELS.contains(c),
    channelDefault' = channelDefault.set(c, d),
    members' = members,
    admins' = admins,
    rolesAlive' = rolesAlive,
    memberRoles' = memberRoles,
    roleGrants' = roleGrants,
    invites' = invites,
  }

  action createInvite(token: str, creator: str): bool = all {
    USERS.contains(creator),
    // The SDK requires admin OR (member AND allowMemberInvites). We don't
    // model allowMemberInvites in this scope; we assert admin-or-member.
    admins.contains(creator) or members.contains(creator),
    not(invites.exists(((t, c)) => t == token)),
    invites' = invites.union(Set((token, creator))),
    members' = members,
    admins' = admins,
    rolesAlive' = rolesAlive,
    memberRoles' = memberRoles,
    roleGrants' = roleGrants,
    channelDefault' = channelDefault,
  }

  action revokeInvite(token: str, by: str): bool = all {
    invites.exists(((t, c)) => t == token),
    // SDK rule: admins or invite creator may revoke.
    invites.exists(((t, c)) => t == token and (admins.contains(by) or c == by)),
    invites' = invites.filter(((t, c)) => t != token),
    members' = members,
    admins' = admins,
    rolesAlive' = rolesAlive,
    memberRoles' = memberRoles,
    roleGrants' = roleGrants,
    channelDefault' = channelDefault,
  }

  // ─── Step ─────────────────────────────────────────────────────────────────
  // Pick any action with any well-typed argument.
  action step = any {
    nondet u = oneOf(USERS); addMember(u),
    nondet u = oneOf(USERS); removeMember(u),
    nondet u = oneOf(USERS); addAdmin(u),
    nondet u = oneOf(USERS); removeAdmin(u),
    nondet r = oneOf(ROLE_IDS); createRole(r),
    nondet r = oneOf(ROLE_IDS); deleteRole(r),
    nondet u = oneOf(USERS);
      nondet r = oneOf(ROLE_IDS); addMemberRole(u, r),
    nondet u = oneOf(USERS);
      nondet r = oneOf(ROLE_IDS); removeMemberRole(u, r),
    nondet r = oneOf(ROLE_IDS);
      nondet room = oneOf(ROOMS);
      nondet p = oneOf(Set(Read, ReadWrite));
      setRoleRoomPermission(r, room, p),
    nondet r = oneOf(ROLE_IDS);
      nondet room = oneOf(ROOMS); clearRoleRoomPermission(r, room),
    nondet c = oneOf(CHANNELS);
      nondet d = oneOf(Set(AccessNone, AccessRead, AccessReadWrite));
      updateChannelDefault(c, d),
    nondet u = oneOf(USERS);
      nondet t = oneOf(Set("tok1", "tok2")); createInvite(t, u),
    nondet u = oneOf(USERS);
      nondet t = oneOf(Set("tok1", "tok2")); revokeInvite(t, u),
  }

  // ─── Invariants ───────────────────────────────────────────────────────────

  // I1: Adminship and membership are independent. We assert that no action
  //     introduces an implication between them. The invariant is structural:
  //     it must be possible to reach states violating each direction.
  //     (We assert non-implication via two existence witnesses below as
  //     temporal/ liveness checks; for invariant-mode we simply assert that
  //     admins and members are disjoint sets in some reachable states by
  //     not coupling them in any action — verified indirectly by I2/I3
  //     producing the right answers when only one holds.)

  // I2: Admins always have read+write on every room, regardless of any other
  //     state (default_access, role grants, soft-deleted roles, etc.).
  val AdminAlwaysCanReadAndWrite: bool =
    USERS.forall(u =>
      ROOMS.forall(room =>
        admins.contains(u) implies (
          canRead(admins, memberRoles, roleGrants, rolesAlive, channelDefault, u, room)
            and
          canWrite(admins, memberRoles, roleGrants, rolesAlive, channelDefault, u, room))))

  // I3: AccessIsUnion — canRead matches the spec's three-way union exactly.
  //     This is more a sanity check on the model than an external property,
  //     but it locks the definition so refactors don't drift.
  val AccessIsUnion: bool =
    USERS.forall(u =>
      ROOMS.forall(room => {
        val canR = canRead(admins, memberRoles, roleGrants, rolesAlive,
                           channelDefault, u, room)
        val unionRhs =
          admins.contains(u)
            or defaultAllowsRead(effectiveDefault(channelDefault, room))
            or hasReadGrant(memberRoles, roleGrants, rolesAlive, u, room)
            or (THREADS.contains(room)
                  and hasReadGrant(memberRoles, roleGrants, rolesAlive,
                                   u, parentOf.get(room)))
        canR == unionRhs
      }))

  // I4: Threads inherit default_access from their parent channel.
  //     If a non-admin user has no role grants at all, their access to a
  //     thread is identical to their access to its parent channel.
  val ThreadInheritsParentWhenNoRoleGrants: bool =
    USERS.forall(u =>
      THREADS.forall(t => {
        val noGrantsForThisUser =
          ROLE_IDS.forall(r =>
            not(memberRoles.contains((u, r)))
              or roleGrants.filter(((rr, room2, p)) => rr == r) == Set())
        (not(admins.contains(u)) and noGrantsForThisUser) implies (
          canRead(admins, memberRoles, roleGrants, rolesAlive, channelDefault, u, t)
            ==
          canRead(admins, memberRoles, roleGrants, rolesAlive, channelDefault,
                  u, parentOf.get(t)))
      }))

  // I5: Soft-deleted roles confer no permissions. If a user's only path to
  //     read access is via a role grant, and that role is not alive, they
  //     must not have read access (admin/default_access paths still apply).
  val SoftDeletedRolesConferNothing: bool =
    USERS.forall(u =>
      ROOMS.forall(room => {
        val onlyPathIsDeadRole =
          not(admins.contains(u))
            and not(defaultAllowsRead(effectiveDefault(channelDefault, room)))
            and not(THREADS.contains(room) and
                    defaultAllowsRead(effectiveDefault(channelDefault,
                                                       parentOf.get(room))))
            and ROLE_IDS.forall(r =>
                  not(memberRoles.contains((u, r)))
                    or not(rolesAlive.contains(r)))
        onlyPathIsDeadRole implies
          not(canRead(admins, memberRoles, roleGrants, rolesAlive,
                      channelDefault, u, room))
      }))

  // I6: Write implies Read. canWrite is strictly stronger than canRead.
  val WriteImpliesRead: bool =
    USERS.forall(u =>
      ROOMS.forall(room =>
        canWrite(admins, memberRoles, roleGrants, rolesAlive,
                 channelDefault, u, room)
          implies
        canRead(admins, memberRoles, roleGrants, rolesAlive,
                channelDefault, u, room)))

  // I7: At most one permission level per (role, room) — the SDK delete-then-insert
  //     pattern must not leave both Read and ReadWrite tuples for the same pair.
  val AtMostOneGrantPerRoleRoom: bool =
    ROLE_IDS.forall(r =>
      ROOMS.forall(room =>
        not(roleGrants.contains((r, room, Read))
              and roleGrants.contains((r, room, ReadWrite)))))

  // ─── Witness traces (for sanity / showing the model permits the design) ──

  // W1: A user can be admin without being a member.
  val AdminWithoutMembership: bool =
    USERS.exists(u => admins.contains(u) and not(members.contains(u)))

  // W2: A user can be a member without being admin.
  val MemberWithoutAdmin: bool =
    USERS.exists(u => members.contains(u) and not(admins.contains(u)))
}

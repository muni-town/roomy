module auth {
  import auth_types.*
  import events.*

  pure val users = Set(
    "did:plc:alice",
    "did:plc:bob",
    "did:plc:caroline",
    "did:plc:danielle"
  )
  pure val roomIds = Set(
    "01ROOMA0000000000000000000",
    "01ROOMB0000000000000000000",
    "01ROOMC0000000000000000000"
  )
  pure val roleIds = Set(
    "01ROLEA0000000000000000000",
    "01ROLEB0000000000000000000"
  )
  pure val inviteTokens = Set("inv1", "inv2")
  pure val permissions = Set(None, Read, ReadWrite)
  pure val roomKinds = Set(ChannelKind, ThreadKind)
  pure val invites = Set(NoInvite, HasInvite("inv1"), HasInvite("inv2"))

  var state: AuthState
  var oracleSnapshot: OracleSnapshot

  pure val initialState: AuthState = {
    allowPublicJoin: AllowPublicJoin,
    roles: Map(),
    admins: Set(),
    rooms: Map(),
    members: Set(),
    invites: Set(),
    bans: Set(),
    result: AuthOk
  }

  // Snapshot oracle decisions over the full (user × room) and (user) pools.
  // Included as a state var so it's emitted in --mbt traces; the harness reads
  // expected decisions directly without re-deriving them in TypeScript.
  pure def makeSnapshot(s: AuthState): OracleSnapshot = {
    rooms: tuples(users, roomIds).mapBy(p => s.specRoomAccess(p._2, p._1)),
    spaces: users.mapBy(u => s.specSpaceAccess(u))
  }

  // Apply an event-produced AuthState and refresh the oracle snapshot together.
  // Every *Any action funnels through this so all state vars advance in lockstep.
  action applyEvent(nextState: AuthState): bool = all {
    state' = nextState,
    oracleSnapshot' = makeSnapshot(nextState)
  }

  action init = all {
    state' = initialState,
    oracleSnapshot' = makeSnapshot(initialState)
  }

  action step = any {
    addAdminAny,
    removeAdminAny,
    joinSpaceAny,
    leaveSpaceAny,
    banAccountAny,
    unbanAccountAny,
    createRoomAny,
    updateRoomAny,
    deleteRoomAny,
    restoreRoomAny,
    createRoleAny,
    updateRoleAny,
    deleteRoleAny,
    addMemberRoleAny,
    removeMemberRoleAny,
    setRoleRoomPermissionAny,
    createInviteAny,
    revokeInviteAny,
    createRoomLinkAny,
  }

  // ── State-derived helper sets ─────────────────────────────────────────
  // Used to bias nondet picks toward feasible events. Actions whose helper
  // pool is empty become infeasible and are skipped by `any { }`.

  val currentChannels: Set[RoomId] =
    state.rooms.keys().filter(rid =>
      match state.rooms.get(rid) {
        | ChannelRoom(_) => true
        | ThreadRoom(_) => false
      })

  val nonDeletedRooms: Set[RoomId] =
    state.rooms.keys().filter(rid =>
      match state.rooms.get(rid) {
        | ChannelRoom(c) => not (c.deleted)
        | ThreadRoom(t) => not (t.deleted)
      })

  val deletedRooms: Set[RoomId] =
    state.rooms.keys().filter(rid =>
      match state.rooms.get(rid) {
        | ChannelRoom(c) => c.deleted
        | ThreadRoom(t) => t.deleted
      })

  val unparentedThreads: Set[RoomId] =
    state.rooms.keys().filter(rid =>
      match state.rooms.get(rid) {
        | ChannelRoom(_) => false
        | ThreadRoom(t) => match t.parent {
            | NoParent => true
            | HasParent(_) => false
          }
      })

  // ── *Any actions ──────────────────────────────────────────────────────
  // Bootstrap: any user can become first admin. Thereafter senders for
  // admin-only events are drawn from state.admins.
  action addAdminAny =
    nondet sender =
      (if (state.admins.size() == 0) users else state.admins).oneOf()
    nondet user = users.oneOf()
    applyEvent(state.addAdmin({ adminId: user }, { userId: sender }))

  action removeAdminAny =
    nondet sender = state.admins.oneOf()
    nondet user = state.admins.oneOf()
    applyEvent(state.removeAdmin({ adminId: user }, { userId: sender }))

  action joinSpaceAny =
    nondet sender =
      users.exclude(state.members).exclude(state.bans).oneOf()
    nondet inv = invites.oneOf()
    applyEvent(state.joinSpace({ invite: inv }, { userId: sender }))

  action leaveSpaceAny =
    nondet sender = state.members.oneOf()
    applyEvent(state.leaveSpace({ userId: sender }))

  action banAccountAny =
    nondet sender = state.admins.oneOf()
    nondet target = users.exclude(state.admins).oneOf()
    applyEvent(state.banAccount({ userId: target }, { userId: sender }))

  action unbanAccountAny =
    nondet sender = state.admins.oneOf()
    nondet target = state.bans.oneOf()
    applyEvent(state.unbanAccount({ userId: target }, { userId: sender }))

  action createRoomAny =
    nondet sender = state.admins.oneOf()
    nondet rid = roomIds.exclude(state.rooms.keys()).oneOf()
    nondet kind = roomKinds.oneOf()
    nondet perm = permissions.oneOf()
    applyEvent(state.createRoom(
      { roomId: rid, kind: kind, defaultAccess: perm },
      { userId: sender }))

  // updateRoom rejects threads — only pick channel ids.
  action updateRoomAny =
    nondet sender = state.admins.oneOf()
    nondet rid = currentChannels.oneOf()
    nondet perm = permissions.oneOf()
    applyEvent(state.updateRoom(
      { roomId: rid, kind: ChannelKind, defaultAccess: perm },
      { userId: sender }))

  action deleteRoomAny =
    nondet sender = state.admins.oneOf()
    nondet rid = nonDeletedRooms.oneOf()
    applyEvent(state.deleteRoom({ roomId: rid }, { userId: sender }))

  action restoreRoomAny =
    nondet sender = state.admins.oneOf()
    nondet rid = deletedRooms.oneOf()
    applyEvent(state.restoreRoom({ roomId: rid }, { userId: sender }))

  action createRoleAny =
    nondet sender = state.admins.oneOf()
    nondet rid = roleIds.exclude(state.roles.keys()).oneOf()
    applyEvent(state.createRole({ roleId: rid }, { userId: sender }))

  action updateRoleAny =
    nondet sender = state.admins.oneOf()
    nondet rid = state.roles.keys().oneOf()
    applyEvent(state.updateRole({ roleId: rid }, { userId: sender }))

  action deleteRoleAny =
    nondet sender = state.admins.oneOf()
    nondet rid = state.roles.keys().oneOf()
    applyEvent(state.deleteRole({ roleId: rid }, { userId: sender }))

  action addMemberRoleAny =
    nondet sender = state.admins.oneOf()
    nondet rid = state.roles.keys().oneOf()
    nondet target = state.members.oneOf()
    applyEvent(state.addMemberRole(
      { roleId: rid, userId: target }, { userId: sender }))

  action removeMemberRoleAny =
    nondet sender = state.admins.oneOf()
    nondet rid = state.roles.keys().oneOf()
    nondet target = state.roles.get(rid).members.oneOf()
    applyEvent(state.removeMemberRole(
      { roleId: rid, userId: target }, { userId: sender }))

  // setRoleRoomPermission rejects threads — only pick channel ids.
  action setRoleRoomPermissionAny =
    nondet sender = state.admins.oneOf()
    nondet rid = state.roles.keys().oneOf()
    nondet room = currentChannels.oneOf()
    nondet perm = permissions.oneOf()
    applyEvent(state.setRoleRoomPermission(
      { roleId: rid, roomId: room, permission: perm },
      { userId: sender }))

  action createInviteAny =
    nondet sender = state.admins.oneOf()
    nondet token = inviteTokens.exclude(state.invites).oneOf()
    applyEvent(state.createInvite({ token: token }, { userId: sender }))

  action revokeInviteAny =
    nondet sender = state.admins.oneOf()
    nondet token = state.invites.oneOf()
    applyEvent(state.revokeInvite({ token: token }, { userId: sender }))

  action createRoomLinkAny =
    nondet sender = state.admins.oneOf()
    nondet fromRoom = currentChannels.oneOf()
    nondet toRoom = unparentedThreads.oneOf()
    applyEvent(state.createRoomLink(
      { fromRoomId: fromRoom, toRoomId: toRoom }, { userId: sender }))

  // --- Invariants ---
  // Check with: quint run auth.qnt --invariant=<name>
  //         or: quint verify auth.qnt --invariant=<name>

  // No admin is ever in the bans set.
  // Note: banAccount refuses to ban an admin, but addAdmin does not check
  //       the bans set — so MBT may find a trace that violates this.
  val adminsNotBanned =
    state.admins.intersect(state.bans).size() == 0

  // A banned user is never a member of the space.
  val bannedNotMembers =
    state.bans.intersect(state.members).size() == 0

  // Every role member is a member of the space.
  val roleMembersAreMembers =
    state.roles.keys().forall(rid =>
      state.roles.get(rid).members.subseteq(state.members))

  // If a thread has a parent, the parent must be a channel — no thread-of-thread.
  val threadParentIsChannel =
    state.rooms.keys().forall(rid =>
      match state.rooms.get(rid) {
        | ChannelRoom(_) => true
        | ThreadRoom(t) => match t.parent {
            | NoParent => true
            | HasParent(p) =>
                state.rooms.keys().contains(p) and
                match state.rooms.get(p) {
                  | ChannelRoom(_) => true
                  | ThreadRoom(_) => false
                }
          }
      })
}

module events {
  import auth_types.*

  type EventContext = {
    userId: UserId
  }

  type AddAdmin = {
    adminId: UserId
  }

  pure def isAdmin(s: AuthState, ctx: EventContext): bool =
    s.admins.contains(ctx.userId)

  pure def addAdmin(s: AuthState, e: AddAdmin, ctx: EventContext): AuthState =
    if (s.admins.size() > 0 and not (s.isAdmin(ctx))) s.throw() 
    else ok(s.with("admins", s.admins.union(Set(e.adminId))))

  type RemoveAdmin = {
    adminId: UserId
  }

  pure def removeAdmin(s: AuthState, e: RemoveAdmin, ctx: EventContext): AuthState = 
    if (not (s.isAdmin(ctx))) s.throw()
    else ok(s.with("admins", s.admins.exclude(Set(e.adminId))))

  type JoinSpace = {
    invite: MaybeInvite
  }

  pure def allowsPublicJoin(c: PublicJoinConfig): bool =
    match (c) {
      | AllowPublicJoin => true
      | InviteOnly => false
    }

  pure def joinSpace(s: AuthState, e: JoinSpace, ctx: EventContext): AuthState =
    if (s.bans.contains(ctx.userId)) s.throw()
    else if (s.members.contains(ctx.userId)) s.throw()
    else match e.invite {
      | HasInvite(token) =>
          if (s.invites.contains(token))
            ok(s.with("members", s.members.union(Set(ctx.userId))))
          else s.throw()
      | NoInvite =>
          if (s.allowPublicJoin.allowsPublicJoin())
            ok(s.with("members", s.members.union(Set(ctx.userId))))
          else s.throw()
    }

  pure def leaveSpace(s: AuthState, ctx: EventContext): AuthState =
    if (not (s.members.contains(ctx.userId))) s.throw()
    else ok(s.with("members", s.members.exclude(Set(ctx.userId))))

  type BanAccount = {
    userId: UserId
  }

  pure def banAccount(s: AuthState, e: BanAccount, ctx: EventContext): AuthState =
    if (not (s.isAdmin(ctx))) s.throw()
    else if (s.admins.contains(e.userId)) s.throw()
    else ok(s.with("bans", s.bans.union(Set(e.userId)))
             .with("members", s.members.exclude(Set(e.userId))))

  type UnbanAccount = {
    userId: UserId
  }

  pure def unbanAccount(s: AuthState, e: UnbanAccount, ctx: EventContext): AuthState =
    if (not (s.isAdmin(ctx))) s.throw()
    else ok(s.with("bans", s.bans.exclude(Set(e.userId))))

  type RoomKind =
    | ChannelKind
    | ThreadKind

  type CreateRoom = {
    roomId: RoomId,
    kind: RoomKind,
    defaultAccess: Permission
  }

  pure def createRoom(s: AuthState, e: CreateRoom, ctx: EventContext): AuthState =
    if (not (s.isAdmin(ctx))) s.throw()
    else if (s.rooms.keys().contains(e.roomId)) s.throw()
    else
      val newRoom = match e.kind {
        | ChannelKind =>
            ChannelRoom({ defaultPermission: e.defaultAccess, deleted: false })
        | ThreadKind =>
            // Threads inherit permission from parent; defaultAccess is ignored.
            ThreadRoom({ deleted: false, parent: NoParent })
      }
      ok(s.with("rooms", s.rooms.put(e.roomId, newRoom)))

  type UpdateRoom = {
    roomId: RoomId,
    kind: RoomKind, // exclude this?
    defaultAccess: Permission
  }

  // Only channels have an updatable defaultPermission; updating a thread throws.
  pure def updateRoom(s: AuthState, e: UpdateRoom, ctx: EventContext): AuthState =
    if (not (s.isAdmin(ctx))) s.throw()
    else if (not (s.rooms.keys().contains(e.roomId))) s.throw()
    else match s.rooms.get(e.roomId) {
      | ThreadRoom(_) => s.throw()
      | ChannelRoom(c) =>
          val updated = ChannelRoom(c.with("defaultPermission", e.defaultAccess))
          ok(s.with("rooms", s.rooms.put(e.roomId, updated)))
    }

  type DeleteRoom = {
    roomId: RoomId
  }

  pure def deleteRoom(s: AuthState, e: DeleteRoom, ctx: EventContext): AuthState =
    if (not (s.isAdmin(ctx))) s.throw()
    else if (not (s.rooms.keys().contains(e.roomId))) s.throw()
    else match s.rooms.get(e.roomId) {
      | ChannelRoom(c) =>
          if (c.deleted) s.throw()
          else ok(s.with("rooms", s.rooms.put(e.roomId,
            ChannelRoom(c.with("deleted", true)))))
      | ThreadRoom(t) =>
          if (t.deleted) s.throw()
          else ok(s.with("rooms", s.rooms.put(e.roomId,
            ThreadRoom(t.with("deleted", true)))))
    }

  type RestoreRoom = {
    roomId: RoomId
  }

  pure def restoreRoom(s: AuthState, e: RestoreRoom, ctx: EventContext): AuthState =
    if (not (s.isAdmin(ctx))) s.throw()
    else if (not (s.rooms.keys().contains(e.roomId))) s.throw()
    else match s.rooms.get(e.roomId) {
      | ChannelRoom(c) =>
          if (not (c.deleted)) s.throw()
          else ok(s.with("rooms", s.rooms.put(e.roomId,
            ChannelRoom(c.with("deleted", false)))))
      | ThreadRoom(t) =>
          if (not (t.deleted)) s.throw()
          else ok(s.with("rooms", s.rooms.put(e.roomId,
            ThreadRoom(t.with("deleted", false)))))
    }

  type CreateRole = {
    roleId: RoleId
  }

  pure def createRole(s: AuthState, e: CreateRole, ctx: EventContext): AuthState =
    if (not (s.isAdmin(ctx))) s.throw()
    else if (s.roles.keys().contains(e.roleId)) s.throw()
    else ok(s.with("roles", s.roles.put(e.roleId,
      { members: Set(), channelPermissions: Map() })))

  // UpdateRole is currently a no-op shape — Role has no scalar fields to update
  // beyond members and per-room permissions, which have dedicated events.
  // Kept as a placeholder for when Role grows fields like name/color.
  type UpdateRole = {
    roleId: RoleId
  }

  pure def updateRole(s: AuthState, e: UpdateRole, ctx: EventContext): AuthState =
    if (not (s.isAdmin(ctx))) s.throw()
    else if (not (s.roles.keys().contains(e.roleId))) s.throw()
    else ok(s)

  type DeleteRole = {
    roleId: RoleId
  }

  pure def deleteRole(s: AuthState, e: DeleteRole, ctx: EventContext): AuthState =
    if (not (s.isAdmin(ctx))) s.throw()
    else if (not (s.roles.keys().contains(e.roleId))) s.throw()
    else
      val remaining = s.roles.keys().exclude(Set(e.roleId))
      ok(s.with("roles", remaining.mapBy(k => s.roles.get(k))))

  type AddMemberRole = {
    roleId: RoleId,
    userId: UserId
  }

  pure def addMemberRole(s: AuthState, e: AddMemberRole, ctx: EventContext): AuthState =
    if (not (s.isAdmin(ctx))) s.throw()
    else if (not (s.roles.keys().contains(e.roleId))) s.throw()
    else if (not (s.members.contains(e.userId))) s.throw()
    else
      val role = s.roles.get(e.roleId)
      val updated = role.with("members", role.members.union(Set(e.userId)))
      ok(s.with("roles", s.roles.put(e.roleId, updated)))

  type RemoveMemberRole = {
    roleId: RoleId,
    userId: UserId
  }

  pure def removeMemberRole(s: AuthState, e: RemoveMemberRole, ctx: EventContext): AuthState =
    if (not (s.isAdmin(ctx))) s.throw()
    else if (not (s.roles.keys().contains(e.roleId))) s.throw()
    else
      val role = s.roles.get(e.roleId)
      val updated = role.with("members", role.members.exclude(Set(e.userId)))
      ok(s.with("roles", s.roles.put(e.roleId, updated)))

  type SetRoleRoomPermission = {
    roleId: RoleId,
    roomId: RoomId,
    permission: Permission
  }

  // channelPermissions only apply to channels; threads inherit from parent.
  pure def setRoleRoomPermission(s: AuthState, e: SetRoleRoomPermission, ctx: EventContext): AuthState =
    if (not (s.isAdmin(ctx))) s.throw()
    else if (not (s.roles.keys().contains(e.roleId))) s.throw()
    else if (not (s.rooms.keys().contains(e.roomId))) s.throw()
    else match s.rooms.get(e.roomId) {
      | ThreadRoom(_) => s.throw()
      | ChannelRoom(_) =>
          val role = s.roles.get(e.roleId)
          val updated = role.with("channelPermissions",
            role.channelPermissions.put(e.roomId, e.permission))
          ok(s.with("roles", s.roles.put(e.roleId, updated)))
    }

  type CreateInvite = {
    token: InviteToken
  }

  pure def createInvite(s: AuthState, e: CreateInvite, ctx: EventContext): AuthState =
    if (not (s.isAdmin(ctx))) s.throw()
    else if (s.invites.contains(e.token)) s.throw()
    else ok(s.with("invites", s.invites.union(Set(e.token))))

  type RevokeInvite = {
    token: InviteToken
  }

  pure def revokeInvite(s: AuthState, e: RevokeInvite, ctx: EventContext): AuthState =
    if (not (s.isAdmin(ctx))) s.throw()
    else if (not (s.invites.contains(e.token))) s.throw()
    else ok(s.with("invites", s.invites.exclude(Set(e.token))))

  // Sent to the parent room. `toRoomId` is the child thread.
  // The first link addressing a given thread sets its canonical parent;
  // subsequent links to the same thread are ignored (no-op).
  type CreateRoomLink = {
    fromRoomId: RoomId,
    toRoomId: RoomId
  }

  pure def createRoomLink(s: AuthState, e: CreateRoomLink, ctx: EventContext): AuthState =
    if (not (s.isAdmin(ctx))) s.throw()
    else if (not (s.rooms.keys().contains(e.fromRoomId))) s.throw()
    else if (not (s.rooms.keys().contains(e.toRoomId))) s.throw()
    else match s.rooms.get(e.fromRoomId) {
      | ThreadRoom(_) => s.throw()  // parent must be a channel
      | ChannelRoom(_) => match s.rooms.get(e.toRoomId) {
          | ChannelRoom(_) => s.throw()  // child must be a thread
          | ThreadRoom(t) => match t.parent {
              | HasParent(_) => ok(s)  // already linked, ignore
              | NoParent =>
                  val updated = ThreadRoom(t.with("parent", HasParent(e.fromRoomId)))
                  ok(s.with("rooms", s.rooms.put(e.toRoomId, updated)))
            }
        }
    }

  // ── Oracle: derived auth decisions ─────────────────────────────────────
  // These mirror the logic in src/auth/access.ts. The MBT harness compares
  // these against the implementation's roomAccess()/spaceAccess() return values.

  pure def specRoomExists(s: AuthState, roomId: RoomId): bool =
    s.rooms.keys().contains(roomId)

  // Canonical parent: for a thread, its current parent; for a channel, NoParent.
  pure def specParentChannel(s: AuthState, roomId: RoomId): MaybeParent =
    if (not (s.specRoomExists(roomId))) NoParent
    else match s.rooms.get(roomId) {
      | ChannelRoom(_) => NoParent
      | ThreadRoom(t) => t.parent
    }

  // Effective default access: channels' own; threads inherit from parent channel.
  // Falls back to ReadWrite (matches normalizeDefaultAccess in access.ts).
  pure def specEffectiveDefaultAccess(s: AuthState, roomId: RoomId): Permission =
    if (not (s.specRoomExists(roomId))) ReadWrite
    else match s.rooms.get(roomId) {
      | ChannelRoom(c) => c.defaultPermission
      | ThreadRoom(t) => match t.parent {
          | NoParent => ReadWrite
          | HasParent(p) =>
              if (not (s.specRoomExists(p))) ReadWrite
              else match s.rooms.get(p) {
                | ChannelRoom(c) => c.defaultPermission
                | ThreadRoom(_) => ReadWrite  // unreachable if threadParentIsChannel holds
              }
        }
    }

  // Room used for role-grant lookups: parent channel for threads, self for channels.
  pure def specEffectiveRoomForPerms(s: AuthState, roomId: RoomId): RoomId =
    match s.specParentChannel(roomId) {
      | NoParent => roomId
      | HasParent(p) => p
    }

  pure def permGrantsRead(p: Permission): bool =
    match p {
      | None => false
      | Read => true
      | ReadWrite => true
    }

  pure def permGrantsWrite(p: Permission): bool =
    match p {
      | None => false
      | Read => false
      | ReadWrite => true
    }

  // True if the user is in any role granting read on the effective room.
  pure def specRoleGrantsRead(s: AuthState, roomId: RoomId, userId: UserId): bool =
    val effRoom = s.specEffectiveRoomForPerms(roomId)
    s.roles.keys().exists(rid =>
      val role = s.roles.get(rid)
      role.members.contains(userId)
        and role.channelPermissions.keys().contains(effRoom)
        and permGrantsRead(role.channelPermissions.get(effRoom)))

  pure def specRoleGrantsWrite(s: AuthState, roomId: RoomId, userId: UserId): bool =
    val effRoom = s.specEffectiveRoomForPerms(roomId)
    s.roles.keys().exists(rid =>
      val role = s.roles.get(rid)
      role.members.contains(userId)
        and role.channelPermissions.keys().contains(effRoom)
        and permGrantsWrite(role.channelPermissions.get(effRoom)))

  // Final decisions. Banned users get nothing (even admins). Admins otherwise
  // bypass everything. Non-admins union default_access with role grants.
  // Non-admin, non-banned access in an invite-only space requires membership.
  // Public spaces let anyone past this gate.
  pure def specPassesSpaceGate(s: AuthState, userId: UserId): bool =
    s.allowPublicJoin.allowsPublicJoin() or s.members.contains(userId)

  pure def specCanRead(s: AuthState, roomId: RoomId, userId: UserId): bool =
    if (not (s.specRoomExists(roomId))) false
    else if (s.bans.contains(userId)) false
    else if (s.admins.contains(userId)) true
    else if (not (s.specPassesSpaceGate(userId))) false
    else
      val defGrants = permGrantsRead(s.specEffectiveDefaultAccess(roomId))
      defGrants or s.specRoleGrantsRead(roomId, userId)

  // Writing always requires membership for non-admins, in any space config.
  pure def specCanWrite(s: AuthState, roomId: RoomId, userId: UserId): bool =
    if (not (s.specRoomExists(roomId))) false
    else if (s.bans.contains(userId)) false
    else if (s.admins.contains(userId)) true
    else if (not (s.members.contains(userId))) false
    else
      val defGrants = permGrantsWrite(s.specEffectiveDefaultAccess(roomId))
      defGrants or s.specRoleGrantsWrite(roomId, userId)

  // Bundled view matching the shape of RoomAccess in access.ts.
  type SpecRoomAccess = {
    exists: bool,
    canRead: bool,
    canWrite: bool,
    isAdmin: bool,
    isBanned: bool,
    defaultAccess: Permission,
    parentChannel: MaybeParent,
  }

  // Impl forces all fields to false/defaults when the room doesn't exist
  // (defensive early return in access.ts — no spaceId is available without
  // a known room). Mirror that here so MBT parity holds. Within the existing
  // branch, banned also suppresses isAdmin.
  pure def specRoomAccess(s: AuthState, roomId: RoomId, userId: UserId): SpecRoomAccess =
    if (not (s.specRoomExists(roomId))) {
      exists: false,
      canRead: false,
      canWrite: false,
      isAdmin: false,
      isBanned: false,
      defaultAccess: ReadWrite,
      parentChannel: NoParent,
    }
    else {
      exists: true,
      canRead: s.specCanRead(roomId, userId),
      canWrite: s.specCanWrite(roomId, userId),
      isAdmin: s.admins.contains(userId) and not (s.bans.contains(userId)),
      isBanned: s.bans.contains(userId),
      defaultAccess: s.specEffectiveDefaultAccess(roomId),
      parentChannel: s.specParentChannel(roomId),
    }

  type SpecSpaceAccess = {
    isMember: bool,
    isAdmin: bool,
    isBanned: bool,
  }

  pure def specSpaceAccess(s: AuthState, userId: UserId): SpecSpaceAccess = {
    isMember: s.members.contains(userId),
    // spaceAccess in access.ts returns raw isAdmin (doesn't suppress on ban).
    isAdmin: s.admins.contains(userId),
    isBanned: s.bans.contains(userId),
  }

  // Snapshot of all oracle decisions over the (user, room) and (user) pools.
  // The MBT harness reads this directly from the trace JSON instead of
  // re-deriving decisions in TypeScript.
  type OracleSnapshot = {
    rooms: (UserId, RoomId) -> SpecRoomAccess,
    spaces: UserId -> SpecSpaceAccess,
  }
}

module auth_types {
  // state for the module
  // every time something happens, 
  // we take current state and create a new state
  type AuthState = {
    allowPublicJoin: PublicJoinConfig,
    roles: RoleId -> Role,
    admins: Set[UserId],
    rooms: RoomId -> Room,
    members: Set[UserId],
    invites: Set[InviteToken],
    bans: Set[UserId],
    result: LastAuthResult, // was the previous event applied?
  }

  type LastAuthResult = 
    | AuthOk
    | AuthPermissionDenied

  pure def ok(authState: AuthState): AuthState = authState.with("result", AuthOk)
  pure def throw(authState: AuthState): AuthState = authState.with("result", AuthPermissionDenied)

  type Role = {
    members: Set[UserId],
    channelPermissions: RoomId -> Permission
  }

  // A Room is either a Channel or a Thread (disjoint variants).
  // Threads inherit defaultPermission from their parent channel.
  type Room =
    | ChannelRoom(Channel)
    | ThreadRoom(Thread)

  type Channel = {
    defaultPermission: Permission,
    deleted: bool
  }

  type Thread = {
    deleted: bool,
    parent: MaybeParent
  }

  type Permission =
    | None
    | Read
    | ReadWrite

  type PublicJoinConfig = 
    | AllowPublicJoin
    | InviteOnly(Set[InviteToken])
  
  type MaybeInvite = HasInvite(InviteToken) | NoInvite

  type MaybeParent = HasParent(RoomId) | NoParent

  type InviteToken = str
  type RoleId = str
  type UserId = str
  type RoomId = str

}
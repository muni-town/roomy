module auth {
  import auth_types.*
  import events.*

  pure val users = Set("alice", "bob", "caroline", "danielle")


  var state: AuthState

  action init = state' = {
    allowPublicJoin: AllowPublicJoin,
    roles: Map(),
    admins: Set(),
    channels: Map(),
    result: AuthOk
  }

  action step = any {
    addAdminAny,
    // removeAdminAny
  }

  action addAdminAny = 
    nondet sender = users.oneOf()
    nondet user = users.oneOf()
    state' = state.addAdmin({adminId: user}, {userId: sender})

  // action removeAdminAny = 
  //   nondet user = state.admins.oneOf()
  //   state' = state.removeAdmin(user)

  // action tryRead Query: QueryResponse


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
    if (s.isAdmin(ctx)) s.throw()
    else ok(s.with("admins", s.admins.exclude(Set(e.adminId))))

  type JoinSpace = {
    invite: MaybeInvite
  }

  // pure def joinSpace(s: AuthState, e: JoinSpace, ctx: EventContext): AuthState =
  //   if (s.allowPublicJoin) match e.invite {
  //     | HasInvite(Invite) => 
  //   }

  pure def allowsPublicJoin(c: PublicJoinConfig): bool = 
    match (c) {
      | AllowPublicJoin => true
      | InviteOnly => false
    }

  type LeaveSpace = {}

  type RoomKind = 
    | ChannelKind
    | ThreadKind

  type CreateRoom = {
    roomId: RoomId,
    kind: RoomKind,
    defaultAccess: Permission
  }

  type DeleteRoom = {
    roomId: RoomId
  }

  type RestoreRoom = {
    roomId: RoomId
  }

  type UpdateRoom = {
    roomId: RoomId,
    kind: RoomKind, // exclude this?
    defaultAccess: Permission
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
    channels: RoomId -> Channel,
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

  type Channel = {
    defaultPermission: Permission
  }

  type Permission =
    | None
    | Read
    | ReadWrite

  type PublicJoinConfig = 
    | AllowPublicJoin
    | InviteOnly(Set[InviteToken])
  
  type MaybeInvite = HasInvite(InviteToken) | NoInvite

  type InviteToken = str
  type RoleId = str
  type UserId = str
  type RoomId = str

}
import { Event } from "../schema";
import { sql } from "../utils/sqlTemplate";
import { LeafClient, type BasicModule } from "@muni-town/leaf-client";

export type ModuleWithCid = {
  def: BasicModule;
  cid: Promise<string>;
};

const personalModuleDef: BasicModule = {
  $type: "muni.town.leaf.module.basic.v0" as const,
  initSql: sql`
    create table if not exists stream_info (
      admin text,
      type text not null default 'space.roomy.space.personal',
      schema_version text not null default '3'
    );

    insert into stream_info (admin) select null where not exists (select 1 from stream_info);
  `.sql,
  stateInitSql: "",
  authorizer: sql`
    -- Get event type once
    with event_info as (
      select drisl_extract(payload, '.$type') as event_type from event
    )
    -- no admin set yet - only allow admin.add events
    select unauthorized('stream not initialized - only admin.add allowed')
    where (select admin from stream_info) is null
      and (select event_type from event_info) is not 'space.roomy.space.addAdmin.v0';

    with event_info as (
      select drisl_extract(payload, '.$type') as event_type from event
    )
    -- admin already set - reject admin.add (only one admin allowed)
    select unauthorized('admin already set')
    where (select admin from stream_info) is not null
      and (select event_type from event_info) = 'space.roomy.space.addAdmin.v0';

    with event_info as (
      select drisl_extract(payload, '.$type') as event_type from event
    )
    -- other events must be from admin
    select unauthorized('only the admin can add events to this stream:' % (select admin from stream_info))
    where (select admin from stream_info) is not null
      and (select user from event) is not (select admin from stream_info);
  `.sql,
  materializer: sql`
    -- Set admin from admin.add event
    update stream_info
    set admin = (select drisl_extract(payload, '.userDid') from event)
    where (select drisl_extract(payload, '.$type') from event) = 'space.roomy.space.addAdmin.v0';
  `.sql,
  stateMaterializer: "",
  queries: [
    {
      name: "stream_info",
      sql: `select * from stream_info;`,
      params: [],
    },
    {
      name: "events",
      sql: sql`
        select unauthorized('only the stream creator can read its events')
          where $requesting_user != (select admin from stream_info);

        select idx, user, payload from events.events
          where idx >= $start limit $limit;
      `.sql,
      params: [],
    },
  ],
};
const personalModuleCid: Promise<string> =
  LeafClient.moduleCid(personalModuleDef);

const personal: ModuleWithCid = {
  def: personalModuleDef,
  cid: personalModuleCid,
};

const metadataQueryEvents: Event["$type"][] = [
  "space.roomy.space.joinSpace.v0",
  "space.roomy.space.leaveSpace.v0",
  "space.roomy.space.addAdmin.v0",
  "space.roomy.space.removeAdmin.v0",
  "space.roomy.space.setHandleProvider.v0",
  "space.roomy.space.updateSpaceInfo.v0",
  "space.roomy.space.updateSidebar.v0",
  "space.roomy.space.updateSidebar.v1",
  "space.roomy.room.createRoom.v0",
  "space.roomy.room.deleteRoom.v0",
  "space.roomy.room.restoreRoom.v0",
  "space.roomy.room.updateRoom.v0",
  "space.roomy.link.createRoomLink.v0",
  // 'space.roomy.room.addMember.v0',
  // 'space.roomy.room.removeMember.v0',
  "space.roomy.user.updateProfile.v0",
  "space.roomy.openmeet.configure.v0",
];

const metadataQueryEventsString = "'" + metadataQueryEvents.join("', '") + "'";

const spaceModuleDef: BasicModule = {
  $type: "muni.town.leaf.module.basic.v0" as const,

  initSql: sql`
    create table if not exists stream_info (

      type text not null default 'space.roomy.space.space',
      schema_version text not null default '5'
    ) strict;

    insert into stream_info (type) select 'space.roomy.space.space'
      where not exists (select 1 from stream_info);

    create table if not exists bans (
      user_did text not null primary key
    ) strict;

    create table if not exists space_info (
      name text,
      avatar text,
      description text,
      handle_provider text,
      allow_public_join integer not null default 1 check(allow_public_join in (0, 1)),
      allow_member_invites integer not null default 0 check(allow_member_invites in (0, 1))
    ) strict;
    delete from space_info;
    insert into space_info (name, avatar, description, handle_provider) values (null, null, null, null);

    create table if not exists sidebar_config (
      config text not null default '{"categories": []}'
    ) strict;
    delete from sidebar_config;
    insert into sidebar_config (config) values ('{"categories": []}');

    create table if not exists rooms (
      id text primary key, -- ulid
      kind text not null, -- 'space.roomy.channel', 'space.roomy.thread', 'space.roomy.page'
      name text,
      description text,
      avatar text,
      deleted integer not null default 0 check(deleted in (0, 1)),
      message_count integer not null default 0,
      parent text -- canonical parent room id (set from first createRoomLink)
    ) strict;
    create index if not exists rooms_kind_idx on rooms(kind);
    create index if not exists rooms_parent_idx on rooms(parent);

    create table if not exists openmeet_config (
      group_slug text,
      tenant_id text,
      api_url text
    ) strict;
    delete from openmeet_config;

    create table if not exists admins (
      user_id text primary key -- did
    ) strict;

    create table if not exists members (
      user_id text primary key,
      name text,
      avatar text,
      handle text
    ) strict;

    create table if not exists metadata_events (
      idx integer primary key
    ) strict;

    create table if not exists room_events (
      idx integer primary key,
      room text not null,
      discord_origin text -- did:discord:<snowflake> if event has Discord extension
    ) strict;
    create index if not exists room_events_room_idx on room_events(room);

    create table if not exists link_events (
      idx integer primary key
    ) strict;

    create table if not exists room_links (
      parent_room text not null,
      child_room text not null,
      is_canonical integer not null default 0,
      created_at integer not null,
      primary key (parent_room, child_room)
    ) strict;
    create index if not exists room_links_parent_idx on room_links(parent_room);
    create index if not exists room_links_child_idx on room_links(child_room, is_canonical desc);

    create table if not exists invites (
      token text primary key,
      created_by text not null,
      event_ulid text not null
    ) strict;
  `.sql,

  stateInitSql: sql`
    create table if not exists state.reads (
      user_did text not null,
      room_id text not null,
      last_read integer not null default 0,
      primary key (user_did, room_id)
    ) strict;
  `.sql,

  authorizer: sql`
    -- Banned users cannot do anything
    select unauthorized('Your account has been banned from this space.')
    where exists (select 1 from bans where user_did = (select user from event));

    -- No admins yet - only allow admin.add (bootstrap)
    with event_info as (
      select
        drisl_extract(payload, '.$type') as event_type
      from event
    )
    select unauthorized('space not initialized - need admin.add')
    where not exists (select 1 from admins)
      and (select event_type from event_info) is not 'space.roomy.space.addAdmin.v0';

    -- Private spaces require a valid invite token to join
    with event_info as (
      select
        drisl_extract(payload, '.$type') as event_type
      from event
    )
    select unauthorized('this space requires an invite to join')
    where (select event_type from event_info) = 'space.roomy.space.joinSpace.v0'
      and (select allow_public_join from space_info) = 0
      and not exists (
        select 1 from invites
        where token = (select drisl_extract(payload, '.inviteToken') from event)
      );

    -- Non-members can only send joinSpace events
    with event_info as (
      select
        drisl_extract(payload, '.$type') as event_type,
        user as author
      from event
    )
    select unauthorized('must be a member of this space')
    where exists (select 1 from admins) -- space is initialized
      and (select event_type from event_info) is not 'space.roomy.space.joinSpace.v0'
      and not exists (select 1 from members where user_id = (select author from event_info))
      and not exists (select 1 from admins where user_id = (select author from event_info));

    -- Non-admins are restricted to whitelisted member events.
    -- Any event type not in this list requires admin.
    with event_info as (
      select
        drisl_extract(payload, '.$type') as event_type,
        user as author
      from event
    )
    select unauthorized('must be admin to perform this action')
    where exists (select 1 from admins) -- space is initialized
      and (select event_type from event_info) not in (
        'space.roomy.space.joinSpace.v0',
        'space.roomy.space.leaveSpace.v0',
        'space.roomy.message.createMessage.v0',
        'space.roomy.message.editMessage.v0',
        'space.roomy.message.deleteMessage.v0',
        'space.roomy.message.moveMessages.v0',
        'space.roomy.message.forwardMessages.v0',
        'space.roomy.room.createRoom.v0',
        'space.roomy.room.updateRoom.v0',
        'space.roomy.reaction.addReaction.v0',
        'space.roomy.reaction.removeReaction.v0',
        'space.roomy.page.editPage.v0',
        'space.roomy.user.updateProfile.v0',
        'space.roomy.link.createRoomLink.v0',
        'space.roomy.link.removeRoomLink.v0',
        'space.roomy.state.markRead.v0',
        'space.roomy.space.createInvite.v0',
        'space.roomy.space.revokeInvite.v0',
        'space.roomy.space.personal.joinSpace.v0',
        'space.roomy.space.personal.leaveSpace.v0'
      )
      and not exists (select 1 from admins where user_id = (select author from event_info));

    -- createMessage with authorOverride extension requires admin (bridge use case)
    with event_info as (
      select
        user as author
      from event
    )
    select unauthorized('must be admin to send messages with author override')
    where (select drisl_extract(payload, '.$type') from event) = 'space.roomy.message.createMessage.v0'
      and (select drisl_exists(payload, '.extensions."space.roomy.extension.authorOverride.v0"') from event) = 1
      and not exists (select 1 from admins where user_id = (select author from event_info));

    -- Only members can create invites when allowMemberInvites is enabled; otherwise admin required
    with event_info as (
      select
        user as author
      from event
    )
    select unauthorized('must be admin to create invites, or space must allow member invites')
    where (select drisl_extract(payload, '.$type') from event) = 'space.roomy.space.createInvite.v0'
      and not exists (select 1 from admins where user_id = (select author from event_info))
      and not exists (select 1 from space_info where allow_member_invites = 1);

    -- Only admins or the invite creator can revoke invites
    with event_info as (
      select
        user as author
      from event
    )
    select unauthorized('must be admin or invite creator to revoke invites')
    where (select drisl_extract(payload, '.$type') from event) = 'space.roomy.space.revokeInvite.v0'
      and not exists (select 1 from admins where user_id = (select author from event_info))
      and not exists (
        select 1 from invites
        where token = (select drisl_extract(payload, '.token') from event)
          and created_by = (select author from event_info)
      );
  `.sql,

  materializer: `
    -- Add admin
    insert or ignore into admins (user_id)

    select drisl_extract(payload, '.userDid') from event
    where drisl_extract(payload, '.$type') = 'space.roomy.space.addAdmin.v0';

    -- Remove admin
    delete from admins
    where user_id = (select drisl_extract(payload, '.userDid') from event)
      and (select drisl_extract(payload, '.$type') from event) = 'space.roomy.space.removeAdmin.v0';

    -- Add member
    insert or ignore into members (user_id)
    select user
    from event
    where drisl_extract(payload, '.$type') = 'space.roomy.space.joinSpace.v0';

    -- Pre-mark all existing channels as read for newly joined user
    insert or ignore into state.reads (user_did, room_id, last_read)
    select
      (select user from event),
      r.id,
      r.message_count
    from rooms r
    where r.kind = 'space.roomy.channel'
      and r.deleted = 0
      and (select drisl_extract(payload, '.$type') from event) = 'space.roomy.space.joinSpace.v0';

    -- Remove member
    delete from members
    where user_id = (select user from event)
      and (select drisl_extract(payload, '.$type') from event) = 'space.roomy.space.leaveSpace.v0';

    -- Update space info
    update space_info
    set
      name = case (select drisl_exists(payload, '.name') from event)
        when 1 then (select drisl_extract(payload, '.name') from event) else name end,
      avatar = case (select drisl_exists(payload, '.avatar') from event)
        when 1 then (select drisl_extract(payload, '.avatar') from event) else avatar end,
      description = case (select drisl_exists(payload, '.description') from event)
        when 1 then (select drisl_extract(payload, '.description') from event) else description end,
      allow_public_join = case (select drisl_exists(payload, '.allowPublicJoin') from event)
        when 1 then (select drisl_extract(payload, '.allowPublicJoin') from event) else allow_public_join end,
      allow_member_invites = case (select drisl_exists(payload, '.allowMemberInvites') from event)
        when 1 then (select drisl_extract(payload, '.allowMemberInvites') from event) else allow_member_invites end
    where (select drisl_extract(payload, '.$type') from event) = 'space.roomy.space.updateSpaceInfo.v0';

    -- Update sidebar config
    update sidebar_config
    set config = (select drisl_extract(payload, '.categories') from event)
    where (select drisl_extract(payload, '.$type') from event) in ('space.roomy.space.updateSidebar.v0', 'space.roomy.space.updateSidebar.v1');

    -- Create room
    insert or ignore into rooms (id, kind, name, description, avatar, deleted)
    select
      drisl_extract(payload, '.id') as id,
      drisl_extract(payload, '.kind') as kind,
      drisl_extract(payload, '.name') as name,
      drisl_extract(payload, '.description') as description,
      drisl_extract(payload, '.avatar') as avatar,
      0 as deleted
    from event
    where drisl_extract(payload, '.$type') = 'space.roomy.room.createRoom.v0';

    -- Update room
    update rooms
    set
      kind = case (select drisl_exists(payload, '.kind') from event)
        when 1 then (select drisl_extract(payload, '.kind') from event) else kind end,
      name = case (select drisl_exists(payload, '.name') from event)
        when 1 then (select drisl_extract(payload, '.name') from event) else name end,
      description = case (select drisl_exists(payload, '.description') from event)
        when 1 then (select drisl_extract(payload, '.description') from event) else description end,
      avatar = case (select drisl_exists(payload, '.avatar') from event)
        when 1 then (select drisl_extract(payload, '.avatar') from event) else avatar end
    where id = (select drisl_extract(payload, '.roomId') from event)
      and (select drisl_extract(payload, '.$type') from event) = 'space.roomy.room.updateRoom.v0';

    -- Delete room (soft delete)
    update rooms
    set deleted = 1
    where id = (select drisl_extract(payload, '.roomId') from event)
      and (select drisl_extract(payload, '.$type') from event) = 'space.roomy.room.deleteRoom.v0';

    -- Restore room
    update rooms
    set deleted = 0
    where id = (select drisl_extract(payload, '.roomId') from event)
      and (select drisl_extract(payload, '.$type') from event) = 'space.roomy.room.restoreRoom.v0';

    -- Update OpenMeet configuration
    update openmeet_config
    set
      group_slug = (select drisl_extract(payload, '.groupSlug') from event),
      tenant_id = (select drisl_extract(payload, '.tenantId') from event),
      api_url = (select drisl_extract(payload, '.apiUrl') from event)
    where (select drisl_extract(payload, '.$type') from event) = 'space.roomy.openmeet.configure.v0';

    -- Set handle provider
    update space_info
    set handle_provider = (select drisl_extract(payload, '.did') from event)
    where (select drisl_extract(payload, '.$type') from event) = 'space.roomy.space.setHandleProvider.v0';
      
    -- Mark metadata events
    insert into metadata_events (idx)
    select idx from event
    where drisl_extract(payload, '.$type') in (
      ${metadataQueryEventsString}
    );

    -- Track room membership for events
    -- Also store Discord origin if present (for bridged messages/reactions)
    insert into room_events (idx, room, discord_origin)
    select
      idx,
      drisl_extract(payload, '.room'),
      -- For bridged messages: check authorOverride extension
      coalesce(
        -- Message events with authorOverride extension
        drisl_extract(payload, '.extensions."space.roomy.extension.authorOverride.v0".did'),
        -- Bridged reaction events: check reactingUser field
        case
          when drisl_extract(payload, '.$type') in (
            'space.roomy.reaction.addBridgedReaction.v0',
            'space.roomy.reaction.removeBridgedReaction.v0'
          )
          and drisl_extract(payload, '.reactingUser') like 'did:discord:%'
          then drisl_extract(payload, '.reactingUser')
          else null
        end
      )
    from event
    where drisl_extract(payload, '.room') is not null
    on conflict(idx) do update set
      discord_origin = excluded.discord_origin
      where room_events.discord_origin is null and excluded.discord_origin is not null;

    -- Increment message count for createMessage events
    update rooms
    set message_count = message_count + 1
    where id = (select drisl_extract(payload, '.room') from event)
      and (select drisl_extract(payload, '.$type') from event) = 'space.roomy.message.createMessage.v0';

    -- Track link events
    insert into link_events (idx)
    select idx from event
    where drisl_extract(payload, '.$type') in (
      'space.roomy.link.createRoomLink.v0',
      'space.roomy.link.removeRoomLink.v0'
    );

    -- Set canonical parent for linked room (only on first link)
    update rooms
    set parent = (select drisl_extract(payload, '.room') from event)
    where id = (select drisl_extract(payload, '.linkToRoom') from event)
      and parent is null
      and (select drisl_extract(payload, '.$type') from event) = 'space.roomy.link.createRoomLink.v0';
    
    -- Update member profiles
    -- First ensure the member exists
    insert or ignore into members (user_id)
    select drisl_extract(payload, '.did')
    from event
    where drisl_extract(payload, '.$type') = 'space.roomy.user.updateProfile.v0';

    -- Update name if provided
    update members
    set name = (select drisl_extract(payload, '.name') from event)
    where user_id = (select drisl_extract(payload, '.did') from event)
      and (select drisl_extract(payload, '.$type') from event) = 'space.roomy.user.updateProfile.v0'
      and (select drisl_exists(payload, '.name') from event) = 1;

    -- Update avatar if provided
    update members
    set avatar = (select drisl_extract(payload, '.avatar') from event)
    where user_id = (select drisl_extract(payload, '.did') from event)
      and (select drisl_extract(payload, '.$type') from event) = 'space.roomy.user.updateProfile.v0'
      and (select drisl_exists(payload, '.avatar') from event) = 1;


    -- Ban a user
    insert or ignore into bans (user_did)
    select drisl_extract(payload, '.userDid') from event
    where
      (select drisl_extract(payload, '.$type') from event) = 'space.roomy.space.banAccount.v0';

    -- Unban a user
    delete from bans
    where
      (select drisl_extract(payload, '.$type') from event) = 'space.roomy.space.unbanAccount.v0'
        and
      user_did = (select drisl_extract(payload, '.userDid') from event);

    -- Update handle from Discord extension if provided
    update members
    set handle = (select drisl_extract(payload, '.extensions."space.roomy.extension.discordUserOrigin.v0".handle') from event)
    where user_id = (select drisl_extract(payload, '.did') from event)
      and (select drisl_extract(payload, '.$type') from event) = 'space.roomy.user.updateProfile.v0'
      and (select drisl_exists(payload, '.extensions."space.roomy.extension.discordUserOrigin.v0".handle') from event) = 1;

    -- Create invite
    insert or ignore into invites (token, created_by, event_ulid)
    select
      drisl_extract(payload, '.token'),
      user,
      drisl_extract(payload, '.id')
    from event
    where drisl_extract(payload, '.$type') = 'space.roomy.space.createInvite.v0';

    -- Revoke invite
    delete from invites
    where token = (select drisl_extract(payload, '.token') from event)
      and (select drisl_extract(payload, '.$type') from event) = 'space.roomy.space.revokeInvite.v0';
  `,

  stateMaterializer: `
    -- Update read receipts (state events)
    insert into state.reads (user_did, room_id, last_read)
    values (
    (select user from event),
    (select drisl_extract(payload, '.room') from event),
    (select message_count from rooms where id = (select drisl_extract(payload, '.room') from event))
    )
    on conflict(user_did, room_id) do update set
    last_read = excluded.last_read
    where (select drisl_extract(payload, '.$type') from event) = 'space.roomy.state.markRead.v0';
  `,

  queries: [
    {
      name: "stream_info",
      sql: `select * from stream_info;`,
      params: [],
    },
    {
      name: "members",
      sql: `
        select unauthorized('must be a member or admin to view this data')
          where not exists (select 1 from members where user_id = $requesting_user)
            and not exists (select 1 from admins where user_id = $requesting_user);

        select user_id, name, avatar, handle from members
      `,
      params: [],
    },
    {
      name: "space_info",
      sql: `select name, avatar, description, handle_provider, allow_public_join, allow_member_invites, exists(select 1 from members where user_id = $requesting_user) as is_member, exists(select 1 from admins where user_id = $requesting_user) as is_admin from space_info;`,
      params: [],
    },
    {
      name: "admins",
      sql: `
        select unauthorized('must be a member or admin to view this data')
          where not exists (select 1 from members where user_id = $requesting_user)
            and not exists (select 1 from admins where user_id = $requesting_user);

        select * from admins;
      `,
      params: [],
    },
    {
      name: "bans",
      sql: `
        select unauthorized('only admins can view the ban list')
          where not exists (select 1 from admins where user_id = $requesting_user);

        select * from bans
      `,
      params: [],
    },
    {
      name: "space_meta",
      sql: `
        select unauthorized('must be a member or admin to view this data')
          where not exists (select 1 from members where user_id = $requesting_user)
            and not exists (select 1 from admins where user_id = $requesting_user);

        select
          json_object(
            '$type', 'space.roomy.query.spaceMeta.v0',
            'latestIdx', (select idx from events.events order by idx desc limit 1),
            'schemaVersion', (select schema_version from stream_info),
            'info', json_object(
              'name', (select name from space_info),
              'avatar', (select avatar from space_info),
              'description', (select description from space_info),
              'handleProvider', (select handle_provider from space_info),
              'allowPublicJoin', (select allow_public_join from space_info),
              'allowMemberInvites', (select allow_member_invites from space_info)
            ),
            'sidebar', (select config from sidebar_config),
            -- sidebar_config.config is already {"categories": [...]}, which is exactly the format we need
            'channels', (
              select json_group_array(
                json_object(
                  'id', r.id,
                  'name', r.name,
                  'description', r.description,
                  'avatar', r.avatar,
                  'messageCount', r.message_count,
                  'lastRead', coalesce(
                    (select last_read from state.reads
                     where user_did = $requesting_user and room_id = r.id),
                    0
                  ),
                  'threads', (
                    select json_group_array(
                      json_object(
                        'id', t.id,
                        'name', t.name,
                        'messageCount', t.message_count,
                        'lastRead', coalesce(
                          (select last_read from state.reads
                           where user_did = $requesting_user and room_id = t.id),
                          0
                        )
                      )
                    )
                    from (
                      select t.id, t.name, t.message_count
                      from rooms t
                      left join room_events re on re.room = t.id
                      where t.kind = 'space.roomy.thread'
                        and t.parent = r.id
                        and t.deleted = 0
                      group by t.id, t.name, t.message_count
                      order by max(re.idx) desc nulls last
                      limit 5
                    ) t
                  )
                )
              )
              from rooms r
              where r.deleted = 0
              and r.kind = 'space.roomy.channel'
            ),
            'admins', (
              select json_group_array(user_id)
              from admins
            ),
            'openmeetConfig', json_object(
              'groupSlug', (select group_slug from openmeet_config),
              'tenantId', (select tenant_id from openmeet_config),
              'apiUrl', (select api_url from openmeet_config)
            )
          ) as payload
        from space_info
        limit 1
      ;
      `,
      params: [],
    },
    {
      name: "events",
      sql: `
        select unauthorized('only admins can query the full event stream')
          where not exists (select 1 from admins where user_id = $requesting_user);

        select idx, user, payload from events.events
          where idx >= $start limit $limit;
      `,
      params: [],
    },
    {
      name: "metadata",
      sql: `
        select unauthorized('must be a member or admin to view this data')
          where not exists (select 1 from members where user_id = $requesting_user)
            and not exists (select 1 from admins where user_id = $requesting_user);

        select e.idx, e.user, e.payload
        from events.events e
        inner join metadata_events m on e.idx = m.idx
        where e.idx >= $start
        limit $limit;
      `,
      params: [],
    },
    {
      name: "room",
      sql: `
        select unauthorized('must be a member or admin to view this data')
          where not exists (select 1 from members where user_id = $requesting_user)
            and not exists (select 1 from admins where user_id = $requesting_user);


        select
          e.idx,
          e.user,
          e.payload,
          -- Include profile JSON if available (for Discord bridged users)
          json_object(
            '$type', 'space.roomy.query.profile.v0',
            'did', coalesce(r.discord_origin, e.user),
            'name', m.name,
            'avatar', m.avatar,
            'handle', m.handle
          ) as profile
        from events.events e
        inner join room_events r on e.idx = r.idx
        left join members m on coalesce(r.discord_origin, e.user) = m.user_id
        where r.room = $room and ($end is null or e.idx < $end)
        order by e.idx desc
        limit $limit;
      `,
      params: [
        { kind: "text", name: "room", optional: false },
        { kind: "integer", name: "end", optional: true },
      ],
    },
    {
      name: "links",
      sql: `
        select unauthorized('must be a member or admin to view this data')
          where not exists (select 1 from members where user_id = $requesting_user)
            and not exists (select 1 from admins where user_id = $requesting_user);

        select e.idx, e.user, e.payload
        from events.events e
        inner join link_events l on e.idx = l.idx
        where e.idx >= $start
          and ($room is null or e.idx in (
            select r.idx from room_events r where r.room = $room
          ))

        union all

        select * from (
          select e.idx, e.user, e.payload
          from events.events e
          inner join room_events re on e.idx = re.idx
          where $room is not null
            and re.room in (
              select id from rooms
              where parent = $room and kind = 'space.roomy.thread' and deleted = 0
            )
          order by e.idx desc
          limit 20
        );
      `,
      params: [{ kind: "text", name: "room", optional: true }],
    },
    {
      name: "rooms",
      sql: `
        select unauthorized('must be a member or admin to view this data')
          where not exists (select 1 from members where user_id = $requesting_user)
            and not exists (select 1 from admins where user_id = $requesting_user);

        select id, name, kind, deleted, parent
        from rooms
        where ($kind is null or kind = $kind)
        order by name
      `,
      params: [{ kind: "text", name: "kind", optional: true }],
    },
    {
      name: "profiles",
      sql: `
        select unauthorized('must be a member or admin to view this data')
          where not exists (select 1 from members where user_id = $requesting_user)
            and not exists (select 1 from admins where user_id = $requesting_user);

        select
          json_object(
            'did', m.user_id,
            'name', m.name,
            'avatar', m.avatar,
            'handle', m.handle
          ) as profile
        from json_each($user_dids) as j
        left join members m on j.value = m.user_id;
      `,
      params: [{ kind: "text", name: "user_dids", optional: false }],
    },
    {
      name: "invites",
      sql: `
        select token, created_by, event_ulid from invites
        where created_by = $requesting_user
          or exists (select 1 from admins where user_id = $requesting_user);
      `,
      params: [],
    },
  ],
};
const spaceModuleCid: Promise<string> = LeafClient.moduleCid(spaceModuleDef);

const space: ModuleWithCid = {
  def: spaceModuleDef,
  cid: spaceModuleCid,
};

export const modules = {
  personal,
  space,
} as const;

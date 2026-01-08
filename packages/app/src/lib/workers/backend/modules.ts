import { sql } from "$lib/utils/sqlTemplate";
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
      schema_version text not null default '2'
    );
    
    insert into stream_info (admin) select null where not exists (select 1 from stream_info);
  `.sql,
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
personal.cid.then((cid) => console.debug(`Personal module cid: ${cid}`));

const spaceModuleDef: BasicModule = {
  $type: "muni.town.leaf.module.basic.v0" as const,

  initSql: sql`
    create table if not exists stream_info (
      type text not null default 'space.roomy.space.space',
      schema_version text not null default '2'
    );
    
    insert into stream_info (type) select 'space.roomy.space.space' 
      where not exists (select 1 from stream_info);
      
    create table if not exists admins (
      user_id text primary key -- did
    );
    
    create table if not exists metadata_events (
      idx integer primary key
    );
    
    create table if not exists room_events (
      idx integer primary key,
      room text not null
    );
    create index if not exists room_events_room_idx on room_events(room);
  `.sql,

  authorizer: sql`
    -- Case 1: No admins yet - only allow admin.add (bootstrap)
    with event_info as (
      select
        drisl_extract(payload, '.$type') as event_type
      from event
    )
    select unauthorized('space not initialized - need admin.add')
    where not exists (select 1 from admins)
      and (select event_type from event_info) is not 'space.roomy.space.addAdmin.v0';

    -- Case 2: Admins exist - author must be an admin for admin management
    with event_info as (
      select
        drisl_extract(payload, '.$type') as event_type,
        user as author
      from event
    )
    select unauthorized('must be admin to manage admins')
    where exists (select 1 from admins)
      and (select event_type from event_info) in ('space.roomy.space.addAdmin.v0', 'space.roomy.space.removeAdmin.v0')
      and not exists (select 1 from admins where user_id = (select author from event_info));
  `.sql,

  materializer: sql`
    -- Add admin
    insert or ignore into admins (user_id)
    select drisl_extract(payload, '.userDid') from event
    where drisl_extract(payload, '.$type') = 'space.roomy.space.addAdmin.v0';

    -- Remove admin
    delete from admins
    where user_id = (select drisl_extract(payload, '.userDid') from event)
      and (select drisl_extract(payload, '.$type') from event) = 'space.roomy.space.removeAdmin.v0';
    
    -- Mark metadata events
    insert into metadata_events (idx)
    select idx from event
    where drisl_extract(payload, '.$type') in (
      'space.roomy.space.personal.joinSpace.v0',
      'space.roomy.space.personal.leaveSpace.v0',
      'space.roomy.space.addAdmin.v0',
      'space.roomy.space.removeAdmin.v0',
      'space.roomy.user.setHandleAccount.v0',
      'space.roomy.space.updateSpaceInfo.v0',
      'space.roomy.room.createRoom.v0',
      'space.roomy.room.deleteRoom.v0',
      'space.roomy.room.updateRoom.v0',
      'space.roomy.link.createRoomLink.v0',
      'space.roomy.room.addMember.v0',
      'space.roomy.room.removeMember.v0',
      'space.roomy.user.updateUserProfile.v0'
    );
    
    -- Track room membership for events
    insert or ignore into room_events (idx, room)
    select idx, drisl_extract(payload, '.room') from event
    where drisl_extract(payload, '.room') is not null;
  `.sql,

  queries: [
    {
      name: "stream_info",
      sql: `select * from stream_info;`,
      params: [],
    },
    {
      name: "admins",
      sql: `select * from admins;`,
      params: [],
    },
    {
      name: "events",
      sql: `
        select idx, user, payload from events.events
          where idx >= $start limit $limit;
      `,
      params: [],
    },
    {
      name: "metadata",
      sql: `
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
        select e.idx, e.user, e.payload
        from events.events e
        inner join room_events r on e.idx = r.idx
        where r.room = $room and ($end is null or e.idx < $end)
        order by e.idx desc
        limit $limit;
      `,
      params: [
        { kind: "text", name: "room", optional: false },
        { kind: "integer", name: "end", optional: true },
      ],
    },
  ],
};
const spaceModuleCid: Promise<string> = LeafClient.moduleCid(spaceModuleDef);

const space: ModuleWithCid = {
  def: spaceModuleDef,
  cid: spaceModuleCid,
};
space.cid.then((cid) => console.debug(`Space module cid: ${cid}`));

export const modules = {
  personal,
  space,
} as const;

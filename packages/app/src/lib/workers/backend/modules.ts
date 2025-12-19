import { type BasicModule } from "@muni-town/leaf-client";

export const personalModule: BasicModule = {
  $type: "muni.town.leaf.module.basic.v0" as const,
  initSql: `
    create table if not exists stream_info (
      admin text,
      type text not null default 'space.roomy.stream.personal',
      schema_version text not null default '2'
    );
    
    insert into stream_info (admin) select null where not exists (select 1 from stream_info);
  `,
  authorizer: `
    -- Get event type once
    with event_info as (
      select drisl_extract(payload, '.variant.$type') as event_type from event
    )
    -- no admin set yet - only allow admin.add events
    select unauthorized('stream not initialized - only admin.add allowed')
    where (select admin from stream_info) is null
      and (select event_type from event_info) is not 'space.roomy.space.addAdmin.v0';
  
    with event_info as (
      select drisl_extract(payload, '.variant.$type') as event_type from event
    )
    -- admin already set - reject admin.add (only one admin allowed)
    select unauthorized('admin already set')
    where (select admin from stream_info) is not null
      and (select event_type from event_info) = 'space.roomy.space.addAdmin.v0';
  
    with event_info as (
      select drisl_extract(payload, '.variant.$type') as event_type from event
    )
    -- other events must be from admin
    select unauthorized('not authorized')
    where (select admin from stream_info) is not null
      and (select event_type from event_info) is not 'space.roomy.space.addAdmin.v0'
      and (select drisl_extract(payload, '.variant.author') from event) is not (select admin from stream_info);
  `,
  materializer: `
    -- Set admin from admin.add event
    update stream_info
    set admin = (select drisl_extract(payload, '.variant.userId') from event)
    where (select drisl_extract(payload, '.variant.$type') from event) = 'space.roomy.space.addAdmin.v0';
  `,
  queries: [
    {
      name: "stream_info",
      sql: `select * from stream_info;`,
      params: [],
    },
    {
      name: "events",
      sql: `
        select unauthorized('only the stream creator can read its events')
          where $requesting_user != (select admin from stream_info);

        select idx, user, payload from events.events
          where idx >= $start limit $limit;
      `,
      params: [],
    },
  ],
};

export const spaceModule: BasicModule = {
  $type: "muni.town.leaf.module.basic.v0" as const,
  initSql: `
    create table if not exists stream_info (
      type text not null default 'space.roomy.stream.space',
      schema_version text not null default '2'
    );
    
    insert into stream_info (type) select 'space.roomy.stream.space' 
      where not exists (select 1 from stream_info);
      
    create table if not exists admins (
      user_id text primary key
    );
  `,
  authorizer: `
    with event_info as (
      select 
        drisl_extract(payload, '.variant.$type') as event_type,
        user as author
      from event
    ),
    admin_count as (
      select count(*) as cnt from admins
    )
    -- Case 1: No admins yet - only allow admin.add (bootstrap)
    select unauthorized('space not initialized - need admin.add')
    where (select cnt from admin_count) = 0
      and (select event_type from event_info) is not 'space.roomy.space.addAdmin.v0';

    with event_info as (
      select 
        drisl_extract(payload, '.variant.$type') as event_type,
        user as author
      from event
    ),
    admin_count as (
      select count(*) as cnt from admins
    )
    -- Case 2: Admins exist - author must be an admin for admin management
    select unauthorized('must be admin to manage admins')
    where (select cnt from admin_count) > 0
      and (select event_type from event_info) in ('space.roomy.space.addAdmin.v0', 'space.roomy.space.removeAdmin.v0')
      and not exists (select 1 from admins where user_id = (select author from event_info));

    with event_info as (
      select 
        drisl_extract(payload, '.variant.$type') as event_type,
        user as author
      from event
    ),
    admin_count as (
      select count(*) as cnt from admins
    )
    -- Case 3: For other events, also require admin (adjust this based on your needs)
    -- You might want different rules for members vs admins here
    select unauthorized('not authorized')
    where (select cnt from admin_count) > 0
      and (select event_type from event_info) not in ('space.roomy.space.addAdmin.v0', 'space.roomy.space.removeAdmin.v0')
      and not exists (select 1 from admins where user_id = (select author from event_info));
  `,
  materializer: `
    -- Add admin
    insert or ignore into admins (user_id)
    select drisl_extract(payload, '.variant.userId') from event
    where drisl_extract(payload, '.variant.$type') = 'space.roomy.space.addAdmin.v0';

    -- Remove admin
    delete from admins
    where user_id = (select drisl_extract(payload, '.variant.userId') from event)
      and (select drisl_extract(payload, '.variant.$type') from event) = 'space.roomy.space.removeAdmin.v0';
    
  `,
  queries: [
    {
      name: "stream_info",
      sql: `select * from stream_info;`,
      params: [],
    },
    {
      name: "events",
      sql: `
        select id, user, payload from events.events
          where id >= $start limit $limit;
      `,
      params: [],
    },
  ],
};

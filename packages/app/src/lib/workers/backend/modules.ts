import { LeafClient } from "@muni-town/leaf-client";

export const personalModule = LeafClient.encodeBasicModule({
  init_sql: `
    create table if not exists stream_info as select
      (select creator from stream) as creator, 
      'space.roomy.stream.personal' as type,
      '2' as schema_version;
  `,
  authorizer: `
    select unauthorized("Only stream owner can add events")
      where (select creator from stream_info) != (select user from event);
  `,
  materializer: ``,
  queries: [
    {
      name: "stream_info",
      sql: `select * from stream_info;`,
      limits: [],
      params: [],
    },
    {
      name: "events",
      sql: `
        select unauthorized('only the strema creator can read its events')
          where $requesting_user != (select creator from stream_info);

        select id, user, payload from events.events
          where id >= $start limit $limit;
      `,
      limits: [],
      params: [],
    },
  ],
});
console.info("Personal module ID:", personalModule.moduleId);

export const spaceModule = LeafClient.encodeBasicModule({
  init_sql: `
    create table if not exists stream_info as select
      (select creator from stream) as creator, 
      'space.roomy.stream.space' as type,
      '2' as schema_version;
  `,
  authorizer: ``,
  materializer: ``,
  queries: [
    {
      name: "stream_info",
      sql: `select * from stream_info;`,
      limits: [],
      params: [],
    },
    {
      name: "events",
      sql: `
        select id, user, payload from events.events
          where id >= $start limit $limit;
      `,
      limits: [],
      params: [],
    },
  ],
});
console.info("Space module ID:", spaceModule.moduleId);

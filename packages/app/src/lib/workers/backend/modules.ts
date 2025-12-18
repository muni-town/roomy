import { LeafClient } from "@muni-town/leaf-client";

export const personalModuleDef = {
  $type: "space.roomy.module.basic.0" as const,
  def: {
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
        params: [],
      },
      {
        name: "events",
        sql: `
        select unauthorized('only the stream creator can read its events')
          where $requesting_user != (select creator from stream_info);

        select id, user, payload from events.events
          where id >= $start limit $limit;
      `,
        params: [],
      },
    ],
  },
};
export const personalModule = await LeafClient.encodeModule(personalModuleDef);
console.info("Personal module ID:", personalModule.moduleCid);

export const spaceModuleDef = {
  $type: "space.roomy.module.basic.0" as const,
  def: {
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
  },
};
export const spaceModule = await LeafClient.encodeModule(spaceModuleDef);
console.info("Space module ID:", spaceModule.moduleCid);

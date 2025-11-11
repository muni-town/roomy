import { page } from "$app/state";
import { LiveQuery } from "./liveQuery.svelte";
import { sql } from "./utils/sqlTemplate";
import { backend, backendStatus } from "./workers";
import { id } from "./workers/encoding";

export type SpaceMeta = {
  id: string;
  name?: string;
  avatar?: string;
  handle_account?: string;
  handle?: string;
  description?: string;
  permissions: [string, "read" | "post" | "admin"][];
};

export type SpaceTreeItem = {
  id: string;
  name: string;
  parent?: string;
} & (
  | {
      type: "category";
      children: (ChannelTreeItem | PageTreeItem)[];
    }
  | {
      type: "channel";
      children?: (ThreadTreeItem | PageTreeItem)[];
    }
  | {
      type: "thread";
      children?: PageTreeItem[];
    }
  | {
      type: "page";
    }
);

type ChannelTreeItem = Extract<SpaceTreeItem, { type: "channel" }>;
type ThreadTreeItem = Extract<SpaceTreeItem, { type: "thread" }>;
type PageTreeItem = Extract<SpaceTreeItem, { type: "page" }>;

/** The space list. */
let spacesQuery: LiveQuery<SpaceMeta>;
export let spaces: { list: SpaceMeta[] } = $state({ list: [] });

/** The sidebar tree for the currently selected space. */
export let spaceTree: LiveQuery<SpaceTreeItem>;

export let current = $state({
  space: undefined as SpaceMeta | undefined,
  roomId: undefined as string | undefined,
  isSpaceAdmin: false,
});

// All of our queries have to be made in the scope of an effect root but we can't export them from
// within the scope.
$effect.root(() => {
  spacesQuery = new LiveQuery(
    () => sql`-- spaces
      select json_object(
          'id', id(cs.entity),
          'name', ci.name,
          'avatar', ci.avatar,
          'description', ci.description,
          'handle_account', cs.handle_account,
          'permissions', (
            select json_group_array(
              json_array(id(cu.did), json_extract(e.payload, '$.can')))
            from edges e 
            join comp_user cu on cu.did = e.tail
            where e.head = cs.entity and e.label = 'member'
        )) as json
      from comp_space cs
      join comp_info ci on cs.entity = ci.entity
      join entities e on e.id = cs.entity
      where e.stream_id = ${backendStatus.personalStreamId && id(backendStatus.personalStreamId)} 
        and hidden = 0
    `,
    (row) => JSON.parse(row.json),
  );

  //
  // was in above query json bit --'admins', (select json_group_array(admin_id) from space_admins where space_id = id)

  spaceTree = new LiveQuery(
    () => sql`-- spaceTree
      select json_object(
        'id', id(e.id),
        'name', i.name,
        'type', 'category',
        'children', (
          select json_group_array(
            json_object(
              'id', id(c1.id),
              'type', case
                when r1.label = 'channel' then 'channel'
                when r1.label = 'page' then 'page'
              end,
              'parent', id(c1.parent),
              'name', i1.name,
              'children', (
                select json_group_array(
                  json_object(
                    'id', id(c2.id),
                    'type', case
                      when r2.label = 'thread' then 'thread'
                      when r2.label = 'page' then 'page'
                    end,
                    'parent', id(c2.parent),
                    'name', i2.name
                  )
                )
                from entities c2
                  join comp_room r2 on c2.id = r2.entity
                  join comp_info i2 on c2.id = i2.entity
                where c2.parent = c1.id
              )
            )
          )
          from entities c1
            join comp_room r1 on c1.id = r1.entity
            join comp_info i1 on c1.id = i1.entity
          where c1.parent = e.id
        )
      ) as json
      from entities e
        join comp_room r on e.id = r.entity
        join comp_info i on e.id = i.entity
      where
        e.stream_id = ${current.space?.id && id(current.space.id)}
        and r.label = 'category'
      
      union
      
      select json_object(
        'id', id(e.id),
        'name', i.name,
        'type', 'channel',
        'parent', id(e.parent),
        'children', (
          select json_group_array(
            json_object(
              'id', id(c.id),
              'type', case
                when r1.label = 'thread' then 'thread'
                when r1.label = 'page' then 'page'
              end,
              'parent', id(c.parent),
              'name', i1.name
            )
          )
          from entities c
            join comp_room r1 on c.id = r1.entity
            join comp_info i1 on c.id = i1.entity
          where c.parent = e.id
        )
      ) as json
      from entities e
        join comp_room r on e.id = r.entity
        join comp_info i on e.id = i.entity
      where
        e.stream_id = ${current.space?.id && id(current.space.id)}
        and r.label = 'channel'
        and e.parent is null
      
      union
      
      select json_object(
        'id', id(e.id),
        'name', i.name,
        'type', 'page',
        'parent', id(e.parent)
      ) as json
      from entities e
        join comp_room r on e.id = r.entity
        join comp_info i on e.id = i.entity
      where
        e.stream_id = ${current.space?.id && id(current.space.id)}
        and r.label = 'page'
        and e.parent is null
  `,
    (row) => row.json && JSON.parse(row.json),
  );

  // Update spaces list, loading the space handle if it has one.
  $effect(() => {
    Promise.all(
      spacesQuery.result?.map(async (x) => ({
        ...x,
        handle: x.handle_account
          ? await backend.resolveHandleForSpace(x.id, x.handle_account)
          : undefined,
      })) || [],
    ).then((s) => (spaces.list = s));
  });

  // Update the current.space
  $effect(() => {
    if (page.params.space) {
      spacesQuery.result;
      if (page.params.space.includes(".")) {
        // Resolve the space handle to a space ID
        backend
          .resolveSpaceFromHandleOrDid(page.params.space)
          .then(async (resp) => {
            if (!resp) return undefined;
            // Get the matching space locally
            const matchingSpace = resp.spaceId
              ? spacesQuery.result?.find((x) => x.id == resp.spaceId)
              : undefined;

            // Make sure that the space actually has a handle
            const handleAccount = matchingSpace?.handle_account;
            if (!handleAccount) return;

            // Validate that the DID of the handle matches our handle account
            if (handleAccount != resp.handleDid) return undefined;

            current.space = matchingSpace;
          });
      } else {
        current.space = page.params.space
          ? spacesQuery.result?.find((x) => x.id == page.params.space)
          : undefined;
      }
    }
  });
  // Update current.isSpaceAdmin
  $effect(() => {
    if (backendStatus.did) {
      current.isSpaceAdmin =
        current.space?.permissions?.some(
          (permission) =>
            permission[0] === backendStatus.did && permission[1] === "admin",
        ) || false;
    }
  });

  // Update current.roomId
  $effect(() => {
    current.roomId = page.params.object;
  });
});

import { page } from "$app/state";
import { LiveQuery } from "./liveQuery.svelte";
import { sql } from "./utils/sqlTemplate";
import { backendStatus } from "./workers";
import { id } from "./workers/encoding";

export type SpaceMeta = {
  id: string;
  name?: string;
  avatar?: string;
  description?: string;
  permissions: [string, "read" | "post" | "admin"][];
};

export type SpaceTreeItem = { id: string; name: string } & (
  | {
      type: "category";
      children: SpaceTreeItem[];
    }
  | {
      type: "channel";
    }
);

/** The space list. */
export let spaces: LiveQuery<SpaceMeta>;

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
  spaces = new LiveQuery(
    () => sql`-- spaces
      select json_object(
          'id', id(cs.entity),
          'name', ci.name,
          'avatar', ci.avatar,
          'description', ci.description,
          'rooms', (select json_group_array(json_object(
            'id', id(cr.entity),
            'type', cr.label
          )) from comp_room cr where cr.parent = cs.entity),
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
              'id', id(e.id),
              'type', 'channel',
              'parent', id(e.parent),
              'name', inf.name
            )
          )
          from entities e
            join comp_room room on e.id = room.entity
            join comp_info inf on e.id = inf.entity
          where
            e.parent = r.entity
              and
            room.label = 'channel'
        )
      ) as json
      from entities e
        join comp_room r on e.id = r.entity
        join comp_info i on e.id = i.entity
      where
        e.stream_id = ${current.space?.id && id(current.space.id)}
          and
        r.label = 'category' 
    union
      select json_object(
        'id', id(e.id),
        'name', i.name,
        'type', 'channel',
        'parent', id(e.parent)
      ) as json
      from entities e
        join comp_room r on e.id = r.entity
        join comp_info i on e.id = i.entity
      where
        e.stream_id = ${current.space?.id && id(current.space.id)}
          and
        r.label = 'channel'
          and
        e.parent is null
  `,
    (row) => row.json && JSON.parse(row.json),
  );

  // Update current values
  $effect(() => {
    // console.log("Checking current space for ", page.params.space)
    current.space = page.params.space
      ? spaces.result?.find((x) => x.id == page.params.space)
      : undefined;
  });
  $effect(() => {
    if (backendStatus.did) {
      current.isSpaceAdmin =
        current.space?.permissions?.some(
          (permission) =>
            permission[0] === backendStatus.did && permission[1] === "admin",
        ) || false;
    }
  });
  $effect(() => {
    current.roomId = page.params.object;
  });
});

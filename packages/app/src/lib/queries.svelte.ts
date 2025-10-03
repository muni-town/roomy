import { page } from "$app/state";
import { LiveQuery } from "./liveQuery.svelte";
import { sql } from "./utils/sqlTemplate";
import { backendStatus } from "./workers";
import { Hash } from "./workers/encoding";

export type SpaceMeta = {
  id: string;
  ulid: string;
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
  isSpaceAdmin: false,
});

// All of our queries have to be made in the scope of an effect root but we can't export them from
// within the scope.
$effect.root(() => {
  spaces = new LiveQuery(
    () => sql`-- spaces
      select json_object(
          'id', format_hash(cs.leaf_space_hash_id),
          'ulid', format_ulid(cs.entity),
          'name', ci.name,
          'avatar', ci.avatar,
          'description', ci.description,
          'rooms', (select json_group_array(json_object(
            'id', format_ulid(cr.entity),
            'type', cr.label
          )) from comp_room cr where cr.parent = cs.entity),
          'permissions', (
            select json_group_array(
              json_array(cu.did, json_extract(e.payload, '$.can')))
            from edges e 
            join comp_user cu on cu.entity = e.tail
            where e.head = cs.entity and e.label = 'member'
        )) as json
      from comp_space cs
      join comp_info ci on cs.entity = ci.entity
      where personal_stream_hash_id = ${backendStatus.personalStreamId && Hash.enc(backendStatus.personalStreamId)} 
        and hidden = 0
    `,
    (row) => JSON.parse(row.json),
  );

  console.log("personalStreamId", backendStatus.personalStreamId);
  console.log("Spaces", spaces.result);

  //
  // was in above query json bit --'admins', (select json_group_array(admin_id) from space_admins where space_id = id)

  spaceTree = new LiveQuery(
    () => sql`-- spaceTree
    select json_object(
      'id', format_ulid(e.ulid),
      'name', i.name,
      'type', 'category',
      'children', (
        select json_group_array(
          json_object(
            'id', format_ulid(e.ulid),
            'type', 'channel',
            'name', inf.name
          )
        )
        from entities e
          join comp_room cat on e.ulid = cat.entity
          join comp_info inf on e.ulid = inf.entity
        where e.parent = c.entity
      )
    ) as json
    from entities e
      join comp_room c on e.ulid = c.entity
      join comp_info i on e.ulid = i.entity
    where e.stream_hash_id = ${current.space?.id && Hash.enc(current.space?.id)}
    union
    select json_object(
      'id', format_ulid(e.ulid),
      'name', i.name,
      'type', 'channel',
      'parent', format_ulid(e.parent)
    ) as json
    from entities e
      join comp_room c on e.ulid = c.entity
      join comp_info i on e.ulid = i.entity
    where e.stream_hash_id = ${backendStatus.personalStreamId && Hash.enc(backendStatus.personalStreamId)} 
      and 
    e.parent is null`,
    (row) => row.json && JSON.parse(row.json),
  );

  console.log("spaceTree", spaceTree.result);

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
});

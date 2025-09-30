import { page } from "$app/state";
import { LiveQuery } from "./liveQuery.svelte";
import { sql } from "./utils/sqlTemplate";
import { backendStatus } from "./workers";
import { Hash } from "./workers/encoding";

export type SpaceMeta = {
  id: string;
  name?: string;
  avatar?: string;
  description?: string;
  admins: string[];
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
        'id', format_hash(id),
        'name', name,
        'avatar', avatar,
        'description', description,
        'admins', (select json_group_array(admin_id) from space_admins where space_id = id)
      ) as json
      from comp_space
      where stream = ${backendStatus.personalStreamId && Hash.enc(backendStatus.personalStreamId)}
        and
      hidden = 0
    `,
    (row) => JSON.parse(row.json),
  );

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
          join comp_channel cat on e.ulid = cat.entity
          join comp_info inf on e.ulid = inf.entity
        where e.parent = c.entity
      )
    ) as json
    from entities e
      join comp_category c on e.ulid = c.entity
      join comp_info i on e.ulid = i.entity
    where stream = ${current.space?.id && Hash.enc(current.space?.id)}
    union
    select json_object(
      'id', format_ulid(e.ulid),
      'name', i.name,
      'type', 'channel',
      'parent', format_ulid(e.parent)
    ) as json
    from entities e
      join comp_channel c on e.ulid = c.entity
      join comp_info i on e.ulid = i.entity
    where
      stream = ${current.space?.id && Hash.enc(current.space?.id)}
        and
      e.parent is null`,
    (row) => row.json && JSON.parse(row.json),
  );

  // Update current values
  $effect(() => {
    current.space = page.params.space
      ? spaces.result?.find((x) => x.id == page.params.space)
      : undefined;
  });
  $effect(() => {
    if (backendStatus.did)
      current.isSpaceAdmin =
        current.space?.admins.includes(backendStatus.did) || false;
  });
});

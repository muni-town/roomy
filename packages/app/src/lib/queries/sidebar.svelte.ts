import { LiveQuery } from "$lib/utils/liveQuery.svelte";
import { current } from "./current.svelte";
import { sql } from "$lib/utils/sqlTemplate";
import type { SidebarCategory } from "./types";

export let categoriesQuery: LiveQuery<{
  name: string;
  children: { id: string; name: string }[];
}>;

/** The sidebar tree for the currently selected space. */
export const sidebar = $state<{ result?: SidebarCategory[] }>({
  result: undefined,
});
(globalThis as any).sidebar = sidebar;

$effect.root(() => {
  // sidebar uses a custom live query that processes all rows into a tree structure
  categoriesQuery = new LiveQuery(
    () => {
      const spaceId = current.joinedSpace?.id;
      return sql`
        select json_object(
          'name', categories.value -> 'name',
          'children', case when count(children.value) > 0 
            then json_group_array(
              json_object(
                'name', child_info.name,
                'id', child_info.entity
              )
              ORDER BY children.key  -- preserve child order
            )
            else json('[]')
            end
        ) as json
        from
          comp_space space,
          json_each(space.sidebar_config -> 'categories') as categories
        left join json_each(categories.value -> 'children') as children
        left join comp_info child_info on child_info.entity = children.value
        left join comp_room child_room on child_room.entity = children.value
        where space.entity = ${spaceId}
          and (child_room.entity is null or child_room.deleted != 1)
        group by categories.key, categories.value -> 'name'  -- include key in group
        order by categories.key  -- preserve category order
      `;
    },
    (row) => JSON.parse(row.json),
  );

  // Convert categories query to expected sidebar items structure
  $effect(() => {
    if (!current.joinedSpace || categoriesQuery.current.status === "loading")
      return;
    // console.debug("categories", $state.snapshot(categoriesQuery.result));
    if (categoriesQuery.result) {
      sidebar.result = categoriesQuery.result.map(
        (x, i) =>
          ({
            type: "space.roomy.category",
            // Add an index to the ID to prevent Svelte key errors when there are two categories
            // with the same name.
            id: x.name + '-' + i, 
            name: x.name,
            lastRead: 0,
            latestEntity: 0,
            sortIdx: "",
            unreadCount: 0,
            children: x.children.map((x) => ({
              type: "space.roomy.channel",
              id: x.id,
              name: x.name,
              lastRead: 0,
              latestEntity: 0,
              sortIdx: "",
              unreadCount: 0,
            })),
          }) satisfies SidebarCategory,
      );
    } else {
      sidebar.result = undefined;
    }
  });
});

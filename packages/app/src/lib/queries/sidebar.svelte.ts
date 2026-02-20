import { createContext } from "svelte";
import { LiveQuery } from "$lib/utils/liveQuery.svelte";
import { current } from "./current.svelte";
import { sql } from "$lib/utils/sqlTemplate";
import type { SidebarCategory } from "./types";
import { newUlid, type Ulid } from "@roomy/sdk";

export class SidebarState {
  categories = $state<SidebarCategory[] | undefined>(undefined);
  orphanChannels = $state<{ id: Ulid; name: string }[] | undefined>(undefined);
  categoriesQuery: LiveQuery<{
    id: string | null;
    name: string;
    children: { id: Ulid; name: string }[];
  }>;

  constructor() {
    // sidebar uses a custom live query that processes all rows into a tree structure
    this.categoriesQuery = new LiveQuery(
      () => {
        const spaceId = current.joinedSpace?.id;
        return sql`
          select json_object(
            'id', categories.value -> 'id',
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

    // A query for all channels, used to calculate the orphaned channels list.
    const allChannelsQuery = new LiveQuery<{ id: Ulid; name: string }>(
      () => sql`
      select id, name from entities e
      join comp_room r on e.id = r.entity
      join comp_info i on e.id = i.entity
      where
        label = 'space.roomy.channel'
          and
        e.stream_id = ${current.space.status == "joined" ? current.space.space.id : null};
    `,
    );

    // Convert categories query to expected sidebar items structure
    $effect(() => {
      if (!current.joinedSpace || this.categoriesQuery.current.status === "loading")
        return;
      if (this.categoriesQuery.result) {
        let allChannelIds = new Set(
          allChannelsQuery.result?.map((x) => x.id) || [],
        );
        let pinnedChannelIds = new Set();
        let cats = this.categoriesQuery.result.map((x) => {
          // Deduplicate children by id (data may have duplicates from bridge sync)
          const seen = new Set<string>();
          const uniqueChildren = x.children.filter((c) => {
            pinnedChannelIds.add(c.id);
            if (seen.has(c.id)) return false;
            seen.add(c.id);
            return true;
          });

          return {
            type: "space.roomy.category",
            // If no ulid (old schema) just create one.
            id: (x.id as Ulid) ?? newUlid(),
            name: x.name,
            lastRead: 0,
            latestEntity: 0,
            sortIdx: "",
            unreadCount: 0,
            children: uniqueChildren.map((x) => ({
              type: "space.roomy.channel",
              id: x.id,
              name: x.name,
              lastRead: 0,
              latestEntity: 0,
              sortIdx: "",
              unreadCount: 0,
            })),
          } satisfies SidebarCategory;
        });

        let orphanChannels = allChannelIds.difference(pinnedChannelIds);

        // Make sure we have a default category if there are none.
        if (!cats.length) {
          cats = [
            {
              id: newUlid(),
              type: "space.roomy.category",
              name: "general",
              lastRead: 0,
              latestEntity: 0,
              sortIdx: "",
              unreadCount: 0,
              children: [],
            },
          ];
        }

        // Format the orphans as sidebar items.
        const orphans = [...orphanChannels]
          .map((id) => allChannelsQuery.result?.find((x) => x.id == id))
          .filter((x) => !!x)
          .map(({ id, name }) => {
            let item: SidebarCategory["children"][number] = {
              id,
              name,
              type: "space.roomy.channel",
              lastRead: 0,
              latestEntity: 0,
              sortIdx: "",
              unreadCount: 0,
            };
            return item;
          });

        // Add the orphans, if any, to the first category
        if (orphans.length > 0) {
          cats = cats.map((category, i) => ({
            ...category,
            children:
              i == 0 ? [...category.children, ...orphans] : category.children,
          }));
        }

        // Assign once to avoid read-write cycle in $effect
        this.categories = cats;
        // TODO: remove orphanChannels since we are not using it anymore.
        this.orphanChannels = undefined;
      } else {
        this.categories = undefined;
        this.orphanChannels = undefined;
      }
    });
  }
}

export const [getSidebar, setSidebar] = createContext<SidebarState>();

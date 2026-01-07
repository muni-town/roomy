import { LiveQuery } from "$lib/utils/liveQuery.svelte";
import { decodeTime } from "ulidx";
import type { SidebarItem } from "./types";
import { current } from "./current.svelte";
import { sql } from "$lib/utils/sqlTemplate";

let flatTreeQuery: LiveQuery<{
  id: string;
  parent: string | null;
  type:
    | "space.roomy.category"
    | "space.roomy.channel"
    | "space.roomy.thread"
    | "space.roomy.page";
  name: string;
  lastRead: number;
  latestEntity: string | null;
  unreadCount: number;
  depth: number;
  sortIdx: string;
}>;

/** The sidebar tree for the currently selected space. */
export const sidebar = $state<{ result?: SidebarItem[] }>({
  result: undefined,
});
(globalThis as any).sidebar = sidebar;

/**
 * Build a tree structure from flat SQL results.
 * The SQL query returns all rooms in a flat list with parent references.
 * This function reconstructs the hierarchical tree structure.
 */
function buildTree(
  rows: Array<{
    id: string;
    parent: string | null;
    type:
      | "space.roomy.category"
      | "space.roomy.channel"
      | "space.roomy.thread"
      | "space.roomy.page";
    name: string;
    lastRead: number;
    latestEntity: string | null;
    unreadCount: number;
    depth: number;
    sortIdx: string;
  }>,
): SidebarItem[] {
  if (!rows || rows.length === 0) return [];

  // Build a map of id -> node for quick lookups
  // Using any here because TypeScript can't track the dynamic children types properly
  const nodeMap = new Map<string, any>();

  // First pass: create all nodes
  for (const row of rows) {
    const node: any = {
      id: row.id,
      name: row.name,
      parent: row.parent || undefined,
      type: row.type,
      lastRead: row.lastRead,
      latestEntity: row.latestEntity ? decodeTime(row.latestEntity) : undefined,
      unreadCount: row.unreadCount,
      sortIdx: row.sortIdx,
    };

    // Add children array for non-page types
    if (row.type !== "space.roomy.page") {
      node.children = [];
    }

    nodeMap.set(row.id, node);
  }

  // Second pass: build parent-child relationships
  const rootNodes: SidebarItem[] = [];

  for (const row of rows) {
    const node = nodeMap.get(row.id)!;

    if (row.parent) {
      const parent = nodeMap.get(row.parent);
      if (parent && parent.children) {
        parent.children.push(node);
      } else {
        // Orphaned room: parent doesn't exist or is deleted, show as top-level
        rootNodes.push(node);
      }
    } else {
      // Top-level node
      rootNodes.push(node);
    }
  }

  rootNodes.sort((a, b) => (a.sortIdx < b.sortIdx ? -1 : 1));

  return rootNodes;
}

$effect.root(() => {
  // sidebar uses a custom live query that processes all rows into a tree structure
  //   flatTreeQuery = new LiveQuery(() => {
  //     const spaceId = current.joinedSpace?.id;
  //     return sql`-- sidebar (recursive CTE)
  //     with recursive room_tree as (
  //       -- Base case: top-level rooms (categories, channels, pages without parents)
  //       select
  //         e.id,
  //         e.parent,
  //         r.label as type,
  //         i.name,
  //         coalesce(l.timestamp, 1) as lastRead,
  //         (select max(id) from entities where parent = e.id) as latestEntity,
  //         coalesce(l.unread_count, 0) as unreadCount,
  //         0 as depth,
  //         e.sort_idx as sortIdx
  //       from entities e
  //         join comp_room r on e.id = r.entity
  //         join comp_info i on e.id = i.entity
  //         left join comp_last_read l on e.id = l.entity
  //       where e.stream_id = ${spaceId}
  //         and e.parent is null
  //         and (r.deleted = 0 or r.deleted is null)

  //       union all

  //       -- Base case: orphaned rooms (rooms whose parent rooms are deleted or don't exist)
  //       select
  //         e.id,
  //         e.parent,
  //         r.label as type,
  //         i.name,
  //         coalesce(l.timestamp, 1) as lastRead,
  //         (select max(id) from entities where parent = e.id) as latestEntity,
  //         coalesce(l.unread_count, 0) as unreadCount,
  //         0 as depth,
  //         e.sort_idx as sortIdx
  //       from entities e
  //         join comp_room r on e.id = r.entity
  //         join comp_info i on e.id = i.entity
  //         left join comp_last_read l on e.id = l.entity
  //         left join comp_room parent_room on parent_room.entity = e.parent
  //       where e.stream_id = ${spaceId}
  //         and e.parent is not null
  //         and (r.deleted = 0 or r.deleted is null)
  //         and (parent_room.entity is null or parent_room.deleted = 1)

  //       union all

  //       -- TODO: Remove this section: we currently have a bug that is causing rooms to be created
  //       -- with the wrong stream ID from the read events in the personal stream, but this is a fine
  //       -- workaround until that is fixed.
  //       --
  //       -- Base case: rooms with parents in the correct stream (handle stream_id mismatches)
  //       -- This catches rooms that have a different stream_id but whose parent is in the correct stream
  //       select
  //         e.id,
  //         e.parent,
  //         r.label as type,
  //         i.name,
  //         coalesce(l.timestamp, 1) as lastRead,
  //         (select max(id) from entities where parent = e.id) as latestEntity,
  //         coalesce(l.unread_count, 0) as unreadCount,
  //         0 as depth,
  //         e.sort_idx as sortIdx
  //       from entities e
  //         join comp_room r on e.id = r.entity
  //         join comp_info i on e.id = i.entity
  //         left join comp_last_read l on e.id = l.entity
  //         join entities parent_e on parent_e.id = e.parent
  //       where parent_e.stream_id = ${spaceId}
  //         and e.parent is not null
  //         and (r.deleted = 0 or r.deleted is null)
  //         and e.stream_id != ${spaceId}
  //         -- Make sure parent exists and is not deleted
  //         and exists (
  //           select 1 from comp_room parent_r
  //           where parent_r.entity = e.parent
  //           and (parent_r.deleted = 0 or parent_r.deleted is null)
  //         )

  //       union all

  //       -- Recursive case: children of rooms
  //       select
  //         e.id,
  //         e.parent,
  //         r.label as type,
  //         i.name,
  //         coalesce(l.timestamp, 1) as lastRead,
  //         (select max(id) from entities where parent = e.id) as latestEntity,
  //         coalesce(l.unread_count, 0) as unreadCount,
  //         rt.depth + 1 as depth,
  //         e.sort_idx as sortIdx
  //       from entities e
  //         join comp_room r on e.id = r.entity
  //         join comp_info i on e.id = i.entity
  //         left join comp_last_read l on e.id = l.entity
  //         join room_tree rt on e.parent = rt.id
  //       where (r.deleted = 0 or r.deleted is null)
  //     )
  //     select
  //       id,
  //       parent,
  //       type,
  //       name,
  //       lastRead,
  //       latestEntity,
  //       unreadCount,
  //       depth,
  //       sortIdx
  //     from room_tree
  //     order by depth, type, sortIdx
  // `;
  //   });
  flatTreeQuery = {} as any;

  // Build tree structure reactively from flat results
  $effect(() => {
    if (flatTreeQuery.result) {
      sidebar.result = buildTree(flatTreeQuery.result);
    } else {
      sidebar.result = undefined;
    }
  });
});

import { page } from "$app/state";
import { decodeTime } from "ulidx";
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
  lastRead: number;
  latestEntity: number;
  unreadCount: number;
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
export let spaceTree: LiveQuery<SpaceTreeItem> | { result?: SpaceTreeItem[] } =
  $state({ result: undefined });

export let current = $state({
  space: undefined as SpaceMeta | undefined,
  roomId: undefined as string | undefined,
  isSpaceAdmin: false,
});

/**
 * Build a tree structure from flat SQL results.
 * The SQL query returns all rooms in a flat list with parent references.
 * This function reconstructs the hierarchical tree structure.
 */
function buildTree(
  rows: Array<{
    id: string;
    parent: string | null;
    type: "category" | "channel" | "thread" | "page";
    name: string;
    lastRead: number;
    latestEntity: string | null;
    unreadCount: number;
    depth: number;
  }>,
): SpaceTreeItem[] {
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
    };

    // Add children array for non-page types
    if (row.type !== "page") {
      node.children = [];
    }

    nodeMap.set(row.id, node);
  }

  // Second pass: build parent-child relationships
  const rootNodes: SpaceTreeItem[] = [];

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

  rootNodes.sort((a, b) => decodeTime(a.id) - decodeTime(b.id));

  return rootNodes;
}

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

  // spaceTree uses a custom live query that processes all rows into a tree structure
  const flatTreeQuery = new LiveQuery<{
    id: string;
    parent: string | null;
    type: "category" | "channel" | "thread" | "page";
    name: string;
    lastRead: number;
    latestEntity: string | null;
    unreadCount: number;
    depth: number;
  }>(() => {
    const spaceId = current.space?.id && id(current.space.id);
    return sql`-- spaceTree (recursive CTE)
      with recursive room_tree as (
        -- Base case: top-level rooms (categories, channels, pages without parents)
        select 
          e.id,
          e.parent,
          r.label as type,
          i.name,
          coalesce(l.timestamp, 1) as lastRead,
          (select max(id) from entities where parent = e.id) as latestEntity,
          coalesce(l.unread_count, 0) as unreadCount,
          0 as depth
        from entities e
          join comp_room r on e.id = r.entity
          join comp_info i on e.id = i.entity
          left join comp_last_read l on e.id = l.entity
        where e.stream_id = ${spaceId}
          and e.parent is null
          and (r.deleted = 0 or r.deleted is null)
        
        union all
        
        -- Base case: orphaned rooms (rooms whose parent rooms are deleted or don't exist)
        select 
          e.id,
          e.parent,
          r.label as type,
          i.name,
          coalesce(l.timestamp, 1) as lastRead,
          (select max(id) from entities where parent = e.id) as latestEntity,
          coalesce(l.unread_count, 0) as unreadCount,
          0 as depth
        from entities e
          join comp_room r on e.id = r.entity
          join comp_info i on e.id = i.entity
          left join comp_last_read l on e.id = l.entity
          left join comp_room parent_room on parent_room.entity = e.parent
        where e.stream_id = ${spaceId}
          and e.parent is not null
          and (r.deleted = 0 or r.deleted is null)
          and (parent_room.entity is null or parent_room.deleted = 1)
        
        union all
        
        -- TODO: Remove this section: we currently have a bug that is causing rooms to be created
        -- with the wrong stream ID from the read events in the personal stream, but this is a fine
        -- workaround until that is fixed.
        --
        -- Base case: rooms with parents in the correct stream (handle stream_id mismatches)
        -- This catches rooms that have a different stream_id but whose parent is in the correct stream
        select 
          e.id,
          e.parent,
          r.label as type,
          i.name,
          coalesce(l.timestamp, 1) as lastRead,
          (select max(id) from entities where parent = e.id) as latestEntity,
          coalesce(l.unread_count, 0) as unreadCount,
          0 as depth
        from entities e
          join comp_room r on e.id = r.entity
          join comp_info i on e.id = i.entity
          left join comp_last_read l on e.id = l.entity
          join entities parent_e on parent_e.id = e.parent
        where parent_e.stream_id = ${spaceId}
          and e.parent is not null
          and (r.deleted = 0 or r.deleted is null)
          and e.stream_id != ${spaceId}
          -- Make sure parent exists and is not deleted
          and exists (
            select 1 from comp_room parent_r 
            where parent_r.entity = e.parent 
            and (parent_r.deleted = 0 or parent_r.deleted is null)
          )
        
        union all
        
        -- Recursive case: children of rooms
        select 
          e.id,
          e.parent,
          r.label as type,
          i.name,
          coalesce(l.timestamp, 1) as lastRead,
          (select max(id) from entities where parent = e.id) as latestEntity,
          coalesce(l.unread_count, 0) as unreadCount,
          rt.depth + 1 as depth
        from entities e
          join comp_room r on e.id = r.entity
          join comp_info i on e.id = i.entity
          left join comp_last_read l on e.id = l.entity
          join room_tree rt on e.parent = rt.id
        where e.stream_id = ${spaceId}
          and (r.deleted = 0 or r.deleted is null)
      )
      select 
        id(id) as id,
        id(parent) as parent,
        type,
        name,
        lastRead,
        id(latestEntity) as latestEntity,
        unreadCount,
        depth
      from room_tree
      order by depth, type, name
  `;
  });

  // Build tree structure reactively from flat results
  $effect(() => {
    if (flatTreeQuery.result) {
      console.log("flatTree", flatTreeQuery.result);
      spaceTree.result = buildTree(flatTreeQuery.result);
    } else {
      spaceTree.result = undefined;
    }
  });

  // Update spaces list, loading the space handle if it has one.
  $effect(() => {
    Promise.all(
      spacesQuery.result?.map(async (x) => ({
        ...x,
        handle: x.handle_account
          ? await backend.resolveHandleForSpace(x.id, x.handle_account)
          : undefined,
      })) || [],
    ).then((s) => {
      spaces.list = s;
    });
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

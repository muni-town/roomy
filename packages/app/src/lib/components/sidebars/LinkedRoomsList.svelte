<script lang="ts">
  import { page } from "$app/state";
  import type { Ulid } from "@roomy-space/sdk";
  import { navigateSync } from "$lib/utils.svelte";
  import { LiveQuery } from "$lib/utils/liveQuery.svelte";
  import { sql } from "$lib/utils/sqlTemplate";
  import LinkedRoomList, {
    type LinkedRoom,
  } from "@roomy/design/components/sidebars/LinkedRoomList.svelte";
  import { getAppState } from "$lib/queries";
  import { flags } from "$lib/config";

  const app = getAppState();

  let {
    roomId = $bindable(),
  }: {
    roomId: Ulid;
  } = $props();

  const spaceDid = $derived(app.joinedSpace?.id);

  let query = new LiveQuery<{
    name: string;
    id: Ulid;
    unreadCount: number;
    lastRead: number;
  }>(
    () => sql`
      SELECT ci.name, room.entity as id, MAX(m.id) as last_message_id,
        coalesce(lr.unread_count, 0) as unreadCount,
        coalesce(lr.last_read, 0) as lastRead
      FROM entities parent_e
      JOIN edges link ON link.head = parent_e.id AND link.label = 'link'
      JOIN comp_room room ON link.tail = room.entity
      JOIN comp_info ci ON ci.entity = room.entity
      LEFT JOIN entities m ON m.room = room.entity
      LEFT JOIN comp_last_read lr ON lr.entity = room.entity
      WHERE parent_e.stream_id = ${spaceDid}
        AND parent_e.id = ${roomId}
      GROUP BY room.entity, ci.name
      ORDER BY last_message_id DESC
      LIMIT 5
    `,
  );

  let linkedRooms = $state<LinkedRoom[]>([]);
  $effect(() => {
    if (query.result) {
      linkedRooms = query.result;
    }
  });

  function hrefFor(id: string): string {
    return (
      navigateSync({
        space: page.params.space!,
        object: id as Ulid,
      }) +
      "?parent=" +
      (page.url.searchParams.get("parent") || page.params.object)
    );
  }
</script>

<LinkedRoomList
  rooms={linkedRooms}
  currentRoomId={page.params.object}
  showUnreadCount={flags.unreadNotifications}
  {hrefFor}
/>

<script lang="ts">
  import { peer } from "$lib/workers";
  import { LiveQuery } from "$lib/utils/liveQuery.svelte";
  import { sql } from "$lib/utils/sqlTemplate";
  import PermissionEditor, {
    type PermissionRole,
  } from "@roomy/design/components/ui/PermissionEditor.svelte";
  import type { StreamDid, Ulid } from "@roomy-space/sdk";

  type Role = PermissionRole & {
    rooms: { roomId: string; permission: string }[];
  };

  let {
    spaceId,
    roomId = undefined,
    accessMode = $bindable("open"),
    rolePermissions = $bindable({}),
    defaultAccess = $bindable<"readwrite" | "read" | "none">("readwrite"),
  }: {
    spaceId: StreamDid;
    roomId?: Ulid;
    accessMode: "open" | "roles";
    rolePermissions: Record<string, "none" | "read" | "readwrite">;
    defaultAccess: "readwrite" | "read" | "none";
  } = $props();

  let roles = $state<Role[] | null>(null);
  let rolesLoading = $state(false);

  $effect(() => {
    accessMode = defaultAccess === "readwrite" ? "open" : "roles";
  });

  const roomAccessQuery = roomId
    ? new LiveQuery<{ default_access: string }>(
        () => sql`
          select default_access from comp_room where entity = ${roomId}
        `,
        (row) => row,
        { description: "room default access", origin: "ChannelPermissions" },
      )
    : null;

  $effect(() => {
    const row = roomAccessQuery?.result?.[0];
    if (row?.default_access) {
      defaultAccess = row.default_access as "readwrite" | "read" | "none";
    }
  });

  $effect(() => {
    if (defaultAccess === "readwrite" || roles !== null || rolesLoading) return;
    rolesLoading = true;
    peer
      .getRoles(spaceId)
      .then((fetched) => {
        roles = fetched;
        for (const role of fetched) {
          const existing = roomId
            ? role.rooms.find((rm) => rm.roomId === roomId)
            : undefined;
          rolePermissions[role.id] = existing?.permission ?? "none";
        }
      })
      .catch(console.error)
      .finally(() => {
        rolesLoading = false;
      });
  });
</script>

<PermissionEditor
  bind:defaultAccess
  bind:rolePermissions
  {roles}
  {rolesLoading}
/>

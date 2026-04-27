<script lang="ts">
  import { peer } from "$lib/workers";
  import { LiveQuery } from "$lib/utils/liveQuery.svelte";
  import { sql } from "$lib/utils/sqlTemplate";
  import ToggleGroup from "$lib/components/ui/ToggleGroup.svelte";
  import { IconLoading } from "@roomy/design/icons";
  import type { StreamDid, Ulid } from "@roomy-space/sdk";

  type Role = { id: string; name: string | null; rooms: { roomId: string; permission: string }[] };

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

  // In edit mode, load the current default_access from comp_room
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

<div class="flex flex-col gap-4">
  <div class="flex items-center justify-between gap-4">
    <span class="text-sm font-medium text-base-900 dark:text-base-100 shrink-0">
      Members
    </span>
    <ToggleGroup
      name="members-permission"
      bind:value={defaultAccess}
      options={[
        { label: "None", value: "none" },
        { label: "Read", value: "read" },
        { label: "Read & Write", value: "readwrite" },
      ]}
    />
  </div>

  {#if defaultAccess === "readwrite"}
    <p class="text-sm text-base-400 italic">
      Channel permissions can be set for specific roles when they are limited for general members.
    </p>
  {:else if rolesLoading}
    <IconLoading class="animate-spin" font-size={20} />
  {:else if roles !== null && roles.length === 0}
    <p class="text-sm text-base-400 italic">
      No roles configured. Create roles in Space Settings → Roles.
    </p>
  {:else if roles !== null}
    <div class="flex flex-col gap-3">
      {#each roles as role}
        <div class="flex items-center justify-between gap-4">
          <span
            class="text-sm font-medium text-base-900 dark:text-base-100 shrink-0"
          >
            {role.name ?? "Unnamed role"}
          </span>
          <ToggleGroup
            name="role-{role.id}"
            bind:value={rolePermissions[role.id]}
            options={[
              { label: "None", value: "none" },
              { label: "Read", value: "read" },
              { label: "Read & Write", value: "readwrite" },
            ]}
          />
        </div>
      {/each}
    </div>
  {/if}
</div>

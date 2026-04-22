<script lang="ts">
  import { peer } from "$lib/workers";
  import ToggleGroup from "$lib/components/ui/ToggleGroup.svelte";
  import { IconLoading } from "@roomy/design/icons";
  import type { StreamDid, Ulid } from "@roomy-space/sdk";

  type Role = { id: string; name: string | null };

  let {
    spaceId,
    roomId = undefined,
    accessMode = $bindable("open"),
    rolePermissions = $bindable({}),
  }: {
    spaceId: StreamDid;
    roomId?: Ulid;
    accessMode: "open" | "roles";
    rolePermissions: Record<string, "none" | "read" | "readwrite">;
  } = $props();

  let roles = $state<Role[] | null>(null);
  let rolesLoading = $state(false);

  $effect(() => {
    // In edit mode, load immediately to detect existing permissions.
    // In create mode, load only when the user switches to "roles" access.
    if ((accessMode !== "roles" && !roomId) || roles !== null || rolesLoading) return;
    rolesLoading = true;
    peer
      .getRoles(spaceId)
      .then((fetched) => {
        roles = fetched;
        let hasExistingPermission = false;
        for (const role of fetched) {
          const existing = roomId
            ? role.rooms.find((rm) => rm.roomId === roomId)
            : undefined;
          rolePermissions[role.id] = existing?.permission ?? "none";
          if (existing) hasExistingPermission = true;
        }
        if (hasExistingPermission) accessMode = "roles";
      })
      .catch(console.error)
      .finally(() => {
        rolesLoading = false;
      });
  });
</script>

<div class="flex flex-col gap-4">
  <div>
    <p class="block text-sm/6 font-medium text-base-900 dark:text-base-100 mb-2">
      Access
    </p>
    <ToggleGroup
      name="accessMode"
      bind:value={accessMode}
      options={[
        { label: "Open to all members", value: "open" },
        { label: "Specific roles only", value: "roles" },
      ]}
    />
  </div>

  {#if accessMode === "roles"}
    {#if rolesLoading}
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
  {/if}
</div>

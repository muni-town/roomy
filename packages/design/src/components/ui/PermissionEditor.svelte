<script lang="ts" module>
  export type PermissionRole = {
    id: string;
    name: string | null;
  };
  export type Permission = "none" | "read" | "readwrite";
</script>

<script lang="ts">
  import ToggleGroup from "./toggle-group/ToggleGroup.svelte";
  import { IconLoading } from "../../icons/index";

  let {
    defaultAccess = $bindable("readwrite"),
    rolePermissions = $bindable({}),
    roles,
    rolesLoading = false,
    ceiling = "readwrite",
  }: {
    defaultAccess: Permission;
    rolePermissions: Record<string, Permission>;
    /** Roles list — null while not yet fetched. */
    roles: PermissionRole[] | null;
    rolesLoading?: boolean;
    /** Highest grantable permission. Below "readwrite" the Read & Write
     *  option renders disabled on every toggle — a federated channel's
     *  origin grants the receiving space at most this level. */
    ceiling?: "read" | "readwrite";
  } = $props();

  const OPTIONS: { label: string; value: Permission; disabled?: boolean }[] = [
    { label: "None", value: "none" },
    { label: "Read", value: "read" },
    {
      label: "Read & Write",
      value: "readwrite",
      disabled: ceiling !== "readwrite",
    },
  ];
</script>

<div class="flex flex-col gap-5">
  <div class="flex items-center justify-between">
    <span class="text-md font-regular text-base-900 dark:text-base-100 shrink-0">
      Members
    </span>
    <ToggleGroup
      name="members-permission"
      bind:value={defaultAccess}
      options={OPTIONS}
    />
  </div>

  {#if defaultAccess === "readwrite"}
    <p class="text-sm text-base-400">
      You can't manage this channel's role permissions without revoking Read & Write access to Members.
    </p>
  {:else if rolesLoading}
    <IconLoading class="animate-spin" font-size={20} />
  {:else if roles !== null && roles.length === 0}
    <p class="text-sm text-base-400">
      No roles configured. Create roles in <b>Space Settings -> Roles</b>.
    </p>
  {:else if roles !== null}
    <div class="flex flex-col">
      {#each roles as role}
        <div class="flex items-center justify-between gap-4">
          <span
            class="text-md font-regular text-base-900 dark:text-base-100 shrink-0"
          >
            {role.name ?? "Unnamed role"}
          </span>
          <ToggleGroup
            name="role-{role.id}"
            bind:value={rolePermissions[role.id]}
            options={OPTIONS}
          />
        </div>
      {/each}
    </div>
  {/if}
</div>

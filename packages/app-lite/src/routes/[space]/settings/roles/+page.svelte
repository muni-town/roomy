<script lang="ts">
  import { page } from "$app/state";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import RoleCreateForm from "@roomy/design/components/modals/RoleCreateForm.svelte";
  import RoleEditForm from "@roomy/design/components/modals/RoleEditForm.svelte";
  import UserTypeahead from "@roomy/design/components/ui/user-typeahead/UserTypeahead.svelte";
  import type { TypeaheadUser } from "@roomy/design/components/ui/user-typeahead/UserTypeahead.svelte";
  import { createRolesQuery, type Role } from "$lib/queries/roles";
  import { createMembersQuery } from "$lib/queries/members";
  import { createSpaceMetadataQuery } from "$lib/queries/space-metadata";
  import { createRole, updateRole, deleteRole, addMemberRole, removeMemberRole } from "$lib/mutations/role";
  import UserAvatar from "@roomy/design/components/user/UserAvatar.svelte";
  import {
    IconLoading,
    IconTrash,
    IconHashtag,
    IconPencil,
    IconArrowLeft,
    IconEllipsisHorizontal,
    IconPlus,
  } from "@roomy/design/icons";
  import Popover from "@roomy/design/components/ui/popover/Popover.svelte";

  const spaceId = $derived(page.params.space!);

  const metaQuery = createSpaceMetadataQuery(() => spaceId);
  const isAdmin = $derived(metaQuery.data?.isAdmin ?? false);

  const rolesQuery = createRolesQuery(() => spaceId);
  const membersQuery = createMembersQuery(() => spaceId);

  const spaceMembers = $derived.by<TypeaheadUser[]>(() => {
    return (membersQuery.data?.members ?? []).map((m) => ({
      did: m.did,
      handle: m.handle,
      name: m.name,
      avatar: m.avatar,
    }));
  });

  const roles = $derived(rolesQuery.data?.roles ?? []);

  let selectedRoleId = $state<string | null>(null);
  const selectedRole = $derived(
    selectedRoleId ? (roles.find((r) => r.id === selectedRoleId) ?? null) : null
  );
  let createOpen = $state(false);
  let creating = $state(false);
  let editOpen = $state(false);
  let isDeleting = $state(false);
  let menuOpen = $state(false);

  // selectedRole is now derived from selectedRoleId above,
  // so it stays in sync with query refetches automatically
  // without writing $state inside $effect (which caused
  // effect_update_depth_exceeded).

  async function onCreate(name: string, description: string) {
    creating = true;
    try {
      await createRole(spaceId, { name, description });
      createOpen = false;
    } finally {
      creating = false;
    }
  }

  async function onSaveEdit(name: string, description: string) {
    if (!selectedRole) return;
    try {
      await updateRole(spaceId, { roleId: selectedRole.id, name, description });
      editOpen = false;
    } catch (e) {
      console.error("Failed to update role", e);
    }
  }

  async function onDelete() {
    if (!selectedRole) return;
    if (!confirm(`Delete role "${selectedRole.name ?? selectedRole.id}"?`)) return;
    isDeleting = true;
    try {
      await deleteRole(spaceId, selectedRole.id);
      selectedRoleId = null;
    } catch (e) {
      console.error("Failed to delete role", e);
    } finally {
      isDeleting = false;
    }
  }

  async function addMember(user: TypeaheadUser) {
    if (!selectedRole) return;
    try {
      await addMemberRole(spaceId, { roleId: selectedRole.id, userDid: user.did });
    } catch (e) {
      console.error("Failed to add member", e);
    }
  }

  async function removeMember(did: string) {
    if (!selectedRole) return;
    try {
      await removeMemberRole(spaceId, { roleId: selectedRole.id, userDid: did });
    } catch (e) {
      console.error("Failed to remove member", e);
    }
  }

  function getMemberInfo(did: string): TypeaheadUser {
    return spaceMembers.find((m) => m.did === did) ?? { did };
  }

  function displayName(user: TypeaheadUser) {
    return user.name || user.handle || user.did;
  }

  /** Build a quick room-name map from the sidebar data for channel permission display */
  const roomNames = $derived.by(() => {
    const meta = metaQuery.data;
    if (!meta?.sidebar) return new Map<string, string>();
    const map = new Map<string, string>();
    for (const cat of meta.sidebar.categories ?? []) {
      for (const ch of cat.channels ?? []) {
        map.set(ch.id, ch.name ?? ch.id);
      }
    }
    for (const ch of meta.sidebar.orphans ?? []) {
      map.set(ch.id, ch.name ?? ch.id);
    }
    return map;
  });
</script>

<div class="min-h-full">
  {#if selectedRole}
    {#key selectedRoleId}
      <div class="space-y-6">
        <Button variant="ghost" class="justify-start" onclick={() => (selectedRoleId = null)}>
          <IconArrowLeft class="size-4" />
          Roles
        </Button>

        <div class="flex items-start justify-between gap-4">
          <div>
            <h2 class="text-xl/7 font-bold text-base-900 dark:text-base-100">
              {selectedRole.name ?? "Unnamed role"}
            </h2>
            {#if selectedRole.description}
              <p class="text-sm text-base-500 dark:text-base-400 mt-1">
                {selectedRole.description}
              </p>
            {/if}
          </div>
          {#if isAdmin}
            <Popover bind:open={menuOpen} side="bottom" sideOffset={6} align="end" class="p-1 w-40">
              {#snippet child({ props })}
                <Button variant="ghost" size="icon" {...props}>
                  <IconEllipsisHorizontal class="size-4" />
                  <span class="sr-only">Role actions</span>
                </Button>
              {/snippet}
              <button
                class="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm font-medium text-base-800 dark:text-base-200 hover:bg-base-100 dark:hover:bg-base-800 transition-colors text-left"
                onclick={() => { menuOpen = false; editOpen = true; }}
              >
                <IconPencil class="size-4 shrink-0 text-base-500" />
                Edit
              </button>
              <button
                class="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors text-left"
                onclick={() => { menuOpen = false; onDelete(); }}
                disabled={isDeleting}
              >
                {#if isDeleting}
                  <IconLoading class="size-4 shrink-0 animate-spin" />
                {:else}
                  <IconTrash class="size-4 shrink-0" />
                {/if}
                Delete
              </button>
            </Popover>
          {/if}
        </div>

        <!-- Members -->
        <div class="space-y-3">
          <h3 class="text-sm font-semibold text-base-700 dark:text-base-300">
            Members
          </h3>

          {#if selectedRole.memberDids.length > 0}
            <ul class="flex flex-col gap-0.5">
              {#each selectedRole.memberDids as did}
                {@const member = getMemberInfo(did)}
                <li
                  class="flex items-center gap-3 rounded-2xl px-3 py-2 hover:bg-base-50 dark:hover:bg-base-800/60 group"
                >
                  <UserAvatar
                    src={member.avatar}
                    name={member.did}
                    size={28}
                    class="size-7 shrink-0 rounded-full"
                  />
                  <span class="text-sm font-medium text-base-900 dark:text-base-100 truncate">
                    {displayName(member)}
                  </span>
                  {#if member.handle && member.name}
                    <span class="text-xs text-base-400 truncate">@{member.handle}</span>
                  {/if}
                  <span class="flex-1" />
                  {#if isAdmin}
                    <button
                      class="text-xs text-base-400 hover:text-red-500 dark:hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity px-2 py-1 rounded-xl"
                      onclick={() => removeMember(did)}
                      aria-label="Remove {displayName(member)} from this role"
                    >
                      Remove
                    </button>
                  {/if}
                </li>
              {/each}
            </ul>
          {:else}
            <p class="text-sm text-base-400 py-1">
              No members yet. Add someone below.
            </p>
          {/if}

          {#if isAdmin}
            <UserTypeahead
              users={spaceMembers}
              excluded={selectedRole.memberDids}
              onSelect={addMember}
              placeholder="Add member..."
            />
          {/if}
        </div>

        <!-- Channel permissions -->
        <div class="space-y-3">
          <h3 class="text-sm font-semibold text-base-700 dark:text-base-300">
            Channel permissions
          </h3>
          {#if selectedRole.rooms.length > 0}
            <ul class="flex flex-col gap-1">
              {#each selectedRole.rooms as room}
                <li
                  class="flex items-center justify-between gap-3 rounded-2xl px-3 py-2 hover:bg-base-50 dark:hover:bg-base-800/60"
                >
                  <span class="flex items-center gap-1.5 text-sm text-base-700 dark:text-base-300 truncate">
                    <IconHashtag class="size-3.5 shrink-0 text-base-400" />
                    {roomNames.get(room.roomId) ?? room.roomId.slice(0, 8)}
                  </span>
                  <span
                    class="text-xs shrink-0 rounded-2xl px-2.5 py-0.5 bg-base-200/70 dark:bg-base-700/50 text-base-600 dark:text-base-300 font-medium"
                  >
                    {room.permission === "readwrite" ? "read and write" : room.permission}
                  </span>
                </li>
              {/each}
            </ul>
          {:else}
            <p class="text-sm text-base-400 py-1">
              No channel permissions configured for this role.
            </p>
          {/if}
        </div>
      </div>
    {/key}
  {:else}
    <div class="space-y-6">
      <div class="flex items-start justify-between gap-4">
        <div>
          <h2 class="text-xl/7 font-bold text-base-900 dark:text-base-100">
            Roles
          </h2>
          <p class="text-sm text-base-500 dark:text-base-400 mt-1">
            Roles control access to channels in your space.
          </p>
        </div>
        {#if isAdmin}
          <Button variant="secondary" size="icon" onclick={() => (createOpen = true)}>
            <IconPlus class="size-4" />
            <span class="sr-only">Create role</span>
          </Button>
        {/if}
      </div>

      {#if rolesQuery.isPending && roles.length === 0}
        <IconLoading class="animate-spin" font-size={40} />
      {:else if roles.length > 0}
        <ul class="flex flex-col gap-0.5">
          {#each roles as role (role.id)}
            <li>
              <button
                class="w-full flex items-center gap-3 rounded-2xl px-4 py-2.5 hover:bg-base-50 dark:hover:bg-base-800/60 text-left transition-colors"
                onclick={() => (selectedRoleId = role.id)}
              >
                <span class="font-medium text-base-900 dark:text-base-100 flex-1">
                  {role.name}
                </span>
                <span class="text-xs text-base-400">
                  {role.memberDids.length}
                  {role.memberDids.length === 1 ? "member" : "members"}
                </span>
                <span class="text-base-300 dark:text-base-600 text-sm">›</span>
              </button>
            </li>
          {/each}
        </ul>
      {:else if !rolesQuery.isPending}
        <p class="text-sm text-base-400 py-2">
          You are not a member of any roles.
        </p>
      {/if}
    </div>
  {/if}
</div>

<RoleCreateForm bind:open={createOpen} {creating} onCreate={onCreate} />
{#key selectedRoleId}
  {#if selectedRole}
    <RoleEditForm bind:open={editOpen} role={selectedRole} onSave={onSaveEdit} />
  {/if}
{/key}
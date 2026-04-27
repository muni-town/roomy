<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { getAppState } from "$lib/queries";
  import { Button, toast } from "@foxui/core";
  import { peer } from "$lib/workers";
  import { newUlid, Ulid, UserDid } from "@roomy-space/sdk";
  import { IconLoading, IconTrash, IconHashtag, IconPencil, IconArrowLeft, IconEllipsisHorizontal, IconPlus } from "@roomy/design/icons";
  import Popover from "$lib/components/ui/popover/Popover.svelte";
  import RoleModal from "$lib/components/modals/RoleModal.svelte";
  import CreateRoleModal from "$lib/components/modals/CreateRoleModal.svelte";
  import UserTypeahead from "$lib/components/ui/UserTypeahead.svelte";
  import EntityName from "$lib/components/helper/EntityName.svelte";
  import type { TypeaheadUser } from "$lib/components/ui/UserTypeahead.svelte";
  import { Avatar } from "bits-ui";
  import { AvatarBeam } from "svelte-boring-avatars";

  const app = getAppState();

  $effect(() => {
    if (app.space.status === "joined" && !app.space.isSpaceAdmin) {
      goto(`/${page.params.space}`);
    }
  });

  const spaceId = $derived(app.joinedSpace?.id);

  type Role = {
    id: string;
    name: string | null;
    avatar: string | null;
    description: string | null;
    rooms: { roomId: string; permission: "read" | "readwrite" }[];
    members: string[];
  };

  let roles = $state<Role[] | undefined>(undefined);
  let rolesLoading = $state(false);
  let selectedRole = $state<Role | null>(null);
  let createModalOpen = $state(false);
  let editModalOpen = $state(false);
  let isDeleting = $state(false);
  let menuOpen = $state(false);

  let spaceMembers = $state<TypeaheadUser[]>([]);

  async function loadRoles() {
    if (!spaceId) return;
    rolesLoading = true;
    try {
      roles = await peer.getRoles(spaceId);
      if (selectedRole) {
        selectedRole = roles.find((r) => r.id === selectedRole?.id) ?? null;
      }
    } finally {
      rolesLoading = false;
    }
  }

  async function loadSpaceMembers() {
    if (!spaceId) return;
    spaceMembers = await peer.getMembers(spaceId);
  }

  $effect(() => {
    if (spaceId) {
      loadRoles();
      loadSpaceMembers();
    }
  });

  async function deleteRole(role: Role) {
    if (!spaceId) return;
    isDeleting = true;
    try {
      await peer.sendEvent(spaceId, {
        id: newUlid(),
        $type: "space.roomy.role.deleteRole.v0",
        roleId: Ulid.assert(role.id),
      });
      selectedRole = null;
      await loadRoles();
    } catch (e) {
      toast.error("Failed to delete role");
      console.error(e);
    } finally {
      isDeleting = false;
    }
  }

  async function addMember(user: TypeaheadUser) {
    if (!spaceId || !selectedRole) return;
    try {
      await peer.sendEvent(spaceId, {
        id: newUlid(),
        $type: "space.roomy.role.addMemberRole.v0",
        roleId: Ulid.assert(selectedRole.id),
        userDid: UserDid.assert(user.did),
      });
      await loadRoles();
    } catch (e) {
      toast.error("Failed to add member");
      console.error(e);
    }
  }

  async function removeMember(did: string) {
    if (!spaceId || !selectedRole) return;
    try {
      await peer.sendEvent(spaceId, {
        id: newUlid(),
        $type: "space.roomy.role.removeMemberRole.v0",
        roleId: Ulid.assert(selectedRole.id),
        userDid: UserDid.assert(did),
      });
      await loadRoles();
    } catch (e) {
      toast.error("Failed to remove member");
      console.error(e);
    }
  }

  function getMemberInfo(did: string): TypeaheadUser {
    return spaceMembers.find((m) => m.did === did) ?? { did };
  }

  function displayName(user: TypeaheadUser) {
    return user.name || user.handle || user.did;
  }
</script>

<div class="space-y-6 pt-4 min-h-full">
  {#if selectedRole}
    <div class="space-y-6">
      <Button variant="ghost" onclick={() => (selectedRole = null)} class="justify-start">
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
        <Popover bind:open={menuOpen} side="bottom" sideOffset={6} align="end" class="p-1 w-40">
          {#snippet child({ props })}
            <Button variant="ghost" size="icon" {...props}>
              <IconEllipsisHorizontal class="size-4" />
              <span class="sr-only">Role actions</span>
            </Button>
          {/snippet}
          <button
            class="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm font-medium text-base-800 dark:text-base-200 hover:bg-base-100 dark:hover:bg-base-800 transition-colors text-left"
            onclick={() => { menuOpen = false; editModalOpen = true; }}
          >
            <IconPencil class="size-4 shrink-0 text-base-500" />
            Edit
          </button>
          <button
            class="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors text-left"
            onclick={() => { menuOpen = false; selectedRole && deleteRole(selectedRole); }}
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
      </div>

      <div class="space-y-3">
        <h3 class="text-sm font-semibold text-base-700 dark:text-base-300">
          Members
        </h3>

        {#if selectedRole.members.length > 0}
          <ul class="flex flex-col gap-0.5">
            {#each selectedRole.members as did}
              {@const member = getMemberInfo(did)}
              <li
                class="flex items-center gap-3 rounded-2xl px-3 py-2 hover:bg-base-50 dark:hover:bg-base-800/60 group"
              >
                <Avatar.Root class="size-7 shrink-0 rounded-full">
                  <Avatar.Image src={member.avatar} class="rounded-full" />
                  <Avatar.Fallback>
                    <AvatarBeam name={member.did} size={28} />
                  </Avatar.Fallback>
                </Avatar.Root>
                <span class="text-sm font-medium text-base-900 dark:text-base-100 flex-1 truncate">
                  {displayName(member)}
                </span>
                {#if member.handle && member.name}
                  <span class="text-xs text-base-400">@{member.handle}</span>
                {/if}
                <button
                  class="text-xs text-base-400 hover:text-red-500 dark:hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity px-2 py-1 rounded-xl"
                  onclick={() => removeMember(did)}
                  aria-label={`Remove ${displayName(member)} from this role`}
                >
                  Remove
                </button>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="text-sm text-base-400 py-1">
            No members yet. Add someone below.
          </p>
        {/if}

        <UserTypeahead
          users={spaceMembers}
          excluded={selectedRole.members}
          onSelect={addMember}
          placeholder="Add member..."
        />
      </div>

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
                  <EntityName id={Ulid.assert(room.roomId)} />
                </span>
                <span
                  class="text-xs shrink-0 rounded-2xl px-2.5 py-0.5 bg-base-200/70 dark:bg-base-700/50 text-base-600 dark:text-base-300 font-medium"
                >
                  {room.permission}
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
  {:else}
    <div class="space-y-6">
      <div class="flex items-start justify-between gap-4">
        <div>
          <h2 class="text-xl/7 font-bold text-base-900 dark:text-base-100">
            Roles
          </h2>
          <p class="text-sm text-base-500 dark:text-base-400 mt-1">
            Create and manage roles to control access to channels in your space.
          </p>
        </div>
        <Button variant="secondary" size="icon" onclick={() => (createModalOpen = true)}>
          <IconPlus class="size-4" />
          <span class="sr-only">Create role</span>
        </Button>
      </div>

      {#if rolesLoading && roles === undefined}
        <IconLoading class="animate-spin" font-size={40} />
      {:else if roles && roles.length > 0}
        <ul class="flex flex-col gap-0.5">
          {#each roles as role}
            <li>
              <button
                class="w-full flex items-center gap-3 rounded-2xl px-4 py-2.5 hover:bg-base-50 dark:hover:bg-base-800/60 text-left transition-colors"
                onclick={() => (selectedRole = role)}
              >
                <span class="font-medium text-base-900 dark:text-base-100 flex-1">
                  {role.name}
                </span>
                <span class="text-xs text-base-400">
                  {role.members.length}
                  {role.members.length === 1 ? "member" : "members"}
                </span>
                <span class="text-base-300 dark:text-base-600 text-sm">›</span>
              </button>
            </li>
          {/each}
        </ul>
      {:else if roles !== undefined}
        <p class="text-sm text-base-400 py-2">
          No roles yet. Use the + button to create one.
        </p>
      {/if}
    </div>
  {/if}
</div>

<CreateRoleModal bind:open={createModalOpen} onCreated={loadRoles} />
<RoleModal bind:open={editModalOpen} role={selectedRole} onSaved={loadRoles} />

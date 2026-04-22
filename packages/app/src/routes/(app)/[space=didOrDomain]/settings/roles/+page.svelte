<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { getAppState } from "$lib/queries";
  import { Button, Input, toast } from "@foxui/core";
  import { peer } from "$lib/workers";
  import { newUlid, Ulid, UserDid } from "@roomy-space/sdk";
  import { IconLoading, IconTrash } from "@roomy/design/icons";
  import RoleModal from "$lib/components/modals/RoleModal.svelte";
  import UserTypeahead from "$lib/components/ui/UserTypeahead.svelte";
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
  let roleName = $state("");
  let isCreating = $state(false);
  let selectedRole = $state<Role | null>(null);
  let editModalOpen = $state(false);
  let isDeleting = $state(false);

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

  async function createRole() {
    if (!spaceId || !roleName.trim()) return;
    isCreating = true;
    try {
      await peer.sendEvent(spaceId, {
        id: newUlid(),
        $type: "space.roomy.role.createRole.v0",
        name: roleName.trim(),
      });
      roleName = "";
      await loadRoles();
    } catch (e) {
      toast.error("Failed to create role");
      console.error(e);
    } finally {
      isCreating = false;
    }
  }

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

<div class="space-y-6 pt-4 overflow-y-auto">
  {#if selectedRole}
    <div class="space-y-6">
      <div class="flex items-center gap-3">
        <button
          class="text-sm text-base-500 hover:text-base-700 dark:hover:text-base-300 flex items-center gap-1"
          onclick={() => (selectedRole = null)}
        >
          ← Roles
        </button>
      </div>

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
          <!-- <p class="text-xs text-base-400 font-mono mt-1">{selectedRole.id}</p> -->
        </div>
        <div class="flex gap-2 shrink-0">
          <Button onclick={() => (editModalOpen = true)} variant="secondary">
            Edit
          </Button>
          <Button
            variant="red"
            onclick={() => selectedRole && deleteRole(selectedRole)}
            disabled={isDeleting}
          >
            {#if isDeleting}
              <IconLoading class="animate-spin mr-2" />
            {:else}
              <IconTrash class="size-4 mr-2" />
            {/if}
            Delete
          </Button>
        </div>
      </div>

      <div class="space-y-3">
        <h3
          class="text-sm font-semibold text-base-700 dark:text-base-300 uppercase tracking-wide"
        >
          Members
        </h3>

        {#if selectedRole.members.length > 0}
          <ul class="flex flex-col gap-1">
            {#each selectedRole.members as did}
              {@const member = getMemberInfo(did)}
              <li
                class="flex items-center gap-3 rounded-xl px-3 py-2 hover:bg-base-50 dark:hover:bg-base-800 group"
              >
                <Avatar.Root class="size-7 shrink-0 rounded-full">
                  <Avatar.Image src={member.avatar} class="rounded-full" />
                  <Avatar.Fallback>
                    <AvatarBeam name={member.did} size={28} />
                  </Avatar.Fallback>
                </Avatar.Root>
                <span
                  class="text-sm font-medium text-base-900 dark:text-base-100 flex-1 truncate"
                >
                  {displayName(member)}
                </span>
                {#if member.handle && member.name}
                  <span class="text-xs text-base-400">@{member.handle}</span>
                {/if}
                <button
                  class="text-base-400 hover:text-red-500 dark:hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity ml-auto text-xs shrink-0"
                  onclick={() => removeMember(did)}
                  aria-label="Remove member"
                >
                  Remove
                </button>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="text-sm text-base-400 italic">
            No members assigned to this role.
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
        <h3
          class="text-sm font-semibold text-base-700 dark:text-base-300 uppercase tracking-wide"
        >
          Channel permissions
        </h3>
        {#if selectedRole.rooms.length > 0}
          <ul class="flex flex-col gap-2">
            {#each selectedRole.rooms as room}
              <li
                class="flex items-center justify-between gap-3 bg-base-50 dark:bg-base-800 rounded px-3 py-1.5"
              >
                <span
                  class="text-sm font-mono text-base-700 dark:text-base-300 truncate"
                  >{room.roomId}</span
                >
                <span
                  class="text-xs shrink-0 rounded-full px-2 py-0.5 bg-base-200 dark:bg-base-700 text-base-600 dark:text-base-300"
                >
                  {room.permission}
                </span>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="text-sm text-base-400 italic">
            No channel permissions configured.
          </p>
        {/if}
      </div>
    </div>
  {:else}
    <div class="space-y-6">
      <h2 class="text-xl/7 font-bold text-base-900 dark:text-base-100">
        Roles
      </h2>
      <p class="text-sm text-base-500 dark:text-base-400">
        Create and manage roles to control access to channels and features in
        your space.
      </p>

      <div class="flex items-center gap-3">
        <Input
          bind:value={roleName}
          placeholder="Role name"
          class="max-w-xs"
          onkeydown={(e) => e.key === "Enter" && createRole()}
        />
        <Button onclick={createRole} disabled={isCreating || !roleName.trim()}>
          {#if isCreating}
            <IconLoading class="animate-spin mr-2" />
          {/if}
          Create Role
        </Button>
      </div>

      {#if rolesLoading && roles === undefined}
        <IconLoading class="animate-spin" font-size={40} />
      {:else if roles && roles.length > 0}
        <ul class="flex flex-col gap-2">
          {#each roles as role}
            <li>
              <button
                class="w-full flex items-center gap-3 rounded-lg border border-base-200 dark:border-base-700 px-4 py-2 hover:bg-base-50 dark:hover:bg-base-800 text-left cursor-pointer"
                onclick={() => (selectedRole = role)}
              >
                <span class="font-medium text-base-900 dark:text-base-100"
                  >{role.name}</span
                >
                <!-- <span class="text-xs text-base-400 font-mono">{role.id}</span> -->
              </button>
            </li>
          {/each}
        </ul>
      {:else if roles !== undefined}
        <p class="text-sm text-base-400 italic">No roles created yet.</p>
      {/if}
    </div>
  {/if}
</div>

<RoleModal bind:open={editModalOpen} role={selectedRole} onSaved={loadRoles} />

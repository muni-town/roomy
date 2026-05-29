<script lang="ts">
  import { page } from "$app/state";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import RoleCreateForm from "@roomy/design/components/modals/RoleCreateForm.svelte";
  import RoleEditForm from "@roomy/design/components/modals/RoleEditForm.svelte";
  import { createRolesQuery, type Role } from "$lib/queries/roles";
  import { createRole, updateRole, deleteRole } from "$lib/mutations/role";

  const spaceId = $derived(page.params.space!);
  const rolesQuery = createRolesQuery(() => spaceId);

  let createOpen = $state(false);
  let creating = $state(false);
  let editOpen = $state(false);
  let editTarget = $state<Role | null>(null);
  let saving = $state(false);

  async function onCreate(name: string, description: string) {
    creating = true;
    try {
      await createRole(spaceId, { name, description });
      createOpen = false;
    } finally {
      creating = false;
    }
  }

  function openEdit(role: Role) {
    editTarget = role;
    editOpen = true;
  }

  async function onSaveEdit(name: string, description: string) {
    if (!editTarget) return;
    saving = true;
    try {
      await updateRole(spaceId, { roleId: editTarget.id, name, description });
      editOpen = false;
      editTarget = null;
    } finally {
      saving = false;
    }
  }

  async function onDelete(role: Role) {
    if (!confirm(`Delete role "${role.name ?? role.id}"?`)) return;
    await deleteRole(spaceId, role.id);
  }
</script>

<div class="max-w-2xl">
  <div class="flex items-center justify-between mb-3">
    <h2 class="text-base font-semibold">Roles</h2>
    <Button onclick={() => (createOpen = true)}>New role</Button>
  </div>

  {#if rolesQuery.isPending}
    <p class="text-sm text-base-400">Loading…</p>
  {:else if rolesQuery.isError}
    <p class="text-sm text-red-600">{rolesQuery.error.message}</p>
  {:else if rolesQuery.data}
    {@const roles = rolesQuery.data.roles}
    {#if roles.length === 0}
      <p class="text-sm text-base-400">No roles defined.</p>
    {:else}
      <ul class="space-y-2">
        {#each roles as role (role.id)}
          <li class="flex items-center justify-between p-3 rounded-2xl border border-base-200 dark:border-base-800 bg-white dark:bg-base-900">
            <div class="min-w-0">
              <div class="font-medium text-sm truncate">{role.name ?? "(unnamed)"}</div>
              {#if role.description}
                <div class="text-xs text-base-500 truncate">{role.description}</div>
              {/if}
              <div class="text-[11px] text-base-400 mt-0.5">
                {role.memberDids.length} member{role.memberDids.length === 1 ? "" : "s"}
              </div>
            </div>
            <div class="flex gap-1 shrink-0">
              <Button variant="ghost" size="sm" onclick={() => openEdit(role)}>Edit</Button>
              <Button variant="ghost" size="sm" onclick={() => onDelete(role)}>Delete</Button>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>

<RoleCreateForm bind:open={createOpen} {creating} onCreate={onCreate} />
<RoleEditForm bind:open={editOpen} role={editTarget} {saving} onSave={onSaveEdit} />

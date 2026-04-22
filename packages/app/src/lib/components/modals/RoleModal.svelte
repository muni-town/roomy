<script lang="ts">
  import { Modal, Button, Input, toast } from "@foxui/core";
  import { peer } from "$lib/workers";
  import { getAppState } from "$lib/queries";
  import { newUlid, Ulid } from "@roomy-space/sdk";
  import { IconLoading, IconSave } from "@roomy/design/icons";

  const app = getAppState();

  let {
    open = $bindable(false),
    role,
    onSaved,
  }: {
    open: boolean;
    role: {
      id: string;
      name: string | null;
      description: string | null;
    } | null;
    onSaved?: () => void;
  } = $props();

  let name = $state("");
  let description = $state("");
  let isSaving = $state(false);

  $effect(() => {
    if (role) {
      name = role.name ?? "";
      description = role.description ?? "";
    }
  });

  async function save() {
    if (!role || !app.joinedSpace) return;
    isSaving = true;
    try {
      await peer.sendEvent(app.joinedSpace.id, {
        id: newUlid(),
        $type: "space.roomy.role.updateRole.v0",
        roleId: Ulid.assert(role.id),
        name: name.trim() || undefined,
        description: description.trim() || undefined,
      });
      open = false;
      onSaved?.();
    } catch (e) {
      toast.error("Failed to update role");
      console.error(e);
    } finally {
      isSaving = false;
    }
  }
</script>

{#if role}
  <Modal bind:open>
    <div class="flex flex-col gap-4 min-w-80">
      <h3 class="text-base font-semibold text-base-900 dark:text-base-100">
        Edit Role
      </h3>

      <div class="flex flex-col gap-2">
        <p class="text-sm font-medium text-base-700 dark:text-base-300">Name</p>
        <Input bind:value={name} placeholder="Role name" />
      </div>

      <div class="flex flex-col gap-2">
        <p class="text-sm font-medium text-base-700 dark:text-base-300">Description</p>
        <Input bind:value={description} placeholder="Role description (optional)" />
      </div>

      <div class="flex justify-end">
        <Button onclick={save} disabled={isSaving || !name.trim()}>
          {#if isSaving}
            <IconLoading class="animate-spin mr-2" />
          {:else}
            <IconSave class="size-4 mr-2" />
          {/if}
          Save
        </Button>
      </div>
    </div>
  </Modal>
{/if}

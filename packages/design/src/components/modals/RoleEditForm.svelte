<script lang="ts">
  import { untrack } from "svelte";
  import { Modal, Button, Input } from "@foxui/core";
  import { IconLoading, IconSave } from "../../icons/index";

  let {
    open = $bindable(false),
    role,
    saving = false,
    onSave,
  }: {
    open: boolean;
    role: {
      id: string;
      name?: string;
      description?: string;
    } | null;
    saving?: boolean;
    onSave: (name: string, description: string) => void;
  } = $props();

  // Seeded once from `role`, then owned by the form. The parent keys this
  // component on role.id, so it is destroyed and recreated whenever the
  // target role changes; that keeps the seed correct without an $effect that
  // writes $state (which would be an effect_update_depth_exceeded loop).
  let name = $state(untrack(() => role?.name) ?? "");
  let description = $state(untrack(() => role?.description) ?? "");

  function submit() {
    if (!role || !name.trim()) return;
    onSave(name.trim(), description.trim());
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
        <p class="text-sm font-medium text-base-700 dark:text-base-300">
          Description
        </p>
        <Input
          bind:value={description}
          placeholder="Role description (optional)"
        />
      </div>

      <div class="flex justify-end">
        <Button onclick={submit} disabled={saving || !name.trim()}>
          {#if saving}
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

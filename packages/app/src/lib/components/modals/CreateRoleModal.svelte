<script lang="ts">
  import { Modal, Button, Input, Textarea, toast } from "@foxui/core";
  import { peer } from "$lib/workers";
  import { getAppState } from "$lib/queries";
  import { newUlid } from "@roomy-space/sdk";
  import { IconLoading } from "@roomy/design/icons";

  const app = getAppState();

  let {
    open = $bindable(false),
    onCreated,
  }: {
    open: boolean;
    onCreated?: () => void;
  } = $props();

  let name = $state("");
  let description = $state("");
  let isCreating = $state(false);

  $effect(() => {
    if (!open) {
      name = "";
      description = "";
    }
  });

  async function create() {
    if (!app.joinedSpace || !name.trim()) return;
    isCreating = true;
    try {
      await peer.sendEvent(app.joinedSpace.id, {
        id: newUlid(),
        $type: "space.roomy.role.createRole.v0",
        name: name.trim(),
        description: description.trim() || undefined,
      });
      open = false;
      onCreated?.();
    } catch (e) {
      toast.error("Failed to create role");
      console.error(e);
    } finally {
      isCreating = false;
    }
  }
</script>

<Modal bind:open>
  <div class="flex flex-col gap-4 min-w-80">
    <h3 class="text-base font-semibold text-base-900 dark:text-base-100">
      New Role
    </h3>

    <Input
      bind:value={name}
      placeholder="Role name"
      onkeydown={(e) => e.key === "Enter" && create()}
    />
    <Textarea
      bind:value={description}
      placeholder="Description (optional)"
      rows={2}
    />

    <div class="flex justify-end">
      <Button onclick={create} disabled={isCreating || !name.trim()}>
        {#if isCreating}
          <IconLoading class="animate-spin" />
        {/if}
        Create
      </Button>
    </div>
  </div>
</Modal>

<script lang="ts">
  import { Modal, Button, Input, Textarea } from "@foxui/core";
  import { IconLoading } from "../../icons/index";

  let {
    open = $bindable(false),
    creating = false,
    onCreate,
  }: {
    open: boolean;
    creating?: boolean;
    onCreate: (name: string, description: string) => void;
  } = $props();

  let name = $state("");
  let description = $state("");

  $effect(() => {
    if (!open) {
      name = "";
      description = "";
    }
  });

  function submit() {
    if (!name.trim()) return;
    onCreate(name.trim(), description.trim());
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
      onkeydown={(e) => e.key === "Enter" && submit()}
    />
    <Textarea
      bind:value={description}
      placeholder="Description (optional)"
      rows={2}
    />

    <div class="flex justify-end">
      <Button onclick={submit} disabled={creating || !name.trim()}>
        {#if creating}
          <IconLoading class="animate-spin" />
        {/if}
        Create
      </Button>
    </div>
  </div>
</Modal>

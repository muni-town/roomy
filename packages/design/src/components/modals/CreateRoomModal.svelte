<script lang="ts">
  import { Modal } from "@foxui/core";
  import Input from "../ui/input/Input.svelte";
  import Button from "../ui/button/Button.svelte";
  import { IconPlus } from "../../icons/index";

  let {
    open = $bindable(false),
    spaceId,
    onCreate,
  }: {
    open: boolean;
    /** The space ID — used to form the default category link. */
    spaceId: string;
    /** Called when the user submits the form. */
    onCreate: (opts: { type: "Channel" | "Category"; name: string }) => void | Promise<void>;
  } = $props();

  const types = ["Channel", "Category"] as const;
  let type = $state<"Channel" | "Category">("Channel");
  let name = $state("");
  let creating = $state(false);

  $effect(() => {
    if (!open) {
      name = "";
      type = "Channel";
      creating = false;
    }
  });

  async function submit() {
    if (!name.trim() || creating) return;
    creating = true;
    try {
      await onCreate({ type, name: name.trim() });
      open = false;
    } catch {
      // error handling is caller's responsibility
    } finally {
      creating = false;
    }
  }
</script>

<Modal bind:open>
  <div class="flex flex-col gap-4 min-w-80">
    <h3 class="text-base font-semibold text-base-900 dark:text-base-100">
      Create new
    </h3>

    <fieldset>
      <legend class="text-sm/6 font-medium text-base-700 dark:text-base-300 mb-2">
        Type
      </legend>
      <div class="flex gap-4">
        {#each types as t}
          <label class="flex items-center gap-2 text-sm text-base-800 dark:text-base-200 cursor-pointer">
            <input
              type="radio"
              bind:group={type}
              value={t}
              class="size-4 accent-accent-600 dark:accent-accent-400"
            />
            {t}
          </label>
        {/each}
      </div>
    </fieldset>

    <div>
      <label
        for="create-room-name"
        class="block text-sm/6 font-medium text-base-900 dark:text-base-100 mb-1"
      >
        Name
      </label>
      <Input
        id="create-room-name"
        bind:value={name}
        placeholder="e.g. general"
        onkeydown={(e: KeyboardEvent) => e.key === "Enter" && submit()}
      />
    </div>

    <div class="flex justify-end mt-2">
      <Button onclick={submit} disabled={!name.trim() || creating}>
        {#if creating}
          Creating…
        {:else}
          <IconPlus class="size-4" /> Create {type}
        {/if}
      </Button>
    </div>
  </div>
</Modal>

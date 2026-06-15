<script lang="ts">
  import type { Snippet } from "svelte";
  import { Dialog } from "bits-ui";
  import Input from "../ui/input/Input.svelte";
  import Button from "../ui/button/Button.svelte";
  import { IconPlus } from "../../icons/index";

  let {
    open = $bindable(false),
    spaceId,
    defaultType = "Channel",
    permissions,
    onCreate,
  }: {
    open: boolean;
    /** The space ID — used to form the default category link. */
    spaceId: string;
    /** Optional permissions editor snippet (e.g. ChannelPermissions component). */
    permissions?: Snippet<[{ type: "Channel" | "Category" }]>;
    /** Called when the user submits the form. */
    onCreate: (opts: { type: "Channel" | "Category"; name: string }) => void | Promise<void>;
    /** Pre-select the creation type when the modal opens. */
    defaultType?: "Channel" | "Category";
  } = $props();

  const types = ["Channel", "Category"] as const;
  let type = $state<"Channel" | "Category">(defaultType);
  let name = $state("");
  let creating = $state(false);

  $effect(() => {
    if (!open) {
      name = "";
      type = defaultType;
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

<Dialog.Root bind:open>
  <Dialog.Portal>
    <!-- Overlay with no exit animation so PresenceLayer dispatches UNMOUNT instantly -->
    <Dialog.Overlay
      class="fixed inset-0 z-50 bg-base-200/10 dark:bg-base-900/10 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0"
    />
    <Dialog.Content
      class="fixed top-[50%] left-[50%] z-50 grid w-[calc(100%-1rem)] max-w-lg translate-x-[-50%] translate-y-[-50%] shadow-lg border border-base-200 bg-base-100 dark:border-base-700 dark:bg-base-800 gap-4 rounded-2xl p-6 backdrop-blur-xl data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
    >
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

        {#if permissions}
          {#if type === "Channel"}
            <div class="border-t border-base-200 dark:border-base-700 pt-4">
              {@render permissions({ type })}
            </div>
          {/if}
        {/if}

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

      <Dialog.Close
        class="text-base-900 dark:text-base-500 hover:text-base-800 dark:hover:text-base-200 hover:bg-base-200 dark:hover:bg-base-800 focus:outline-base-900 dark:focus:outline-base-50 focus:bg-base-200 dark:focus:bg-base-800 focus:text-base-800 dark:focus:text-base-200 absolute top-2 right-2 cursor-pointer rounded-xl p-1 transition-colors focus:outline-2 focus:outline-offset-2"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="currentColor"
          class="size-4"
        >
          <path
            fill-rule="evenodd"
            d="M5.47 5.47a.75.75 0 0 1 1.06 0L12 10.94l5.47-5.47a.75.75 0 1 1 1.06 1.06L13.06 12l5.47 5.47a.75.75 0 1 1-1.06 1.06L12 13.06l-5.47 5.47a.75.75 0 0 1-1.06-1.06L10.94 12 5.47 6.53a.75.75 0 0 1 0-1.06Z"
            clip-rule="evenodd"
          />
        </svg>
        <span class="sr-only">Close</span>
      </Dialog.Close>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
<script lang="ts">
  import Icon from "@iconify/svelte";
  import { Dialog } from "bits-ui";
  import type { Snippet } from "svelte";

  type Props = {
    title: string;
    description?: string; // may be formatted with HTML
    isDialogOpen?: boolean;
    disabled?: boolean;
    dialogTrigger?: Snippet;
    children?: Snippet;
  };

  let {
    title,
    description,
    isDialogOpen = $bindable<boolean>(false),
    disabled,
    dialogTrigger,
    children,
  }: Props = $props();
</script>

<Dialog.Root bind:open={isDialogOpen}>
  {#if dialogTrigger}
    <Dialog.Trigger {disabled}>
      {@render dialogTrigger()}
    </Dialog.Trigger>
  {/if}
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-50 bg-black/80" />

    <Dialog.Content
      class="fixed flex flex-col gap-4 p-4 w-dvw max-w-(--breakpoint-sm) left-[50%] top-[50%] z-50 translate-x-[-50%] translate-y-[-50%]"
      onkeydown={(e) => {
        if (e.key === "Escape") {
          isDialogOpen = false;
        }
      }}
    >
      <div class="p-5 bg-base-200 rounded-box flex flex-col gap-3">
        <div class="flex flex-col gap-3">
          <header class="flex justify-between items-center">
            <Dialog.Title class="text-xl font-bold">
              {title}
            </Dialog.Title>
            <Dialog.Close class="dz-btn dz-btn-circle">
              <Icon icon="zondicons:close-solid" />
            </Dialog.Close>
          </header>
          <div class="divider my-0"></div>
        </div>

        {#if description}
          <Dialog.Description class="text-sm">
            <!-- allows text to be formed with HTML -->
            {@html description}
          </Dialog.Description>
        {/if}

        {@render children?.()}
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

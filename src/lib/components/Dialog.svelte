<script lang="ts">
  import Icon from "@iconify/svelte";
  import { fade } from "svelte/transition";
  import { Dialog, Separator } from "bits-ui";
  import type { Snippet } from "svelte";

  type Props = {
    title: string;
    description?: string;
    isDialogOpen?: boolean;
    dialogTrigger: Snippet;
    children?: Snippet;  
  };

  let { 
    title, 
    description, 
    isDialogOpen = $bindable<boolean>(false),
    dialogTrigger,
    children 
  }: Props = $props();
</script>

<Dialog.Root bind:open={isDialogOpen}>
  <Dialog.Trigger>
    {@render dialogTrigger()}
  </Dialog.Trigger>
  <Dialog.Portal>
    <Dialog.Overlay
      class="fixed inset-0 z-50 bg-black/80"
    />

    <Dialog.Content
      class="fixed p-5 flex flex-col text-white gap-4 w-dvw max-w-(--breakpoint-sm) left-[50%] top-[50%] z-50 translate-x-[-50%] translate-y-[-50%] rounded-lg border bg-purple-950"
    >
      <div class="flex flex-col gap-3">
        <header class="flex justify-between items-center">
          <Dialog.Title class="text-lg font-bold">
            {title}
          </Dialog.Title>
          <Dialog.Close class="cursor-pointer transition-all duration-150 hover:scale-105 active:scale-95">
            <Icon icon="zondicons:close-solid" />
          </Dialog.Close>
        </header>
        <Separator.Root class="border border-white" />
      </div>

      {#if description}
        <Dialog.Description class="text-sm">
          {description}
        </Dialog.Description>
      {/if}

      {@render children?.()}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

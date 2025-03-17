<script lang="ts">
  import Icon from "@iconify/svelte";
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
      class="fixed p-5 flex flex-col bg-base-200 rounded-box gap-4 w-dvw max-w-(--breakpoint-sm) left-[50%] top-[50%] z-50 translate-x-[-50%] translate-y-[-50%] "
    >
      <div class="flex flex-col gap-3">
        <header class="flex justify-between items-center">
          <Dialog.Title class="text-xl font-bold">
            {title}
          </Dialog.Title>
          <Dialog.Close class="btn btn-circle">
            <Icon icon="zondicons:close-solid" />
          </Dialog.Close>
        </header>
        <div class="divider my-0"></div>
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
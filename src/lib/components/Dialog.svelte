<script lang="ts">
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
      transition={fade}
      transitionConfig={{ duration: 150 }}
      class="fixed inset-0 z-50 bg-black/80"
    />

    <Dialog.Content
      class="fixed p-5 flex flex-col text-white gap-4 w-dvw max-w-(--breakpoint-sm) left-[50%] top-[50%] z-50 translate-x-[-50%] translate-y-[-50%] rounded-lg border bg-purple-950"
    >
      <Dialog.Title
        class="text-bold font-bold text-xl flex items-center justify-center gap-4"
      >
        {title}
      </Dialog.Title>
      <Separator.Root class="border border-white" />
      <div class="flex flex-col items-center gap-4">
        {description}
      </div>

      {@render children?.()}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

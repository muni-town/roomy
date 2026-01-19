<script lang="ts">
  import { Drawer } from "vaul-svelte";
  import type { Snippet } from "svelte";

  type Props = {
    title?: string;
    description?: string;
    open?: boolean;
    drawerTrigger?: Snippet;
    children: Snippet;
    onOpenChange?: (open: boolean) => void;
  };

  let {
    title,
    description,
    open = $bindable<boolean>(false),
    drawerTrigger,
    children,
    onOpenChange,
  }: Props = $props();
</script>

<Drawer.Root bind:open {onOpenChange}>
  {#if drawerTrigger}
    <Drawer.Trigger>
      {@render drawerTrigger?.()}
    </Drawer.Trigger>
  {/if}

  <Drawer.Portal>
    <Drawer.Overlay
      class="fixed inset-0 bg-base-100/40 dark:bg-black/40 z-40"
    />
    <Drawer.Content
      class="flex flex-col mt-24 fixed bottom-0 left-0 right-0 z-50"
    >
      <div
        class="bg-base-50 border-t border-base-200 dark:border-base-800 dark:bg-base-900 h-fit min-h-32 rounded-t-xl px-4 py-8"
      >
        {#if title}
          <Drawer.Title>{title}</Drawer.Title>
        {/if}

        {#if description}
          <Drawer.Description>{description}</Drawer.Description>
        {/if}

        {@render children()}
      </div>
    </Drawer.Content>
  </Drawer.Portal>
</Drawer.Root>

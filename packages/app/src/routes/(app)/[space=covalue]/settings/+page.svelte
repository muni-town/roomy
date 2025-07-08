<script lang="ts">
  import { page } from "$app/state";
  import MainLayout from "$lib/components/layout/MainLayout.svelte";
  import MainSidebarSpace from "$lib/components/MainSidebarSpace.svelte";
  import { Button } from "@fuxui/base";
  import Icon from "@iconify/svelte";
</script>

<MainLayout>
  {#snippet sidebar()}
    <MainSidebarSpace />

    <div class="px-2 flex flex-col gap-2">
      <Button href={`/${page.params.space}`} class="w-full justify-start mb-4">
        <Icon icon="lucide:arrow-left" class="size-4" />
        Back to space
      </Button>

      <Button variant="ghost" class="w-full justify-start">General</Button>
      <Button variant="ghost" class="w-full justify-start">Discord Bridge</Button>
      <Button variant="ghost" class="w-full justify-start">Members</Button>
      <Button variant="ghost" class="w-full justify-start">Bans & Permissions</Button>
    </div>
  {/snippet}

  <div class="flex-1 flex items-center justify-center">
    Settings coming soon...
  </div>
</MainLayout>

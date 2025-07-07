<script lang="ts">
  import { page } from "$app/state";
  import MainLayout from "$lib/components/layout/MainLayout.svelte";
  import SidebarMain from "$lib/components/SidebarMain.svelte";
  import TimelineView from "$lib/components/TimelineView.svelte";
  import ToggleNavigation from "$lib/components/ToggleNavigation.svelte";
  import Navbar from "$lib/components/ui/Navbar.svelte";
  import { ThemeToggle } from "@fuxui/base";
  import { RoomyObject } from "@roomy-chat/sdk";
  import { CoState } from "jazz-svelte";

  let object = $derived(new CoState(RoomyObject, page.params.object));
</script>

<MainLayout>
  {#snippet sidebar()}
    <SidebarMain />
  {/snippet}

  {#if object.current?.objectType === "thread"}
    <TimelineView
      objectId={page.params.object ?? ""}
      spaceId={page.params.space ?? ""}
    />
  {:else}
    <div class="flex-1 flex items-center justify-center">
      <h1 class="text-2xl font-bold text-center text-base-900 dark:text-base-100">Unknown object type</h1>
    </div>
  {/if}
</MainLayout>

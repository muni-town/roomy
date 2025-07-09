<script lang="ts">
  import { page } from "$app/state";
  import MainLayout from "$lib/components/layout/MainLayout.svelte";
  import PageView from "$lib/components/PageView.svelte";
  import SidebarMain from "$lib/components/SidebarMain.svelte";
  import TimelineView from "$lib/components/TimelineView.svelte";
  import { RoomyObject } from "@roomy-chat/sdk";
  import { CoState } from "jazz-svelte";

  let object = $derived(new CoState(RoomyObject, page.params.object));
</script>

<MainLayout>
  {#snippet sidebar()}
    <SidebarMain />
  {/snippet}

  {#snippet navbar()}
    <div class="flex flex-col items-center justify-between w-full px-2">
      <h2
        class="text-lg font-bold w-full py-4 text-base-900 dark:text-base-100 flex items-center gap-2"
      >
        <span>{object.current?.name || "..."}</span>
      </h2>
    </div>
  {/snippet}


  {#if object.current?.components?.thread}
    <TimelineView
      objectId={page.params.object ?? ""}
      spaceId={page.params.space ?? ""}
    />
  {:else if object.current?.components?.page}
    <PageView
      objectId={page.params.object ?? ""}
      spaceId={page.params.space ?? ""}
    />
  {:else}
    <div class="flex-1 flex items-center justify-center">
      <h1
        class="text-2xl font-bold text-center text-base-900 dark:text-base-100"
      >
        Unknown object type
      </h1>
    </div>
  {/if}
</MainLayout>
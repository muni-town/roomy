<script lang="ts">
  import { page } from "$app/state";

  import { navigate } from "$lib/utils.svelte";
  import Icon from "@iconify/svelte";
  import { ToggleGroup } from "bits-ui";
  import { slide } from "svelte/transition";
  let { availableThreads } = $props();
</script>

<div transition:slide class="flex flex-col gap-4">
  {#each availableThreads.value as thread}
    <ToggleGroup.Item
      onclick={() => navigate({ space: page.params.space!, thread: thread.id })}
      value={thread.id}
      class="w-full cursor-pointer px-1 dz-btn dz-btn-ghost justify-start border border-transparent data-[state=on]:border-primary data-[state=on]:text-primary"
    >
      <h3 class="flex justify-start items-center gap-2 px-2">
        <Icon icon="material-symbols:thread-unread-rounded" />
        {thread.name}
      </h3>
    </ToggleGroup.Item>
  {/each}
</div>

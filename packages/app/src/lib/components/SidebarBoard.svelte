<script lang="ts">
  import { page } from "$app/state";
  import { globalState } from "$lib/global.svelte";
  import { navigate } from "$lib/utils.svelte";
  import Icon from "@iconify/svelte";
  import { Accordion, ToggleGroup } from "bits-ui";
  import { slide } from "svelte/transition";
  let { availableThreads } = $props();
  let sidebarAccordionValues = $state(["threads"]);
</script>

<!--
Pages
Threads
Links
--->
<ToggleGroup.Root type="single" value={globalState.channel?.id}>
  <Accordion.Root
    type="multiple"
    bind:value={sidebarAccordionValues}
    class="flex flex-col px-2 gap-4"
  >
    <Accordion.Item value="threads">
      <Accordion.Header>
        <Accordion.Trigger
          class="cursor-pointer flex w-full items-center justify-between mb-2 uppercase text-xs font-medium text-base-content"
        >
          <h3>All Threads</h3>
          <Icon
            icon="basil:caret-up-solid"
            class={`size-4 transition-transform duration-150 ${sidebarAccordionValues.includes("threads") && "rotate-180"}`}
          />
        </Accordion.Trigger>
      </Accordion.Header>
      <Accordion.Content forceMount>
        {#snippet child({ open }: { open: boolean })}
          {#if open}
            {@render threadsSidebar()}
          {/if}
        {/snippet}
      </Accordion.Content>
    </Accordion.Item>
  </Accordion.Root>
</ToggleGroup.Root>

{#snippet threadsSidebar(limit = Infinity)}
  <div transition:slide={{ duration: 100 }} class="flex flex-col gap-1">
    {#each availableThreads.value.filter((_: any, i: number) => i < limit) as thread}
      <ToggleGroup.Item
        onclick={() =>
          navigate({ space: page.params.space!, thread: thread.id })}
        value={thread.id}
        class="w-full cursor-pointer px-1 dz-btn dz-btn-ghost justify-start border border-transparent data-[state=on]:border-primary data-[state=on]:text-primary"
      >
        <h3 class="flex justify-start items-center gap-2 px-2 w-full">
          <Icon
            icon="material-symbols:thread-unread-rounded"
            class="shrink-0"
          />
          <span class="truncate">{thread.name}</span>
        </h3>
      </ToggleGroup.Item>
    {/each}
  </div>
{/snippet}

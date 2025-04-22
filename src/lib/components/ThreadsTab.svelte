<script lang="ts">
  import { page } from "$app/state";
  import { g } from "$lib/global.svelte";
  import { derivePromise } from "$lib/utils.svelte";
  import { Channel } from "@roomy-chat/sdk";
  import { format, isToday } from "date-fns";

  let relatedThreads = derivePromise([], async () =>
    g.channel && g.channel instanceof Channel
      ? await g.channel.threads.items()
      : [],
  );
</script>

<div class="flex justify-between items-center">
  <h3 class="text-xl font-bold text-base-content">Topics</h3>
</div>
<ul class="list w-full join join-vertical">
  {#each relatedThreads.value as thread}
    <a href={`/${page.params.space}/thread/${thread.id}`}>
      <li
        class="list-row join-item flex items-center w-full bg-base-200 card-title text-md text-content-primary"
      >
        <span>
          {thread.name}
        </span>
        {#if thread.createdDate}
          {@const formattedDate = isToday(thread.createdDate)
            ? "Today"
            : format(thread.createdDate, "P")}
          <time class="text-xs">
            {formattedDate}, {format(thread.createdDate, "pp")}
          </time>
        {/if}
      </li>
    </a>
  {:else}
    No threads for this channel.
  {/each}
</ul>

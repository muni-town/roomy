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

<ul class="list w-full join join-vertical">
  {#each relatedThreads.value as thread}
    <a href={`/${page.params.space}/thread/${thread.id}`}>
      <li class="list-row join-item flex items-center w-full bg-base-200">
        <h3 class="card-title text-md font-medium text-content-primary">
          {thread.name}
        </h3>
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

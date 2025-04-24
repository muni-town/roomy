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

<ul class="list w-full dz-join dz-join-vertical">
  {#if relatedThreads.value.length > 0}
    {#each relatedThreads.value as thread}
      <a href={`/${page.params.space}/thread/${thread.id}`}>
        <li class="list-row dz-join-item flex items-center w-full bg-base-200">
          <h3 class="card-title text-xl font-medium text-primary">
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
    {/each}
  {:else}
    No threads for this channel.
  {/if}
</ul>

<script lang="ts">
  import { createMessageQuery } from "$lib/queries/message";
  import { renderMarkdownPlaintext } from "@roomy/design/utils";

  type Props = {
    replyToId: string;
    roomId: string;
  };

  let { replyToId, roomId }: Props = $props();

  const target = createMessageQuery(() => replyToId, () => roomId);
</script>

{#if target.data}
  <div class="flex gap-1 items-center shrink-0">
    <span class="font-medium text-accent-700 dark:text-accent-300">
      {target.data.authorName || target.data.authorDid.slice(0, 12)}
    </span>
  </div>
  <div class="line-clamp-1 overflow-hidden italic">
    {@html renderMarkdownPlaintext(target.data.content ?? "")}
  </div>
{:else if target.isPending}
  <div class="h-5"></div>
{:else}
  <span class="italic text-base-400">Reply unavailable</span>
{/if}

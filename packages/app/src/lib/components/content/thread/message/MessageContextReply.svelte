<script lang="ts">
  import { Avatar } from "bits-ui";
  import { AvatarBeam } from "svelte-boring-avatars";
  import { IconReplyLine } from "@roomy/design/icons";
  import { LiveQuery } from "$lib/utils/liveQuery.svelte";
  import { sql } from "$lib/utils/sqlTemplate";
  import type { Message } from "../ChatArea.svelte";
  import { renderMarkdownPlaintext } from "$lib/utils/markdown";

  let {
    replyToId,
  }: {
    replyToId: string;
  } = $props();

  let query = new LiveQuery<Message>(
    () => sql`
      select
        c.entity as id,
        cast(c.data as text) as content,
        author_edge.tail as authorDid,
        i.name as authorName,
        i.avatar as authorAvatar,
        c.timestamp as timestamp
      from entities e
        join comp_content c on c.entity = e.id
        join edges author_edge on author_edge.head = e.id and author_edge.label = 'author'
        left join comp_user u on u.did = author_edge.tail
        left join comp_info i on i.entity = author_edge.tail
      where
        e.id = ${replyToId}
        limit 1
    `,
    undefined,
    {
      description: "Reply context for a message",
      origin: "MessageContextReply.svelte",
    },
  );

  let contextMessage = $derived.by(() => {
    if (!query.result) return null;
    return query.result[0];
  });
</script>

{#if contextMessage}
  <div class="flex md:basis-auto gap-1 items-center shrink-0">
    <IconReplyLine
      width="28px"
      height="12px"
      class="relative -bottom-1 ml-2 mr-1 left-0.75 stroke-black/25 dark:stroke-white/50 dark:stroke-1"
    />
    {#if contextMessage.authorAvatar || contextMessage.authorDid}
      <Avatar.Root class="w-4 h-4">
        <Avatar.Image src={contextMessage?.authorAvatar} class="rounded-full" />
        <Avatar.Fallback>
          <AvatarBeam size={16} name={contextMessage?.authorDid || ""} />
        </Avatar.Fallback>
      </Avatar.Root>
    {/if}
    {#if contextMessage.authorName}
      <span
        class="font-medium text-ellipsis text-accent-700 dark:text-accent-300"
        aria-label="Replying to"
      >
        {contextMessage?.authorName || ""}
      </span>
    {/if}
  </div>
  <div class="line-clamp-1 md:basis-auto overflow-hidden italic">
    {@html renderMarkdownPlaintext(contextMessage?.content ?? "")}
  </div>
{/if}

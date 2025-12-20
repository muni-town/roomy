<script lang="ts">
  import { Avatar } from "bits-ui";
  import { AvatarBeam } from "svelte-boring-avatars";
  import IconMdiReply from "~icons/mdi/reply";
  import { LiveQuery } from "$lib/utils/liveQuery.svelte";
  import { sql } from "$lib/utils/sqlTemplate";
  import type { Message } from "../ChatArea.svelte";

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
        u.did as authorDid,
        i.name as authorName,
        i.avatar as authorAvatar,
        o.author as masqueradeAuthor,
        oi.name as masqueradeAuthorName,
        oi.avatar as masqueradeAuthorAvatar,
        o.timestamp as masqueradeTimestamp
      from entities e
        join comp_content c on c.entity = e.id
        join edges author_edge on author_edge.head = e.id and author_edge.label = 'author'
        join comp_user u on u.did = author_edge.tail
        join comp_info i on i.entity = author_edge.tail
        left join comp_override_meta o on o.entity = e.id
        left join comp_info oi on oi.entity = o.author
      where
        e.id = ${replyToId}
        limit 1
    `,
  );

  let contextMessage = $derived.by(() => {
    if (!query.result) return null;
    return query.result[0];
  });
</script>

<div class="flex md:basis-auto gap-2 items-center shrink-0">
  <IconMdiReply width="12px" height="12px" />
  {#if contextMessage && (contextMessage.authorAvatar || contextMessage.masqueradeAuthorAvatar || contextMessage.authorDid || contextMessage.masqueradeAuthor)}
    <Avatar.Root class="w-4 h-4">
      <Avatar.Image
        src={contextMessage?.masqueradeAuthorAvatar ||
          contextMessage?.authorAvatar}
        class="rounded-full"
      />
      <Avatar.Fallback>
        <AvatarBeam
          size={16}
          name={contextMessage?.masqueradeAuthor ||
            contextMessage?.authorDid ||
            ""}
        />
      </Avatar.Fallback>
    </Avatar.Root>
  {/if}
  {#if contextMessage && (contextMessage.masqueradeAuthorName || contextMessage.authorName)}
    <span
      class="font-medium text-ellipsis text-accent-800 dark:text-accent-300"
      aria-label="Replying to"
    >
      {contextMessage?.masqueradeAuthorName || contextMessage?.authorName || ""}
    </span>
  {/if}
</div>
<div class="line-clamp-1 md:basis-auto overflow-hidden italic">
  {@html contextMessage?.content ?? ""}
</div>

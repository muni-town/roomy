<script lang="ts">
  import { Button } from "bits-ui";
  import { Avatar } from "bits-ui";
  import { AvatarBeam } from "svelte-boring-avatars";
  import { getContext } from "svelte";

  import IconMdiReply from "~icons/mdi/reply";
  import IconHeroiconsChatBubbleBottomCenterText from "~icons/heroicons/chat-bubble-bottom-center-text";
  import type { Message } from "../ChatArea.svelte";
  import { LiveQuery } from "$lib/liveQuery.svelte";
  import { sql } from "$lib/utils/sqlTemplate";
  import { id } from "$lib/workers/encoding";
  import type { MessagingState } from "../TimelineView.svelte";

  let {
    context = $bindable(undefined),
  }: {
    context?: MessagingState;
  } = $props();

  if (!context || context.kind === "normal")
    throw new Error("No relevant context");
  let query = new LiveQuery<Message>(
    () => sql`
        select
          id(c.entity) as id,
          cast(c.data as text) as content,
          id(u.did) as authorDid,
          i.name as authorName,
          i.avatar as authorAvatar,
          id(o.author) as masqueradeAuthor,
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
          e.id = ${id("replyTo" in context ? context.replyTo.id : "")}
          limit 1
      `,
  );

  let message = $derived.by(() => {
    // if (passedMessage) return passedMessage;
    if (!query.result) return null;
    return query.result[0];
  });

  const scrollToMessage = getContext("scrollToMessage") as (id: string) => void;
</script>

<Button.Root
  onclick={() => scrollToMessage(message?.id ?? "")}
  class="cursor-pointer flex gap-2 text-sm text-start items-center pl-2 pr-4 py-1 bg-base-300/20 dark:bg-base-400/5 w-full rounded-lg"
>
  <div class="flex md:basis-auto gap-2 items-center shrink-0">
    {#if context.kind === "replying"}
      <IconMdiReply width="12px" height="12px" />
    {:else if context.kind === "commenting"}
      <IconHeroiconsChatBubbleBottomCenterText width="12px" height="12px" />
    {/if}
    {#if message && (message.authorAvatar || message.masqueradeAuthorAvatar || message.authorDid || message.masqueradeAuthor)}
      <Avatar.Root class="w-4 h-4">
        <Avatar.Image
          src={message?.masqueradeAuthorAvatar || message?.authorAvatar}
          class="rounded-full"
        />
        <Avatar.Fallback>
          <AvatarBeam
            size={16}
            name={message?.masqueradeAuthor || message?.authorDid || ""}
          />
        </Avatar.Fallback>
      </Avatar.Root>
    {/if}
    {#if message && (message.masqueradeAuthorName || message.authorName)}
      <h5
        class="font-medium text-ellipsis text-accent-800 dark:text-accent-300"
      >
        {message?.masqueradeAuthorName || message?.authorName || ""}
      </h5>
    {/if}
  </div>
  <div class="line-clamp-1 md:basis-auto overflow-hidden italic">
    {#if context.kind === "commenting"}
      {context.comment.snippet}
    {:else}
      {@html message?.content ?? ""}
    {/if}
  </div>
</Button.Root>

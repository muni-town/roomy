<script lang="ts">
  import { Button } from "bits-ui";
  import { Avatar } from "bits-ui";
  import { AvatarBeam } from "svelte-boring-avatars";
  import { getContext } from "svelte";

  import IconMdiReply from "~icons/mdi/reply";
  import type { Message } from "../ChatArea.svelte";
  import { LiveQuery } from "$lib/liveQuery.svelte";
  import { sql } from "$lib/utils/sqlTemplate";
  import { id } from "$lib/workers/encoding";

  let {
    message: passedMessage,
    messageId,
  }: { message?: Message; messageId?: string } = $props();

  if (!messageId && !passedMessage)
    throw new Error("Either message or messageId must be provided");
  let query = new LiveQuery<Message>(
    () => sql`
        select
          id(c.entity) as id,
          cast(c.data as text) as content,
          id(u.did) as authorDid,
          i.name as authorName,
          i.avatar as authorAvatar,
          id(o.author) as masqueradeAuthor,
          o.timestamp as masqueradeTimestamp
        from entities e
          join comp_content c on c.entity = e.id
          join edges author_edge on author_edge.head = e.id and author_edge.label = 'author'
          join comp_user u on u.did = author_edge.tail
          join comp_info i on i.entity = author_edge.tail
          left join comp_override_meta o on o.entity = e.id
        where
          e.id = ${id(messageId || passedMessage?.id || "")}
          limit 1
      `,
  );

  let message = $derived.by(() => {
    if (passedMessage) return passedMessage;
    if (!query.result) return null;
    return query.result[0];
  });

  const scrollToMessage = getContext("scrollToMessage") as (id: string) => void;
</script>

<Button.Root
  onclick={() => scrollToMessage(message?.id ?? "")}
  class="cursor-pointer flex gap-2 text-sm text-start items-center px-4 py-1 bg-base-300/20 dark:bg-base-400/5 w-full rounded-lg"
>
  <div class="flex md:basis-auto gap-2 items-center shrink-0">
    <IconMdiReply width="12px" height="12px" />
    <Avatar.Root class="w-4 h-4">
      <Avatar.Image src={message?.authorAvatar} class="rounded-full" />
      <Avatar.Fallback>
        <AvatarBeam size={16} name={message?.authorName ?? ""} />
      </Avatar.Fallback>
    </Avatar.Root>
    <h5 class="font-medium text-ellipsis text-accent-800 dark:text-accent-300">
      {message?.authorName ?? ""}
    </h5>
  </div>
  <div class="line-clamp-1 md:basis-auto overflow-hidden italic">
    {@html message?.content ?? ""}
  </div>
</Button.Root>

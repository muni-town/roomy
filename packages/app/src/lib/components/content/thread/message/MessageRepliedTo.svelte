<script lang="ts">
  import { Button } from "bits-ui";
  import { Avatar } from "bits-ui";
  import { AvatarBeam } from "svelte-boring-avatars";
  import { getContext } from "svelte";

  import IconMdiReply from "~icons/mdi/reply";

  let { messageId }: { messageId: string } = $props();

  const scrollToMessage = getContext("scrollToMessage") as (id: string) => void;
</script>

<Button.Root
  onclick={() => scrollToMessage(message.current?.id ?? "")}
  class="cursor-pointer flex gap-2 text-sm text-start items-center px-4 py-1 bg-base-300/20 dark:bg-base-400/5 w-full rounded-lg"
>
  <div class="flex md:basis-auto gap-2 items-center shrink-0">
    <IconMdiReply width="12px" height="12px" />
    <Avatar.Root class="w-4 h-4">
      <Avatar.Image src={authorData?.imageUrl} class="rounded-full" />
      <Avatar.Fallback>
        <AvatarBeam size={16} name={authorData?.id ?? authorData?.name ?? ""} />
      </Avatar.Fallback>
    </Avatar.Root>
    <h5 class="font-medium text-ellipsis text-accent-800 dark:text-accent-300">
      {authorData?.name ?? ""}
    </h5>
  </div>
  <div class="line-clamp-1 md:basis-auto overflow-hidden italic">
    {@html content.current?.content ?? ""}
  </div>
</Button.Root>

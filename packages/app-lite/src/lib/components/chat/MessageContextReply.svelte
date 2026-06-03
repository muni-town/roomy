<script lang="ts">
  import { Avatar } from "bits-ui";
  import { AvatarBeam } from "svelte-boring-avatars";
  import { IconReplyLine } from "@roomy/design/icons";
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
    <IconReplyLine
      width="28px"
      height="12px"
      class="relative -bottom-1 ml-2 mr-1 left-0.75 stroke-black/25 dark:stroke-white/50 dark:stroke-1"
    />
    {#if target.data.authorAvatar || target.data.authorDid}
      <Avatar.Root class="w-4 h-4">
        <Avatar.Image src={target.data.authorAvatar} class="rounded-full" />
        <Avatar.Fallback>
          <AvatarBeam size={16} name={target.data.authorDid || ""} />
        </Avatar.Fallback>
      </Avatar.Root>
    {/if}
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

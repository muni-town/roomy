<script lang="ts">
  import { Avatar, Tooltip } from "bits-ui";
  import type { ChatEvent } from "$lib/schemas/types";
  import { renderMarkdownSanitized } from "$lib/markdown";
  import { AvatarBeam } from "svelte-boring-avatars";
  import { format, formatDistanceToNowStrict } from "date-fns";
  import { fly } from "svelte/transition";

  let { event }: { event: ChatEvent } = $props();
</script>

<li class="w-full h-fit flex gap-4">
  <Avatar.Root class="w-12">
    <Avatar.Image src={event.user.avatar} class="rounded-full" />
    <Avatar.Fallback>
      <AvatarBeam name={event.user.handle} />
    </Avatar.Fallback>
  </Avatar.Root>

  <div class="flex flex-col gap-2 text-white">
    <section class="flex gap-2">
      <h5 class="font-bold">{event.user.handle}</h5>
      <Tooltip.Root openDelay={300}>
        <Tooltip.Trigger>
          <time class="text-zinc-400 cursor-context-menu">
            {formatDistanceToNowStrict(new Date(event.timestamp))}
          </time>
        </Tooltip.Trigger>
        <Tooltip.Content 
          transition={fly}
          transitionConfig={{ y: 8, duration: 150 }}
          sideOffset={8}
        >
          <time class="flex items-center justify-center rounded-input border border-dark-10 bg-white p-3 text-sm font-medium shadow-popover outline-none">
            {format(new Date(event.timestamp), "MM/dd/yyyy K:mm:ss aaa")}
          </time>
        </Tooltip.Content>
      </Tooltip.Root>
    </section>
    <p class="text-lg">{@html renderMarkdownSanitized(event.content)}</p>
  </div>
</li>
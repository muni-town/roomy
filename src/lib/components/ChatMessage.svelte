<script lang="ts">
  import { Avatar, Button, Toolbar, Tooltip } from "bits-ui";
  import type { Channel, Ulid } from "$lib/schemas/types";
  import { renderMarkdownSanitized } from "$lib/markdown";
  import { AvatarBeam } from "svelte-boring-avatars";
  import { format, formatDistanceToNowStrict } from "date-fns";
  import { fly } from "svelte/transition";
  import { getContext } from "svelte";
  import { decodeTime } from "ulidx";
  import { getProfile } from "$lib/profile.svelte";
  import Icon from "@iconify/svelte";
  import type { Autodoc } from "$lib/autodoc/peer";

  let { id, channel }: { id: Ulid; channel: Autodoc<Channel> } = $props();
  let message = $derived(channel.view.messages[id]);
  let profile: { handle: string; avatarUrl: string } | undefined = getProfile(
    message.author,
  );
  let messageRepliedTo = $derived(
    message.replyTo && channel.view.messages[message.replyTo],
  );
  let profileRepliedTo = $derived(
    messageRepliedTo && getProfile(messageRepliedTo.author),
  );

  let isSelected = $state(false);
  let isThreading: { value: boolean } = getContext("isThreading");

  const selectMessage: (message: Ulid) => void = getContext("selectMessage");
  const removeSelectedMessage: (message: Ulid) => void = getContext(
    "removeSelectedMessage",
  );

  function updateSelect() {
    if (isSelected) {
      selectMessage(id);
    } else {
      removeSelectedMessage(id);
    }
  }

  const setReplyTo = getContext("setReplyTo") as (value: {
    id: Ulid;
    profile: { handle: string; avatarUrl: string };
    content: string;
  }) => void;

  function scrollToReply() {
    if (!message.replyTo) {
      return;
    }
    let element = document.getElementById(message.replyTo);
    element?.scrollIntoView();
  }

  $effect(() => {
    if (!isThreading.value) {
      isSelected = false;
    }
  });
</script>

<li {id} class="flex flex-col">
  {#if messageRepliedTo && profileRepliedTo}
    <Button.Root
      onclick={scrollToReply}
      class="cursor-pointer flex gap-2 text-start w-full items-center text-gray-300 px-4 py-1 bg-violet-900 rounded-t"
    >
      <Icon icon="prime:reply" />
      <Avatar.Root class="w-4">
        <Avatar.Image src={profileRepliedTo.avatarUrl} class="rounded-full" />
        <Avatar.Fallback>
          <AvatarBeam name={profileRepliedTo.handle} />
        </Avatar.Fallback>
      </Avatar.Root>
      <h5 class="text-white font-medium">{profileRepliedTo.handle}</h5>
      <p class="text-ellipsis italic">
        {@html renderMarkdownSanitized(messageRepliedTo.content)}
      </p>
    </Button.Root>
  {/if}

  <div
    class="relative group w-full h-fit flex gap-4 px-2 py-2.5 hover:bg-white/5 transition-all duration-75"
  >
    <Avatar.Root class="w-12 aspect-square">
      <Avatar.Image src={profile.avatarUrl} class="rounded-full" />
      <Avatar.Fallback>
        <AvatarBeam name={profile.handle} />
      </Avatar.Fallback>
    </Avatar.Root>

    <div class="flex flex-col gap-2 text-white w-full">
      <section class="flex gap-2">
        <h5 class="font-bold">{profile.handle}</h5>
        <!-- TODO: Change to exact time (eg "Today at 14:20") -->
        <Tooltip.Root openDelay={300}>
          <Tooltip.Trigger>
            <time class="text-zinc-400 cursor-context-menu">
              {formatDistanceToNowStrict(new Date(decodeTime(id)))}
            </time>
          </Tooltip.Trigger>
          <Tooltip.Content
            transition={fly}
            transitionConfig={{ y: 8, duration: 150 }}
            sideOffset={8}
          >
            <time
              class="flex items-center justify-center rounded-input border border-dark-10 bg-white p-3 text-sm font-medium shadow-popover outline-none"
            >
              {format(new Date(decodeTime(id)), "MM/dd/yyyy K:mm:ss aaa")}
            </time>
          </Tooltip.Content>
        </Tooltip.Root>
      </section>

      <p class="text-lg">{@html renderMarkdownSanitized(message.content)}</p>
    </div>

    <Toolbar.Root
      class="hidden group-hover:block absolute -top-2 right-0 bg-violet-800 p-2 rounded"
    >
      <Toolbar.Button
        onclick={() => setReplyTo({ id, profile, content: message.content })}
        class="p-2 hover:bg-white/5 hover:scale-105 active:scale-95 transition-all duration-150 rounded cursor-pointer"
      >
        <Icon icon="fa6-solid:reply" color="white" />
      </Toolbar.Button>
    </Toolbar.Root>

    {#if isThreading.value}
      <!-- TODO: Use bits-ui Checkbox -->
      <input
        type="checkbox"
        onchange={updateSelect}
        bind:checked={isSelected}
        class="absolute right-4 inset-y-0"
      />
    {/if}
  </div>
</li>

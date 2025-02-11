<script lang="ts">
  import { Avatar, Button, Popover, Toolbar, Tooltip } from "bits-ui";
  import type { Message, Ulid } from "$lib/schemas/types";
  import { renderMarkdownSanitized } from "$lib/markdown";
  import { AvatarBeam } from "svelte-boring-avatars";
  import { format, formatDistanceToNowStrict } from "date-fns";
  import { fly } from "svelte/transition";
  import { getContext } from "svelte";
  import { decodeTime } from "ulidx";
  import { getProfile } from "$lib/profile.svelte";
  import Icon from "@iconify/svelte";
  import { user } from "$lib/user.svelte";
  import "emoji-picker-element";
  import { outerWidth } from "svelte/reactivity/window";
  import Drawer from "./Drawer.svelte";

  let { id, messages }: { id: Ulid; messages: { [ulid: string]: Message } } =
    $props();
  let message = $derived(messages[id]);
  let profile: { handle: string; avatarUrl: string } | undefined = getProfile(
    message.author,
  );
  let messageRepliedTo = $derived(message.replyTo && messages[message.replyTo]);
  let profileRepliedTo = $derived(
    messageRepliedTo && getProfile(messageRepliedTo.author),
  );

  let isMobile = $derived((outerWidth.current ?? 0) < 640);
  let isDrawerOpen = $state(false);

  let isSelected = $state(false);
  let isThreading: { value: boolean } = getContext("isThreading");

  let emojiDrawerPicker: HTMLElement | undefined = $state();
  let emojiToolbarPicker: HTMLElement | undefined = $state();
  let emojiRowPicker: HTMLElement | undefined = $state();
  let isEmojiDrawerPickerOpen = $state(false);
  let isEmojiToolbarPickerOpen = $state(false);
  let isEmojiRowPickerOpen = $state(false);

  const selectMessage: (message: Ulid) => void = getContext("selectMessage");
  const removeSelectedMessage: (message: Ulid) => void = getContext(
    "removeSelectedMessage",
  );

  const setReplyTo = getContext("setReplyTo") as (value: {
    id: Ulid;
    profile: { handle: string; avatarUrl: string };
    content: string;
  }) => void;

  const toggleReaction = getContext("toggleReaction") as (
    id: Ulid,
    reaction: string,
  ) => void;

  function onEmojiPick(event: Event) {
    // @ts-ignore
    toggleReaction(id, event.detail.unicode);
    isEmojiToolbarPickerOpen = false;
    isEmojiRowPickerOpen = false;
  }

  function updateSelect() {
    if (isSelected) {
      selectMessage(id);
    } else {
      removeSelectedMessage(id);
    }
  }

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

  $effect(() => {
    if (emojiToolbarPicker) {
      emojiToolbarPicker.addEventListener("emoji-click", onEmojiPick);
    }
    if (emojiDrawerPicker) {
      emojiDrawerPicker.addEventListener("emoji-click", (e) => {
        onEmojiPick(e);
        isEmojiDrawerPickerOpen = false;
        isDrawerOpen = false;
      });
    }
    if (emojiRowPicker) {
      emojiRowPicker.addEventListener("emoji-click", onEmojiPick);
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

  <Button.Root
    onclick={() => {
      if (isMobile) {
        isDrawerOpen = true;
      }
    }}
    class="relative group w-full text-start h-fit flex gap-4 px-2 py-2.5 hover:bg-white/5 transition-all duration-75"
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

      <p class="text-lg prose-invert chat">
        {@html renderMarkdownSanitized(message.content)}
      </p>

      {#if Object.keys(message.reactions).length > 0}
        <div class="flex gap-2 flex-wrap">
          {#each Object.keys(message.reactions) as reaction}
            {@render reactionToggle(reaction)}
          {/each}
          <Popover.Root bind:open={isEmojiRowPickerOpen}>
            <Popover.Trigger
              class="p-2 hover:bg-white/5 hover:scale-105 active:scale-95 transition-all duration-150 rounded cursor-pointer"
            >
              <Icon icon="lucide:smile-plus" color="white" />
            </Popover.Trigger>
            <Popover.Content>
              <emoji-picker bind:this={emojiRowPicker}></emoji-picker>
            </Popover.Content>
          </Popover.Root>
        </div>
      {/if}
    </div>

    {#if isMobile}
      <Drawer bind:isDrawerOpen={isDrawerOpen}>
        <div class="flex gap-4 justify-center mb-4">
          <Button.Root 
            onclick={() => toggleReaction(id, "👍")}
            class="px-4 rounded-full bg-violet-800"
          >
            👍 
          </Button.Root>
          <Button.Root 
            onclick={() => toggleReaction(id, "😂")}
            class="px-4 rounded-full bg-violet-800"
          >
            😂
          </Button.Root>
          <Popover.Root bind:open={isEmojiDrawerPickerOpen}>
            <Popover.Trigger
              class="p-4 rounded-full bg-violet-800"
            >
              <Icon icon="lucide:smile-plus" color="white" />
            </Popover.Trigger>
            <Popover.Content>
              <emoji-picker bind:this={emojiDrawerPicker}></emoji-picker>
            </Popover.Content>
          </Popover.Root>
        </div>
        <Button.Root 
          onclick={() => setReplyTo({ id, profile, content: message.content })}
          class="text-white p-4 flex gap-4 items-center bg-violet-800 w-full rounded-lg" 
        >
          <Icon icon="fa6-solid:reply" color="white" />
          Reply
        </Button.Root>
      </Drawer>
    {:else}
      <Toolbar.Root
        class={`${!isEmojiToolbarPickerOpen && "hidden"} group-hover:flex absolute -top-2 right-0 bg-violet-800 p-2 rounded items-center`}
      >
        <Toolbar.Button
          onclick={() => toggleReaction(id, "👍")}
          class="p-2 hover:bg-white/5 hover:scale-105 active:scale-95 transition-all duration-150 rounded cursor-pointer"
        >
          👍
        </Toolbar.Button>
        <Toolbar.Button
          onclick={() => toggleReaction(id, "😂")}
          class="p-2 hover:bg-white/5 hover:scale-105 active:scale-95 transition-all duration-150 rounded cursor-pointer"
        >
          😂
        </Toolbar.Button>
        <Popover.Root bind:open={isEmojiToolbarPickerOpen}>
          <Popover.Trigger
            class="p-2 hover:bg-white/5 hover:scale-105 active:scale-95 transition-all duration-150 rounded cursor-pointer"
          >
            <Icon icon="lucide:smile-plus" color="white" />
          </Popover.Trigger>
          <Popover.Content>
            <emoji-picker bind:this={emojiToolbarPicker}></emoji-picker>
          </Popover.Content>
        </Popover.Root>
        <Toolbar.Button
          onclick={() => setReplyTo({ id, profile, content: message.content })}
          class="p-2 hover:bg-white/5 hover:scale-105 active:scale-95 transition-all duration-150 rounded cursor-pointer"
        >
          <Icon icon="fa6-solid:reply" color="white" />
        </Toolbar.Button>
      </Toolbar.Root>
    {/if}

    {#if isThreading.value}
      <!-- TODO: Use bits-ui Checkbox -->
      <input
        type="checkbox"
        onchange={updateSelect}
        bind:checked={isSelected}
        class="absolute right-4 inset-y-0"
      />
    {/if}
  </Button.Root>
</li>

{#snippet reactionToggle(reaction: string)}
  <Button.Root
    onclick={() => toggleReaction(id, reaction)}
    class={`
      ${user.profile.data && message.reactions[reaction].includes(user.profile.data.did) ? "bg-violet-600" : "bg-violet-800"}
      cursor-pointer border border-violet-500 px-2 py-1 rounded tabular-nums hover:scale-105 active:scale-95 transition-all duration-150
    `}
  >
    {reaction}
    {message.reactions[reaction].length}
  </Button.Root>
{/snippet}

<style>
  .chat :global(a) {
    text-decoration: underline;
  }
</style>
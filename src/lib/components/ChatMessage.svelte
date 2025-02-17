<script lang="ts">
  import { Avatar, Button, Popover, Toolbar } from "bits-ui";
  import type { Message, Ulid } from "$lib/schemas/types";
  import { renderMarkdownSanitized } from "$lib/markdown";
  import { AvatarBeam } from "svelte-boring-avatars";
  import { format, isToday } from "date-fns";
  import { getContext } from "svelte";
  import { decodeTime } from "ulidx";
  import { getProfile } from "$lib/profile.svelte";
  import Icon from "@iconify/svelte";
  import { user } from "$lib/user.svelte";
  import "emoji-picker-element";
  import { outerWidth } from "svelte/reactivity/window";
  import Drawer from "./Drawer.svelte";
  import AvatarImage from "./AvatarImage.svelte";

  // TODO: refactor $derived values into props
  let { id, messages }: { id: Ulid; messages: { [ulid: string]: Message } } =
    $props();
  let message = $derived(messages[id]);
  let profile: { handle: string; avatarUrl: string } | undefined = getProfile(
    message.author,
  );
  let messageRepliedTo = $derived(message.replyTo && messages[message.replyTo]);
  let profileRepliedTo =
    messageRepliedTo && getProfile(messageRepliedTo.author);

  // TODO: refactor to $derived
  let reactionHandles = $state({}) as { [reaction: string]: string[] };
  $effect(() => {
    reactionHandles = Object.fromEntries(
      Object.entries(message.reactions).map(([reaction, dids]) => [
        reaction,
        dids.map((did) => getProfile(did).handle),
      ]),
    );
  });

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
    element?.scrollIntoView({ behavior: "smooth" });
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

<li {id} class={`flex flex-col ${isMobile && "w-[90%] max-w-screen"}`}>
  {@render replyBanner()}

  <div
    class="relative group w-full h-fit flex flex-col gap-4 px-2 py-2.5 hover:bg-white/5 transition-all duration-75"
  >
    <div class="flex gap-4">
      <a href={`https://bsky.app/profile/${profile.handle}`} target="_blank">
        <AvatarImage handle={profile.handle} avatarUrl={profile.avatarUrl} />
      </a>

      <Button.Root
        onclick={() => {
          if (isMobile) {
            isDrawerOpen = true;
          }
        }}
        class="flex flex-col text-start gap-2 text-white w-full min-w-0"
      >
        <section class="flex items-center gap-2 flex-wrap w-fit">
          <a
            href={`https://bsky.app/profile/${profile.handle}`}
            target="_blank"
          >
            <h5 class="font-bold">{profile.handle}</h5>
          </a>
          {@render timestamp()}
        </section>

        <p class="text-lg prose-invert chat min-w-0 max-w-full overflow-hidden text-ellipsis">
          {@html renderMarkdownSanitized(message.content)}
        </p>
      </Button.Root>
    </div>

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

    {#if isMobile}
      <Drawer bind:isDrawerOpen>
        <div class="flex gap-4 justify-center mb-4">
          <Button.Root
            onclick={() => {
              toggleReaction(id, "👍");
              isDrawerOpen = false;
            }}
            class="px-4 rounded-full bg-violet-800"
          >
            👍
          </Button.Root>
          <Button.Root
            onclick={() => {
              toggleReaction(id, "😂");
              isDrawerOpen = false;
            }}
            class="px-4 rounded-full bg-violet-800"
          >
            😂
          </Button.Root>
          <Popover.Root bind:open={isEmojiDrawerPickerOpen}>
            <Popover.Trigger class="p-4 rounded-full bg-violet-800">
              <Icon icon="lucide:smile-plus" color="white" />
            </Popover.Trigger>
            <Popover.Content>
              <emoji-picker bind:this={emojiDrawerPicker}></emoji-picker>
            </Popover.Content>
          </Popover.Root>
        </div>
        <Button.Root
          onclick={() => {
            setReplyTo({ id, profile, content: message.content });
            isDrawerOpen = false;
          }}
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
  </div>
</li>

{#snippet timestamp()}
  {@const decodedTime = decodeTime(id)}
  {@const formattedDate = isToday(decodedTime)
    ? "Today"
    : format(decodedTime, "P")}
  <time class="text-xs text-gray-300">
    {formattedDate}, {format(decodedTime, "pp")}
  </time>
{/snippet}

{#snippet reactionToggle(reaction: string)}
  <Button.Root
    onclick={() => toggleReaction(id, reaction)}
    class={`
      ${user.profile.data && message.reactions[reaction].includes(user.profile.data.did) ? "bg-violet-600" : "bg-violet-800"}
      cursor-pointer text-white border border-violet-500 px-2 py-1 rounded tabular-nums hover:scale-105 active:scale-95 transition-all duration-150
    `}
    title={(reactionHandles[reaction] || []).join(", ")}
  >
    {reaction}
    {message.reactions[reaction].length}
  </Button.Root>
{/snippet}

{#snippet replyBanner()}
  {#if messageRepliedTo && profileRepliedTo}
    <Button.Root
      onclick={scrollToReply}
      class="cursor-pointer flex gap-2 text-start w-full items-center text-gray-300 px-4 py-1 bg-violet-900 rounded-t"
    >
      <div class="flex basis-1/2 md:basis-auto gap-2 items-center">
        <Icon icon="prime:reply" width="12px" height="12px" />
        <Avatar.Root class="w-4">
          <Avatar.Image src={profileRepliedTo.avatarUrl} class="rounded-full" />
          <Avatar.Fallback>
            <AvatarBeam name={profileRepliedTo.handle} />
          </Avatar.Fallback>
        </Avatar.Root>
        <h5 class="text-white font-medium text-ellipsis">
          {profileRepliedTo.handle}
        </h5>
      </div>
      <p class="line-clamp-1 basis-1/2 md:basis-auto overflow-hidden italic">
        {@html renderMarkdownSanitized(messageRepliedTo.content)}
      </p>
    </Button.Root>
  {/if}
{/snippet}

<style>
  @reference "../../app.css";

  .chat :global(a) {
    @apply underline;
  }

  .chat :global(*) {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .chat :global(blockquote) {
    @apply ml-3 px-2  border-l-2 border-solid border-l-violet-200;
  }
  .chat :global(h1) {
    @apply text-3xl font-bold;
  }
  .chat :global(h2) {
    @apply text-2xl font-bold;
  }
  .chat :global(h3),
  .chat :global(h4),
  .chat :global(h5) {
    @apply text-xl font-bold;
  }
</style>

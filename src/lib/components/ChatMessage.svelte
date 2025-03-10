<script lang="ts">
  import { Avatar, Button, Checkbox, Popover, Toolbar } from "bits-ui";
  import type { Announcement, Message, Space, Ulid } from "$lib/schemas/types";
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
  import { getContentHtml } from "$lib/tiptap/editor";
  import type { Autodoc } from "$lib/autodoc/peer";
  import { page } from "$app/state";
  import { isAnnouncement } from "$lib/utils";

  type Props = {
    id: Ulid;
    message: Message | Announcement;
    messageRepliedTo?: Message;
  };

  let { id, message, messageRepliedTo }: Props = $props();
  let space: { value: Autodoc<Space> } = getContext("space");

  // doesn't change after render, so $derived is not necessary
  const authorProfile = !isAnnouncement(message) && getProfile(message.author);
  const profileRepliedTo =
    messageRepliedTo && getProfile(messageRepliedTo.author);

  // set initial set with entries, no need for $effect
  let reactionHandles = $state(
    Object.fromEntries(
      Object.entries(message.reactions).map(([reaction, dids]) => [
        reaction,
        dids.map((did) => getProfile(did).handle),
      ]),
    ),
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

  const isAdmin: { value: boolean } = getContext("isAdmin"); 
  let mayDelete = $derived(
    !isAnnouncement(message) &&  
    (isAdmin.value || user.agent?.did == message.author)
  );

  const selectMessage = getContext("selectMessage") as (
    messageId: Ulid,
  ) => void;
  const deleteMessage = getContext("deleteMessage") as (
    messageId: Ulid,
  ) => void;
  const removeSelectedMessage = getContext("removeSelectedMessage") as (
    messageId: Ulid,
  ) => void;

  const setReplyTo = getContext("setReplyTo") as (value: {
    id: Ulid;
    authorProfile: { handle: string; avatarUrl: string };
    content: string;
  }) => void;

  const toggleReaction = getContext("toggleReaction") as (
    id: Ulid,
    reaction: string,
  ) => void;
  const scrollToMessage = getContext("scrollToMessage") as (id: Ulid) => void;

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
    if (isAnnouncement(message) || !message.replyTo) {
      return;
    }
    scrollToMessage(message.replyTo);
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

  let shiftDown = $state(false);
  function onKeydown({ shiftKey }: KeyboardEvent) {
    shiftDown = shiftKey;
  }
  function onKeyup({ shiftKey }: KeyboardEvent) {
    shiftDown = shiftKey;
  }

  function getAnnouncementHtml(announcement: Announcement) {
    const schema = {
      "type": "doc",
      "content": [] as Record<string, any>[]
    };

    switch (announcement.kind) {
      case "threadCreated": {
        const relatedThread = space.value.view.threads[announcement.relatedThreads![0]];
        schema.content.push({
          "type": "paragraph",
          "content": [
            { "type": "text", "text": "A new thread has been created: " },
            { 
              "type": "channelThreadMention",
              "attrs": {
                "id": JSON.stringify({
                  "ulid": announcement.relatedThreads![0],
                  "space": page.params.space,
                  "type": "thread"
                }),
                "label": relatedThread.title
              }
            }
          ]
        });
        break;
      }
      case "messageMoved": {
        const relatedThread = space.value.view.threads[announcement.relatedThreads![0]];
        schema.content.push({
          "type": "paragraph",
          "content": [
            { "type": "text", "text": "This message has been moved: " },
            { 
              "type": "channelThreadMention",
              "attrs": {
                "id": JSON.stringify({
                  "ulid": announcement.relatedThreads![0],
                  "space": page.params.space,
                  "type": "thread"
                }),
                "label": relatedThread.title
              }
            }
          ]
        });
        break;
      }
      case "messageDeleted": {
        schema.content.push({
          "type": "paragraph",
          "content": [
            { "type": "text", "text": "This message has been deleted" }
          ]
        });
        break;
      }
    };

    return getContentHtml(JSON.stringify(schema));
  }
</script>

<svelte:window onkeydown={onKeydown} onkeyup={onKeyup} />

<li {id} class={`flex flex-col ${isMobile && "max-w-screen"}`}>
  {@render replyBanner()}

  <div
    class="relative group w-full h-fit flex flex-col gap-4 px-2 py-2.5 hover:bg-white/5 transition-all duration-75"
  >
    {#if isAnnouncement(message)}
      {@render announcementView(message)}
    {:else}
      {@render messageView(message)}
    {/if}

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

        {#if authorProfile}
          <div class="flex flex-col gap-2">
            <Button.Root
              onclick={() => {
                setReplyTo({ id, authorProfile, content: message.content });
                isDrawerOpen = false;
              }}
              class="text-white p-4 flex gap-4 items-center bg-violet-800 w-full rounded-lg"
            >
              <Icon icon="fa6-solid:reply" color="white" />
              Reply
            </Button.Root>
            {#if mayDelete}
              <Button.Root
                onclick={() => deleteMessage(id)}
                class="text-white p-4 flex gap-4 items-center bg-violet-800 w-full rounded-lg"
              >
                <Icon icon="tabler:trash" color="red" />
                Delete
              </Button.Root>
            {/if}
          </div>
        {/if}
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
        {#if shiftDown && mayDelete}
          <Toolbar.Button
            onclick={() => deleteMessage(id)}
            class="p-2 hover:bg-white/5 hover:scale-105 active:scale-95 transition-all duration-150 rounded cursor-pointer"
          >
            <Icon icon="tabler:trash" color="red" />
          </Toolbar.Button>
        {/if}

        {#if authorProfile}
          <Toolbar.Button
            onclick={() =>
              setReplyTo({ id, authorProfile, content: message.content })}
            class="p-2 hover:bg-white/5 hover:scale-105 active:scale-95 transition-all duration-150 rounded cursor-pointer"
          >
            <Icon icon="fa6-solid:reply" color="white" />
          </Toolbar.Button>
        {/if}
      </Toolbar.Root>
    {/if}

    {#if isThreading.value && !isAnnouncement(message)}
      <Checkbox.Root
        onCheckedChange={updateSelect} 
        bind:checked={isSelected}
        class="absolute right-4 inset-y-0"
      >
        {#snippet children({ checked })}
          <div class="border bg-violet-800 size-4 rounded items-center cursor-pointer">
            {#if checked}
              <Icon 
                icon="material-symbols:check-rounded" 
                color="#5b21b6" 
                class="bg-white size-3.5"
              />
            {/if}
          </div>
        {/snippet}
      </Checkbox.Root>
    {/if}
  </div>
</li>

{#snippet announcementView(message: Announcement)}
  <div class="flex gap-4">
    <Button.Root
      onclick={() => {
        if (isMobile) {
          isDrawerOpen = true;
        }
      }}
      class="flex flex-col text-start gap-2 text-white w-full min-w-0"
    >
      <section class="flex items-center gap-2 flex-wrap w-fit">
        {@render timestamp()}
      </section>

      <p
        class="text-sm italic prose-invert chat min-w-0 max-w-full overflow-hidden text-ellipsis"
      >
        {@html getAnnouncementHtml(message)}
      </p>
    </Button.Root>
  </div>
{/snippet}

{#snippet messageView(message: Message)}
  {#if authorProfile}
    <div class="flex gap-4">
      <a
        href={`https://bsky.app/profile/${authorProfile.handle}`}
        target="_blank"
      >
        <AvatarImage
          handle={authorProfile.handle}
          avatarUrl={authorProfile.avatarUrl}
        />
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
            href={`https://bsky.app/profile/${authorProfile.handle}`}
            target="_blank"
          >
            <h5 class="font-bold">{authorProfile.handle}</h5>
          </a>
          {@render timestamp()}
        </section>

        <p
          class="text-lg prose-invert chat min-w-0 max-w-full overflow-hidden text-ellipsis"
        >
          {@html getContentHtml(message.content)}
        </p>
        {#if message.images?.length}
          <div class="flex flex-wrap gap-2 mt-2">
            {#each message.images as image}
              <img
                src={image.source}
                alt={image.alt || ""}
                class="max-w-md max-h-64 rounded-lg object-cover"
                loading="lazy"
              />
            {/each}
          </div>
        {/if}
      </Button.Root>
    </div>
  {/if}
{/snippet}

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
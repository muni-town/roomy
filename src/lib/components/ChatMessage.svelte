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
  };

  let { id, message }: Props = $props();
  let space: { value: Autodoc<Space> } = getContext("space");

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
            { "type": "text", "text": "Moved to: " },
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
  <div
    class="relative group w-full h-fit flex flex-col gap-4 px-2 py-2.5 hover:bg-white/5 transition-all duration-75"
  >
    {#if isAnnouncement(message)}
      {@render announcementView()}
    {:else}
      {@render replyBanner()}
      {@render messageView(id, message)}
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

  </div>
</li>

{#snippet announcementView()}
  {@const announcement = message as Announcement}
  {@render toolbar()}
  <div class="flex flex-col gap-4">
    {#if announcement.kind === "threadCreated"}
      <Button.Root
        onclick={() => {
          if (isMobile) {
            isDrawerOpen = true;
          }
        }}
        class="flex flex-col text-start gap-2 w-full min-w-0"
      >
        <section class="flex items-center gap-2 flex-wrap w-fit">
          {@render timestamp(id)}
        </section>

        <p
          class="text-sm italic prose-invert prose min-w-0 max-w-full overflow-hidden text-ellipsis"
        >
          {@html getAnnouncementHtml(announcement)}
        </p>
      </Button.Root>
    {:else if announcement.kind === "messageMoved"}
      {@const related = space.value.view.messages[announcement.relatedMessages![0]] as Message} 
      <Button.Root
        onclick={() => {
          if (isMobile) {
            isDrawerOpen = true;
          }
        }}
        class="cursor-pointer flex gap-2 text-start w-full items-center text-info-content px-4 py-1 bg-info rounded-t"
      >
        <Icon icon="prime:reply" width="12px" height="12px" />
        <p
          class="text-sm italic prose-invert chat min-w-0 max-w-full overflow-hidden text-ellipsis"
        >
          {@html getAnnouncementHtml(announcement)}
        </p>
        {@render timestamp(id)}
      </Button.Root>
      <div class="flex items-start gap-4">
        {@render messageView(announcement.relatedMessages![0], related)}
      </div>
    {/if}
  </div>
{/snippet}

{#snippet messageView(ulid: Ulid, msg: Message)}
  <!-- doesn't change after render, so $derived is not necessary -->
  {@const authorProfile = getProfile(msg.author)}

  {@render toolbar(authorProfile)}

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
      class="flex flex-col text-start gap-2 w-full min-w-0"
    >
      <section class="flex items-center gap-2 flex-wrap w-fit">
        <a
          href={`https://bsky.app/profile/${authorProfile.handle}`}
          target="_blank"
          class="text-primary hover:underline"
        >
          <h5 class="font-bold">{authorProfile.handle}</h5>
        </a>
        {@render timestamp(ulid)}
      </section>

      <span class="prose select-text">
        {@html getContentHtml(msg.content)}
      </span>
      {#if msg.images?.length}
        <div class="flex flex-wrap gap-2 mt-2">
          {#each msg.images as image}
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
{/snippet}

{#snippet toolbar(authorProfile?: { handle: string, avatarUrl: string })}
  {#if isMobile}
    <Drawer bind:isDrawerOpen>
      <div class="flex gap-4 justify-center mb-4">
        <Button.Root
          onclick={() => {
            toggleReaction(id, "👍");
            isDrawerOpen = false;
          }}
          class="btn btn-circle"
        >
          👍
        </Button.Root>
        <Button.Root
          onclick={() => {
            toggleReaction(id, "😂");
            isDrawerOpen = false;
          }}
          class="btn btn-circle"
        >
          😂
        </Button.Root>
        <Popover.Root bind:open={isEmojiDrawerPickerOpen}>
          <Popover.Trigger class="btn btn-circle">
            <Icon icon="lucide:smile-plus" />
          </Popover.Trigger>
          <Popover.Content>
            <emoji-picker bind:this={emojiDrawerPicker}></emoji-picker>
          </Popover.Content>
        </Popover.Root>
      </div>

      {#if authorProfile}
        <div class="join join-vertical w-full">
          <Button.Root
            onclick={() => {
              setReplyTo({ id, authorProfile, content: (message as Message).content });
              isDrawerOpen = false;
            }}
            class="join-item btn w-full"
          >
            <Icon icon="fa6-solid:reply" />
            Reply
          </Button.Root>
          {#if mayDelete}
            <Button.Root
              onclick={() => deleteMessage(id)}
              class="join-item btn btn-error w-full"
            >
              <Icon icon="tabler:trash" />
              Delete
            </Button.Root>
          {/if}
        </div>
      {/if}
    </Drawer>
  {:else}
    <Toolbar.Root
      class={`${!isEmojiToolbarPickerOpen && "hidden"} group-hover:flex absolute -top-2 right-0 bg-base-300 p-1 rounded items-center`}
    >
      <Toolbar.Button
        onclick={() => toggleReaction(id, "👍")}
        class="btn btn-ghost btn-square"
      >
        👍
      </Toolbar.Button>
      <Toolbar.Button
        onclick={() => toggleReaction(id, "😂")}
        class="btn btn-ghost btn-square"
      >
        😂
      </Toolbar.Button>
      <Popover.Root bind:open={isEmojiToolbarPickerOpen}>
        <Popover.Trigger
          class="btn btn-ghost btn-square"
        >
          <Icon icon="lucide:smile-plus" />
        </Popover.Trigger>
        <Popover.Content>
          <emoji-picker bind:this={emojiToolbarPicker}></emoji-picker>
        </Popover.Content>
      </Popover.Root>
      {#if shiftDown && mayDelete}
        <Toolbar.Button
          onclick={() => deleteMessage(id)}
          class="btn btn-ghost btn-square"
        >
          <Icon icon="tabler:trash" color="red" />
        </Toolbar.Button>
      {/if}

      {#if authorProfile}
        <Toolbar.Button
          onclick={() =>
            setReplyTo({ id, authorProfile, content: (message as Message).content })}
          class="btn btn-ghost btn-square"
        >
          <Icon icon="fa6-solid:reply" />
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
        <div class="border border-primary bg-base-100 text-primary-content size-4 rounded items-center cursor-pointer">
          {#if checked}
            <Icon 
              icon="material-symbols:check-rounded" 
              class="bg-primary size-3.5"
            />
          {/if}
        </div>
      {/snippet}
    </Checkbox.Root>
  {/if}
{/snippet}

{#snippet timestamp(ulid: Ulid)}
  {@const decodedTime = decodeTime(ulid)}
  {@const formattedDate = isToday(decodedTime)
    ? "Today"
    : format(decodedTime, "P")}
  <time class="text-xs">
    {formattedDate}, {format(decodedTime, "pp")}
  </time>
{/snippet}

{#snippet reactionToggle(reaction: string)}
  <Button.Root
    onclick={() => toggleReaction(id, reaction)}
    class={`
      btn
      ${user.profile.data && message.reactions[reaction].includes(user.profile.data.did) ? "bg-accent text-accent-content" : "bg-secondary text-secondary-content"}
    `}
    title={(reactionHandles[reaction] || []).join(", ")}
  >
    {reaction}
    {message.reactions[reaction].length}
  </Button.Root>
{/snippet}

{#snippet replyBanner()}
  {@const messageRepliedTo = !isAnnouncement(message) && message.replyTo && space.value.view.messages[message.replyTo] as Message}
  {@const profileRepliedTo = messageRepliedTo && getProfile(messageRepliedTo.author)}
  {#if messageRepliedTo && profileRepliedTo}
    <Button.Root
      onclick={scrollToReply}
      class="cursor-pointer flex gap-2 text-sm text-start w-full items-center text-secondary-content px-4 py-1 bg-secondary rounded-t"
    >
      <div class="flex basis-1/2 md:basis-auto gap-2 items-center">
        <Icon icon="prime:reply" width="12px" height="12px" />
        <Avatar.Root class="w-4">
          <Avatar.Image src={profileRepliedTo.avatarUrl} class="rounded-full" />
          <Avatar.Fallback>
            <AvatarBeam name={profileRepliedTo.handle} />
          </Avatar.Fallback>
        </Avatar.Root>
        <h5 class="text-secondary-content font-medium text-ellipsis">
          {profileRepliedTo.handle}
        </h5>
      </div>
      <p class="line-clamp-1 basis-1/2 md:basis-auto overflow-hidden italic">
        {@html getContentHtml(messageRepliedTo.content)}
      </p>
    </Button.Root>
  {/if}
{/snippet}
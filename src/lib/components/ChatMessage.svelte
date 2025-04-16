<script lang="ts">
  import { Avatar, Button, Checkbox, Popover, Toolbar } from "bits-ui";
  import { AvatarBeam } from "svelte-boring-avatars";
  import { format, isToday } from "date-fns";
  import { getContext } from "svelte";
  import { getProfile } from "$lib/profile.svelte";
  import Icon from "@iconify/svelte";
  import { user } from "$lib/user.svelte";
  import "emoji-picker-element";
  import { outerWidth } from "svelte/reactivity/window";
  import Drawer from "./Drawer.svelte";
  import AvatarImage from "./AvatarImage.svelte";
  import { getContentHtml } from "$lib/tiptap/editor";
  import { Announcement, Message, type EntityIdStr } from "@roomy-chat/sdk";
  import { g } from "$lib/global.svelte";
  import { derivePromise } from "$lib/utils.svelte";
  import type { JSONContent } from "@tiptap/core";

  type Props = {
    message: Message | Announcement;
    mergeWithPrevious?: boolean;
  };

  let { message, mergeWithPrevious = false }: Props = $props();

  let messageRepliedTo = derivePromise(undefined, async () => {
    if (g.roomy && message.replyTo) {
      return await g.roomy.open(Message, message.replyTo);
    }
  });
  let relatedThreads = derivePromise([], async () => {
    if (message instanceof Announcement) {
      return await message.relatedThreads.items();
    }
    return [];
  });
  let relatedMessages = derivePromise([], async () => {
    if (message instanceof Announcement) {
      return await message.relatedMessages.items();
    }
    return [];
  });

  let isMobile = $derived((outerWidth.current ?? 0) < 640);
  let isDrawerOpen = $state(false);

  let isSelected = $state(false);
  let isThreading: { value: boolean } = getContext("isThreading");

  let emojiDrawerPicker: (HTMLElement & any) | undefined = $state();
  let emojiToolbarPicker: (HTMLElement & any) | undefined = $state();
  let emojiRowPicker: (HTMLElement & any) | undefined = $state();
  let isEmojiDrawerPickerOpen = $state(false);
  let isEmojiToolbarPickerOpen = $state(false);
  let isEmojiRowPickerOpen = $state(false);

  let mayDelete = $derived(
    message.matches(Message) &&
      (g.isAdmin ||
        (user.agent &&
          message
            .forceCast(Message)
            .authors((x) => x.toArray().includes(user.agent!.assertDid)))),
  );

  const selectMessage = getContext("selectMessage") as (
    message: Message,
  ) => void;
  const removeSelectedMessage = getContext("removeSelectedMessage") as (
    message: Message,
  ) => void;
  const setReplyTo = getContext("setReplyTo") as (message: Message) => void;
  const scrollToMessage = getContext("scrollToMessage") as (
    id: EntityIdStr,
  ) => void;

  function deleteMessage() {
    message.softDeleted = true;
    message.commit();
  }

  function onEmojiPick(event: Event & { detail: { unicode: string } }) {
    if (!user.agent) return;
    message.reactions.toggle(event.detail.unicode, user.agent.assertDid);
    message.commit();
    isEmojiToolbarPickerOpen = false;
    isEmojiRowPickerOpen = false;
  }

  function updateSelect() {
    const m = message.tryCast(Message);
    if (isSelected) {
      m && selectMessage(m);
    } else {
      m && removeSelectedMessage(m);
    }
  }

  function toggleReaction(reaction: string) {
    if (!user.agent) return;
    message.reactions.toggle(reaction, user.agent.assertDid);
    message.commit();
  }

  function scrollToReply() {
    if (message.matches(Announcement) || !message.replyTo) {
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
      emojiDrawerPicker.addEventListener(
        "emoji-click",
        (e: Event & { detail: { unicode: string } }) => {
          onEmojiPick(e);
          isEmojiDrawerPickerOpen = false;
          isDrawerOpen = false;
        },
      );
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
    if (!g.space) return "";
    const schema = {
      type: "doc",
      content: [] as Record<string, any>[],
    } satisfies JSONContent;

    switch (announcement.kind) {
      case "threadCreated": {
        schema.content.push({
          type: "paragraph",
          content: [
            { type: "text", text: "A new thread has been created: " },
            {
              type: "channelThreadMention",
              attrs: {
                id: JSON.stringify({
                  id: relatedThreads.value[0]?.id,
                  space: g.space.id,
                  type: "thread",
                }),
                label: relatedThreads.value[0]?.name || "loading...",
              },
            },
          ],
        });
        break;
      }
      case "messageMoved": {
        schema.content.push({
          type: "paragraph",
          content: [
            { type: "text", text: "Moved to: " },
            {
              type: "channelThreadMention",
              attrs: {
                id: JSON.stringify({
                  id: relatedThreads.value[0]?.id,
                  space: g.space.id,
                  type: "thread",
                }),
                label: relatedThreads.value[0]?.name || "loading...",
              },
            },
          ],
        });
        break;
      }
      case "messageDeleted": {
        schema.content.push({
          type: "paragraph",
          content: [{ type: "text", text: "This message has been deleted" }],
        });
        break;
      }
    }

    return getContentHtml(schema);
  }
</script>

<svelte:window onkeydown={onKeydown} onkeyup={onKeyup} />

<li id={message.id} class={`flex flex-col ${isMobile && "max-w-screen"}`}>
  <div
    class={`relative group w-full h-fit flex flex-col gap-4 px-2 ${!mergeWithPrevious && "pt-5"}  hover:bg-white/5 transition-all duration-75`}
  >
    {#if message instanceof Announcement}
      {@render announcementView(message)}
    {:else if message instanceof Message}
      {@render replyBanner()}
      {@render messageView(message)}
    {/if}

    {#if Object.keys(message.reactions.all()).length > 0}
      <div class="flex gap-2 flex-wrap">
        {#each Object.keys(message.reactions.all()) as reaction}
          {@render reactionToggle(reaction)}
        {/each}
        <Popover.Root bind:open={isEmojiRowPickerOpen}>
          <Popover.Trigger
            class="p-2 hover:bg-white/5 hover:scale-105 active:scale-95 transition-all duration-150 rounded cursor-pointer"
          >
            <Icon icon="lucide:smile-plus" color="white" />
          </Popover.Trigger>
          <Popover.Content class="z-10">
            <emoji-picker bind:this={emojiRowPicker}></emoji-picker>
          </Popover.Content>
        </Popover.Root>
      </div>
    {/if}
  </div>
</li>

{#snippet announcementView(announcement: Announcement)}
  {@const relatedMessage = relatedMessages.value[0]}
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
          {#if message.createdDate}
            {@render timestamp(message.createdDate)}
          {/if}
        </section>

        <p
          class="text-sm italic prose-invert prose min-w-0 max-w-full overflow-hidden text-ellipsis"
        >
          {@html getAnnouncementHtml(announcement)}
        </p>
      </Button.Root>
    {:else if announcement.kind === "messageMoved"}
      {#if !mergeWithPrevious}
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
          {#if message.createdDate}
            {@render timestamp(message.createdDate)}
          {/if}
        </Button.Root>
      {/if}
      <div class="ml-0 border-l-2 border-info pt-0.5 pl-2">
        {#if relatedMessage}
          {@render messageView(relatedMessage)}
        {/if}
      </div>
    {/if}
  </div>
{/snippet}

{#snippet messageView(msg: Message)}
  <!-- doesn't change after render, so $derived is not necessary -->
  {@const authorProfile = getProfile(msg.authors((x) => x.get(0)))}

  {#await authorProfile then authorProfile}
    {@render toolbar(authorProfile)}

    <div class="flex gap-4 group">
      {#if !mergeWithPrevious}
        <a
          href={`https://bsky.app/profile/${authorProfile.handle}`}
          title={authorProfile.handle}
          target="_blank"
        >
          <AvatarImage
            handle={authorProfile.handle}
            avatarUrl={authorProfile.avatarUrl}
          />
        </a>
      {:else}
        <div
          class="w-10 flex items-center justify-center relative group select-none pointer-events-none"
        >
          <AvatarImage
            handle={authorProfile.handle}
            className="opacity-0 pointer-events-none select-none"
          />
          {#if message.createdDate}
            <span
              class="opacity-0 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-[8px] text-gray-300 transition-opacity duration-200 whitespace-nowrap group-hover:opacity-100"
            >
              {format(message.createdDate, "pp")}
            </span>
          {/if}
        </div>
      {/if}

      <Button.Root
        onclick={() => {
          if (isMobile) {
            isDrawerOpen = true;
          }
        }}
        class="flex flex-col text-start gap-2 w-full min-w-0"
      >
        {#if !mergeWithPrevious}
          <section class="flex items-center gap-2 flex-wrap w-fit">
            <a
              href={`https://bsky.app/profile/${authorProfile.handle}`}
              target="_blank"
              class="text-primary hover:underline"
            >
              <h5 class="font-bold" title={authorProfile.handle}>
                {authorProfile.displayName || authorProfile.handle}
              </h5>
            </a>
            {@render timestamp(message.createdDate || new Date())}
          </section>
        {/if}

        <span class="prose select-text">
          {@html getContentHtml(JSON.parse(msg.bodyJson))}
        </span>
        <!-- TODO: images. -->
        <!-- {#if msg.images?.length}
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
      {/if} -->
      </Button.Root>
    </div>
  {/await}
{/snippet}

{#snippet toolbar(authorProfile?: { handle: string; avatarUrl: string })}
  {#if !g.isBanned}
    {#if isMobile}
      <Drawer bind:isDrawerOpen>
        <div class="flex gap-4 justify-center mb-4">
          <Button.Root
            onclick={() => {
              toggleReaction("👍");
              isDrawerOpen = false;
            }}
            class="btn btn-circle"
          >
            👍
          </Button.Root>
          <Button.Root
            onclick={() => {
              toggleReaction("😂");
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
            <Popover.Content class="z-10">
              <emoji-picker bind:this={emojiDrawerPicker}></emoji-picker>
            </Popover.Content>
          </Popover.Root>
        </div>

        {#if authorProfile}
          <div class="join join-vertical w-full">
            {#if message instanceof Message}
              <Button.Root
                onclick={() => {
                  setReplyTo(message);
                  isDrawerOpen = false;
                }}
                class="join-item btn w-full"
              >
                <Icon icon="fa6-solid:reply" />
                Reply
              </Button.Root>
            {/if}
            {#if mayDelete}
              <Button.Root
                onclick={() => deleteMessage()}
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
          onclick={() => toggleReaction("👍")}
          class="btn btn-ghost btn-square"
        >
          👍
        </Toolbar.Button>
        <Toolbar.Button
          onclick={() => toggleReaction("😂")}
          class="btn btn-ghost btn-square"
        >
          😂
        </Toolbar.Button>
        <Popover.Root bind:open={isEmojiToolbarPickerOpen}>
          <Popover.Trigger class="btn btn-ghost btn-square">
            <Icon icon="lucide:smile-plus" />
          </Popover.Trigger>
          <Popover.Content class="z-10">
            <emoji-picker bind:this={emojiToolbarPicker}></emoji-picker>
          </Popover.Content>
        </Popover.Root>
        {#if shiftDown && mayDelete}
          <Toolbar.Button
            onclick={() => deleteMessage()}
            class="btn btn-ghost btn-square"
          >
            <Icon icon="tabler:trash" color="red" />
          </Toolbar.Button>
        {/if}

        {#if authorProfile && message instanceof Message}
          <Toolbar.Button
            onclick={() => setReplyTo(message)}
            class="btn btn-ghost btn-square"
          >
            <Icon icon="fa6-solid:reply" />
          </Toolbar.Button>
        {/if}
      </Toolbar.Root>
    {/if}

    {#if isThreading.value && message instanceof Message}
      <Checkbox.Root
        onCheckedChange={updateSelect}
        bind:checked={isSelected}
        class="absolute right-4 inset-y-0"
      >
        {#snippet children({ checked }: { checked: boolean })}
          <div
            class="border border-primary bg-base-100 text-primary-content size-4 rounded items-center cursor-pointer"
          >
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
  {/if}
{/snippet}

{#snippet timestamp(date: Date)}
  {@const formattedDate = isToday(date) ? "Today" : format(date, "P")}
  <time class="text-xs">
    {formattedDate}, {format(date, "pp")}
  </time>
{/snippet}

{#snippet reactionToggle(reaction: string)}
  {@const reactions = message.reactions.all()[reaction]}
  {#if reactions}
    {#await Promise.all([...reactions.values()].map( (x) => getProfile(x), )) then profilesThatReacted}
      <Button.Root
        onclick={() => toggleReaction(reaction)}
        class={`
      btn
      ${user.agent && reactions.has(user.agent.assertDid) ? "bg-accent text-accent-content" : "bg-secondary text-secondary-content"}
    `}
        title={profilesThatReacted
          .map((x) => x.displayName || x.handle)
          .join(", ")}
      >
        {reaction}
        {message.reactions.all()[reaction]?.size}
      </Button.Root>
    {/await}
  {/if}
{/snippet}

{#snippet replyBanner()}
  {@const profileRepliedTo =
    messageRepliedTo.value &&
    getProfile(messageRepliedTo.value.authors((x) => x.get(0)))}
  {#await profileRepliedTo then profileRepliedTo}
    {#if messageRepliedTo.value && profileRepliedTo}
      <Button.Root
        onclick={scrollToReply}
        class="cursor-pointer flex gap-2 text-sm text-start w-full items-center text-secondary-content px-4 py-1 bg-secondary rounded-t"
      >
        <div class="flex basis-1/2 md:basis-auto gap-2 items-center">
          <Icon icon="prime:reply" width="12px" height="12px" />
          <Avatar.Root class="w-4">
            <Avatar.Image
              src={profileRepliedTo.avatarUrl}
              class="rounded-full"
            />
            <Avatar.Fallback>
              <AvatarBeam name={profileRepliedTo.handle} />
            </Avatar.Fallback>
          </Avatar.Root>
          <h5 class="text-secondary-content font-medium text-ellipsis">
            {profileRepliedTo.handle}
          </h5>
        </div>
        <p class="line-clamp-1 basis-1/2 md:basis-auto overflow-hidden italic">
          {@html getContentHtml(JSON.parse(messageRepliedTo.value.bodyJson))}
        </p>
      </Button.Root>
    {/if}
  {/await}
{/snippet}

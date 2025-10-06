<script lang="ts" module>
  export let editingMessage = $state({ id: "" });
</script>

<script lang="ts">
  import { Avatar, Checkbox } from "bits-ui";
  import { AvatarBeam } from "svelte-boring-avatars";
  import { format, isToday } from "date-fns";
  import MessageToolbar from "./MessageToolbar.svelte";
  import MessageRepliedTo from "./MessageRepliedTo.svelte";
  import MessageReactions from "./MessageReactions.svelte";
  import ChatInput from "../ChatInput.svelte";
  import IconTablerCheck from "~icons/tabler/check";
  // import MessageRepliedTo from "./MessageRepliedTo.svelte";
  // import ImageUrlEmbed from "./embeds/ImageUrlEmbed.svelte";
  // import { convertReactionsToEmojis } from "$lib/utils/reactions";
  // import MessageThreadBadge from "./MessageThreadBadge.svelte";
  // import VideoUrlEmbed from "./embeds/VideoUrlEmbed.svelte";
  import { goto } from "$app/navigation";
  // import { Badge } from "@fuxui/base";
  import { renderMarkdownSanitized } from "$lib/markdown";
  import type { Message } from "../ChatArea.svelte";
  import { backendStatus } from "$lib/workers";
  import { decodeTime } from "ulidx";
  import { current } from "$lib/queries.svelte";
  import { toast } from "@fuxui/base";

  let {
    message,
    threading,
    startThreading,
    toggleSelect,
  }: {
    message: Message;
    threading?: { active: boolean; selectedMessages: Message[]; name: string };
    startThreading: (message?: Message) => void;
    toggleSelect: (message: Message) => void;
  } = $props();

  // TODO: move this author can masquerade logic into the materializer so we don't have to
  // re-hash this in the UI.
  let authorCanMasquerade = $derived(true);
  let metadata: {
    id: string;
    name?: string;
    handle?: string;
    avatarUrl?: string;
    appTag?: string;
    timestamp: Date;
    profileUrl?: string;
  } = $derived.by(() => {
    const defaultInfo = {
      id: message.authorDid,
      name: message.authorName,
      handle: message.authorHandle,
      avatarUrl: message.authorAvatar,
      timestamp: new Date(decodeTime(message.id)),
      profileUrl: `/user/${message.authorDid}`,
    };
    if (!authorCanMasquerade) return defaultInfo;
    if (!message.masqueradeAuthor) return defaultInfo;

    try {
      return {
        id: message.masqueradeAuthor,
        handle: message.masqueradeAuthorHandle,
        name: message.masqueradeAuthorName,
        avatarUrl: message.masqueradeAuthorAvatar,
        timestamp: message.masqueradeTimestamp
          ? new Date(message.masqueradeTimestamp)
          : new Date(decodeTime(message.id)),
      };
    } catch (_) {}

    return defaultInfo;
  });

  let messageByMe = $derived(message.authorDid == backendStatus.did);
  let canDelete = $derived(current.isSpaceAdmin || messageByMe);

  // let previousMessage = $derived(new CoState(RoomyEntity, previousMessageId));

  // let profile = $derived(
  //   new CoState(
  //     RoomyProfile,
  //     message.current?._edits.components?.by?.profile?.id,
  //   ),
  // );

  // let customAuthor = $derived(
  //   new CoState(
  //     AuthorComponent,
  //     message.current?.components?.[AuthorComponent.id],
  //   ),
  // );
  // let prevMessageCustomAuthor = $derived(
  //   new CoState(
  //     AuthorComponent,
  //     previousMessage.current?.components?.[AuthorComponent.id],
  //   ),
  // );
  // let userAccessTimes = $derived(
  //   new CoState(
  //     UserAccessTimesComponent,
  //     message.current?.components?.[UserAccessTimesComponent.id],
  //   ),
  // );
  // let prevMessageUserAccessTimes = $derived(
  //   new CoState(
  //     UserAccessTimesComponent,
  //     previousMessage.current?.components?.[UserAccessTimesComponent.id],
  //   ),
  // );
  // let messageContent = $derived(
  //   new CoState(
  //     CommonMarkContentComponent,
  //     message.current?.components?.[CommonMarkContentComponent.id],
  //   ),
  // );

  // let embeds = $derived(
  //   new CoState(
  //     EmbedsComponent,
  //     message.current?.components?.[EmbedsComponent.id],
  //   ),
  // );

  // let hiddenIn = $derived(
  //   new CoState(
  //     HiddenInComponent,
  //     message.current?.components?.[HiddenInComponent.id],
  //   ),
  // );

  // let reactions = $derived(
  //   new CoState(
  //     ReactionsComponent,
  //     message.current?.components?.[ReactionsComponent.id],
  //   ),
  // );

  // const authorData = $derived.by(() => {
  //   if (customAuthor.current) return customAuthor.current;
  //   return profile.current;
  // });

  let isDrawerOpen = $state(false);

  let isSelected = $derived(
    threading?.selectedMessages.find((x) => x.id == message.id) ?? false,
  );

  function deleteMessage() {
    // if (!message.current) return;
    // message.current.softDeleted = true;
  }

  function editMessage() {
    // editingMessage.id = message;
  }

  function saveEditedMessage(content: string) {
    // if (!messageContent.current || !userAccessTimes.current) return;
    // // if the content is the same, dont save
    // if (messageContent.current?.content === content) {
    //   editingMessage.id = "";
    //   return;
    // }
    // messageContent.current.content = content;
    // userAccessTimes.current.updatedAt = new Date();
    // editingMessage.id = "";
  }

  function cancelEditing() {
    // editingMessage.id = "";
  }

  let isMessageEdited = $derived.by(() => {
    // if (!message.current) return false;
    // if (
    //   !userAccessTimes.current?.createdAt ||
    //   !userAccessTimes.current?.updatedAt
    // )
    //   return false;
    // // if time between createdAt and updatedAt is less than 1 minute, we dont consider it edited
    // return (
    //   userAccessTimes.current?.updatedAt.getTime() -
    //     userAccessTimes.current?.createdAt.getTime() >
    //   1000 * 60
    // );
  });

  function removeReaction(emoji: string) {
    // let index = reactions.current?.reactions?.findIndex(
    //   (reaction) =>
    //     reaction?.emoji === emoji &&
    //     reaction?._edits.emoji?.by?.profile?.id === me.current?.profile?.id,
    // );
    // if (index === undefined || index < 0) return;
    // reactions.current?.reactions?.splice(index, 1);
  }

  function addReaction(emoji: string) {
    // reactions.current?.reactions?.push(
    //   Reaction.create(
    //     {
    //       emoji: emoji,
    //     },
    //     {
    //       owner: publicGroup("reader"),
    //     },
    //   ),
    // );
  }
  let reactionsEmojis = $derived(
    [],
    // convertReactionsToEmojis(reactions.current?.reactions, me.current),
  );

  function toggleReaction(emoji: string) {
    // // check if the emoji is already in the reactions array with the current user
    // let index = reactionsEmojis?.findIndex(
    //   (reaction) => reaction.emoji === emoji && reaction.user,
    // );
    // if (index === undefined || index < 0) {
    //   addReaction(emoji);
    // } else {
    //   removeReaction(emoji);
    // }
  }

  const selectMessage = () => {
    // if (threading?.active) {
    //   if (!isSelected && !messageByMe && !isAdmin) {
    //     toast.error("You cannot move someone else's message");
    //     return;
    //   }
    //   toggleSelect(message);
    // }
  };
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div
  id={message.id}
  class={`flex flex-col w-full relative max-w-screen isolate px-4 ${threading?.active ? "select-none" : ""}`}
  onclick={selectMessage}
>
  {#if threading?.active}
    <Checkbox.Root
      aria-label="Select message"
      onclick={(e) => e.stopPropagation()}
      bind:checked={
        () => isSelected,
        (value) => {
          if (value && !messageByMe && !current.isSpaceAdmin) {
            toast.error("You cannot move someone else's message");
            return;
          }
          toggleSelect(message);
        }
      }
      class="absolute right-8 inset-y-0 z-10"
    >
      <div
        class="border border-primary bg-base-50 text-primary-content size-4 rounded items-center cursor-pointer"
      >
        {#if isSelected}
          <IconTablerCheck class="bg-primary size-3.5 dark:text-black" />
        {/if}
      </div>
    </Checkbox.Root>
  {/if}

  <div
    class={[
      `relative group w-full h-fit flex flex-col gap-2 px-2 pt-2 pb-1 ${isSelected ? "bg-accent-100/50 dark:bg-accent-900/50 hover:bg-accent-100/75 dark:hover:bg-accent-900/75" : " hover:bg-base-100/50  dark:hover:bg-base-400/5"}`,
      !message.mergeWithPrevious && "pt-3",
    ]}
  >
    {#if message.replyTo}
      <MessageRepliedTo messageId={message.replyTo} />
    {/if}

    <div class={"group relative flex w-full justify-start gap-3"}>
      {#if !message.mergeWithPrevious}
        <div class="size-8 sm:size-10">
          <button
            onclick={async (e) => {
              e.stopPropagation();
              // Navigate to user profile page
              if (metadata.profileUrl) {
                goto(metadata.profileUrl);
              }
            }}
            class="rounded-full hover:ring-2 hover:ring-accent-500 transition-all cursor-pointer"
          >
            <Avatar.Root class="size-8 sm:size-10">
              <Avatar.Image src={metadata.avatarUrl} class="rounded-full" />
              <Avatar.Fallback>
                <AvatarBeam name={metadata.id} />
              </Avatar.Fallback>
            </Avatar.Root>
          </button>
        </div>
      {:else}
        <div class="w-8 shrink-0 sm:w-10"></div>
      {/if}

      <div class="flex flex-col gap-1">
        {#if !message.mergeWithPrevious}
          <span class="flex items-center gap-2 text-sm">
            <span class="font-bold text-accent-700 dark:text-accent-400"
              >{metadata.name}</span
            >
            <!-- {#if customAuthor.current && customAuthor.current.authorId?.startsWith("discord:")}
              <Badge
                variant="secondary"
                title="This message is being bridged into this space via a Discord.com instance."
                >Discord</Badge
              >
            {:else if customAuthor.current}
              <Badge variant="secondary">App</Badge>
            {/if} -->
            {@render timestamp(metadata.timestamp)}
          </span>
        {/if}
        <div
          class="prose prose-a:text-accent-600 dark:prose-a:text-accent-400 dark:prose-invert prose-a:no-underline max-w-full"
        >
          {#if editingMessage.id === message.id}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              onkeydown={(e) => {
                if (e.key === "Escape") {
                  cancelEditing();
                }
              }}
            >
              <ChatInput
                content={message.content}
                onEnter={saveEditedMessage}
                setFocus={true}
              />

              <div class="text-xs text-base-content mt-1">
                Press <kbd class="text-accent-600 dark:text-accent-400"
                  >Enter</kbd
                >
                to save,
                <kbd class="text-accent-600 dark:text-accent-400 font-medium"
                  >Escape</kbd
                > to cancel
              </div>
            </div>
          {:else}
            {@html renderMarkdownSanitized(message.content)}

            <!-- {#if isMessageEdited && userAccessTimes.current?.updatedAt}
              <div class="text-xs text-base-700 dark:text-base-400">
                Edited {@render timestamp(userAccessTimes.current?.updatedAt)}
              </div>
            {/if} -->
          {/if}
        </div>
      </div>
    </div>

    {#if editingMessage.id !== message.id && !threading?.active}
      <MessageToolbar
        bind:isDrawerOpen
        {toggleReaction}
        canEdit={messageByMe}
        {canDelete}
        {deleteMessage}
        {editMessage}
        startThreading={() => startThreading(message)}
        {message}
      />
    {/if}

    <button
      onclick={() => (isDrawerOpen = true)}
      class="block pointer-fine:hidden absolute inset-0 w-full h-full"
    >
      <span class="sr-only">Open toolbar</span>
    </button>

    <!-- <div class="pl-11 md:pl-13 max-w-full flex flex-wrap gap-2 z-10">
      {#each embeds.current?.embeds ?? [] as embed}
        {#if embed?.type === "imageUrl"}
          <ImageUrlEmbed embedId={embed.embedId} />
        {/if}
        {#if embed?.type === "videoUrl"}
          <VideoUrlEmbed embedId={embed.embedId} />
        {/if}
      {/each}
    </div> -->
    <!-- 
    {#if message.current?.components?.[BranchThreadIdComponent.id] && message.current?.components?.[BranchThreadIdComponent.id] !== threadId}
      <MessageThreadBadge
        threadId={message.current?.components?.[BranchThreadIdComponent.id]!}
        spaceId={space?.id ?? ""}
      />
    {/if} -->

    <MessageReactions reactions={reactionsEmojis} {toggleReaction} />
  </div>
</div>

{#snippet timestamp(date: Date)}
  {@const formattedDate = isToday(date) ? "Today" : format(date, "P")}
  <time class="text-xs text-base-700 dark:text-base-400">
    {formattedDate}, {format(date, "pp")}
  </time>
{/snippet}

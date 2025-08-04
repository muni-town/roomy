<script lang="ts" module>
  export let editingMessage = $state({ id: "" });

  export let replyTo = $state({ id: "" });
</script>

<script lang="ts">
  import { Avatar, Checkbox } from "bits-ui";
  import { AvatarBeam } from "svelte-boring-avatars";
  import { format, isToday } from "date-fns";
  import Icon from "@iconify/svelte";
  import { AccountCoState, CoState } from "jazz-tools/svelte";
  import {
    AuthorComponent,
    PlainTextContentComponent,
    Reaction,
    ReplyToComponent,
    RoomyAccount,
    RoomyEntity,
    RoomyProfile,
    BranchThreadIdComponent,
    UserAccessTimesComponent,
    publicGroup,
    EmbedsComponent,
    HiddenInComponent,
    ReactionsComponent,
  } from "@roomy-chat/sdk";
  import { co } from "jazz-tools";
  import MessageToolbar from "./MessageToolbar.svelte";
  import MessageReactions from "./MessageReactions.svelte";
  import ChatInput from "../ChatInput.svelte";
  import MessageRepliedTo from "./MessageRepliedTo.svelte";
  import toast from "svelte-french-toast";
  import ImageUrlEmbed from "./embeds/ImageUrlEmbed.svelte";
  import { setInputFocus } from "../ChatInput.svelte";
  import { convertReactionsToEmojis } from "$lib/utils/reactions";
  import MessageThreadBadge from "./MessageThreadBadge.svelte";
  import VideoUrlEmbed from "./embeds/VideoUrlEmbed.svelte";
  import { goto } from "$app/navigation";
  import { Badge } from "@fuxui/base";

  let {
    messageId,
    previousMessageId,
    isAdmin,
    space,
    threadId,
    allowedToInteract,
    threading,
    startThreading,
    toggleSelect,
  }: {
    messageId: string;
    previousMessageId?: string;
    isAdmin?: boolean;
    space: co.loaded<typeof RoomyEntity> | undefined | null;
    threadId?: string;
    allowedToInteract?: boolean;
    threading?: { active: boolean; selectedMessages: string[] };
    startThreading: () => void;
    toggleSelect: (id: string) => void;
  } = $props();

  const me = new AccountCoState(RoomyAccount, {
    resolve: {
      profile: true,
      root: true,
    },
  });

  let message = $derived(
    new CoState(RoomyEntity, messageId, {
      resolve: {
        components: {
          $each: true,
          $onError: null,
        },
      },
    }),
  );

  let messageByMe = $derived(
    message.current?._edits.components?.by?.profile?.id ===
      me.current?.profile?.id,
  );
  let canDelete = $derived(isAdmin || messageByMe);

  let previousMessage = $derived(new CoState(RoomyEntity, previousMessageId));

  let profile = $derived(
    new CoState(
      RoomyProfile,
      message.current?._edits.components?.by?.profile?.id,
    ),
  );

  let author = $derived(message.current?.components?.[AuthorComponent.id]);
  let prevMessageAuthor = $derived(
    previousMessage.current?.components?.[AuthorComponent.id],
  );
  let userAccessTimes = $derived(
    new CoState(
      UserAccessTimesComponent.schema,
      message.current?.components?.[UserAccessTimesComponent.id],
    ),
  );
  let prevMessageUserAccessTimes = $derived(
    new CoState(
      UserAccessTimesComponent.schema,
      previousMessage.current?.components?.[UserAccessTimesComponent.id],
    ),
  );
  let messageContent = $derived(
    new CoState(
      PlainTextContentComponent.schema,
      message.current?.components?.[PlainTextContentComponent.id],
    ),
  );

  let embeds = $derived(
    new CoState(
      EmbedsComponent.schema,
      message.current?.components?.[EmbedsComponent.id],
    ),
  );

  let hiddenIn = $derived(
    new CoState(
      HiddenInComponent.schema,
      message.current?.components?.[HiddenInComponent.id],
    ),
  );

  let reactions = $derived(
    new CoState(
      ReactionsComponent.schema,
      message.current?.components?.[ReactionsComponent.id],
    ),
  );

  let isImportedMessage = $derived(
    author?.startsWith("discord:") ||
      author?.startsWith("app:") ||
      author?.startsWith("atproto") ||
      author?.startsWith("twitter:"),
  );

  const authorData = $derived.by(() => {
    // if the message has an author in the format of discord:username:avatarUrl or atproto||handle||displayName||did||uri||avatar,
    // and the message is made by the admin, return the profile data otherwise return profile data
    if (isImportedMessage) {
      if (author?.startsWith("atproto")) {
        // ATProto format: atproto||handle||displayName||did||uri||avatar
        const authorSplit = author.split("||");
        const avatarUrl = authorSplit?.[5]
          ? decodeURIComponent(authorSplit[5])
          : "";
        // console.log(`👤 ATProto author data - Handle: ${author?.[1]}, Display: ${author?.[2]}, Avatar: ${avatarUrl}`);
        return {
          name: `${authorSplit?.[2] ?? authorSplit?.[1] ?? "Unknown"} (@${authorSplit?.[1] ?? "unknown"})`,
          imageUrl: avatarUrl,
          id: undefined,
        };
      } else {
        // Discord format: discord:username:avatarUrl
        const authorSplit = author?.split(":");
        return {
          name: authorSplit?.[1] ?? "Unknown",
          imageUrl: decodeURIComponent(authorSplit?.[2] ?? ""),
          id: undefined,
        };
      }
    }
    return profile.current;
  });

  // if the same user and the message was created in the last 5 minutes, don't show the border, username or avatar
  let mergeWithPrevious = $derived.by(() => {
    if (!previousMessage) return false;
    if (previousMessage.current?.softDeleted) return false;

    if (isImportedMessage) {
      // Handle ATProto with || delimiter
      if (
        author?.startsWith("atproto") &&
        prevMessageAuthor?.startsWith("atproto")
      ) {
        const previousAuthor = prevMessageAuthor.split("||");
        const currentAuthor = author.split("||");

        // Compare by handle (index 1) and DID (index 3)
        if (
          previousAuthor?.[1] === currentAuthor?.[1] &&
          previousAuthor?.[3] === currentAuthor?.[3]
        ) {
          return (
            (userAccessTimes.current?.createdAt.getTime() ?? 0) -
              (prevMessageUserAccessTimes?.current?.createdAt.getTime() ?? 0) <
            1000 * 60 * 5
          );
        } else {
          return false;
        }
      }
      // Handle Discord with : delimiter
      else {
        const previousAuthor = prevMessageAuthor?.split(":");
        const currentAuthor = author?.split(":");

        if (
          previousAuthor?.[1] === currentAuthor?.[1] &&
          previousAuthor?.[2] === currentAuthor?.[2]
        ) {
          return (
            (userAccessTimes.current?.createdAt.getTime() ?? 0) -
              (prevMessageUserAccessTimes?.current?.createdAt.getTime() ?? 0) <
            1000 * 60 * 5
          );
        } else {
          return false;
        }
      }
    }
    if (
      authorData?.id === profile.current?.id &&
      previousMessage.current?._edits.components?.by?.profile?.id !==
        message.current?._edits.components?.by?.profile?.id
    )
      return false;
    if (message.current?.components?.[ReplyToComponent.id]) return false;
    return (
      (userAccessTimes.current?.createdAt.getTime() ?? 0) -
        (prevMessageUserAccessTimes?.current?.createdAt.getTime() ?? 0) <
      1000 * 60 * 5
    );
  });

  let isDrawerOpen = $state(false);

  let isSelected = $derived(
    threading?.selectedMessages.includes(messageId) ?? false,
  );

  function deleteMessage() {
    if (!message.current) return;
    message.current.softDeleted = true;
  }

  function editMessage() {
    editingMessage.id = messageId;
  }

  function saveEditedMessage(content: string) {
    if (!messageContent.current || !userAccessTimes.current) return;

    // if the content is the same, dont save
    if (messageContent.current?.content === content) {
      editingMessage.id = "";
      return;
    }

    messageContent.current.content = content;
    userAccessTimes.current.updatedAt = new Date();
    editingMessage.id = "";
  }

  function cancelEditing() {
    editingMessage.id = "";
  }

  let isMessageEdited = $derived.by(() => {
    if (!message.current) return false;
    if (
      !userAccessTimes.current?.createdAt ||
      !userAccessTimes.current?.updatedAt
    )
      return false;
    // if time between createdAt and updatedAt is less than 1 minute, we dont consider it edited
    return (
      userAccessTimes.current?.updatedAt.getTime() -
        userAccessTimes.current?.createdAt.getTime() >
      1000 * 60
    );
  });

  function setReplyTo() {
    replyTo.id = message.current?.id ?? "";
    setInputFocus();
  }

  function removeReaction(emoji: string) {
    let index = reactions.current?.reactions?.findIndex(
      (reaction) =>
        reaction?.emoji === emoji &&
        reaction?._edits.emoji?.by?.profile?.id === me.current?.profile?.id,
    );
    if (index === undefined || index < 0) return;
    reactions.current?.reactions?.splice(index, 1);
  }

  function addReaction(emoji: string) {
    reactions.current?.reactions?.push(
      Reaction.create(
        {
          emoji: emoji,
        },
        {
          owner: publicGroup("reader"),
        },
      ),
    );
  }
  let reactionsEmojis = $derived(
    convertReactionsToEmojis(reactions.current?.reactions, me.current),
  );

  function toggleReaction(emoji: string) {
    // check if the emoji is already in the reactions array with the current user
    let index = reactionsEmojis?.findIndex(
      (reaction) => reaction.emoji === emoji && reaction.user,
    );

    if (index === undefined || index < 0) {
      addReaction(emoji);
    } else {
      removeReaction(emoji);
    }
  }

  let hiddenInSet = $derived(new Set(hiddenIn.current?.hiddenIn ?? []));

  let shouldShow = $derived.by(() => {
    if (!message.current) return false;
    if (message.current.softDeleted) return false;
    // if (!admin || !messageHasAdmin(message.current, admin)) return false;
    if (hiddenInSet.has(threadId ?? "")) return false;
    return true;
  });

  const selectMessage = () => {
    if (threading?.active) {
      if (!isSelected && !messageByMe && !isAdmin) {
        toast.error("You cannot move someone else's message");
        return;
      }

      toggleSelect(messageId);
    }
  };
</script>

{#if shouldShow}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    id={message.current?.id}
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
            if (value && !messageByMe && !isAdmin) {
              toast.error("You cannot move someone else's message");
              return;
            }
            toggleSelect(messageId);
          }
        }
        class="absolute right-8 inset-y-0 z-10"
      >
        <div
          class="border border-primary bg-base-50 text-primary-content size-4 rounded items-center cursor-pointer"
        >
          {#if isSelected}
            <Icon
              icon="material-symbols:check-rounded"
              class="bg-primary size-3.5 dark:text-black"
            />
          {/if}
        </div>
      </Checkbox.Root>
    {/if}
    <div
      class={[
        `relative group w-full h-fit flex flex-col gap-2 px-2 pt-2 pb-1 ${isSelected ? "bg-accent-100/50 dark:bg-accent-900/50 hover:bg-accent-100/75 dark:hover:bg-accent-900/75" : " hover:bg-base-100/50  dark:hover:bg-base-400/5"}`,
        !mergeWithPrevious && "pt-3",
      ]}
    >
      {#if message.current?.components?.[ReplyToComponent.id]}
        <MessageRepliedTo
          messageId={message.current?.components?.[ReplyToComponent.id]}
        />
      {/if}

      <div class={"group relative flex w-full justify-start gap-3"}>
        {#if !mergeWithPrevious}
          <div class="size-8 sm:size-10">
            <button
              onclick={async (e) => {
                e.stopPropagation();
                // Navigate to user profile page
                const userId =
                  message.current?._edits.components?.by?.id || authorData?.id;
                if (userId) {
                  goto(`/user/${userId}`);
                }
              }}
              class="rounded-full hover:ring-2 hover:ring-accent-500 transition-all cursor-pointer"
            >
              <Avatar.Root class="size-8 sm:size-10">
                <Avatar.Image src={authorData?.imageUrl} class="rounded-full" />
                <Avatar.Fallback>
                  <AvatarBeam name={authorData?.id ?? authorData?.name ?? ""} />
                </Avatar.Fallback>
              </Avatar.Root>
            </button>
          </div>
        {:else}
          <div class="w-8 shrink-0 sm:w-10"></div>
        {/if}

        <div class="flex flex-col gap-1">
          {#if !mergeWithPrevious || !message.current}
            <span class="flex items-center gap-2 text-sm">
              <span class="font-bold text-accent-700 dark:text-accent-400"
                >{authorData?.name ?? ""}</span
              >
              {#if isImportedMessage}
                <Badge variant="secondary">App</Badge>
              {/if}
              {#if userAccessTimes.current?.createdAt}
                {@render timestamp(userAccessTimes.current?.createdAt)}
              {/if}
            </span>
          {/if}
          <div
            class="prose prose-a:text-accent-600 dark:prose-a:text-accent-400 dark:prose-invert prose-a:no-underline max-w-full"
          >
            {#if editingMessage.id === messageId}
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div
                onkeydown={(e) => {
                  if (e.key === "Escape") {
                    cancelEditing();
                  }
                }}
              >
                <ChatInput
                  content={messageContent.current?.content.toString() ?? ""}
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
              {@html messageContent.current?.content ?? ""}

              {#if isMessageEdited && userAccessTimes.current?.updatedAt}
                <div class="text-xs text-base-700 dark:text-base-400">
                  Edited {@render timestamp(userAccessTimes.current?.updatedAt)}
                </div>
              {/if}
            {/if}
          </div>
        </div>
      </div>

      {#if editingMessage.id !== messageId && !threading?.active && allowedToInteract}
        <MessageToolbar
          bind:isDrawerOpen
          {toggleReaction}
          canEdit={messageByMe}
          {canDelete}
          {deleteMessage}
          {editMessage}
          {startThreading}
          {setReplyTo}
        />
      {/if}

      <button
        onclick={() => (isDrawerOpen = true)}
        class="block pointer-fine:hidden absolute inset-0 w-full h-full"
      >
        <span class="sr-only">Open toolbar</span>
      </button>

      <div class="pl-11 md:pl-13 max-w-full flex flex-wrap gap-2 z-10">
        {#each embeds.current?.embeds ?? [] as embed}
          {#if embed?.type === "imageUrl"}
            <ImageUrlEmbed embedId={embed.embedId} />
          {/if}
          {#if embed?.type === "videoUrl"}
            <VideoUrlEmbed embedId={embed.embedId} />
          {/if}
        {/each}
      </div>

      {#if message.current?.components?.[BranchThreadIdComponent.id] && message.current?.components?.[BranchThreadIdComponent.id] !== threadId}
        <MessageThreadBadge
          threadId={message.current?.components?.[BranchThreadIdComponent.id]!}
          spaceId={space?.id ?? ""}
        />
      {/if}

      <MessageReactions reactions={reactionsEmojis} {toggleReaction} />
    </div>
  </div>
{/if}

{#snippet timestamp(date: Date)}
  {@const formattedDate = isToday(date) ? "Today" : format(date, "P")}
  <time class="text-xs text-base-700 dark:text-base-400">
    {formattedDate}, {format(date, "pp")}
  </time>
{/snippet}

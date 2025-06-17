<script lang="ts" module>
  export let editingMessage = $state({ id: "" });

  export let replyTo = $state({ id: "" });
</script>

<script lang="ts">
  import { Avatar, Checkbox } from "bits-ui";
  import { AvatarBeam } from "svelte-boring-avatars";
  import { format, isToday } from "date-fns";
  import Icon from "@iconify/svelte";
  import { AccountCoState, CoState } from "jazz-svelte";
  import {
    Message,
    Reaction,
    RoomyAccount,
    RoomyProfile,
    Space,
  } from "$lib/jazz/schema";
  import { Account, co } from "jazz-tools";
  import MessageToolbar from "./Message/MessageToolbar.svelte";
  import {
    makeSpaceAdmin,
    messageHasAdmin,
    publicGroup,
  } from "$lib/jazz/utils";
  import MessageReactions from "./Message/MessageReactions.svelte";
  import ChatInput from "./ChatInput.svelte";
  import MessageRepliedTo from "./Message/MessageRepliedTo.svelte";
  import toast from "svelte-french-toast";
  import ImageUrlEmbed from "./Message/embeds/ImageUrlEmbed.svelte";
  import { setInputFocus } from "./ChatInput.svelte";
  import { convertReactionsToEmojis } from "$lib/utils/reactions";
  import { dev } from "$app/environment";
  import MessageThreadBadge from "./Message/MessageThreadBadge.svelte";
  import { goto } from "$app/navigation";
  import { dmClient } from "$lib/dm.svelte";

  let {
    messageId,
    previousMessageId,
    isAdmin,
    admin,
    space,
    threadId,
    allowedToInteract,
    threading,
  }: {
    messageId: string;
    previousMessageId?: string;
    isAdmin?: boolean;
    admin: co.loaded<typeof Account> | undefined | null;
    space: co.loaded<typeof Space> | undefined | null;
    threadId?: string;
    allowedToInteract?: boolean;
    threading?: { active: boolean; selectedMessages: string[] };
  } = $props();

  const me = new AccountCoState(RoomyAccount, {
    resolve: {
      profile: true,
      root: true,
    },
  });

  let message = $derived(
    new CoState(Message, messageId, {
      resolve: {
        reactions: true,
        embeds: {
          $each: true,
          $onError: null,
        },
      },
    }),
  );

  let messageByMe = $derived(
    message.current?._edits.content?.by?.profile?.id ===
      me.current?.profile?.id,
  );
  let canDelete = $derived(isAdmin || messageByMe);

  let previousMessage = $derived(new CoState(Message, previousMessageId));

  let profile = $derived(
    new CoState(RoomyProfile, message.current?._edits.content?.by?.profile?.id),
  );

  let isImportedMessage = $derived(
    message.current?.author?.startsWith("discord:") ||
      message.current?.author?.startsWith("app:") ||
      message.current?.author?.startsWith("atproto"),
  );

  const authorData = $derived.by(() => {
    // if the message has an author in the format of discord:username:avatarUrl or atproto||handle||displayName||did||uri||avatar,
    // and the message is made by the admin, return the profile data otherwise return profile data
    if (isImportedMessage) {
      if (message.current?.author?.startsWith("atproto")) {
        // ATProto format: atproto||handle||displayName||did||uri||avatar
        const author = message.current.author.split("||");
        const avatarUrl = author?.[5] ? decodeURIComponent(author[5]) : "";
        // console.log(`👤 ATProto author data - Handle: ${author?.[1]}, Display: ${author?.[2]}, Avatar: ${avatarUrl}`);
        return {
          name: `${author?.[2] ?? author?.[1] ?? "Unknown"} (@${author?.[1] ?? "unknown"})`,
          imageUrl: avatarUrl,
          id: undefined,
        };
      } else {
        // Discord format: discord:username:avatarUrl
        const author = message.current?.author?.split(":");
        return {
          name: author?.[1] ?? "Unknown",
          imageUrl: decodeURIComponent(author?.[2] ?? ""),
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
        message.current?.author?.startsWith("atproto") &&
        previousMessage.current?.author?.startsWith("atproto")
      ) {
        const previousAuthor = previousMessage.current.author.split("||");
        const currentAuthor = message.current.author.split("||");

        // Compare by handle (index 1) and DID (index 3)
        if (
          previousAuthor?.[1] === currentAuthor?.[1] &&
          previousAuthor?.[3] === currentAuthor?.[3]
        ) {
          return (
            (message.current?.createdAt.getTime() ?? 0) -
              (previousMessage?.current?.createdAt.getTime() ?? 0) <
            1000 * 60 * 5
          );
        } else {
          return false;
        }
      }
      // Handle Discord with : delimiter
      else {
        const previousAuthor = previousMessage.current?.author?.split(":");
        const currentAuthor = message.current?.author?.split(":");

        if (
          previousAuthor?.[1] === currentAuthor?.[1] &&
          previousAuthor?.[2] === currentAuthor?.[2]
        ) {
          return (
            (message.current?.createdAt.getTime() ?? 0) -
              (previousMessage?.current?.createdAt.getTime() ?? 0) <
            1000 * 60 * 5
          );
        } else {
          return false;
        }
      }
    }
    if (
      authorData?.id === profile.current?.id &&
      previousMessage.current?._edits.content?.by?.profile?.id !==
        message.current?._edits.content?.by?.profile?.id
    )
      return false;
    if (message.current?.replyTo) return false;
    return (
      (message.current?.createdAt.getTime() ?? 0) -
        (previousMessage?.current?.createdAt.getTime() ?? 0) <
      1000 * 60 * 5
    );
  });

  let isDrawerOpen = $state(false);

  let isSelected = $derived(threading?.selectedMessages.includes(messageId) ?? false);

  function deleteMessage() {
    if (!message.current) return;
    message.current.softDeleted = true;
  }

  function editMessage() {
    editingMessage.id = messageId;
  }

  function saveEditedMessage(content: string) {
    if (!message.current) return;

    // if the content is the same, dont save
    if (message.current.content === content) {
      editingMessage.id = "";
      return;
    }

    message.current.content = content;
    message.current.updatedAt = new Date();
    editingMessage.id = "";
  }

  function cancelEditing() {
    editingMessage.id = "";
  }

  let isMessageEdited = $derived.by(() => {
    if (!message.current) return false;
    if (!message.current.createdAt || !message.current.updatedAt) return false;
    // if time between createdAt and updatedAt is less than 1 minute, we dont consider it edited
    return (
      message.current?.updatedAt.getTime() -
        message.current?.createdAt.getTime() >
      1000 * 60
    );
  });

  function setReplyTo() {
    replyTo.id = message.current?.id ?? "";
    setInputFocus();
  }

  function removeReaction(emoji: string) {
    let index = message.current?.reactions?.findIndex(
      (reaction) =>
        reaction?.emoji === emoji &&
        reaction?._edits.emoji?.by?.profile?.id === me.current?.profile?.id,
    );
    if (index === undefined || index < 0) return;
    message.current?.reactions?.splice(index, 1);
  }

  function addReaction(emoji: string) {
    message.current?.reactions?.push(
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
  let reactions = $derived(
    convertReactionsToEmojis(message.current?.reactions, me.current),
  );

  function toggleReaction(emoji: string) {
    // check if the emoji is already in the reactions array with the current user
    let index = reactions?.findIndex(
      (reaction) => reaction.emoji === emoji && reaction.user,
    );

    if (index === undefined || index < 0) {
      addReaction(emoji);
    } else {
      removeReaction(emoji);
    }
  }

  let bannedHandles = $derived(new Set(space?.bans ?? []));
  let hiddenIn = $derived(new Set(message.current?.hiddenIn ?? []));

  let shouldShow = $derived.by(() => {
    if (!message.current) return false;
    if (message.current.softDeleted) return false;
    if (!admin || !messageHasAdmin(message.current, admin)) return false;
    if (bannedHandles.has(profile?.current?.blueskyHandle ?? "")) return false;
    if (hiddenIn.has(threadId ?? "")) return false;
    return true;
  });

  async function handleOpenDM() {
    try {
      // Get the user's handle - try blueskyHandle first, then name as fallback
      const userHandle = profile?.current?.blueskyHandle || authorData?.name;

      if (!userHandle) {
        toast.error("Unable to find user handle for messaging");
        return;
      }

      // Initialize DM client if needed
      const initialized = await dmClient.init();
      if (!initialized) {
        toast.error("Please log in to use direct messaging");
        return;
      }

      // Navigate to messages with user parameter for new/existing conversations
      await goto(`/messages?user=${encodeURIComponent(userHandle)}`);
    } catch (error) {
      console.error("Failed to open DM:", error);
      toast.error("Failed to open direct message");
    }
  }
</script>

{#if shouldShow}
  <div
    id={message.current?.id}
    class={`flex flex-col w-full relative max-w-screen isolate`}
  >
    {#if threading?.active}
      <Checkbox.Root
        bind:checked={
          () => isSelected,
          (value) => {
            if (value && !messageByMe && !isAdmin) {
              toast.error("You cannot move someone else's message");
              return;
            }

            if (value) {
              threading?.selectedMessages.push(messageId);
              return;
            }

            const index = threading?.selectedMessages.indexOf(messageId) ?? -1;
            if (index > -1) {
              threading?.selectedMessages.splice(index, 1);
            }
          }
        }
        class="absolute right-4 inset-y-0 z-10"
      >
        <div
          class="border border-primary bg-base-100 text-primary-content size-4 rounded items-center cursor-pointer"
        >
          {#if isSelected}
            <Icon
              icon="material-symbols:check-rounded"
              class="bg-primary size-3.5"
            />
          {/if}
        </div>
      </Checkbox.Root>
    {/if}
    <div
      class={[
        `relative group w-full h-fit flex flex-col gap-2 px-2 pt-2 pb-1 hover:bg-white/5`,
        !mergeWithPrevious && "pt-3",
      ]}
    >
      {#if message.current?.replyTo}
        <MessageRepliedTo messageId={message.current.replyTo} />
      {/if}

      <div class={"group relative flex w-full justify-start gap-3"}>
        {#if !mergeWithPrevious}
          <div class="size-8 sm:size-10">
            <button
              onclick={async (e) => {
                e.stopPropagation();
                // Navigate to user profile page
                const userId =
                  message.current?._edits.content?.by?.id || authorData?.id;
                if (userId) {
                  goto(`/user/${userId}`);
                }
              }}
              oncontextmenu={async (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (authorData?.id !== me.current?.id) {
                  await handleOpenDM();
                }
              }}
              class="rounded-full hover:ring-2 hover:ring-blue-500 transition-all"
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
              <span class="font-bold text-primary"
                >{authorData?.name ?? ""}</span
              >
              {#if isImportedMessage}
                <span class="dz-badge dz-badge-info dz-badge-xs">App</span>
              {/if}
              {#if message.current?.createdAt}
                {@render timestamp(message.current?.createdAt)}
              {/if}
            </span>
          {/if}
          <div class="dz-prose prose-a:text-primary prose-a:hover:underline">
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
                  content={message.current?.content.toString() ?? ""}
                  onEnter={saveEditedMessage}
                  setFocus={true}
                />

                <div class="text-xs text-base-content mt-1">
                  Press <kbd class="text-primary">Enter</kbd> to save,
                  <kbd class="text-primary font-medium">Escape</kbd> to cancel
                </div>
              </div>
            {:else}
              {@html message.current?.content ?? ""}

              {#if isMessageEdited && message.current?.updatedAt}
                <div class="text-xs text-secondary">
                  Edited {@render timestamp(message.current?.updatedAt)}
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
          {setReplyTo}
          isAdmin={dev && (isAdmin ?? false)}
          makeAdmin={() => {
            if (space?.id && message.current?._edits.content?.by?.id) {
              makeSpaceAdmin(space.id, message.current._edits.content.by.id);
            }
          }}
        />
      {/if}

      <button
        onclick={() => (isDrawerOpen = true)}
        class="block pointer-fine:hidden absolute inset-0 w-full h-full"
      >
        <span class="sr-only">Open toolbar</span>
      </button>

      <div class="pl-11 md:pl-13 max-w-full flex flex-wrap gap-2">
        {#each message.current?.embeds ?? [] as embed}
          {#if embed?.type === "imageUrl"}
            <ImageUrlEmbed embedId={embed.embedId} />
          {/if}
        {/each}
      </div>

      {#if message.current?.threadId && message.current.threadId !== threadId}
        <MessageThreadBadge
          threadId={message.current.threadId}
          spaceId={space?.id ?? ""}
        />
      {/if}

      <MessageReactions {reactions} {toggleReaction} />
    </div>
  </div>
{/if}

{#snippet timestamp(date: Date)}
  {@const formattedDate = isToday(date) ? "Today" : format(date, "P")}
  <time class="text-xs">
    {formattedDate}, {format(date, "pp")}
  </time>
{/snippet}

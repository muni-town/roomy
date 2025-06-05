<script lang="ts" module>
  export let editingMessage = $state({ id: "" });

  export let replyTo = $state({ id: "" });
</script>

<script lang="ts">
  import { Avatar, Checkbox } from "bits-ui";
  import { AvatarBeam } from "svelte-boring-avatars";
  import { format, isToday } from "date-fns";
  import { getContext } from "svelte";
  import Icon from "@iconify/svelte";
  import { selectMessage } from "$lib/thread.svelte";
  import { AccountCoState, CoState } from "jazz-svelte";
  import {
    Message,
    Reaction,
    ReactionList,
    RoomyAccount,
    RoomyProfile,
  } from "$lib/jazz/schema";
  import { Account, co, CoRichText, type Loaded } from "jazz-tools";
  import MessageToolbar from "./Message/MessageToolbar.svelte";
  import { messageHasAdmin, publicGroup } from "$lib/jazz/utils";
  import MessageReactions from "./Message/MessageReactions.svelte";
  import ChatInput from "./ChatInput.svelte";
  import MessageRepliedTo from "./Message/MessageRepliedTo.svelte";

  type Props = {
    messageId: string;
    previousMessageId?: string;
    isAdmin?: boolean;
    admin: co.loaded<typeof Account> | undefined | null;
  };

  const me = new AccountCoState(RoomyAccount, {
    resolve: {
      profile: true,
      root: true,
    },
  });

  let { messageId, previousMessageId, isAdmin, admin }: Props = $props();

  let message = $derived(
    new CoState(Message, messageId, {
      resolve: {
        content: true,
        reactions: true,
      },
    }),
  );

  let canEdit = $derived(
    message.current?._edits.content?.by?.profile?.id ===
      me.current?.profile?.id,
  );
  let canDelete = $derived(isAdmin || canEdit);

  let previousMessage = $derived(new CoState(Message, previousMessageId));

  let profile = $derived(
    new CoState(RoomyProfile, message.current?._edits.content?.by?.profile?.id),
  );

  // if the same user and the message was created in the last 5 minutes, don't show the border, username or avatar
  let mergeWithPrevious = $derived.by(() => {
    if (!previousMessage) return false;
    if (previousMessage.current?.softDeleted) return false;
    if (
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

  let isSelected = $state(false);
  let isThreading: { value: boolean } = getContext("isThreading");

  const removeSelectedMessage = getContext("removeSelectedMessage") as (
    message: co.loaded<typeof Message>,
  ) => void;

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
    if (message.current.content.toString() === content) {
      editingMessage.id = "";
      return;
    }

    message.current.content = new CoRichText({
      text: content,
      owner: publicGroup("reader"),
    });
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

  function updateSelect() {
    if (!message.current) return;
    if (isSelected) {
      selectMessage(message.current);
    } else {
      removeSelectedMessage(message.current);
    }
  }

  function setReplyTo() {
    replyTo.id = message.current?.id ?? "";
  }

  function convertReactionsToEmojis(
    reactions: Loaded<typeof ReactionList> | undefined | null,
  ) {
    if (!reactions) return [];

    // convert to [emoji, count, user (if current user has reacted with that emoji)]
    const emojiMap = new Map<string, { count: number; user: boolean }>();
    for (const reaction of reactions) {
      if (!reaction || !reaction.emoji) continue;
      let emoji = reaction.emoji;
      let obj = emojiMap.get(emoji);
      if (obj) {
        obj.count++;
      } else {
        obj = { count: 1, user: false };
        emojiMap.set(emoji, obj);
      }

      if (reaction._edits.emoji?.by?.profile?.id === me.current?.profile?.id) {
        obj.user = true;
      }
    }
    let array = Array.from(emojiMap.entries())
      .map(([emoji, obj]) => ({
        emoji,
        count: obj.count,
        user: obj.user,
      }))
      .sort((a, b) => b.emoji.localeCompare(a.emoji));
    return array;
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
          owner: publicGroup(),
        },
      ),
    );
  }
  let reactions = $derived(
    convertReactionsToEmojis(message.current?.reactions),
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
</script>

{#if message.current && !message.current.softDeleted && admin && messageHasAdmin(message.current, admin)}
  <div
    id={message.current?.id}
    class={`flex flex-col w-full relative max-w-screen`}
  >
    {#if isThreading.value}
      <Checkbox.Root
        onCheckedChange={updateSelect}
        bind:checked={isSelected}
        class="absolute right-4 inset-y-0"
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
      class={`relative group w-full h-fit flex flex-col gap-2 px-2 py-1 hover:bg-white/5`}
    >
      {#if message.current?.replyTo}
        <MessageRepliedTo messageId={message.current?.replyTo} />
      {/if}

      <div class={"group relative flex w-full justify-start gap-3"}>
        {#if !mergeWithPrevious && message.current}
          <div class="size-8 sm:size-10">
            <Avatar.Root class="size-8 sm:size-10">
              <Avatar.Image
                src={profile.current?.imageUrl}
                class="rounded-full"
              />
              <Avatar.Fallback>
                <AvatarBeam name={profile.current?.id} />
              </Avatar.Fallback>
            </Avatar.Root>
          </div>
        {:else}
          <div class="w-8 shrink-0 sm:w-10"></div>
        {/if}

        <div class="flex flex-col gap-1">
          {#if !mergeWithPrevious || !message.current}
            <span class=" flex items-center gap-2 text-sm">
              <span class="font-bold text-primary"
                >{profile?.current?.name ?? ""}</span
              >
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

              {#if isMessageEdited}
                <div class="text-xs text-secondary">
                  Edited {@render timestamp(message.current?.updatedAt)}
                </div>
              {/if}
            {/if}
          </div>
        </div>
      </div>

      {#if editingMessage.id !== messageId}
        <MessageToolbar
          bind:isDrawerOpen
          {toggleReaction}
          {canEdit}
          {canDelete}
          {deleteMessage}
          {editMessage}
          {setReplyTo}
        />
      {/if}

      <button
        onclick={() => (isDrawerOpen = true)}
        class="block pointer-fine:hidden absolute inset-0 w-full h-full"
      >
        <span class="sr-only">Open toolbar</span>
      </button>

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

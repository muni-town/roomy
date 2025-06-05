<script lang="ts">
  import { Checkbox } from "bits-ui";
  import { AvatarBeam } from "svelte-boring-avatars";
  import { format, isToday } from "date-fns";
  import { getContext } from "svelte";
  import Icon from "@iconify/svelte";
  import { outerWidth } from "svelte/reactivity/window";
  import AvatarImage from "./AvatarImage.svelte";
  import { type Item } from "$lib/tiptap/editor";
  import type { JSONContent } from "@tiptap/core";
  import toast from "svelte-french-toast";
  import { selectMessage } from "$lib/thread.svelte";
  import { AccountCoState, CoState } from "jazz-svelte";
  import {
    Message,
    Reaction,
    RoomyAccount,
    RoomyProfile,
  } from "$lib/jazz/schema";
  import { co, type Loaded } from "jazz-tools";
  import MessageToolbar from "./MessageToolbar.svelte";
  import { publicGroup } from "$lib/jazz/utils";
  import MessageReactions from "./MessageReactions.svelte";

  type Props = {
    messageId: string;
    previousMessageId?: string;
  };

  const me = new AccountCoState(RoomyAccount, {
    resolve: {
      profile: true,
      root: true,
    },
  });

  let { messageId, previousMessageId }: Props = $props();

  let message = $derived(
    new CoState(Message, messageId, {
      resolve: {
        content: true,
        reactions: true,
      },
    }),
  );

  // $inspect(message).with(()=>{
  //   console.log("message content", message.current?.content.toString())
  // })

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

  let isMobile = $derived((outerWidth.current ?? 0) < 640);
  let isDrawerOpen = $state(false);

  let isSelected = $state(false);
  let isThreading: { value: boolean } = getContext("isThreading");

  // Editing state
  let isEditing = $state(false);
  let editMessageContent: JSONContent = $state({});

  // let mayDelete = $derived(
  //   message.matches(Message) &&
  //     (globalState.isAdmin ||
  //       (user.agent &&
  //         message
  //           .forceCast(Message)
  //           .authors((x) => x.toArray().includes(user.agent!.assertDid)))),
  // );

  // let mayEdit = $derived(
  //   message.matches(Message) &&
  //     user.agent &&
  //     message
  //       .forceCast(Message)
  //       .authors((x) => x.toArray())
  //       .includes(user.agent?.assertDid),
  // );

  const removeSelectedMessage = getContext("removeSelectedMessage") as (
    message: co.loaded<typeof Message>,
  ) => void;

  const setReplyTo = getContext("setReplyTo") as (
    message: co.loaded<typeof Message>,
  ) => void;

  function deleteMessage() {
    if (!message.current) return;
    message.current.softDeleted = true;
  }

  function startEditing() {
    try {
      // Parse the message body JSON to get a plain object
      const parsedContent = JSON.parse(message.body) as JSONContent;

      // Create a deep copy to ensure we're not working with a Proxy object
      // This keeps all content including images intact
      editMessageContent = JSON.parse(
        JSON.stringify(parsedContent),
      ) as JSONContent;

      isEditing = true;
    } catch (error) {
      console.error("Error starting message edit:", error);
      toast.error("Failed to edit message", { position: "bottom-end" });
    }
  }

  function saveEditedMessage() {
    if (Object.keys(editMessageContent).length > 0) {
      try {
        // Ensure we're working with a plain object, not a Proxy
        const plainContent = JSON.parse(
          JSON.stringify(editMessageContent),
        ) as JSONContent;

        // Update the message
        message.body = JSON.stringify(plainContent);

        // Add an updatedDate field to track edits
        // @ts-ignore - Adding custom property for edit tracking
        message.updatedDate = new Date();

        isEditing = false;
        toast.success("Message updated", { position: "bottom-end" });
      } catch (error) {
        console.error("Error saving edited message:", error);
        toast.error("Failed to save message", { position: "bottom-end" });
      }
    }
  }

  function cancelEditing() {
    isEditing = false;
    editMessageContent = {};
  }

  function isMessageEdited(msg: Message): boolean {
    // @ts-ignore - Check for custom property
    // return !!msg.updatedDate;
    return false;
  }

  function getEditedTime(msg: Message): string {
    // @ts-ignore - Access custom property
    if (msg.updatedDate) {
      // @ts-ignore - Access custom property
      return format(msg.updatedDate, "PPpp");
    }
    return "";
  }

  function updateSelect() {
    if (!message.current) return;
    if (isSelected) {
      selectMessage(message.current);
    } else {
      removeSelectedMessage(message.current);
    }
  }

  $effect(() => {
    if (!isThreading.value) {
      isSelected = false;
    }
  });

  function convertReactionsToEmojis(reactions: Loaded<typeof Reaction>[]) {
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

<div
  id={message.current?.id}
  class={`flex flex-col w-full relative ${isMobile && "max-w-screen"}`}
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
    <div class={"group relative flex w-full justify-start gap-5"}>
      {#if !mergeWithPrevious && message.current}
        <div class="size-8 sm:size-10">
          {#if profile.current?.imageUrl}
            <AvatarImage
              handle={profile.current?.name}
              avatarUrl={profile.current?.imageUrl}
            />
          {:else}
            <AvatarBeam name={profile.current?.id} />
          {/if}
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
          {@html message.current?.content ?? ""}
        </div>
      </div>
    </div>

    <MessageToolbar bind:isDrawerOpen {toggleReaction} />

    <button
      onclick={() => (isDrawerOpen = true)}
      class="block pointer-fine:hidden absolute inset-0 w-full h-full"
    >
      <span class="sr-only">Open toolbar</span>
    </button>

    <MessageReactions {reactions} {toggleReaction} />
  </div>
</div>

{#snippet timestamp(date: Date)}
  {@const formattedDate = isToday(date) ? "Today" : format(date, "P")}
  <time class="text-xs">
    {formattedDate}, {format(date, "pp")}
  </time>
{/snippet}

<!-- {#snippet replyBanner()}
  {@const profileRepliedTo =
    messageRepliedTo.value &&
    getProfile(messageRepliedTo.value.authors((x) => x.get(0)))}
  {#await profileRepliedTo then profileRepliedTo}
    {#if messageRepliedTo.value && profileRepliedTo}
      <Button.Root
        onclick={scrollToReply}
        class="cursor-pointer flex gap-2 text-sm text-start w-full items-center text-base-content px-4 py-1"
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
          <h5 class="text-base-content font-medium text-ellipsis">
            {profileRepliedTo.handle}
          </h5>
        </div>
        <div
          class="line-clamp-1 basis-1/2 md:basis-auto overflow-hidden italic"
        >
          {@html getContentHtml(JSON.parse(messageRepliedTo.value.bodyJson))}
        </div>
      </Button.Root>
    {/if}
  {/await}
{/snippet} -->

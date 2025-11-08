<script lang="ts" module>
  export let editingMessage = $state({ id: "" });
</script>

<script lang="ts">
  import { patchMake, patchToText } from "diff-match-patch-es";
  import { Avatar, Checkbox } from "bits-ui";
  import { AvatarBeam } from "svelte-boring-avatars";
  import { format, isToday } from "date-fns";
  import MessageToolbar from "./MessageToolbar.svelte";
  import MessageContext from "./MessageContext.svelte";
  import MessageReactions from "./MessageReactions.svelte";
  import ChatInput from "../ChatInput.svelte";
  import IconTablerCheck from "~icons/tabler/check";
  import { goto } from "$app/navigation";
  import { renderMarkdownSanitized } from "$lib/markdown";
  import type { Message } from "../ChatArea.svelte";
  import { backend, backendStatus } from "$lib/workers";
  import { decodeTime, ulid } from "ulidx";
  import { current } from "$lib/queries.svelte";
  import { toast } from "@fuxui/base";
  import type { MessagingState } from "../TimelineView.svelte";
  import MediaEmbed from "./embeds/MediaEmbed.svelte";

  let {
    message,
    messagingState,
    startThreading,
    toggleSelect,
  }: {
    message: Message;
    messagingState?: MessagingState;
    startThreading: (message?: Message) => void;
    toggleSelect: (message: Message) => void;
  } = $props();

  // log messages sent in last 2.7hours
  // if (decodeTime(message.id) > Date.now() - 10000000)
  console.log("message", message.content, message);

  const threading = $derived.by(() => {
    if (!messagingState) return null;
    if (messagingState.kind !== "threading") return null;
    return messagingState;
  });

  let hovered = $state(false);
  let keepToolbarOpen = $state(false);

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
      name: message.authorName || undefined,
      handle: message.authorHandle || undefined,
      avatarUrl: message.authorAvatar || undefined,
      timestamp: new Date(decodeTime(message.id)),
      profileUrl: `/user/${message.authorDid}`,
    };
    if (!authorCanMasquerade) return defaultInfo;
    if (!message.masqueradeAuthor) return defaultInfo;

    try {
      return {
        id: message.masqueradeAuthor,
        handle: message.masqueradeAuthorHandle || undefined,
        name: message.masqueradeAuthorName || undefined,
        avatarUrl: message.masqueradeAuthorAvatar || undefined,
        timestamp: message.masqueradeTimestamp
          ? new Date(message.masqueradeTimestamp)
          : new Date(decodeTime(message.id)),
      };
    } catch (_) {}

    return defaultInfo;
  });

  let messageByMe = $derived(message.authorDid == backendStatus.did);

  let isDrawerOpen = $state(false);

  let isSelected = $derived(
    threading?.selectedMessages.find((x) => x.id == message.id) ? true : false,
  );

  function editMessage() {
    editingMessage.id = message.id;
  }

  async function saveEditedMessage(newContent: string) {
    editingMessage.id = "";
    if (!current.space) return;

    // If the content is the same, don't save
    if (message.content == newContent) {
      editingMessage.id = "";
      return;
    }
    let contentPatch = patchToText(patchMake(message.content, newContent));

    await backend.sendEvent(current.space.id, {
      ulid: ulid(),
      parent: message.id,
      variant: {
        kind: "space.roomy.message.edit.0",
        data: {
          content: {
            mimeType: "text/x-dmp-patch",
            content: new TextEncoder().encode(contentPatch),
          },
          replyTo: message.replyTo || undefined,
        },
      },
    });

    editingMessage.id = "";
  }

  function cancelEditing() {
    editingMessage.id = "";
  }

  // let isMessageEdited = $derived.by(() => {
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
  // });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div
  id={message.id}
  class={`flex flex-col w-full relative max-w-screen isolate px-4 ${threading ? "select-none" : ""}`}
  onmouseenter={() => (hovered = true)}
  onmouseleave={() => (hovered = false)}
>
  {#if threading}
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
      message.mergeWithPrevious ? "" : "pt-3",
    ]}
  >
    <div class={message.mergeWithPrevious ? "pl-12" : ""}>
      {#if message.replyTo}
        <MessageContext
          context={{
            kind: "replying",
            messageId: message.id,
            replyTo: { id: message.replyTo },
          }}
        />
      {:else if message.comment.version}
        <MessageContext
          context={{
            kind: "commenting",
            messageId: message.id,
            comment: message.comment,
          }}
        />
      {/if}
    </div>

    <div class="group relative flex w-full justify-start gap-3">
      <!-- Avatar, or left margin -->
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
        <!-- Username, timestamp -->
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

        <!-- Message text -->
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

        <!-- Media -->
        {#if message.media.length}
          <div class="flex flex-wrap gap-4 my-3">
            {#each message.media as media}
              <MediaEmbed {media} />
            {/each}
          </div>
        {/if}
      </div>
    </div>

    {#if (editingMessage.id !== message.id && hovered && !threading) || keepToolbarOpen}
      <MessageToolbar
        bind:isDrawerOpen
        canEdit={messageByMe}
        bind:keepToolbarOpen
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

    <!-- 
    {#if message.current?.components?.[BranchThreadIdComponent.id] && message.current?.components?.[BranchThreadIdComponent.id] !== threadId}
      <MessageThreadBadge
        threadId={message.current?.components?.[BranchThreadIdComponent.id]!}
        spaceId={space?.id ?? ""}
      />
    {/if} -->

    <MessageReactions {message} />
  </div>
</div>

{#snippet timestamp(date: Date)}
  {@const formattedDate = isToday(date) ? "Today" : format(date, "P")}
  <time class="text-xs text-base-700 dark:text-base-400">
    {formattedDate}, {format(date, "pp")}
  </time>
{/snippet}

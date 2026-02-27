<script lang="ts">
  import { Avatar, Checkbox } from "bits-ui";
  import { AvatarBeam } from "svelte-boring-avatars";
  import { format, isToday, isTomorrow, isYesterday } from "date-fns";
  import MessageToolbar from "./MessageToolbar.svelte";
  import MessageContext from "./MessageContext.svelte";
  import MessageReactions from "./MessageReactions.svelte";
  import ChatInput from "../ChatInput.svelte";
  import { goto } from "$app/navigation";
  import { renderMarkdownSanitized } from "$lib/utils/markdown";

  function resolveDiscordMentions(
    content: string,
    tags: {
      snowflake: string;
      name: string | null;
      handle: string | null;
      roomId: string | null;
    }[],
  ): string {
    if (!tags.length) return content;
    const userMap = new Map(
      tags
        .filter((t) => !t.roomId)
        .map((t) => [t.snowflake, t.name || t.handle || t.snowflake]),
    );
    const roomMap = new Map(
      tags
        .filter((t) => t.roomId)
        .map((t) => [
          t.snowflake,
          { name: t.name || t.snowflake, roomId: t.roomId },
        ]),
    );
    return content
      .replace(/<@!?(\d+)>/g, (_, snowflake) => {
        const name = userMap.get(snowflake) ?? snowflake;
        const escaped = name.replace(/[_*~`[\]\\]/g, "\\$&");
        return `[@${escaped}]()`;
      })
      .replace(/<#(\d+)>/g, (_, snowflake) => {
        const room = roomMap.get(snowflake);
        const name = room?.name ?? snowflake;
        const escaped = name.replace(/[_*~`[\]\\]/g, "\\$&");
        return `[#${escaped}](${room?.roomId || ""})`;
      });
  }
  import type { Message } from "../ChatArea.svelte";
  import { peer, peerStatus } from "$lib/workers";
  import { decodeTime } from "ulidx";
  import { getAppState } from "$lib/queries";
  const app = getAppState();
  import { toast } from "@foxui/core";
  import Badge from "$lib/components/ui/badge/Badge.svelte";
  import type { MessagingState } from "../TimelineView.svelte";
  import { messagingState as importedMessagingState } from "../TimelineView.svelte";
  import MediaEmbed from "./embeds/MediaEmbed.svelte";
  import { Event, newUlid, toBytes, Ulid } from "@roomy/sdk";
  import { page } from "$app/state";
  import { cdnImageUrl } from "$lib/utils.svelte";

  let {
    message,
    messagingState,
    onOpenMobileMenu,
    editingMessageId,
    onStartEdit,
    onCancelEdit,
  }: {
    message: Message;
    messagingState?: MessagingState;
    onOpenMobileMenu: (message: Message) => void;
    editingMessageId: string;
    onStartEdit: (id: string) => void;
    onCancelEdit: () => void;
  } = $props();

  const threading = $derived.by(() => {
    if (!messagingState) return null;
    if (messagingState.kind !== "threading") return null;
    return messagingState;
  });

  let hovered = $state(false);
  let keepToolbarOpen = $state(false);

  // Metadata is now canonical (resolved at query level)
  let metadata: {
    id: string | null;
    name?: string;
    handle?: string;
    avatarUrl?: string;
    appTag?: string;
    timestamp: Date;
    profileUrl?: string;
  } = $derived.by(() => {
    return {
      id: message.authorDid,
      name: message.authorName || undefined,
      handle: message.authorHandle || undefined,
      avatarUrl: message.authorAvatar || undefined,
      timestamp: new Date(message.timestamp),
      profileUrl: `/user/${message.authorDid}`,
    };
  });

  let messageByMe = $derived(
    peerStatus.authState &&
      "did" in peerStatus.authState &&
      message.authorDid == peerStatus.authState.did,
  );

  let isSelected = $derived(
    threading?.selectedMessages.find((x) => x.id == message.id) ? true : false,
  );

  let isEditing = $derived(editingMessageId === message.id);

  let isFromDiscord = $derived(message.isBridged);

  function editMessage() {
    onStartEdit(message.id);
  }

  async function saveEditedMessage(newContent: string) {
    onCancelEdit();
    const spaceId = app.joinedSpace?.id;
    if (!spaceId) return;

    // If the content is the same, don't save
    if (message.content == newContent) {
      return;
    }

    await peer.sendEvent(spaceId, {
      id: newUlid(),
      room: Ulid.assert(page.params.object),
      $type: "space.roomy.message.editMessage.v0",
      messageId: message.id,
      body: {
        mimeType: "text/markdown",
        data: toBytes(new TextEncoder().encode(newContent)),
      },
    } satisfies Event<"space.roomy.message.editMessage.v0">);
  }

  function cancelEditing() {
    onCancelEdit();
  }
</script>

{#snippet messageBox()}
  <div
    class={[
      `relative group w-full flex flex-col px-2 rounded ${isSelected ? "bg-accent-100/50 dark:bg-accent-900/50 hover:bg-accent-100/75 dark:hover:bg-accent-900/75" : " hover:bg-base-100/50  dark:hover:bg-base-400/5"}`,
      message.mergeWithPrevious ? "mt-1" : "mt-5 pt-1",
    ]}
  >
    <div class={message.mergeWithPrevious ? "pl-12" : ""}>
      {#if message.replyTo[0]}
        <!-- TODO: support multiple replies; multiple contexts? -->
        <MessageContext
          context={{
            kind: "replying",
            messageId: Ulid.assert(message.id),
            replyTo: { id: Ulid.assert(message.replyTo[0]) },
          }}
        />
      {:else if message.comment?.version}
        <MessageContext
          context={{
            kind: "commenting",
            messageId: Ulid.assert(message.id),
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
              <Avatar.Image
                src={metadata.avatarUrl?.startsWith("atblob://")
                  ? cdnImageUrl(metadata.avatarUrl)
                  : metadata.avatarUrl}
                class="rounded-full"
              />
              <Avatar.Fallback>
                <AvatarBeam name={metadata.id || "system"} />
              </Avatar.Fallback>
            </Avatar.Root>
          </button>
        </div>
      {:else}
        <div class="w-8 shrink-0 sm:w-10"></div>
      {/if}

      <div class="flex flex-col w-full">
        <!-- Username, timestamp -->
        {#if !message.mergeWithPrevious}
          <div class="text-sm w-full">
            <span class="gap-2">
              <span class="font-medium text-accent-700 dark:text-accent-400"
                >{metadata.name}</span
              >
              {#if metadata.handle}<span
                  class="opacity-75 font-normal">@{metadata.handle}</span
                >{/if}
              {#if isFromDiscord}
                <Badge
                  variant="secondary"
                  title="This message was bridged from Discord."
                  class="text-[10px] my-[-2px] px-1.5 font-bold opacity-75"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="16"
                    height="16"
                    fill="currentColor"
                    class="bi bi-discord"
                    viewBox="0 0 16 16"
                    ><path
                      d="M13.545 2.907a13.2 13.2 0 0 0-3.257-1.011.05.05 0 0 0-.052.025c-.141.25-.297.577-.406.833a12.2 12.2 0 0 0-3.658 0 8 8 0 0 0-.412-.833.05.05 0 0 0-.052-.025c-1.125.194-2.22.534-3.257 1.011a.04.04 0 0 0-.021.018C.356 6.024-.213 9.047.066 12.032q.003.022.021.037a13.3 13.3 0 0 0 3.995 2.02.05.05 0 0 0 .056-.019q.463-.63.818-1.329a.05.05 0 0 0-.01-.059l-.018-.011a9 9 0 0 1-1.248-.595.05.05 0 0 1-.02-.066l.015-.019q.127-.095.248-.195a.05.05 0 0 1 .051-.007c2.619 1.196 5.454 1.196 8.041 0a.05.05 0 0 1 .053.007q.121.1.248.195a.05.05 0 0 1-.004.085 8 8 0 0 1-1.249.594.05.05 0 0 0-.03.03.05.05 0 0 0 .003.041c.24.465.515.909.817 1.329a.05.05 0 0 0 .056.019 13.2 13.2 0 0 0 4.001-2.02.05.05 0 0 0 .021-.037c.334-3.451-.559-6.449-2.366-9.106a.03.03 0 0 0-.02-.019m-8.198 7.307c-.789 0-1.438-.724-1.438-1.612s.637-1.613 1.438-1.613c.807 0 1.45.73 1.438 1.613 0 .888-.637 1.612-1.438 1.612m5.316 0c-.788 0-1.438-.724-1.438-1.612s.637-1.613 1.438-1.613c.807 0 1.451.73 1.438 1.613 0 .888-.631 1.612-1.438 1.612"
                    /></svg
                  >
                  BRIDGE
                </Badge>
              {/if}
            </span>
            <span class="opacity-70">
              {@render timestamp(metadata.timestamp)}
            </span>
          </div>
        {/if}

        <!-- Message text -->
        <div
          class="text-sm font-normal prose text-left prose-a:text-accent-600 dark:prose-a:text-accent-400 dark:prose-invert prose-a:no-underline max-w-full"
        >
          {#if isEditing}
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
            {@html renderMarkdownSanitized(
              resolveDiscordMentions(message.content, message.tags),
            )}

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

    {#if (!isEditing && hovered && !threading) || keepToolbarOpen}
      <MessageToolbar
        canEdit={messageByMe}
        bind:keepToolbarOpen
        {editMessage}
        startThreading={() => importedMessagingState.startThreading(message)}
        {message}
      />
    {/if}

    <button
      onclick={() => onOpenMobileMenu(message)}
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
{/snippet}

{#if threading}
  <Checkbox.Root
    aria-label="Select message"
    onclick={(e) => e.stopPropagation()}
    bind:checked={
      () => isSelected,
      (value) => {
        if (value && !messageByMe && !app.isSpaceAdmin) {
          toast.error("You cannot move someone else's message");
          return;
        }
        importedMessagingState.toggleMessageSelection(message);
      }
    }
    class="flex flex-col w-full relative max-w-full isolate px-4"
  >
    {@render messageBox()}
  </Checkbox.Root>
{:else}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    id={message.id}
    data-message-id={message.id}
    class={`flex flex-col w-full relative max-w-full isolate px-4 ${threading ? "select-none" : ""}`}
    onmouseenter={() => (hovered = true)}
    onmouseleave={() => (hovered = false)}
  >
    {@render messageBox()}
  </div>
{/if}

{#snippet timestamp(date: Date)}
  {@const formattedDate = isTomorrow(date)
    ? "Tomorrow at "
    : isToday(date)
      ? "Today at "
      : isYesterday(date)
        ? "Yesterday at "
        : format(date, "P") + ", "}
  <time
    class="text-[11px] align-middle font-medium text-base-700 dark:text-base-400"
  >
    {formattedDate}{format(date, "p")}
  </time>
{/snippet}

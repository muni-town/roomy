<script lang="ts">
  import { Avatar, Checkbox } from "bits-ui";
  import { AvatarBeam } from "svelte-boring-avatars";
  import { format, isToday } from "date-fns";
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
  import { current } from "$lib/queries";
  import { Badge, toast } from "@fuxui/base";
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

  // TODO: move this author can masquerade logic into the materializer so we don't have to
  // re-hash this in the UI.
  let authorCanMasquerade = $derived(true);
  let metadata: {
    id: string | null;
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

  let messageByMe = $derived(
    peerStatus.authState &&
      "did" in peerStatus.authState &&
      message.authorDid == peerStatus.authState.did,
  );

  let isSelected = $derived(
    threading?.selectedMessages.find((x) => x.id == message.id) ? true : false,
  );

  let isEditing = $derived(editingMessageId === message.id);

  let isFromDiscord = $derived(
    message.masqueradeAuthor?.startsWith("did:discord:") ?? false,
  );

  function editMessage() {
    onStartEdit(message.id);
  }

  async function saveEditedMessage(newContent: string) {
    onCancelEdit();
    const spaceId = current.joinedSpace?.id;
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

      <div class="flex flex-col gap-1 w-full">
        <!-- Username, timestamp -->
        {#if !message.mergeWithPrevious}
          <div class="flex items-center gap-2 text-sm w-full">
            <span class="font-bold text-accent-700 dark:text-accent-400"
              >{metadata.name}</span
            >
            {#if metadata.handle && !message.masqueradeAuthor}<span
                class="opacity-70">@{metadata.handle}</span
              >{/if}
            {#if isFromDiscord}
              <Badge
                variant="secondary"
                title="This message was bridged from Discord"
                class="text-xs">Discord</Badge
              >
            {/if}
            <span class="ml-auto opacity-70"
              >{@render timestamp(metadata.timestamp)}</span
            >
          </div>
        {/if}

        <!-- Message text -->
        <div
          class="prose text-left prose-a:text-accent-600 dark:prose-a:text-accent-400 dark:prose-invert prose-a:no-underline max-w-full"
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
        if (value && !messageByMe && !current.isSpaceAdmin) {
          toast.error("You cannot move someone else's message");
          return;
        }
        importedMessagingState.toggleMessageSelection(message);
      }
    }
    class="flex flex-col w-full relative max-w-screen isolate px-4"
  >
    {@render messageBox()}
  </Checkbox.Root>
{:else}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    id={message.id}
    data-message-id={message.id}
    class={`flex flex-col w-full relative max-w-screen isolate px-4 ${threading ? "select-none" : ""}`}
    onmouseenter={() => (hovered = true)}
    onmouseleave={() => (hovered = false)}
  >
    {@render messageBox()}
  </div>
{/if}

{#snippet timestamp(date: Date)}
  {@const formattedDate = isToday(date) ? "" : format(date, "P") + ", "}
  <time class="text-xs text-base-700 dark:text-base-400">
    {formattedDate}{format(date, "p")}
  </time>
{/snippet}

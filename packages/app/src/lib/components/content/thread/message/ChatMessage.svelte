<script lang="ts">
  import { Checkbox, ContextMenu } from "bits-ui";
  import MessageToolbar from "./MessageToolbar.svelte";
  import MessageContext from "./MessageContext.svelte";
  import MessageReactions from "./MessageReactions.svelte";
  import ChatInput from "../ChatInput.svelte";
  import { goto } from "$app/navigation";
  import { renderMarkdownSanitized } from "@roomy/design/utils";

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
  import { getAppState } from "$lib/queries";
  const app = getAppState();
  import { toast } from "@foxui/core";
  import MessageBubble from "@roomy/design/components/content/thread/message/MessageBubble.svelte";
  import type { MessagingState } from "../TimelineView.svelte";
  import { messagingState as importedMessagingState } from "../TimelineView.svelte";
  import MediaEmbed from "./embeds/MediaEmbed.svelte";
  import { Event, newUlid, toBytes, Ulid } from "@roomy-space/sdk";
  import { page } from "$app/state";
  import { cdnImageUrl } from "$lib/utils.svelte";
  import { getLinkEmbedData } from "$lib/utils/getLinkEmbedData";
  import IconLucideX from "~icons/lucide/x";
  import LinkCard from "./LinkCard.svelte";

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

  let mobileDrawerOpen = $state(false);
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
    // Strip Discord discriminator from handle (e.g., "username#0" -> "username")
    const handle = message.authorHandle
      ? message.authorHandle.replace(/#\d+$/, "")
      : undefined;

    return {
      id: message.authorDid,
      name: message.authorName || undefined,
      handle,
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

  let resolvedAvatarSrc = $derived(
    metadata.avatarUrl?.startsWith("atblob://")
      ? cdnImageUrl(metadata.avatarUrl)
      : metadata.avatarUrl,
  );

  let showToolbar = $derived(
    (!isEditing && hovered && !threading) || keepToolbarOpen,
  );

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
  // const UrlRegex =
  //   /<?(https?:\/\/)*[a-z0-9][-a-z0-9]*\.[a-z]{2,}[^\s]*[a-zA-Z0-9\/]>?/gi;

  const linkUrls = $derived([
    // Unfortunately link previews seems to cause problems for iOS somehow.
    //
    // ...(message?.content?.matchAll(UrlRegex)?.map((x) => x[0]) || []),
  ] as string[]);
  const linkEmbedsPromise = $derived(
    Promise.all(
      linkUrls.map(async (_url) => {
        if (_url.startsWith("<") && _url.endsWith(">")) return;

        let url =
          _url.startsWith("http://") || _url.startsWith("https://")
            ? _url
            : "https://" + _url;
        const data = await getLinkEmbedData(url);
        return { url, data };
      }),
    ),
  );

  function handleAvatarClick() {
    if (metadata.profileUrl) {
      goto(metadata.profileUrl);
    }
  }
</script>

{#snippet replyContextSnippet()}
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
        comment: message.comment as {
          snippet?: string;
          version: Ulid;
          from: number;
          to: number;
        },
      }}
    />
  {/if}
{/snippet}

{#snippet contentSnippet()}
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
        Press <kbd class="text-accent-600 dark:text-accent-400">Enter</kbd>
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
  {/if}
{/snippet}

{#snippet linkEmbedsSnippet()}
  {#await linkEmbedsPromise then links}
    {#if links && links.filter((x) => !!x?.data).length > 0}
      <div class="pr-2 flex gap-1 items-start">
        <div class="">
          {#each links as link}
            {#if link && link.data}
              <div class="py-1">
                <LinkCard embed={link.data} url={link.url} />
              </div>
            {/if}
          {/each}
        </div>
        <button
          class="opacity-0 hover:opacity-100 cursor-pointer transition-opacity ease-in-out duration-75"
          ><IconLucideX /></button
        >
      </div>
    {/if}
  {/await}
{/snippet}

{#snippet mediaSnippet()}
  {#if message.media.length}
    <div class="flex flex-wrap gap-4 my-3">
      {#each message.media as media}
        <MediaEmbed {media} />
      {/each}
    </div>
  {/if}
{/snippet}

{#snippet toolbarSnippet()}
  <MessageToolbar
    canEdit={messageByMe}
    bind:keepToolbarOpen
    {editMessage}
    startThreading={() => importedMessagingState.startThreading(message)}
    {message}
  />
{/snippet}

{#snippet reactionsSnippet()}
  <MessageReactions {message} />
{/snippet}

{#snippet messageBox()}
  <ContextMenu.Root
    bind:open={
      () => mobileDrawerOpen,
      (v) => {
        mobileDrawerOpen = v;
        if (v) {
          onOpenMobileMenu(message);
        }
      }
    }
  >
    <ContextMenu.Trigger>
      <MessageBubble
        authorDid={metadata.id}
        authorName={metadata.name}
        authorHandle={metadata.handle}
        authorAvatarUrl={metadata.avatarUrl}
        avatarSrc={resolvedAvatarSrc}
        profileUrl={metadata.profileUrl}
        timestamp={metadata.timestamp}
        isBridged={!!isFromDiscord}
        mergeWithPrevious={!!message.mergeWithPrevious}
        {isSelected}
        {showToolbar}
        onAvatarClick={handleAvatarClick}
        replyContext={replyContextSnippet}
        content={contentSnippet}
        linkEmbeds={linkEmbedsSnippet}
        media={mediaSnippet}
        toolbar={toolbarSnippet}
        reactions={reactionsSnippet}
      />
    </ContextMenu.Trigger>
  </ContextMenu.Root>
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

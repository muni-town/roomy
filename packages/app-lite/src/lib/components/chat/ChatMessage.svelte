<script lang="ts">
  import { goto } from "$app/navigation";
  import { MediaQuery } from "svelte/reactivity";
  import { Checkbox } from "bits-ui";
  import MessageBubble from "@roomy/design/components/content/thread/message/MessageBubble.svelte";
  import { messagingState, toggleToolbar, toolbarOpenState } from "./messaging-state.svelte";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import { IconCheck, IconX } from "@roomy/design/icons";
  import MessageContext from "./MessageContext.svelte";
  import MessageReactions from "./MessageReactions.svelte";
  import MessageToolbar from "./MessageToolbar.svelte";
  import MediaEmbed from "./embeds/MediaEmbed.svelte";
  import LinkCard from "./embeds/LinkCard.svelte";
  import ForwardContext from "./ForwardContext.svelte";
  import MessageContent from "./MessageContent.svelte";
  import ChatInput from "./ChatInput.svelte";
  import { createMentionSearch } from "$lib/tiptap/mentions";
  import { editMessage, removeLinkEmbed } from "$lib/mutations/message";
  import type { Message } from "$lib/queries/messages";
  import { resolveBlobUrl } from "$lib/utils";
  import { RICHTEXT_MIME, extractFacetUrls } from "@roomy-space/sdk";
  import type { schemas, Block } from "@roomy-space/sdk";
  import { parseRichTextContent } from "./enrich-internal-links";
  import { extractUrls, fetchEmbedData } from "$lib/embed/embed-service";

  type LinkEmbedData = typeof schemas.queries.getMessage.LinkEmbedData.infer;
  /** A link preview being managed in the in-place editor. */
  type EditLink = { url: string; embed: LinkEmbedData | null; showPreview: boolean };

  type Props = {
    spaceId: string;
    roomId: string;
    message: Message;
    currentUserDid: string | undefined;
    /** Whether the current user is an admin of the space (moderation). */
    isAdmin: boolean;
    editingMessageId: string | undefined;
    onStartEdit: (messageId: string) => void;
    onCancelEdit: () => void;
    onOpenMobileMenu: (message: Message) => void;
    /** Requests the delete confirmation for this message (raised to ChatArea). */
    onRequestDelete: (message: Message) => void;
    onForward: (message: Message) => void;
    mergeWithPrevious?: boolean;
  };

  let {
    spaceId,
    roomId,
    message,
    currentUserDid,
    isAdmin,
    editingMessageId,
    onStartEdit,
    onCancelEdit,
    onOpenMobileMenu,
    onRequestDelete,
    onForward,
    mergeWithPrevious = false,
  }: Props = $props();

  let hovered = $state(false);
  let keepToolbarOpen = $state(false);
  let isEditing = $derived(editingMessageId === message.id);
  // Local buffer for the in-place editor. Bound to ChatInput so the save
  // button can submit the current text. Re-seeded from the latest message
  // content when editing *begins*: a pre-effect runs before the DOM update,
  // so the fresh value is in place before ChatInput mounts and reads it.
  // Rising-edge only, so in-progress edits aren't clobbered if the server
  // pushes an updated message while editing.
  let editContent = $state("");
  // Blocks+facets form of the in-place editor's content. Only used when the
  // message is rich-text (`application/vnd.roomy.richtext+json`): seeded from
  // the decoded blocks when editing begins and kept in sync by ChatInput so
  // the save path re-encodes the same format instead of downgrading to
  // markdown.
  let editBlocks: Block[] | undefined = $state();
  // DIDs mentioned in the in-place editor, kept in sync by ChatInput. Only
  // used for legacy markdown messages — rich-text messages carry mentions in
  // their blocks' `#didMention` facets.
  let editMentions: string[] = $state([]);
  let prevEditing = false;
  // ── Edit-mode link preview management ──────────────────────────────────
  // While editing, the author can dismiss or re-add link previews the same
  // way they can while composing. `editLinks` holds one entry per URL in the
  // edited content with its current preview state; on save the states are
  // synced to the message via link attachments (showPreview true/false).
  let editLinks: EditLink[] = $state([]);
  /** URLs that were already dismissed (show_preview=0) when editing began. */
  let initialDismissed = new Set<string>();
  /** Non-reactive guard so each URL's embed data is fetched at most once. */
  const fetchedEmbeds = new Set<string>();
  $effect.pre(() => {
    const editing = isEditing;
    if (editing && !prevEditing) {
      editMentions = [];
      if (message.mimeType === RICHTEXT_MIME) {
        // Seed the editor from the decoded blocks (ChatInput reads these via
        // `initialBlocks`); `editContent` is synced to markdown on mount.
        editBlocks = parseRichTextContent(message.content) ?? [];
        editContent = "";
      } else {
        editBlocks = undefined;
        editContent = message.content;
      }
      // Seed the edit link previews from the message's current embeds. A URL
      // present in the content but absent from `linkEmbeds` was dismissed
      // (the read path filters show_preview=0), so it starts hidden.
      const urls =
        message.mimeType === RICHTEXT_MIME
          ? extractFacetUrls(editBlocks ?? [])
          : extractUrls(message.content);
      const linkEmbeds = message.linkEmbeds ?? [];
      const shown = new Set(linkEmbeds.map((l) => l.url));
      // Seed each preview's embed from the message's cached data when
      // available, so already-shown cards render immediately instead of
      // waiting on a redundant refetch.
      const embedByUrl = new Map(linkEmbeds.map((l) => [l.url, l.embed ?? null]));
      initialDismissed = new Set(urls.filter((u) => !shown.has(u)));
      editLinks = urls.map((url) => ({
        url,
        embed: embedByUrl.get(url) ?? null,
        showPreview: !initialDismissed.has(url),
      }));
      fetchedEmbeds.clear();
    }
    prevEditing = editing;
  });
  // URLs currently present in the edited content.
  const editUrls = $derived(
    message.mimeType === RICHTEXT_MIME
      ? extractFacetUrls(editBlocks ?? [])
      : extractUrls(editContent),
  );
  // Keep `editLinks` in sync with the content as the author types: drop URLs
  // that were removed, and add new URLs (defaulting to shown unless they were
  // dismissed before editing began).
  $effect(() => {
    const urls = editUrls;
    const current = editLinks;
    const next = current.filter((l) => urls.includes(l.url));
    for (const url of urls) {
      if (!next.some((l) => l.url === url)) {
        next.push({ url, embed: null, showPreview: !initialDismissed.has(url) });
      }
    }
    if (next.length !== current.length || next.some((link, i) => link !== current[i])) {
      editLinks = next;
    }
  });
  // Best-effort fetch of embed metadata for each preview (guarded so a URL is
  // fetched once). Degrades to a URL-only card when the fetch fails.
  $effect(() => {
    for (const link of editLinks) {
      if (link.embed === null && !fetchedEmbeds.has(link.url)) {
        fetchedEmbeds.add(link.url);
        fetchEmbedData(link.url).then((embed) => {
          const i = editLinks.findIndex((l) => l.url === link.url);
          const cur = editLinks[i];
          if (cur) editLinks[i] = { ...cur, embed };
        });
      }
    }
  });
  function toggleEditLink(url: string) {
    const i = editLinks.findIndex((l) => l.url === url);
    const cur = editLinks[i];
    if (cur) editLinks[i] = { ...cur, showPreview: !cur.showPreview };
  }
  function hostname(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }
  let isMobile = new MediaQuery("(pointer: coarse)")
  let isThreading = $derived(messagingState.current.kind === "threading");
  let isSelected = $derived.by(() => {
    const cur = messagingState.current;
    return cur.kind === "threading" && cur.selectedMessages.some((m) => m.id === message.id);
  });
  // On touch devices there is no hover, so the toolbar is shown by tapping the
  // message (see the onclick on the message box below). Only one message's
  // toolbar is open at a time (shared `toolbarOpenState`).
  let isToolbarOpen = $derived(toolbarOpenState.id === message.id);
  // System messages (e.g. "X joined the space", "X created [thread]") are
  // authored by the space itself. They carry no meaningful author identity, so
  // render them as a centred system notice without an avatar/author line.
  let isSystem = $derived(message.system === true);
  let showToolbar = $derived(
    !isSystem &&
      !isEditing &&
      !isThreading &&
      ((!isMobile.current && hovered) || (isMobile.current && isToolbarOpen)) ||
      keepToolbarOpen,
  );

  let isBridged = $derived(message.authorDid.startsWith("did:discord:"));
  let isAuthor = $derived(message.authorDid === currentUserDid);

  // ── Forwards ──────────────────────────────────────────────────────────
  // A forward is a real message (authored by the forwarder) carrying a
  // forward attachment. The bubble renders the embedded original (fully
  // denormalised server-side as `forwardedFrom.message` — content, author,
  // timestamp), with the forwarder surfaced in the forward context line
  // above. The forwarder's own note (if any) renders as a second bubble
  // below. No extra fetch: the original arrives with the room query.
  const forwardedFrom = $derived(message.forwardedFrom);
  const isForward = $derived(!!forwardedFrom);
  /** The embedded original message (denormalised server-side). */
  const original = $derived(forwardedFrom?.message);
  const effBridged = $derived(
    original
      ? original.authorDid.startsWith("did:discord:")
      : isBridged,
  );

  // Edit stays author-only; space admins may delete anyone's message.
  // Forwards aren't editable (the visible content belongs to the original).
  let canEdit = $derived(isAuthor && !isForward);
  let canDelete = $derived(isAuthor || isAdmin);

  function handleContextAction(e: MouseEvent) {
    // On mobile (coarse pointer), long-press opens the drawer
    if (isMobile.current) {
      e.preventDefault();
      onOpenMobileMenu(message);
    }
  }


  async function handleEdit(newContent: string, _mentions: string[], submittedBlocks: Block[]) {
    const isRichText = message.mimeType === RICHTEXT_MIME;
    // Sync the link preview states (dismissed / re-added) to the message via
    // link attachments. The materializer treats a link-only edit as a
    // non-destructive show_preview toggle, so other attachments are kept.
    const linkAttachments = editLinks.map((l) => ({
      $type: "space.roomy.attachment.link.v0",
      uri: l.url,
      showPreview: l.showPreview,
    }));
    // Save when the content changed OR any link preview state changed (e.g.
    // the author dismissed/re-added a preview without touching the text).
    const contentUnchanged = !isRichText && newContent === message.content;
    const shownUrls = new Set((message.linkEmbeds ?? []).map((l) => l.url));
    const linksChanged = linkAttachments.some((a) => a.showPreview !== shownUrls.has(a.uri));
    if (contentUnchanged && !linksChanged) {
      onCancelEdit();
      return;
    }
    await editMessage(
      spaceId,
      roomId,
      message.id,
      newContent,
      {
        // Rich-text messages stay rich-text: send the blocks (which ChatInput
        // keeps in sync) rather than the base64-encoded wire body or markdown.
        ...(isRichText ? { blocks: submittedBlocks } : {}),
        // Legacy markdown messages carry mentions in the sidecar. Without
        // this, mentions added while editing are silently dropped.
        ...(!isRichText && _mentions.length > 0 ? { mentions: _mentions } : {}),
        ...(linkAttachments.length > 0 ? { attachments: linkAttachments } : {}),
      },
    );
    onCancelEdit();
  }

  /** Remove (dismiss) a link embed preview on the author's own message. */
  async function handleRemoveEmbed(url: string) {
    await removeLinkEmbed(spaceId, roomId, message.id, url, {
      body: message.content,
      mimeType: message.mimeType,
      blocks:
        message.mimeType === RICHTEXT_MIME
          ? (parseRichTextContent(message.content) ?? [])
          : undefined,
    });
  }
</script>

{#snippet messageBox()}
  <div
    class="relative"
    onmouseenter={() => (hovered = true)}
    onmouseleave={() => (hovered = false)}
    oncontextmenu={handleContextAction}
    onclick={(e) => {
      // On touch devices, tapping a message toggles its inline toolbar.
      // Skip when the tap lands on a link (the user is navigating, not
      // summoning the toolbar).
      if (isMobile.current && !isThreading && !isEditing && !(e.target as Element)?.closest?.("a")) {
        toggleToolbar(message.id);
      }
    }}
  >
    <MessageBubble
      authorDid={original ? original.authorDid : message.authorDid}
      authorName={original ? (original.authorName ?? undefined) : (message.authorName ?? undefined)}
      authorHandle={original ? (original.authorHandle ?? undefined) : (message.authorHandle ?? undefined)}
      authorAvatarUrl={original ? (original.authorAvatar ?? undefined) : (message.authorAvatar ?? undefined)}
      avatarSrc={original ? resolveBlobUrl(original.authorAvatar) : resolveBlobUrl(message.authorAvatar)}
      profileUrl={effBridged ? undefined : `/user/${original ? original.authorDid : message.authorDid}`}
      onAvatarClick={effBridged ? undefined : () => goto(`/user/${original ? original.authorDid : message.authorDid}`)}
      timestamp={new Date(original ? original.timestamp : message.timestamp)}
      isBridged={effBridged}
      isSystem={isSystem}
      mergeWithPrevious={isSystem ? false : mergeWithPrevious}
      {isSelected}
      {isEditing}
      {showToolbar}
    >
      {#snippet replyContext()}
        {#if message.forwardedFrom}
          <ForwardContext
            name={message.authorName}
            did={message.authorDid}
            avatar={message.authorAvatar}
            timestamp={new Date(message.timestamp)}
            {spaceId}
            roomId={message.forwardedFrom.roomId}
            messageId={message.forwardedFrom.messageId}
          />
        {:else if message.replyTo}
          <MessageContext context={{ kind: "replying", replyTo: { id: message.replyTo } }} roomId={roomId} />
        {/if}
      {/snippet}

      {#snippet content()}
        {#if isEditing}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="editing-message"
            onkeydown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                onCancelEdit();
              }
            }}
          >
            <ChatInput
              bind:content={editContent}
              bind:blocks={editBlocks}
              bind:mentions={editMentions}
              initialBlocks={editBlocks}
              onEnter={handleEdit}
              placeholder="Edit message..."
              disabled={false}
              setFocus={true}
              mentionSearch={createMentionSearch(spaceId, roomId)}
            />
            {#if editLinks.length > 0}
              <div class="flex flex-col gap-2 mt-2">
                {#each editLinks as link (link.url)}
                  {#if link.showPreview}
                    <div class="relative">
                      <LinkCard url={link.url} embed={link.embed} />
                      <Button
                        variant="ghost"
                        class="absolute p-0.5 top-1 right-1 bg-base-100 hover:bg-base-200 dark:bg-base-900 dark:hover:bg-base-800 rounded-full"
                        aria-label="Dismiss link preview"
                        title="Remove link preview"
                        onclick={() => toggleEditLink(link.url)}
                      >
                        <IconX class="size-4" />
                      </Button>
                    </div>
                  {:else}
                    <div class="flex items-center justify-between gap-2 rounded-lg border border-dashed border-base-400/60 dark:border-base-800 px-3 py-2">
                      <span class="text-sm text-base-500 truncate">{hostname(link.url)}</span>
                      <Button
                        variant="secondary"
                        size="sm"
                        aria-label="Add link preview"
                        title="Show link preview"
                        onclick={() => toggleEditLink(link.url)}
                      >
                        Add preview
                      </Button>
                    </div>
                  {/if}
                {/each}
              </div>
            {/if}
          </div>
        {:else if isForward}
          {#if original}
            <MessageContent content={original.content} mimeType={original.mimeType} />
          {:else}
            <span class="italic text-base-400 text-sm">Original message unavailable</span>
          {/if}
        {:else}
          <MessageContent content={message.content} mimeType={message.mimeType} />
        {/if}
      {/snippet}

      {#snippet actions()}
        {#if isEditing}
          <Button
            variant="secondary"
            size="icon"
            class="shrink-0 rounded-full"
            aria-label="Cancel editing"
            title="Cancel (Esc)"
            onclick={onCancelEdit}
          >
            <IconX />
          </Button>
          <Button
            variant="primary"
            size="icon"
            class="shrink-0 rounded-full"
            aria-label="Save changes"
            title="Save (Enter)"
            onclick={() => handleEdit(editContent, editMentions, editBlocks ?? [])}
          >
            <IconCheck />
          </Button>
        {/if}
      {/snippet}

      {#snippet linkEmbeds()}
        {@const embeds = (isForward ? original?.linkEmbeds : message.linkEmbeds) ?? []}
        {#if embeds.length > 0}
          {@const withEmbed = embeds.filter((l: Message["linkEmbeds"][number]) => l.embed)}
          {#if withEmbed.length > 0}
            <div class="flex flex-col gap-2 mt-1">
              {#each withEmbed as link (link.url)}
                <LinkCard
                  url={link.url}
                  embed={link.embed}
                  onRemove={!isForward && isAuthor ? () => handleRemoveEmbed(link.url) : undefined}
                />
              {/each}
            </div>
          {/if}
        {/if}
      {/snippet}

      {#snippet media()}
        {@const media = (isForward ? original?.media : message.media) ?? []}
        {#if media.length > 0}
          {@const nonLinkMedia = media.filter((m: Message["media"][number]) => !m.type.startsWith("text/"))}
          {#if nonLinkMedia.length > 0}
            <MediaEmbed media={nonLinkMedia.map((m: Message["media"][number]) => ({ ...m, alt: m.alt ?? undefined }))} />
          {/if}
        {/if}
      {/snippet}

      {#snippet toolbar()}
        <MessageToolbar
          {spaceId}
          {roomId}
          {message}
          {mergeWithPrevious}
          {canEdit}
          {canDelete}
          bind:keepToolbarOpen
          {onStartEdit}
          onRequestDelete={() => onRequestDelete(message)}
          {onForward}
        />
      {/snippet}

      {#snippet reactions()}
        {#if message.reactions.length > 0}
          <MessageReactions
            {spaceId}
            {roomId}
            messageId={message.id}
            reactions={message.reactions}
            currentUserDid={currentUserDid}
          />
        {/if}
      {/snippet}
    </MessageBubble>

    {#if isForward && message.content}
      <!-- The forwarder's own commentary, rendered below the forwarded
           message as if it were a separate message (it's modelled as part of
           the same forward unit). -->
      <div class="mt-1">
        <MessageBubble
          authorDid={message.authorDid}
          authorName={message.authorName ?? undefined}
          authorHandle={message.authorHandle ?? undefined}
          authorAvatarUrl={message.authorAvatar ?? undefined}
          avatarSrc={resolveBlobUrl(message.authorAvatar)}
          profileUrl={isBridged ? undefined : `/user/${message.authorDid}`}
          onAvatarClick={isBridged ? undefined : () => goto(`/user/${message.authorDid}`)}
          timestamp={new Date(message.timestamp)}
          {isBridged}
        >
          {#snippet content()}
            <MessageContent content={message.content} mimeType={message.mimeType} />
          {/snippet}
        </MessageBubble>
      </div>
    {/if}
  </div>
{/snippet}

{#if isThreading}
  <Checkbox.Root
    aria-label="Select message"
    onclick={(e) => e.stopPropagation()}
    bind:checked={
      () => isSelected,
      () => messagingState.toggleMessageSelection(message)
    }
    class="flex flex-col w-full relative max-w-full isolate px-2 select-none"
  >
    {@render messageBox()}
  </Checkbox.Root>
{:else}
  <div class="flex flex-col w-full relative max-w-full isolate px-2">
    {@render messageBox()}
  </div>
{/if}

<style>
  /*
    The rendered message lives directly under the `.prose` wrapper, so Tailwind
    Typography's `.prose > :first-child { margin-top: 0 }` / `> :last-child
    { margin-bottom: 0 }` resets make its first/last paragraphs flush with the
    bubble. The tiptap editor instead renders paragraphs nested under
    `.tiptap` (inside `#chat-input`), so those resets never reach it and the
    editor picks up an extra ~1.25em margin above its first paragraph and below
    its last — making the edited content look inset vs. the rendered message.
    Mirror the resets here, scoped to the editing editor so the composer (which
    is not inside `.prose`) is unaffected.
  */
  :global(.editing-message .tiptap > :first-child) {
    margin-top: 0;
  }
  :global(.editing-message .tiptap > :last-child) {
    margin-bottom: 0;
  }
</style>

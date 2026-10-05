<script lang="ts">
  import type { Snippet } from "svelte";
  import UserAvatar from "../../../user/UserAvatar.svelte";
  import { formatMessageTimestamp } from "../../../../utils/date.js";
  import Badge from "../../../ui/badge/Badge.svelte";
  import {
    IconAlertCircle,
    IconHourglassMedium,
    IconLoading,
  } from "../../../../icons/index";

  /**
   * Presentational message bubble shell.
   *
   * Pure presentation — accepts data via props and presentational hooks via
   * snippets. Holds no data fetching, no app-state, no mutations. Wrapper
   * components (e.g. app's ChatMessage.svelte) wire data + handlers and pass
   * children/snippets to render reactions, toolbars, embeds, etc.
   *
   * Snippet slots are rendered as siblings/children at well-defined positions.
   * The shell decides layout; the wrapper decides what fills each slot.
   */
  let {
    // Author identity
    authorDid,
    authorName,
    authorHandle,
    authorAvatarUrl,
    profileUrl,
    // Timestamp + flags
    timestamp,
    isBridged = false,
    isSystem = false,
    isEdited = false,
    mergeWithPrevious = false,
    isSelected = false,
    isEditing = false,
    // Visual / interaction state
    showToolbar = false,
    compact = false,
    deliveryState,
    // Avatar fallback handling: wrappers may want a CDN-resolved URL
    avatarSrc,
    // Behaviour hooks
    onAvatarClick,
    // Snippet slots
    replyContext,
    content,
    media,
    linkEmbeds,
    forwardEmbed,
    toolbar,
    reactions,
    deliveryActions,
    queuedLabel,
  }: {
    authorDid: string | null;
    authorName?: string;
    authorHandle?: string;
    authorAvatarUrl?: string;
    profileUrl?: string;
    timestamp: Date;
    isBridged?: boolean;
    /** System notice (e.g. "X joined the space"). Renders centred without an author identity line or avatar. */
    isSystem?: boolean;
    /** Message content has been edited — renders an "edited" marker beside the timestamp. */
    isEdited?: boolean;
    mergeWithPrevious?: boolean;
    isSelected?: boolean;
    isEditing?: boolean;
    showToolbar?: boolean;
    /** Reduced top margin for dense contexts (e.g. search result lists). */
    compact?: boolean;
    /**
     * Delivery state of a message the viewer just sent, until the server
     * acknowledges it. `pending` dims the body and puts a spinner in the
     * avatar slot — it gets no status line of its own, so the row never
     * shifts when it resolves; `failed` shows a "Not sent" marker above the
     * message with the `deliveryActions` slot (retry / discard); `queued`
     * dims the body the same way and shows `queuedLabel` instead, for a send
     * that was held back rather than rejected. Messages delivered by the
     * server leave this unset.
     */
    deliveryState?: "pending" | "failed" | "queued";
    /** Pre-resolved avatar URL (e.g. after CDN rewriting). Falls back to authorAvatarUrl. */
    avatarSrc?: string;
    onAvatarClick?: (e: MouseEvent) => void;
    replyContext?: Snippet;
    /** Renders the message body (HTML, plaintext, or edit input). */
    content?: Snippet;
    media?: Snippet;
    linkEmbeds?: Snippet;
    /** Renders a forward embed (a quoted copy of the original message). */
    forwardEmbed?: Snippet;
    toolbar?: Snippet;
    reactions?: Snippet;
    /** Action buttons rendered at the end of the message row, vertically
        centered across the whole message (avatar + header + body) — e.g. the
        save/cancel controls shown while editing. Only rendered while editing. */
    actions?: Snippet;
    /** Controls rendered beside the marker of an unsent message (retry /
        discard). Rendered for both the `failed` and the `queued` state. */
    deliveryActions?: Snippet;
    /** Text of the marker a `queued` send gets instead of the "Not sent" line.
        Absent, a `queued` message falls back to the failure marker. */
    queuedLabel?: string;
  } = $props();

  /**
   * Classes for the sticky anchor that carries the toolbar (see the markup).
   *
   * `-mx-2` widens the anchor to the root's padding box, which is the box the
   * toolbar's `right-0` was measured against before it moved inside the anchor;
   * `-mt-*`/`mb-*` re-align its top edge with the root's padding box, cancelling
   * the root's `pt-*` without contributing any height, so nothing on the row
   * moves. The `top-*` values are the toolbar's own `-top-4` / `-top-9` offset
   * plus 8px, so a stuck toolbar's top edge lands 8px below the chat area's top.
   */
  let toolbarAnchorClass = $derived(
    `sticky ${mergeWithPrevious ? "top-11" : "top-6"} z-30 h-0 -mx-2 ${
      mergeWithPrevious ? "" : compact ? "-mt-0.5 mb-0.5" : "-mt-1 mb-1"
    }`,
  );
</script>

{#snippet timestampLabel(date: Date)}
  {@const isValid = !isNaN(date.getTime())}
  <time
    class="text-[13px] align-middle font-medium text-base-700 dark:text-base-400"
  >
    {isValid ? formatMessageTimestamp(date) : ""}
  </time>
{/snippet}

<!-- Edit notice. The appserver sets `lastEdit` only on a message whose
     content was actually edited, so this never shows for a pristine one.
     Rendered beside the timestamp in the message header, and on its own
     line when the header is suppressed — consecutive messages by one author
     merge into a single header, which is exactly where a fresh edit lands. -->
{#snippet editedLabel()}
  <span
    class="text-[11px] font-medium align-middle text-base-400 dark:text-base-500"
  >
    edited
  </span>
{/snippet}

<div
  class={[
    `no-mobile-select relative group w-full flex flex-col px-2 rounded border ${isEditing ? "border-accent-400/60 dark:border-accent-800 bg-accent-100/50 dark:bg-accent-900/50" : isSelected ? "border-transparent bg-accent-100/50 dark:bg-accent-900/50 hover:bg-accent-100/75 dark:hover:bg-accent-900/75" : "border-transparent hover:bg-base-100/50 dark:hover:bg-base-400/5"}`,
    mergeWithPrevious ? "mt-1" : compact ? "mt-1.5 pt-0.5" : "mt-5 pt-1",
  ]}
>
  <!-- The message toolbar's sticky anchor, deliberately the root's first child
       and always mounted (the toolbar inside it still mounts only when shown).

       The chat list is virtualized, so each message is an absolutely
       positioned row of a fixed-height container and the scroll container
       (`ChatArea`'s viewport) is not an ancestor of the row's content box for
       sticky purposes. A sticky element therefore travels inside its own row,
       which only carries this message: the toolbar rides down the message as
       you scroll into it and stops at the chat area's top edge — it does not
       follow the whole timeline. That is the intended scope: the actions stay
       reachable while you read *this* message, and release when the next
       message's row takes over.

       `h-0` with a margin pair that cancels the root's `pt-*` means the anchor
       contributes no height and leaves the message's layout exactly where it
       was; the toolbar keeps its own absolute placement inside it. -->
  <div class={toolbarAnchorClass}>
    {#if showToolbar && toolbar}
      {@render toolbar()}
    {/if}
  </div>

  {#if deliveryState === "failed"}
    <!-- A rejected send: the marker sits above the message so it is visible
         without hover (unlike the message toolbar), carrying the retry /
         discard controls the app wires into `deliveryActions`. A pending send
         has no marker of its own — its spinner lives in the avatar slot below
         (see `deliveryState`). -->
    <div
      class="flex items-center gap-1.5 pl-12 text-[11px] font-medium text-red-600 dark:text-red-400"
    >
      <IconAlertCircle class="size-3 shrink-0" />
      Not sent
      {#if deliveryActions}
        <span class="flex items-center gap-1">
          {@render deliveryActions()}
        </span>
      {/if}
    </div>
  {:else if deliveryState === "queued" && queuedLabel}
    <!-- A send the appserver is holding off while the space it targets is set
         up: nothing is wrong with the message, so this reads as a wait rather
         than as the rejection above. It carries the same retry / discard
         controls and resends the same event under the same ULID. -->
    <div
      class="flex items-center gap-1.5 pl-12 text-[11px] font-medium text-amber-700 dark:text-amber-400"
      data-testid="queued-delivery"
    >
      <IconHourglassMedium class="size-3 shrink-0" />
      {queuedLabel}
      {#if deliveryActions}
        <span class="flex items-center gap-1">
          {@render deliveryActions()}
        </span>
      {/if}
    </div>
  {/if}

  <div class={mergeWithPrevious ? "pl-12" : ""}>
    {#if replyContext}
      {@render replyContext()}
    {/if}
  </div>

  <!-- An unacknowledged send reads as provisional. A rejected one dims the
       whole row, avatar included, matching its "Not sent" marker above. A
       queued one dims only the body: its spinner replaces the avatar and is
       the one thing that should stay legible. -->
  <div
    class="group relative flex w-full justify-start gap-3"
    class:opacity-60={deliveryState === "failed"}
  >
    <!-- The avatar slot — the message's left margin (skipped for centred
         system notices). A queued send puts its spinner here in place of the
         avatar: delivery state is transient, so it takes no line of its own
         above the message, and the row never shifts when the avatar comes
         back. -->
    {#if !isSystem}
      {#if deliveryState === "pending"}
        <!-- Sized and top-aligned like the avatar it replaces, so the swap
             when the server row lands moves nothing. -->
        <div class="flex size-8 shrink-0 items-center justify-center sm:size-10">
          <IconLoading
            class="size-4 shrink-0 animate-spin text-base-500 dark:text-base-400"
          />
        </div>
      {:else if mergeWithPrevious}
        <div class="w-8 shrink-0 sm:w-10"></div>
      {:else}
        <div class="size-8 sm:size-10">
          <button
            onclick={(e) => {
              e.stopPropagation();
              onAvatarClick?.(e);
            }}
            class="rounded-full hover:ring-2 hover:ring-accent-500 transition-all cursor-pointer"
          >
            <UserAvatar
              src={avatarSrc ?? authorAvatarUrl}
              name={authorDid || "system"}
              class="size-8 sm:size-10"
            />
          </button>
        </div>
      {/if}
    {/if}

    <div
      class:justify-center={isSystem}
      class:items-center={isSystem}
      class:opacity-60={deliveryState === "pending" || deliveryState === "queued"}
      class="flex flex-col flex-1 min-w-0"
    >
      <!-- Username, timestamp (system notices render a small centred timestamp instead) -->
      {#if isSystem}
        <span class="text-[11px] font-medium uppercase tracking-wide text-base-400 dark:text-base-500 mb-1">
          {@render timestampLabel(timestamp)}
        </span>
      {:else if !mergeWithPrevious}
        <div class="text-sm w-full text-start">
          <span class="gap-2">
          {#if profileUrl}
            <a
              href={profileUrl}
              class="font-medium text-accent-700 dark:text-accent-400 hover:underline"
              >{authorName || (authorHandle ? `@${authorHandle}` : "")}</a
            >
          {:else}
            <span class="font-medium text-accent-700 dark:text-accent-400"
              >{authorName || (authorHandle ? `@${authorHandle}` : "")}</span
            >
          {/if}
            {#if authorHandle}
              {#if profileUrl}
                <a
                  href={profileUrl}
                  class="opacity-75 font-normal hover:underline"
                  >@{authorHandle}</a
                >
              {:else}
                <span class="opacity-75 font-normal">@{authorHandle}</span>
              {/if}
            {/if}
            {#if isBridged}
              <Badge
                variant="secondary"
                title="This message was bridged from Discord."
                class="text-[10px] -my-0.5 px-1.5 font-bold opacity-75"
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
            {@render timestampLabel(timestamp)}
          </span>
          {#if isEdited}
            {@render editedLabel()}
          {/if}
        </div>
      {:else if isEdited}
        <!-- Header suppressed (merged with the previous message by the same
             author): the timestamp is not rendered, so the edit notice gets
             its own line rather than disappearing with the header. -->
        <span class="text-sm w-full text-start">
          {@render editedLabel()}
        </span>
      {/if}

      <!-- Message text.
           `roomy-prose` opts this element into the shared block typography in
           app-lite's `lib/message-typography.css` — the same rules the
           composer's `.tiptap` uses, so the two stay a WYSIWYG pair. It is
           deliberately not applied to other `.prose` users (ActivityFeed,
           UserProfile), which render inline/compact and keep `.prose` as-is. -->
      <div
        class="roomy-prose prose dark:prose-invert prose-a:text-accent-600 dark:prose-a:text-accent-400 prose-a:no-underline text-sm font-normal max-w-full overflow-auto hide-scrollbar"
        class:text-left={!isSystem}
        class:text-center={isSystem}
        class:opacity-75={isSystem}
      >
        {#if content}
          {@render content()}
        {/if}
        {#if forwardEmbed}
          {@render forwardEmbed()}
        {/if}
        {#if linkEmbeds}
          {@render linkEmbeds()}
        {/if}
      </div>

      <!-- Media -->
      {#if media}
        {@render media()}
      {/if}
    </div>

    {#if isEditing && actions}
      <div class="flex shrink-0 items-center self-center gap-1 not-prose">
        {@render actions()}
      </div>
    {/if}
  </div>

  {#if reactions}
    {@render reactions()}
  {/if}
</div>

<style>
  @media (hover: none), (pointer: coarse) {
    .no-mobile-select {
      user-select: none;
    }
  }

  .hide-scrollbar::-webkit-scrollbar {
    display: none;
  }

  /* Hide scrollbar for IE, Edge and Firefox */
  .hide-scrollbar {
    -ms-overflow-style: none; /* IE and Edge */
    scrollbar-width: none; /* Firefox */
  }

  .prose a:hover {
    text-decoration: underline;
  }
</style>

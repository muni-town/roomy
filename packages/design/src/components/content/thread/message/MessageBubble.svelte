<script lang="ts">
  import type { Snippet } from "svelte";
  import { Avatar } from "bits-ui";
  import { AvatarBeam } from "svelte-boring-avatars";
  import { format, isToday, isTomorrow, isYesterday } from "date-fns";
  import Badge from "../../../ui/badge/Badge.svelte";

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
    mergeWithPrevious = false,
    isSelected = false,
    // Visual / interaction state
    showToolbar = false,
    // Avatar fallback handling: wrappers may want a CDN-resolved URL
    avatarSrc,
    // Behaviour hooks
    onAvatarClick,
    // Snippet slots
    replyContext,
    content,
    media,
    linkEmbeds,
    toolbar,
    reactions,
  }: {
    authorDid: string | null;
    authorName?: string;
    authorHandle?: string;
    authorAvatarUrl?: string;
    profileUrl?: string;
    timestamp: Date;
    isBridged?: boolean;
    mergeWithPrevious?: boolean;
    isSelected?: boolean;
    showToolbar?: boolean;
    /** Pre-resolved avatar URL (e.g. after CDN rewriting). Falls back to authorAvatarUrl. */
    avatarSrc?: string;
    onAvatarClick?: (e: MouseEvent) => void;
    replyContext?: Snippet;
    /** Renders the message body (HTML, plaintext, or edit input). */
    content?: Snippet;
    media?: Snippet;
    linkEmbeds?: Snippet;
    toolbar?: Snippet;
    reactions?: Snippet;
  } = $props();
</script>

{#snippet timestampLabel(date: Date)}
  {@const isValid = !isNaN(date.getTime())}
  {@const formattedDate = !isValid
    ? ""
    : isTomorrow(date)
      ? "Tomorrow at "
      : isToday(date)
        ? "Today at "
        : isYesterday(date)
          ? "Yesterday at "
          : format(date, "P") + ", "}
  <time
    class="text-[13px] align-middle font-medium text-base-700 dark:text-base-400"
  >
    {formattedDate}{isValid ? format(date, "p") : ""}
  </time>
{/snippet}

<div
  class={[
    `no-mobile-select relative group w-full flex flex-col px-2 rounded ${isSelected ? "bg-accent-100/50 dark:bg-accent-900/50 hover:bg-accent-100/75 dark:hover:bg-accent-900/75" : " hover:bg-base-100/50  dark:hover:bg-base-400/5"}`,
    mergeWithPrevious ? "mt-1" : "mt-5 pt-1",
  ]}
>
  <div class={mergeWithPrevious ? "pl-12" : ""}>
    {#if replyContext}
      {@render replyContext()}
    {/if}
  </div>

  <div class="group relative flex w-full justify-start gap-3">
    <!-- Avatar, or left margin -->
    {#if !mergeWithPrevious}
      <div class="size-8 sm:size-10">
        <button
          onclick={(e) => {
            e.stopPropagation();
            onAvatarClick?.(e);
          }}
          class="rounded-full hover:ring-2 hover:ring-accent-500 transition-all cursor-pointer"
        >
          <Avatar.Root class="size-8 sm:size-10">
            <Avatar.Image
              src={avatarSrc ?? authorAvatarUrl}
              class="rounded-full"
            />
            <Avatar.Fallback>
              <AvatarBeam name={authorDid || "system"} />
            </Avatar.Fallback>
          </Avatar.Root>
        </button>
      </div>
    {:else}
      <div class="w-8 shrink-0 sm:w-10"></div>
    {/if}

    <div class="flex flex-col w-full min-w-0">
      <!-- Username, timestamp -->
      {#if !mergeWithPrevious}
        <div class="text-sm w-full text-start">
          <span class="gap-2">
            <span class="font-medium text-accent-700 dark:text-accent-400"
              >{authorName}</span
            >
            {#if authorHandle}<span class="opacity-75 font-normal"
                >@{authorHandle}</span
              >{/if}
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
        </div>
      {/if}

      <!-- Message text -->
      <div
        class="text-sm font-normal prose text-left prose-a:text-accent-600 dark:prose-a:text-accent-400 dark:prose-invert prose-a:no-underline max-w-full overflow-auto hide-scrollbar"
      >
        {#if content}
          {@render content()}
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
  </div>

  {#if showToolbar && toolbar}
    {@render toolbar()}
  {/if}

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
</style>

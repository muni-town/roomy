<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { createQueries } from "@tanstack/svelte-query";
  import { cache } from "@roomy-space/sdk";
  import { px, auth } from "$lib/auth.svelte";
  import { queryClient } from "$lib/client";
  import { setNavbar } from "$lib/components/layout/navbar.svelte";
  import { setSidebarContent, setSidebarHeader } from "$lib/components/layout/sidebar.svelte";
  import { setWideSidebar } from "$lib/components/layout/wide-sidebar.svelte";
  import RoomyMark from "$lib/components/RoomyMark.svelte";
  import { createSearchMessagesQuery, type SearchMessage } from "$lib/queries/search";
  import { createFeatureFlagsQuery } from "$lib/queries/feature-flags";
  import { resolveBlobUrl } from "$lib/utils";
  import ErrorMessage from "@roomy/design/components/helper/ErrorMessage.svelte";
  import MessageBubble from "@roomy/design/components/content/thread/message/MessageBubble.svelte";
  import SpaceAvatar from "@roomy/design/components/spaces/SpaceAvatar.svelte";
  import {
    IconSearch,
    IconChevronRight,
    IconNeedleThread,
    IconForward,
    IconReplyLine,
  } from "@roomy/design/icons";
  import UserAvatar from "@roomy/design/components/user/UserAvatar.svelte";
  import MessageContent from "$lib/components/chat/MessageContent.svelte";
  import ForwardContext from "$lib/components/chat/ForwardContext.svelte";
  import { messageContentToPlaintext } from "$lib/components/chat/messagePreview";
  import MessageReactions from "$lib/components/chat/MessageReactions.svelte";
  import MediaEmbed from "$lib/components/chat/embeds/MediaEmbed.svelte";
  import LinkCard from "$lib/components/chat/embeds/LinkCard.svelte";
  import SeoMeta from "$lib/components/seo/SeoMeta.svelte";

  const { queryKey } = cache;

  // Search feature flag: gates the whole Explore page (direct navigation
  // lands here even when the sidebar button is hidden).
  const flagsQuery = createFeatureFlagsQuery();
  const searchEnabled = $derived(
    flagsQuery.data?.flags.includes("search") ?? false,
  );

  let searchInput = $state("");
  let searchTerm = $state("");
  // NOTE: the input value must be read synchronously inside the effect —
  // Svelte 5 effects only track reads that happen during the effect run, so
  // reading it inside the setTimeout callback would never re-trigger.
  $effect(() => {
    const value = searchInput;
    const timer = setTimeout(() => {
      searchTerm = value.trim();
    }, 250);
    return () => clearTimeout(timer);
  });

  const searchQuery = createSearchMessagesQuery(() => searchTerm);

  // Flatten all pages into a single array.
  const messages = $derived(
    searchQuery.data?.pages.flatMap((p) => p.messages) ?? [],
  );

  let hasMore = $derived(searchQuery.hasNextPage ?? false);

  function loadMore() {
    searchQuery.fetchNextPage();
  }

  // Auto-pagination sentinel: when the sentinel scrolls into view (200px
  // before the end), fetch the next page. Same pattern as BoardView.
  let sentinel: HTMLElement | undefined = $state();

  $effect(() => {
    const el = sentinel;
    if (!el || !hasMore) return;

    let fetching = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !fetching) {
          fetching = true;
          loadMore();
          timer = setTimeout(() => { fetching = false; }, 500);
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (timer !== undefined) clearTimeout(timer);
    };
  });

  // Space names for result context: one lightweight getSpaceSummary query
  // per distinct space in the results. createQueries is reactive — the
  // accessor re-runs as results change, and the results array updates as
  // each summary lands (getQueryData reads would be non-reactive).
  const spaceIds = $derived(
    [...new Set(messages.map((m) => m.spaceId).filter(Boolean))] as string[],
  );

  const spaceSummaryQueries = createQueries(
    () => ({
      queries: spaceIds.map((sid) => ({
        queryKey: queryKey("space.roomy.space.getSpaceSummary", { spaceId: sid }),
        queryFn: () => px().query("space.roomy.space.getSpaceSummary", { spaceId: sid }),
      })),
    }),
    () => queryClient,
  );

  const spaceNames = $derived.by<Map<string, { name?: string; avatar?: string }>>(() => {
    const map = new Map<string, { name?: string; avatar?: string }>();
    for (let i = 0; i < spaceIds.length; i++) {
      const data = spaceSummaryQueries[i]?.data;
      if (data) map.set(spaceIds[i]!, data);
    }
    return map;
  });

  // Room display names/kinds for the result context line: one lightweight
  // getRoomSummary query per distinct room in the results (same pattern as
  // the space summaries above).
  const roomIds = $derived(
    [...new Set(messages.map((m) => m.roomId).filter(Boolean))] as string[],
  );

  const roomSummaryQueries = createQueries(
    () => ({
      queries: roomIds.map((rid) => ({
        queryKey: queryKey("space.roomy.room.getRoomSummary", { roomId: rid }),
        queryFn: () => px().query("space.roomy.room.getRoomSummary", { roomId: rid }),
      })),
    }),
    () => queryClient,
  );

  const roomSummaries = $derived.by<Map<string, { name?: string; kind?: string }>>(
    () => {
      const map = new Map<string, { name?: string; kind?: string }>();
      for (let i = 0; i < roomIds.length; i++) {
        const data = roomSummaryQueries[i]?.data;
        if (data) map.set(roomIds[i]!, data);
      }
      return map;
    },
  );

  onMount(() => {
    setNavbar(exploreNavbar);
    setSidebarContent(undefined);
    setSidebarHeader(roomyHeader);
    setWideSidebar(true);
    return () => {
      setNavbar(undefined);
      setSidebarContent(undefined);
      setSidebarHeader(undefined);
      setWideSidebar(false);
    };
  });

  function hrefFor(m: SearchMessage): string {
    return `/${m.spaceId}/${m.roomId}`;
  }
</script>

<SeoMeta title="Explore - Roomy" description="Search across all your spaces" />

{#snippet roomyHeader()}
  <!-- Roomy logo + wordmark, matching the Directory page's homepage header
       (SpaceSidebar spaceHeader) so the sidebar reads identically. -->
  <div class="w-full h-fit flex justify-between items-center gap-1">
    <div class="flex items-center gap-2 flex-1 min-w-0">
      <div class="flex items-center gap-2.75 -mx-1 px-5.5 py-3">
        <RoomyMark sizeClass="size-8" />
        <h1
          class="text-lg font-black opacity-90 text-base-700 dark:text-base-200 truncate max-w-full grow min-w-0"
        >
          Roomy
        </h1>
      </div>
    </div>
  </div>
{/snippet}

{#snippet exploreNavbar()}
  <div class="flex w-full items-center gap-2 px-2 min-w-0 grow">
    <span class="text-sm font-semibold truncate">Explore</span>
  </div>
{/snippet}

<div class="h-full dark:bg-base-900/20 text-base-800 dark:text-base-200">
  {#if !searchEnabled}
    <div class="h-full flex items-center justify-center">
      <p class="text-sm text-base-500 dark:text-base-400">
        Search is not enabled for your account yet.
      </p>
    </div>
  {:else}
  <main class="h-full overflow-y-auto text-base-950 dark:text-base-50">
    <div class="flex flex-col items-center py-8 px-4">
      <div class="w-full max-w-2xl flex flex-col gap-4">
        <div class="relative">
          <IconSearch class="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-base-400" />
          <input
            type="text"
            bind:value={searchInput}
            placeholder="Search messages across all your spaces…"
            class="w-full ring-1 ring-inset ring-base-300 dark:ring-base-700 focus:ring-2 focus:ring-accent-500 bg-base-100 dark:bg-base-800/50 focus:bg-accent-400/5 dark:focus:bg-accent-600/5 text-base-900 dark:text-base-100 placeholder:text-base-400 dark:placeholder:text-base-500 rounded-2xl pl-9 pr-3 py-2 text-sm font-medium outline-none border-0 transition-colors"
          />
        </div>

        {#if searchTerm.length > 0 && searchTerm.length < 3}
          <p class="text-sm text-base-400">Type at least 3 characters to search.</p>
        {:else if searchQuery.isPending}
          <p class="text-sm text-base-400">Searching…</p>
        {:else if searchQuery.isError}
          <ErrorMessage message={searchQuery.error.message} class="py-8" />
        {:else if searchQuery.data}
          {#if messages.length === 0}
            <p class="text-sm text-base-400">No messages found.</p>
          {:else}
            <ul class="space-y-3">
              {#each messages as m (m.id)}
                {@const spaceMeta = spaceNames.get(m.spaceId ?? "")}
                {@const roomMeta = roomSummaries.get(m.roomId ?? "")}
                {@const isForward = !!m.forwardedFrom}
                {@const original = m.forwardedFrom?.message}
                {@const replyPreview = m.reply?.message}
                {@const effBridged =
                  m.authorDid.startsWith("did:discord:") ||
                  (original?.authorDid.startsWith("did:discord:") ?? false)}
                {@const replyBridged = replyPreview?.authorDid.startsWith("did:discord:") ?? false}
                {@const replyPreviewContent =
                  replyPreview?.forwardedFrom?.message?.content ??
                  replyPreview?.content ??
                  ""}
                {@const replyPreviewMime =
                  replyPreview?.forwardedFrom?.message?.mimeType ??
                  replyPreview?.mimeType}
                <li>
                  <!-- Results render with the same MessageBubble the chat
                       area uses. The whole row navigates to the room; inner
                       interactive elements (avatar, links, reactions) are
                       skipped. -->
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <div
                    role="link"
                    tabindex="0"
                    class="rounded-xl cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60 hover:bg-base-100/50 dark:hover:bg-base-400/5"
                    onclick={(e) => {
                      if ((e.target as Element)?.closest?.("a,button,[role=button]")) return;
                      goto(hrefFor(m));
                    }}
                    onkeydown={(e) => {
                      if ((e.target as Element)?.closest?.("a,button,[role=button]")) return;
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        goto(hrefFor(m));
                      }
                    }}
                  >
                    <!-- Where the result lives. Rendered above the message so
                         the hit reads like a regular message in context. -->
                    <div class="flex items-center gap-1 px-3 pt-1.5 pb-1 text-xs text-base-500 dark:text-base-400">
                      <span class="inline-flex items-center gap-1 min-w-0">
                        <SpaceAvatar
                          src={resolveBlobUrl(spaceMeta?.avatar)}
                          id={m.spaceId}
                          name={spaceMeta?.name ?? m.spaceId}
                          size={14}
                        />
                        <span class="truncate">{spaceMeta?.name ?? m.spaceId}</span>
                      </span>
                      <IconChevronRight class="opacity-40 size-3 shrink-0" />
                      <span class="inline-flex items-center gap-1 min-w-0">
                        {#if roomMeta?.kind === "thread"}
                          <IconNeedleThread class="opacity-60 size-3.5 shrink-0" />
                        {:else}
                          <span class="opacity-60 shrink-0">#</span>
                        {/if}
                        <span class="truncate">{roomMeta?.name ?? m.roomId}</span>
                      </span>
                    </div>

                    <MessageBubble
                      authorDid={original ? original.authorDid : m.authorDid}
                      authorName={original ? (original.authorName ?? undefined) : (m.authorName ?? undefined)}
                      authorHandle={original ? (original.authorHandle ?? undefined) : (m.authorHandle ?? undefined)}
                      authorAvatarUrl={original ? (original.authorAvatar ?? undefined) : (m.authorAvatar ?? undefined)}
                      avatarSrc={original ? resolveBlobUrl(original.authorAvatar) : resolveBlobUrl(m.authorAvatar)}
                      profileUrl={effBridged ? undefined : `/user/${original ? original.authorDid : m.authorDid}`}
                      onAvatarClick={effBridged ? undefined : () => goto(`/user/${original ? original.authorDid : m.authorDid}`)}
                      timestamp={new Date(original ? original.timestamp : m.timestamp)}
                      isBridged={effBridged}
                      isSystem={m.system === true}
                    >
                      {#snippet replyContext()}
                        {#if m.forwardedFrom}
                          <ForwardContext
                            name={m.authorName}
                            did={m.authorDid}
                            avatar={m.authorAvatar}
                            timestamp={new Date(m.timestamp)}
                          />
                        {:else if m.replyTo}
                          {#if replyPreview}
                            <div class="flex gap-1 items-center shrink-0">
                              <IconReplyLine
                                width="28px"
                                height="12px"
                                class="relative -bottom-1 ml-2 mr-1 left-0.75 stroke-black/25 dark:stroke-white/50 dark:stroke-1"
                              />
                              {#if replyPreview.authorAvatar || replyPreview.authorDid}
                                {#if replyBridged}
                                  <div class="w-4 h-4 rounded-full shrink-0">
                                    <UserAvatar
                                      src={resolveBlobUrl(replyPreview.authorAvatar)}
                                      name={replyPreview.authorDid || ""}
                                      size={16}
                                      class="w-4 h-4"
                                    />
                                  </div>
                                {:else}
                                  <button
                                    onclick={(e) => {
                                      e.stopPropagation();
                                      goto(`/user/${replyPreview.authorDid}`);
                                    }}
                                    class="w-4 h-4 rounded-full shrink-0 hover:ring-2 hover:ring-accent-500 transition-all cursor-pointer"
                                  >
                                    <UserAvatar
                                      src={resolveBlobUrl(replyPreview.authorAvatar)}
                                      name={replyPreview.authorDid || ""}
                                      size={16}
                                      class="w-4 h-4"
                                    />
                                  </button>
                                {/if}
                              {/if}
                              {#if replyBridged}
                                <span class="font-medium text-accent-700 dark:text-accent-300">
                                  {replyPreview.authorName || replyPreview.authorDid.slice(0, 12)}
                                </span>
                              {:else}
                                <a
                                  href={`/user/${replyPreview.authorDid}`}
                                  class="font-medium text-accent-700 dark:text-accent-300 hover:underline"
                                >{replyPreview.authorName || replyPreview.authorDid.slice(0, 12)}</a
                                >
                              {/if}
                            </div>
                            <div class="flex items-center gap-1 italic">
                              {#if replyPreview.forwardedFrom}
                                <IconForward class="size-3.5 shrink-0 text-base-500 dark:text-base-400" />
                              {/if}
                              <span class="line-clamp-1 overflow-hidden">
                                {@html messageContentToPlaintext(replyPreviewContent, replyPreviewMime)}
                              </span>
                            </div>
                          {:else}
                            <span class="italic text-base-400">Reply unavailable</span>
                          {/if}
                        {/if}
                      {/snippet}

                      {#snippet content()}
                        {#if isForward}
                          {#if original}
                            <MessageContent content={original.content} mimeType={original.mimeType} />
                          {:else}
                            <span class="italic text-base-400 text-sm">Original message unavailable</span>
                          {/if}
                        {:else}
                          <MessageContent content={m.content} mimeType={m.mimeType} />
                        {/if}
                      {/snippet}

                      {#snippet linkEmbeds()}
                        {@const embeds = (isForward ? original?.linkEmbeds : m.linkEmbeds) ?? []}
                        {#if embeds.some((l) => l.embed)}
                          <div class="flex flex-col gap-2 mt-1">
                            {#each embeds.filter((l) => l.embed) as link (link.url)}
                              <LinkCard url={link.url} embed={link.embed} />
                            {/each}
                          </div>
                        {/if}
                      {/snippet}

                      {#snippet media()}
                        {@const media = (isForward ? original?.media : m.media) ?? []}
                        {#if media.some((item) => !item.type.startsWith("text/"))}
                          <MediaEmbed
                            media={media
                              .filter((item) => !item.type.startsWith("text/"))
                              .map((item) => ({ ...item, alt: item.alt ?? undefined }))}
                          />
                        {/if}
                      {/snippet}

                      {#snippet reactions()}
                        {#if m.reactions.length > 0}
                          <MessageReactions
                            spaceId={m.spaceId}
                            roomId={m.roomId}
                            messageId={m.id}
                            reactions={m.reactions}
                            currentUserDid={auth.userDid}
                          />
                        {/if}
                      {/snippet}
                    </MessageBubble>

                    {#if isForward && m.content}
                      <!-- The forwarder's own note, below the forwarded
                           original — same as the chat area. -->
                      <div class="mt-1">
                        <MessageBubble
                          authorDid={m.authorDid}
                          authorName={m.authorName ?? undefined}
                          authorHandle={m.authorHandle ?? undefined}
                          authorAvatarUrl={m.authorAvatar ?? undefined}
                          avatarSrc={resolveBlobUrl(m.authorAvatar)}
                          profileUrl={m.authorDid.startsWith("did:discord:") ? undefined : `/user/${m.authorDid}`}
                          onAvatarClick={m.authorDid.startsWith("did:discord:") ? undefined : () => goto(`/user/${m.authorDid}`)}
                          timestamp={new Date(m.timestamp)}
                        >
                          {#snippet content()}
                            <MessageContent content={m.content} mimeType={m.mimeType} />
                          {/snippet}
                        </MessageBubble>
                      </div>
                    {/if}
                  </div>
                </li>
              {/each}
            </ul>
            {#if hasMore}
              <div
                bind:this={sentinel}
                class="flex items-center justify-center py-4"
              >
                <div class="text-sm text-base-400">
                  {searchQuery.isFetchingNextPage ? "Loading more…" : "Scroll for more"}
                </div>
              </div>
            {/if}
          {/if}
        {/if}
      </div>
    </div>
  </main>
  {/if}
</div>

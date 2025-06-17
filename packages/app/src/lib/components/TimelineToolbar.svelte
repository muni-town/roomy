<script lang="ts">
  import { page } from "$app/state";
  import { navigate } from "$lib/utils.svelte";
  import Icon from "@iconify/svelte";
  import { Popover, Button } from "bits-ui";
  import Dialog from "$lib/components/Dialog.svelte";
  import { toast } from "svelte-french-toast";
  import { threading } from "./TimelineView.svelte";
  import { isSpaceAdmin } from "$lib/jazz/utils";
  import { CoState, AccountCoState } from "jazz-svelte";
  import { Channel, Space, Thread, RoomyAccount, GlobalHiddenPost } from "$lib/jazz/schema";
  import { co } from "jazz-tools";
  import { publicGroup } from "$lib/jazz/utils";
  import { ATPROTO_FEED_CONFIG, ATPROTO_FEEDS, addFeedToList } from "$lib/utils/atproToFeeds";
  import { user } from "$lib/user.svelte";

  let { createThread, threadTitleInput = $bindable() } = $props();
  let showSettingsDialog = $state(false);
  let channelNameInput = $state("");
  let channelCategoryInput = $state(undefined) as undefined | string;
  let selectedFeeds = $state<string[]>([]);
  let customFeedInput = $state(""); // For both URLs and URIs

  // Get the current Jazz account
  const me = new AccountCoState(RoomyAccount, {
    resolve: {
      profile: true,
      root: true,
    },
  });

  // Get hidden posts statistics with content previews (personal + global)
  let hiddenPostsStats = $state<Array<{ uri: string, count: number, lastHidden: Date, preview: string, author?: string, isGlobal?: boolean, hiddenBy?: string }>>([]);
  
  // Update hidden posts stats when hiddenFeedPosts or channel changes
  $effect(async () => {
    const personallyHidden = me.current?.profile?.hiddenFeedPosts || [];
    const globalHiddenPosts = channel.current?.globalHiddenPosts || [];
    
    console.log('🔍 DEBUG: TimelineToolbar effect', {
      hasChannel: !!channel.current,
      channelType: channel.current?.channelType,
      hasGlobalHiddenPosts: !!channel.current?.globalHiddenPosts,
      globalHiddenPostsLength: globalHiddenPosts.length,
      personallyHiddenLength: personallyHidden.length
    });
    
    if (personallyHidden.length === 0 && globalHiddenPosts.length === 0) {
      hiddenPostsStats = [];
      return;
    }
    
    // Combine personal and global hidden posts
    const allStats = new Map<string, { uri: string, count: number, lastHidden: Date, isGlobal: boolean, hiddenBy?: string }>();
    
    // Add personally hidden posts
    const uniquePersonal = [...new Set(personallyHidden)];
    uniquePersonal.forEach(uri => {
      allStats.set(uri, { uri, count: 1, lastHidden: new Date(), isGlobal: false, hiddenBy: me.current?.profile?.blueskyHandle || 'You' });
    });
    
    // Add posts with votes (both hidden and not-yet-hidden)
    globalHiddenPosts.forEach((ghp, index) => {
      console.log(`🌐 DEBUG: Processing global post ${index}:`, {
        hasPost: !!ghp,
        postUri: ghp?.postUri,
        hasVotes: !!ghp?.votes,
        voteCount: ghp?.votes?.length || 0,
        isHidden: ghp?.isHidden
      });
      
      if (!ghp || !ghp.votes) return; // Skip null entries
      
      const voteCount = ghp.votes.length;
      const isHidden = ghp.isHidden;
      
      if (allStats.has(ghp.postUri)) {
        // Update existing entry with global info
        const existing = allStats.get(ghp.postUri)!;
        existing.count = voteCount;
        existing.isGlobal = isHidden; // True if globally hidden, false if just has votes
        if (voteCount > 1) {
          existing.hiddenBy = `${voteCount} users`;
        } else if (voteCount === 1 && ghp.votes[0]) {
          // Try to get handle of single voter - for now just show "1 user"
          existing.hiddenBy = '1 user';
        }
      } else if (voteCount > 0 || isHidden) {
        // Add post with votes OR if globally hidden (includes admin overrides)
        const hiddenBy = voteCount > 1 ? `${voteCount} users` : 
                         voteCount === 1 ? '1 user' : 
                         isHidden ? 'Admin' : undefined;
        
        allStats.set(ghp.postUri, { 
          uri: ghp.postUri, 
          count: voteCount, 
          lastHidden: ghp.hiddenAt || new Date(), 
          isGlobal: isHidden, // True if globally hidden, false if just has votes
          hiddenBy
        });
      }
    });
    
    // Convert to array and fetch previews
    const statsArray = Array.from(allStats.values()).sort((a, b) => b.count - a.count);
    
    // Try to get post previews from cached data or fetch from ATProto
    hiddenPostsStats = await Promise.all(statsArray.map(async stat => {
      // Filter out any null entries and find the matching cache entry
      const validCacheEntries = me.current?.profile?.hiddenFeedPostsCache?.filter(cached => cached !== null && cached !== undefined) || [];
      const postData = validCacheEntries.find(cached => cached.uri === stat.uri);
      
      if (postData) {
        return {
          ...stat,
          preview: postData.text || getPostPreview(stat.uri),
          author: postData.author
        };
      } else {
        // Try to fetch post data from ATProto
        try {
          if (user.agent) {
            const postResponse = await user.agent.com.atproto.repo.getRecord({
              repo: stat.uri.split('/')[2], // Extract DID from URI
              collection: 'app.bsky.feed.post',
              rkey: stat.uri.split('/').pop() // Extract record key
            });
            
            const record = postResponse.data.value as any;
            return {
              ...stat,
              preview: record.text?.slice(0, 100) || getPostPreview(stat.uri),
              author: extractAuthorFromUri(stat.uri)
            };
          }
        } catch (error) {
          console.log('Could not fetch post data:', error);
        }
        
        // Fallback to basic preview
        return {
          ...stat,
          preview: getPostPreview(stat.uri),
          author: extractAuthorFromUri(stat.uri)
        };
      }
    }));
    
    console.log('✅ DEBUG: Final hiddenPostsStats', {
      length: hiddenPostsStats.length,
      stats: hiddenPostsStats.map(s => ({ uri: s.uri, count: s.count, isGlobal: s.isGlobal, preview: s.preview.slice(0, 30) }))
    });
  });

  let space = $derived(new CoState(Space, page.params.space))

  let channel = $derived(new CoState(Channel, page.params.channel))

  let thread = $derived(new CoState(Thread, page.params.thread))

  // Populate form fields when dialog opens
  $effect(() => {
    if (showSettingsDialog && channel.current) {
      channelNameInput = channel.current.name || "";
      selectedFeeds = channel.current.atprotoFeedsConfig?.feeds || [];
      customFeedInput = ""; // Clear the input field when dialog opens
    }
  });

  function saveSettings(e: Event) {
    e.preventDefault();
    if (!channel.current) return;
    
    console.log("Saving channel settings:", {
      channelType: channel.current.channelType,
      selectedFeeds,
      currentConfig: channel.current.atprotoFeedsConfig
    });
    
    channel.current.name = channelNameInput;
    
    // Update feeds if this is a feeds channel
    if (channel.current.channelType === "feeds") {
      if (!channel.current.atprotoFeedsConfig) {
        channel.current.atprotoFeedsConfig = {
          feeds: selectedFeeds,
          threadsOnly: false
        };
      } else {
        channel.current.atprotoFeedsConfig.feeds = selectedFeeds;
      }
      
      console.log("After save - atprotoFeedsConfig:", channel.current.atprotoFeedsConfig);
    }
    
    showSettingsDialog = false;
    toast.success("Channel settings saved");
  }

  function toggleFeed(feedUri: string) {
    if (selectedFeeds.includes(feedUri)) {
      selectedFeeds = selectedFeeds.filter(uri => uri !== feedUri);
    } else {
      selectedFeeds = [...selectedFeeds, feedUri];
    }
  }

  function addCustomFeed() {
    selectedFeeds = addFeedToList(
      customFeedInput,
      selectedFeeds,
      (uri) => {
        toast.success(`Added feed: ${uri}`);
        customFeedInput = ""; // Clear the input on success
      },
      (error) => {
        alert(error);
      }
    );
  }

  function removeFeed(feedUri: string) {
    selectedFeeds = selectedFeeds.filter(uri => uri !== feedUri);
  }

  function unhidePost(postUri: string) {
    console.log('🔄 DEBUG: unhidePost called', {
      postUri,
      userId: me.current?.id,
      hasProfile: !!me.current?.profile,
      hasHiddenFeedPosts: !!me.current?.profile?.hiddenFeedPosts,
      hiddenCount: me.current?.profile?.hiddenFeedPosts?.length || 0
    });
    
    if (!me.current?.profile?.hiddenFeedPosts || !me.current?.id) {
      console.log('❌ DEBUG: Early return - missing data');
      return;
    }
    
    // Remove from personal hidden list
    const hiddenPosts = me.current.profile.hiddenFeedPosts;
    const newList = [];
    for (let i = 0; i < hiddenPosts.length; i++) {
      if (hiddenPosts[i] !== postUri) {
        newList.push(hiddenPosts[i]);
      }
    }
    hiddenPosts.splice(0, hiddenPosts.length, ...newList);
    
    // Also remove from cached data
    if (me.current.profile.hiddenFeedPostsCache) {
      const index = me.current.profile.hiddenFeedPostsCache.findIndex(cached => cached.uri === postUri);
      if (index !== -1) {
        me.current.profile.hiddenFeedPostsCache.splice(index, 1);
      }
    }
    
    // Remove vote from global hidden posts if user voted
    if (channel.current?.globalHiddenPosts) {
      const globalPost = channel.current.globalHiddenPosts.find(ghp => ghp.postUri === postUri);
      if (globalPost) {
        const voteIndex = globalPost.votes.findIndex(vote => vote && vote.userId === me.current!.id);
        if (voteIndex !== -1) {
          globalPost.votes.splice(voteIndex, 1);
          
          // Check if should no longer be globally hidden
          const threshold = globalPost.threshold;
          if (globalPost.votes.length < threshold && globalPost.isHidden) {
            globalPost.isHidden = false;
            globalPost.hiddenAt = undefined;
            console.log(`Post no longer globally hidden (${globalPost.votes.length} < ${threshold})`);
          }
        }
      }
    }
    
    toast.success("Post unhidden");
  }

  function extractAuthorFromUri(uri: string): string {
    // Extract author DID from AT Proto URI: at://did:plc:xyz/app.bsky.feed.post/postid
    try {
      const match = uri.match(/^at:\/\/([^\/]+)/);
      if (match) {
        const did = match[1];
        // Convert DID to a more readable format
        if (did.startsWith('did:plc:')) {
          return `@${did.replace('did:plc:', '').slice(0, 12)}...`;
        }
        return `@${did.slice(0, 20)}...`;
      }
    } catch (e) {
      // Ignore parsing errors
    }
    return 'Unknown author';
  }

  function getPostPreview(uri: string): string {
    // Extract post ID from URI for display
    const parts = uri.split('/');
    const postId = parts[parts.length - 1];
    return `Post ${postId.slice(-8)}`;
  }
</script>

<menu class="relative flex items-center gap-3 px-2 w-fit justify-end">
  <Popover.Root bind:open={threading.active}>
    <Popover.Trigger>
      <Icon icon="tabler:needle-thread" class="text-2xl" />
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content
        side="left"
        sideOffset={16}
        interactOutsideBehavior="ignore"
        class="my-4 bg-base-300 rounded py-4 px-5 max-w-[300px] w-full"
      >
        <div class="flex flex-col gap-4">
          <div class="flex justify-between items-center">
            <h2 class="text-xl font-bold">Create Thread</h2>
            <Popover.Close>
              <Icon icon="lucide:x" class="text-2xl" />
            </Popover.Close>
          </div>
          <p class="text-sm text-base-content">
            Threads are a way to organize messages in a channel. Select as many
            messages as you want and join them into a new thread.
          </p>
          <form onsubmit={createThread} class="flex flex-col gap-4">
            <input
              type="text"
              bind:value={threadTitleInput}
              class="dz-input"
              placeholder="Thread Title"
              required
            />
            <button type="submit" class="dz-btn dz-btn-primary">
              Create Thread
            </button>
          </form>
        </div>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>

  <Button.Root
    title="Copy invite link"
    onclick={() => {
      navigator.clipboard.writeText(`${page.url.href}`);
      toast.success("Invite link copied to clipboard");
    }}
  >
    <Icon icon="icon-park-outline:people-plus" class="text-2xl" />
  </Button.Root>

  {#if isSpaceAdmin(space.current)}
    <Dialog
      title={thread.current
        ? "Thread Settings"
        : "Channel Settings"}
      bind:isDialogOpen={showSettingsDialog}
    >
      {#snippet dialogTrigger()}
        <Button.Root
          title={thread.current
          ? "Thread Settings"
          : "Channel Settings"}
          class="m-auto flex"
        >
          <Icon icon="lucide:settings" class="text-2xl" />
        </Button.Root>
      {/snippet}

      <div class="max-h-[80vh] overflow-y-auto">
        <form class="flex flex-col gap-4 w-full" onsubmit={saveSettings}>
        <label class="dz-input w-full">
          <span class="dz-label">Name</span>
          <input
            bind:value={channelNameInput}
            placeholder="name"
            type="text"
            required
          />
        </label>
        {#if space.current && channel.current}
          <select bind:value={channelCategoryInput} class="select">
            <option value={undefined}>None</option>
            <!-- {#await Space.sidebarItems(globalState.space) then sidebarItems}
              {@const categories = sidebarItems
                .map((x) => x.tryCast(Category))
                .filter((x) => !!x)}

              {#each categories as category}
                <option value={category.id}>{category.name}</option>
              {/each}
            {/await} -->
          </select>
        {/if}
        
        {#if channel.current?.channelType === "feeds"}
          <div class="space-y-3 border-t pt-4">
            <h3 class="text-sm font-semibold">Feed Configuration</h3>
            
            <!-- Available feeds -->
            <div class="space-y-2">
              {#each Object.entries(ATPROTO_FEED_CONFIG) as [uri, config]}
                <label class="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedFeeds.includes(uri)}
                    onchange={() => toggleFeed(uri)}
                    class="checkbox checkbox-sm"
                  />
                  <div class="flex-1 min-w-0">
                    <div class="text-sm font-medium">{config.name}</div>
                    <div class="text-xs text-base-content/60 truncate">{config.url}</div>
                  </div>
                </label>
              {/each}
            </div>
            
            <!-- Custom feeds that aren't in the default list -->
            {#each selectedFeeds.filter(uri => !ATPROTO_FEEDS.includes(uri)) as customUri}
              <div class="flex items-center gap-2">
                <input type="checkbox" checked disabled class="checkbox checkbox-sm" />
                <span class="text-sm flex-1 truncate">{customUri}</span>
                <Button.Root
                  type="button"
                  onclick={() => removeFeed(customUri)}
                  class="dz-btn dz-btn-ghost dz-btn-sm text-error hover:bg-error/10"
                >
                  <Icon icon="tabler:x" class="size-3" />
                </Button.Root>
              </div>
            {/each}
            
            <!-- Add custom feed from URL or URI -->
            <div class="space-y-2">
              <h4 class="text-sm font-medium">Add Custom Feed</h4>
              <div class="flex gap-2">
                <input
                  type="text"
                  bind:value={customFeedInput}
                  placeholder="https://bsky.app/profile/did:plc:example/feed/feedname or at://..."
                  class="dz-input flex-1 text-xs"
                />
                <Button.Root
                  type="button"
                  onclick={addCustomFeed}
                  disabled={!customFeedInput}
                  class="dz-btn dz-btn-secondary dz-btn-sm"
                >
                  Add
                </Button.Root>
              </div>
              <p class="text-xs text-base-content/60">
                Accepts both Bluesky URLs and AT:// URIs
              </p>
            </div>
            
            <div class="text-xs text-base-content/60">
              Selected {selectedFeeds.length} feed{selectedFeeds.length !== 1 ? 's' : ''}
            </div>
          </div>

          <!-- Global Voting System -->
          {#if !channel.current?.globalHiddenPosts}
            <div class="space-y-3 border-t pt-4">
              <h3 class="text-sm font-semibold flex items-center gap-2">
                <Icon icon="mdi:vote" class="size-4" />
                Global Voting System
              </h3>
              <p class="text-xs text-base-content/60">
                Enable community voting to hide irrelevant posts when multiple users vote.
              </p>
              <button
                type="button"
                onclick={() => {
                  if (channel.current) {
                    channel.current.globalHiddenPosts = co.list(GlobalHiddenPost).create([], publicGroup("writer"));
                    channel.current.hideThreshold = 3;
                    toast.success("Global voting system enabled");
                  }
                }}
                class="dz-btn dz-btn-primary dz-btn-sm"
              >
                Enable Global Voting
              </button>
            </div>
          {/if}

          <!-- Hidden Posts Section -->
          <div class="space-y-3 border-t pt-4">
            <h3 class="text-sm font-semibold flex items-center gap-2">
              <Icon icon="mdi:eye-off" class="size-4" />
              Hidden Posts
            </h3>
            
            {#if hiddenPostsStats.length === 0}
              <p class="text-sm text-base-content/60">No posts hidden yet</p>
            {:else}
              <div class="space-y-2 max-h-48 overflow-y-auto">
                {#each hiddenPostsStats as stat}
                  <div class="flex items-center justify-between gap-2 p-2 bg-base-100 rounded">
                    <div class="flex-1 min-w-0">
                      <div class="text-sm text-base-content/80 truncate">
                        {stat.preview}
                      </div>
                      <div class="text-xs text-base-content/60">
                        <div class="flex items-center gap-2 mb-1">
                          <span>{stat.author}</span>
                          {#if stat.isGlobal}
                            <span class="dz-badge dz-badge-error dz-badge-xs">GLOBAL</span>
                            <span class="dz-badge dz-badge-neutral dz-badge-xs">{stat.count} votes</span>
                          {:else if stat.count > 1}
                            <span class="dz-badge dz-badge-warning dz-badge-xs">VOTING</span>
                            <span class="dz-badge dz-badge-neutral dz-badge-xs">{stat.count}/{channel.current?.hideThreshold || 3} votes</span>
                          {:else}
                            <span class="dz-badge dz-badge-neutral dz-badge-xs">Personal</span>
                          {/if}
                        </div>
                        {#if stat.hiddenBy}
                          <div class="text-xs text-base-content/50">
                            Hidden by: {stat.hiddenBy}
                          </div>
                        {/if}
                      </div>
                    </div>
                    
                    <!-- Only show unhide button for admin's personal hides OR globally hidden posts -->
                    {#if stat.isGlobal || (me.current?.profile?.hiddenFeedPosts?.includes(stat.uri))}
                      <Button.Root
                        type="button"
                        onclick={() => unhidePost(stat.uri)}
                        class="dz-btn dz-btn-ghost dz-btn-xs text-primary hover:bg-primary/10"
                      >
                        <Icon icon="mdi:eye" class="size-3" />
                        Unhide
                      </Button.Root>
                    {:else}
                      <span class="text-xs text-base-content/40">User hidden</span>
                    {/if}
                  </div>
                {/each}
              </div>
              
              <div class="text-xs text-base-content/60">
                {hiddenPostsStats.length} hidden post{hiddenPostsStats.length !== 1 ? 's' : ''} • 
                {hiddenPostsStats.filter(s => s.isGlobal).length} globally hidden
              </div>
            {/if}
          </div>
        {/if}
          <Button.Root class="dz-btn dz-btn-primary">Save Settings</Button.Root>
        </form>
      </div>

      <form
        onsubmit={(e) => {
          e.preventDefault();
          if (!channel.current) return;
          channel.current.softDeleted = true;
          // globalState.channel.commit();
          showSettingsDialog = false;
          navigate({ space: page.params.space! });
        }}
        class="flex flex-col gap-3 mt-3"
      >
        <h2 class="text-xl font-bold">Danger Zone</h2>
        <p>
          Deleting a {channel.current ? "channel" : "thread"} doesn't delete
          the data permanently, it just hides the thread from the UI.
        </p>
        <Button.Root class="dz-btn dz-btn-error"
          >Delete {channel.current ? "Channel" : "Thread"}</Button.Root
        >
      </form>
    </Dialog>
  {/if}
</menu>
<script lang="ts">
  import { co } from "jazz-tools";
  import { Message, Space } from "@roomy-chat/sdk";
  import Icon from "@iconify/svelte";

  let {
    space,
  }: {
    space: co.loaded<typeof Space> | null | undefined;
  } = $props();

  interface DiscoveredLink {
    url: string;
    title?: string;
    domain: string;
    messageId: string;
    channelId: string;
    channelName: string;
    authorId: string;
    timestamp: Date;
    messageText: string;
  }

  let discoveredLinks = $state<DiscoveredLink[]>([]);
  let loading = $state(true);

  // Extract URLs from text using regex
  function extractUrls(text: string): string[] {
    const urlRegex = /(https?:\/\/[^\s<>"\[\]{}|\\^`]+)/gi;
    return text.match(urlRegex) || [];
  }

  // Get domain from URL
  function getDomain(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return "unknown";
    }
  }

  // Discover links from all channels in the space
  async function discoverLinks() {
    if (!space?.channels) {
      loading = false;
      return;
    }

    loading = true;
    const links: DiscoveredLink[] = [];

    try {
      console.log("Discovering links in space with", space.channels.length, "channels");
      // Iterate through all channels
      for (const channel of space.channels) {
        if (!channel || channel.softDeleted || channel.channelType !== "chat") continue;

        const channelName = channel.name || "Unnamed Channel";
        console.log("Checking channel:", channelName, "type:", channel.channelType);

        // Get messages from main thread
        if (channel.mainThread?.timeline?.perAccount) {
          const allMessages = Object.values(channel.mainThread.timeline.perAccount);
          console.log(`Channel ${channelName} has ${allMessages.length} account timelines`);
          
          for (const accountFeed of allMessages) {
            if (!accountFeed?.all) continue;
            const entries = Array.from(accountFeed.all);
            console.log(`Processing ${entries.length} messages from account timeline`);
            
            for (const entry of entries) {
              try {
                const messageId = entry.value;
                const message = await Message.load(messageId);
                if (!message?.content) continue;

                const urls = extractUrls(message.content);
                if (urls.length > 0) {
                  console.log(`Found ${urls.length} URLs in message:`, message.content);
                }
                
                for (const url of urls) {
                  links.push({
                    url,
                    domain: getDomain(url),
                    messageId: messageId,
                    channelId: channel.id,
                    channelName,
                    authorId: message._edits?.content?.by?.id || "unknown",
                    timestamp: message._edits?.content?.madeAt || new Date(),
                    messageText: message.content,
                  });
                }
              } catch (e) {
                console.warn("Failed to load message:", entry, e);
              }
            }
          }
        }

        // Get messages from sub-threads
        if (channel.subThreads) {
          for (const thread of channel.subThreads) {
            if (!thread?.timeline?.perAccount) continue;

            const allMessages = Object.values(thread.timeline.perAccount);
            
            for (const accountFeed of allMessages) {
              if (!accountFeed?.all) continue;
              const entries = Array.from(accountFeed.all);
              
              for (const entry of entries) {
                try {
                  const messageId = entry.value;
                  const message = await Message.load(messageId);
                  if (!message?.content) continue;

                  const urls = extractUrls(message.content);
                  
                  for (const url of urls) {
                    links.push({
                      url,
                      domain: getDomain(url),
                      messageId: messageId,
                      channelId: channel.id,
                      channelName: `${channelName} → ${thread.name}`,
                      authorId: message._edits?.content?.by?.id || "unknown",
                      timestamp: message._edits?.content?.madeAt || new Date(),
                      messageText: message.content,
                    });
                  }
                } catch (e) {
                  console.warn("Failed to load thread message:", entry, e);
                }
              }
            }
          }
        }
      }

      // Sort by timestamp (newest first) and remove duplicates
      const uniqueLinks = links
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
        .filter((link, index, array) => 
          array.findIndex(l => l.url === link.url) === index
        );

      console.log("Discovered", links.length, "total links before deduplication");
      discoveredLinks = uniqueLinks;
      console.log("Final discovered links:", uniqueLinks.length);
    } catch (error) {
      console.error("Failed to discover links:", error);
    } finally {
      loading = false;
    }
  }

  // Discover links when space changes
  $effect(() => {
    if (space) {
      discoverLinks();
    }
  });

  function getRelativeTime(date: Date): string {
    const now = new Date();
    const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

    if (diffInSeconds < 60) return `${diffInSeconds}s ago`;
    if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)}m ago`;
    if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)}h ago`;
    return `${Math.floor(diffInSeconds / 86400)}d ago`;
  }

  function stripHtml(html: string): string {
    // Create a temporary div element to parse HTML
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = html;
    return tempDiv.textContent || tempDiv.innerText || '';
  }

  function truncateText(text: string, maxLength: number = 100): string {
    const plainText = stripHtml(text);
    if (plainText.length <= maxLength) return plainText;
    return plainText.substring(0, maxLength) + "...";
  }
</script>

<div class="space-y-6">
  <div class="flex items-center justify-between">
    <h2 class="text-xl font-bold flex items-center gap-2">
      <Icon icon="basil:link-outline" class="text-secondary" />
      Discovered Links
    </h2>
    <button
      onclick={discoverLinks}
      class="dz-btn dz-btn-sm dz-btn-ghost"
      disabled={loading}
    >
      <Icon
        icon={loading ? "mdi:loading" : "mdi:refresh"}
        class={loading ? "animate-spin" : ""}
      />
      Refresh
    </button>
  </div>

  {#if loading}
    <div class="flex items-center justify-center py-8">
      <Icon icon="mdi:loading" class="animate-spin size-6 text-primary" />
      <span class="ml-2">Discovering links...</span>
    </div>
  {:else if discoveredLinks.length === 0}
    <div class="text-center py-8 text-base-content/60">
      <Icon icon="basil:link-off-outline" class="size-12 mx-auto mb-2" />
      <p>No links found in this space</p>
      <p class="text-sm mt-2">Links shared in channels will appear here</p>
    </div>
  {:else}
    <div class="space-y-4">
      {#each discoveredLinks as link (link.url + link.messageId)}
        <article
          class="dz-card bg-base-200 shadow-sm hover:shadow-md transition-all"
        >
          <div class="dz-card-body p-4">
            <div class="flex items-start gap-3">
              <div class="flex-shrink-0 mt-1">
                <Icon icon="basil:link-outline" class="size-5 text-secondary" />
              </div>
              
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 mb-2">
                  <a
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    class="text-primary hover:text-primary-focus font-medium truncate"
                  >
                    {link.url}
                  </a>
                  <span class="text-xs bg-base-300 px-2 py-1 rounded">
                    {link.domain}
                  </span>
                </div>
                
                <p class="text-sm text-base-content/80 mb-2">
                  {truncateText(link.messageText)}
                </p>
                
                <div class="flex items-center gap-4 text-xs text-base-content/60">
                  <span class="flex items-center gap-1">
                    <Icon icon="basil:comment-outline" class="size-3" />
                    {link.channelName}
                  </span>
                  <span class="flex items-center gap-1">
                    <Icon icon="basil:clock-outline" class="size-3" />
                    {getRelativeTime(link.timestamp)}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </article>
      {/each}
    </div>
  {/if}
</div>
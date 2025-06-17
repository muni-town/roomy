<script lang="ts">
  import { Avatar } from "bits-ui";
  import { AvatarBeam } from "svelte-boring-avatars";
  import { format, startOfWeek, endOfWeek, eachDayOfInterval, startOfYear, endOfYear, eachWeekOfInterval } from "date-fns";

  let {
    conversationPartner
  }: {
    conversationPartner: { displayName?: string; handle: string; did: string; avatar?: string } | null;
  } = $props();

  let heatmapData = $state<Record<string, number>>({});
  let isLoadingActivity = $state(false);

  // Load activity data when conversation partner changes
  $effect(async () => {
    if (conversationPartner?.did) {
      // Temporarily disabled due to globalState deprecation
      isLoadingActivity = false;
      return;
      
      isLoadingActivity = true;
      try {
        const activityResults = []; // await searchActivityByAuthor(conversationPartner.did);
        const newHeatmapData: Record<string, number> = {};
        
        // Process activity results into daily counts
        activityResults.forEach((result: any) => {
          if (result.timestamp) {
            const date = format(new Date(result.timestamp), "yyyy-MM-dd");
            newHeatmapData[date] = (newHeatmapData[date] || 0) + 1;
          }
        });
        
        heatmapData = newHeatmapData;
      } catch (error) {
        console.error("Failed to load activity data:", error);
      } finally {
        isLoadingActivity = false;
      }
    }
  });

  // Generate contribution graph data (last 12 weeks)
  let contributionGraphData = $derived.by(() => {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(endDate.getDate() - (12 * 7)); // 12 weeks back
    
    const weeks = eachWeekOfInterval(
      { start: startDate, end: endDate },
      { weekStartsOn: 0 } // Sunday start
    );
    
    const weekColumns = weeks.map(weekStart => {
      const weekEnd = endOfWeek(weekStart, { weekStartsOn: 0 });
      const daysInWeek = eachDayOfInterval({ start: weekStart, end: weekEnd });
      
      return daysInWeek.map(day => {
        if (day > endDate) return null; // Don't show future dates
        return day;
      });
    });

    return { weekColumns };
  });

  // Get color class based on activity count
  function getColorClass(count: number): string {
    if (count === 0) return "bg-base-200";
    if (count === 1) return "bg-primary/20";
    if (count <= 3) return "bg-primary/40";
    if (count <= 6) return "bg-primary/60";
    return "bg-primary";
  }

  // Calculate total messages
  let totalMessages = $derived(
    Object.values(heatmapData).reduce((a, b) => a + b, 0)
  );

  // Calculate active days
  let activeDays = $derived(
    Object.values(heatmapData).filter(count => count > 0).length
  );
</script>

{#if conversationPartner}
  <div class="flex-shrink-0 border-b border-base-300 p-4 bg-base-50">
    <div class="flex items-start gap-4">
      <!-- Avatar and basic info -->
      <div class="flex items-center gap-3 min-w-0 flex-1">
        <Avatar.Root class="w-12 h-12 flex-shrink-0">
          <Avatar.Image 
            src={conversationPartner.avatar} 
            alt={conversationPartner.displayName || conversationPartner.handle}
            class="rounded-full"
          />
          <Avatar.Fallback>
            <AvatarBeam 
              name={conversationPartner.did || conversationPartner.handle || 'unknown'} 
              size={48}
            />
          </Avatar.Fallback>
        </Avatar.Root>
        <div class="flex-1 min-w-0">
          <h3 class="font-semibold text-base-content text-lg">
            {conversationPartner.displayName || conversationPartner.handle || 'Unknown User'}
          </h3>
          {#if conversationPartner.displayName && conversationPartner.handle}
            <p class="text-sm text-base-content/60">@{conversationPartner.handle}</p>
          {/if}
          <!-- Quick stats -->
          <div class="flex gap-4 mt-1 text-xs text-base-content/60">
            <span>{totalMessages} messages</span>
            <span>{activeDays} active days</span>
          </div>
        </div>
      </div>

      <!-- Mini contribution graph -->
      <div class="flex-shrink-0">
        <div class="text-xs text-base-content/60 mb-2">Recent Activity</div>
        {#if isLoadingActivity}
          <div class="flex items-center justify-center h-16 w-32">
            <div class="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin"></div>
          </div>
        {:else}
          <div class="grid grid-flow-col auto-cols-[10px] gap-x-1">
            {#each contributionGraphData.weekColumns as weekColumn}
              <div class="grid grid-rows-7 gap-y-1">
                {#each weekColumn as day}
                  {#if day}
                    <div
                      class={`w-2 h-2 rounded-sm ${getColorClass(heatmapData[format(day, "yyyy-MM-dd")] || 0)}`}
                      title={`${format(day, "MMM d")}: ${heatmapData[format(day, "yyyy-MM-dd")] || 0} messages`}
                    ></div>
                  {:else}
                    <div class="w-2 h-2"></div>
                  {/if}
                {/each}
              </div>
            {/each}
          </div>
          
          <!-- Legend -->
          <div class="flex items-center justify-end gap-1 mt-2 text-xs text-base-content/60">
            <span>Less</span>
            <div class="flex gap-1">
              <div class="w-2 h-2 bg-base-200 rounded-sm"></div>
              <div class="w-2 h-2 bg-primary/20 rounded-sm"></div>
              <div class="w-2 h-2 bg-primary/40 rounded-sm"></div>
              <div class="w-2 h-2 bg-primary/60 rounded-sm"></div>
              <div class="w-2 h-2 bg-primary rounded-sm"></div>
            </div>
            <span>More</span>
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}
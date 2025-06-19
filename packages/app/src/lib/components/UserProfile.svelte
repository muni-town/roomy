<script lang="ts">
  import {
    format,
    subDays,
    eachDayOfInterval,
    startOfWeek,
    endOfWeek,
    addDays,
    subMonths,
  } from "date-fns";
  import { Message, Space, Channel, RoomyAccount } from "$lib/jazz/schema";
  import { Avatar } from "bits-ui";
  import { AvatarBeam } from "svelte-boring-avatars";
  import { activityIndex } from "$lib/services/activityIndex";
  import { AccountCoState } from "jazz-svelte";
  import { co } from "jazz-tools";

  // Props
  let {
    profile,
  }: {
    profile: {
      id?: string;
      did?: string;
      handle?: string;
      displayName?: string;
      avatar?: string;
      banner?: string;
      description?: string;
      accountId?: string;
    };
  } = $props();


  // Space and Heatmap data state
  let spacesList = $state<{ id: string; name: string; messageCount: number }[]>(
    [],
  );
  let selectedSpaceId = $state("all"); // 'all' or a specific space ID
  let heatmapData = $state<Record<string, Record<string, number>>>({ all: {} }); // Data per spaceId and for 'all'
  let isLoading = $state(true);

  // Get current user to access their joined spaces
  const me = new AccountCoState(RoomyAccount, {
    resolve: {
      profile: {
        joinedSpaces: {
          $each: {
            channels: {
              $each: {
                mainThread: {
                  timeline: {
                    perAccount: {
                      $each: {
                        all: {
                          $each: {
                            madeAt: true,
                            content: true,
                          },
                        },
                      },
                    },
                  },
                },
              },
              $onError: null,
            },
          },
          $onError: null,
        },
      },
    },
  });

  // Generate chronological list of the current calendar year for data fetching and grid calculation
  const today = new Date();
  const calendarYearStartDate = new Date(today.getFullYear(), 0, 1); // January 1st of current year
  const calendarYearEndDate = new Date(today.getFullYear(), 11, 31); // December 31st of current year

  // Activity data should span from the start of the year up to today (not the full calendar year)
  const activityStartDate = calendarYearStartDate;
  const activityEndDate = today;

  const allDaysChronological = eachDayOfInterval({
    start: activityStartDate,
    end: calendarYearEndDate, // Use calendar year end date
  });

  let currentHeatmapData = $derived.by(() => {
    const dataForSelected = heatmapData[selectedSpaceId];
    if (dataForSelected) {
      return dataForSelected;
    }
    return {};
  });

  let contributionGraphData = $derived.by(() => {
    // Start from the first Sunday of the year or before
    const yearStart = new Date(today.getFullYear(), 0, 1);
    const firstSundayOffset = yearStart.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
    const gridStartDate = subDays(yearStart, firstSundayOffset);

    // End on the last Saturday of the year or after
    const yearEnd = new Date(today.getFullYear(), 11, 31);
    const lastSaturdayOffset = 6 - yearEnd.getDay(); // Days to add to reach Saturday
    const gridEndDate = addDays(yearEnd, lastSaturdayOffset);

    const allWeeks = [];
    let currentWeekStart = gridStartDate;

    while (currentWeekStart <= gridEndDate) {
      const weekEnd = endOfWeek(currentWeekStart, { weekStartsOn: 0 });
      const daysInWeek = eachDayOfInterval({
        start: currentWeekStart,
        end: weekEnd,
      });
      allWeeks.push(daysInWeek);
      currentWeekStart = addDays(weekEnd, 1);
    }

    // Generate month headers - only for months in the current year
    const monthHeaders = [];
    let currentMonth = -1;
    let columnIndex = 0;

    for (const week of allWeeks) {
      const firstDayOfWeek = week[0];
      const monthOfFirstDay = firstDayOfWeek.getMonth();
      const yearOfFirstDay = firstDayOfWeek.getFullYear();

      // Only create headers for current year months
      if (yearOfFirstDay === today.getFullYear() && monthOfFirstDay !== currentMonth) {
        if (currentMonth !== -1) {
          // Close the previous month header
          const lastHeader = monthHeaders[monthHeaders.length - 1];
          if (lastHeader) {
            lastHeader.columnSpan = columnIndex - lastHeader.startColumn;
          }
        }

        // Start a new month header
        monthHeaders.push({
          name: format(firstDayOfWeek, "MMM"),
          startColumn: columnIndex,
          columnSpan: 1, // Will be updated when the month ends
        });
        currentMonth = monthOfFirstDay;
      }

      columnIndex++;
    }

    // Close the last month header
    if (monthHeaders.length > 0) {
      const lastHeader = monthHeaders[monthHeaders.length - 1];
      if (lastHeader) {
        lastHeader.columnSpan = columnIndex - lastHeader.startColumn;
      }
    }

    return {
      weekColumns: allWeeks,
      monthHeaders,
    };
  });

  // Load activity data when profile or selected space changes
  $effect(() => {
    if (
      (profile?.accountId || profile?.did || profile?.id) &&
      me.current?.profile?.joinedSpaces
    ) {
      loadActivityData();
    }
  });

  // Function to process message data into heatmap format using the new activity index service
  async function loadActivityData() {
    if (!me.current?.profile?.joinedSpaces) {
      console.warn("No joined spaces available");
      isLoading = false;
      return;
    }

    isLoading = true;
    const newHeatmapData: Record<string, Record<string, number>> = { all: {} };

    // Initialize heatmap data for all days in the chronological list
    allDaysChronological.forEach(
      (day) => (newHeatmapData["all"][format(day, "yyyy-MM-dd")] = 0),
    );

    let newSpacesList: { id: string; name: string; messageCount: number }[] =
      [];

    try {
      // Get the user's ID - prefer id, then accountId, fallback to did
      const userId = profile.id || profile.accountId || profile.did;
      const isOwnProfile = userId === me.current?.id;
      if (!userId) {
        console.warn("No user ID available for activity data");
        isLoading = false;
        return;
      }

      // Determine which spaces to check for activity
      let spacesToCheck: co.loaded<typeof Space>[];
      
      if (isOwnProfile) {
        // Viewing our own profile - use our joined spaces
        spacesToCheck = me.current.profile.joinedSpaces.filter(
          (space) => space != null,
        ) as co.loaded<typeof Space>[];
      } else {
        // Viewing someone else's profile - we can only see activity in spaces we both have access to
        spacesToCheck = me.current.profile.joinedSpaces.filter(
          (space) => space != null,
        ) as co.loaded<typeof Space>[];
      }

      if (spacesToCheck.length === 0) {
        console.warn("No valid spaces found for activity analysis");
        isLoading = false;
        return;
      }

      // Use the activity index service to get user activity
      const userActivity = await activityIndex.getUserActivity(
        userId,
        spacesToCheck,
      );

      // Set the "all" data
      newHeatmapData["all"] = userActivity.activityByDate;

      // Set individual space data and build spaces list
      for (const [spaceId, spaceInfo] of Object.entries(
        userActivity.activityBySpace,
      )) {
        // Get space-specific activity data
        const space = spacesToCheck.find((s) => s.id === spaceId);
        if (space) {
          const spaceActivity = await activityIndex.getSpaceActivity(
            userId,
            space,
          );
          newHeatmapData[spaceId] = spaceActivity;

          newSpacesList.push({
            id: spaceId,
            name: spaceInfo.name,
            messageCount: spaceInfo.count,
          });
        }
      }

      // Sort by message count (descending)
      newSpacesList.sort((a, b) => b.messageCount - a.messageCount);

      // Add some test data to verify heatmap works
      // const testDates = [
      //   format(new Date(), "yyyy-MM-dd"),
      //   format(subDays(new Date(), 1), "yyyy-MM-dd"),
      //   format(subDays(new Date(), 2), "yyyy-MM-dd"),
      //   format(subDays(new Date(), 7), "yyyy-MM-dd"),
      // ];
      // testDates.forEach((date, index) => {
      //   newHeatmapData["all"][date] = index + 1;
      // });

      heatmapData = newHeatmapData;
      spacesList = newSpacesList;
    } catch (error) {
      console.error("Error loading activity data:", error);
    } finally {
      isLoading = false;
    }
  }

  // Function to determine color class based on message count
  function getColorClass(count: number): string {
    if (count === 0) return "bg-base-200";
    if (count === 1) return "bg-accent-200";
    if (count <= 3) return "bg-accent-400";
    if (count <= 6) return "bg-accent-600";
    return "bg-accent-800";
  }

  // Function to convert URLs in text to clickable links
  function linkifyText(text: string): string {
    const urlRegex = /(https?:\/\/[^\s<>"]+)/gi;
    return text
      .replaceAll("\n", "<br/>")
      .replace(urlRegex, '<a href="$1" target="_blank" rel="noopener noreferrer" class="text-primary hover:text-primary-focus underline hover:no-underline transition-colors font-medium">$1</a>');
  }
</script>

<div
  class="mx-auto w-full max-w-full sm:max-w-4xl sm:py-6"
>
  <!-- Header -->
  <div class="flex justify-between items-center mb-4 px-4 sm:px-6 lg:px-8">
    <h2 class="text-xl font-bold">User Profile</h2>
  </div>

  <div>
    {#if profile?.banner}
      <img
        class="aspect-[3/1] w-full border-b border-base-300 object-cover sm:rounded-xl sm:border"
        src={profile.banner}
        alt=""
      />
    {:else}
      <div class="aspect-[8/1] w-full"></div>
    {/if}
  </div>
  <div
    class={[
      profile?.banner ? "-mt-11" : "-mt-8",
      "flex max-w-full items-end space-x-5 px-4 sm:-mt-16 sm:px-6 lg:px-8",
    ]}
  >
    <Avatar.Root class="size-24 sm:size-32">
      <Avatar.Image src={profile?.avatar} class="rounded-full" />
      <Avatar.Fallback>
        <AvatarBeam
          name={profile?.did || profile?.handle || "unknown"}
        />
      </Avatar.Fallback>
    </Avatar.Root>
    <div
      class="flex min-w-0 flex-1 flex-row sm:flex-row sm:items-center sm:justify-end sm:space-x-6 sm:pb-1"
    >
      <div
        class={[
          profile?.banner
            ? "mt-4 sm:mt-0"
            : "-mt-[4.5rem] sm:-mt-[6.5rem]",
          "flex min-w-0 max-w-full flex-1 flex-col items-baseline",
        ]}
      >
        <h1 class="max-w-full truncate text-lg font-bold text-primary sm:text-xl">
          {profile?.displayName || profile?.handle}
        </h1>
        {#if profile?.handle}
          <a 
            href="https://bsky.app/profile/{profile.handle}" 
            target="_blank" 
            rel="noopener noreferrer"
            class="text-sm text-primary hover:text-primary-focus transition-colors underline hover:no-underline"
          >
            @{profile.handle}
          </a>
        {/if}
      </div>
    </div>
  </div>


  {#if profile?.description}
    <div class="px-4 sm:px-6 lg:px-8 py-4 text-xs sm:text-sm text-base-900">
      {@html linkifyText(profile.description)}
    </div>
  {/if}

    <!-- Content Area -->
    <div class="px-4 sm:px-6 lg:px-8 py-4">
      <div class="w-full">
        {#if isLoading}
          <div class="flex items-center justify-center py-8">
            <span class="loading loading-spinner loading-lg text-primary"
            ></span>
            <span class="ml-2">Loading activity data...</span>
          </div>
        {:else}
          <!-- Space Selector -->
          <div class="mb-4">
            <label for="space-select" class="block text-sm font-medium mb-2">
              Select Space:
            </label>
            <select
              id="space-select"
              class="select select-bordered w-full"
              bind:value={selectedSpaceId}
            >
              <option value="all">
                All Spaces ({Object.values(heatmapData.all || {}).reduce(
                  (a, b) => a + b,
                  0,
                )})
              </option>
              {#each spacesList as space}
                <option value={space.id}>
                  {space.name} ({space.messageCount})
                </option>
              {/each}
            </select>
          </div>

          <!-- Heatmap -->
          <div class="mb-6">
            <h3 class="text-lg font-semibold mb-2">Message Activity</h3>

            <div class="overflow-x-auto">
              <div class="flex gap-x-1 tabular-nums min-w-max">
                <!-- Day of Week Labels (Mon, Wed, Fri) -->
                <div
                  class="grid grid-rows-8 gap-y-1 w-6 mr-1 flex-shrink-0 text-xs text-base-content/60"
                >
                  <!-- Month header spacer -->
                  <div class="h-4"></div>
                  <div class="h-2.5"></div>
                  <!-- Spacer for Sun -->
                  <div class="h-2.5 flex items-center text-xs">M</div>
                  <div class="h-2.5"></div>
                  <!-- Spacer for Tue -->
                  <div class="h-2.5 flex items-center text-xs">W</div>
                  <div class="h-2.5"></div>
                  <!-- Spacer for Thu -->
                  <div class="h-2.5 flex items-center text-xs">F</div>
                  <div class="h-2.5"></div>
                  <!-- Spacer for Sat -->
                </div>

                <!-- Activity Grid with Month Headers -->
                <div
                  class="grid grid-flow-col auto-cols-[10px] gap-x-1"
                >
                  {#each contributionGraphData.weekColumns as weekColumn, weekIndex}
                    <div class="grid grid-rows-8 gap-y-1">
                      <!-- Month Header Row -->
                      <div class="h-4 text-xs text-base-content/60 flex items-end">
                        {#if weekIndex === 0 || (weekColumn[0] && contributionGraphData.monthHeaders.find(h => h.startColumn === weekIndex))}
                          <span class="text-xs">
                            {contributionGraphData.monthHeaders.find(h => h.startColumn === weekIndex)?.name || ''}
                          </span>
                        {/if}
                      </div>
                      
                      <!-- Activity Days -->
                      {#each weekColumn as day}
                        {#if day}
                          <div class="relative group">
                            <div
                              class={`w-2.5 h-2.5 rounded-sm ${getColorClass(currentHeatmapData[format(day, "yyyy-MM-dd")] || 0)}`}
                              title={`${format(day, "MMM d, yyyy")}: ${currentHeatmapData[format(day, "yyyy-MM-dd")] || 0} messages`}
                            >
                            </div>
                          </div>
                        {:else}
                          <div
                            class="w-2.5 h-2.5 rounded-sm bg-base-200/30"
                          ></div>
                        {/if}
                      {/each}
                    </div>
                  {/each}
                </div>
              </div>
            </div>

            <div
              class="flex justify-between items-center mt-2 text-xs text-base-content/60"
            >
              <div class="text-xs">
                {Object.values(currentHeatmapData).filter(count => count > 0).length} contributions in the last year
              </div>
              <div class="flex items-center gap-2">
                <span>Less</span>
                <div class="flex gap-1">
                  <div class="w-2.5 h-2.5 rounded-sm bg-base-200"></div>
                  <div class="w-2.5 h-2.5 rounded-sm bg-accent-200"></div>
                  <div class="w-2.5 h-2.5 rounded-sm bg-accent-400"></div>
                  <div class="w-2.5 h-2.5 rounded-sm bg-accent-600"></div>
                  <div class="w-2.5 h-2.5 rounded-sm bg-accent-800"></div>
                </div>
                <span>More</span>
              </div>
            </div>
          </div>

          <!-- Stats -->
          <div class="grid grid-cols-2 gap-4 mb-6">
            <div class="bg-base-200 p-4 rounded-lg">
              <p class="text-sm text-base-content/60">Messages Sent</p>
              <p class="text-2xl font-bold">
                {Object.values(currentHeatmapData)
                  .reduce((a, b) => a + b, 0)
                  .toLocaleString()}
              </p>
            </div>
            <div class="bg-base-200 p-4 rounded-lg">
              <p class="text-sm text-base-content/60">Active Days</p>
              <p class="text-2xl font-bold">
                {Object.values(currentHeatmapData).filter((count) => count > 0)
                  .length}
              </p>
            </div>
          </div>
        {/if}
      </div>
    </div>
</div>

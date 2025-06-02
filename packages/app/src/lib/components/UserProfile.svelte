<script lang="ts">
  import { onMount } from "svelte";
  import { globalState, searchActivityByAuthor } from "$lib/global.svelte";
  import { format, subDays, eachDayOfInterval, startOfWeek, endOfWeek, addDays, subMonths } from "date-fns";
  import Icon from "@iconify/svelte";
  import { Message, Space, Channel } from "@roomy-chat/sdk"; // Assuming Space and Channel are correct types

  // Props
  let {
    show = false,
    onClose = () => {},
    profileData = { did: "", handle: "", displayName: "", avatar: "" },
  } = $props();

  // Space and Heatmap data state
  let spacesList = $state<{ id: string; name: string; messageCount: number }[]>([]);

  let selectedSpaceId = $state("all"); // 'all' or a specific space ID
  let heatmapData = $state<Record<string, Record<string, number>>>({ all: {} }); // Data per spaceId and for 'all'

  let isLoading = $state(true);

  // Generate chronological list of the current calendar year for data fetching and grid calculation
  const today = new Date();
  const currentYear = today.getFullYear();
  const activityStartDate = new Date(currentYear, 0, 1); // January 1st of current year
  const calendarYearEndDate = new Date(currentYear, 11, 31); // December 31st of current year

  const allDaysChronological = eachDayOfInterval({
    start: activityStartDate,
    end: calendarYearEndDate, // Use calendar year end date
  });

  let currentHeatmapData = $derived.by(() => {
    const dataForSelected = heatmapData[selectedSpaceId];
    if (dataForSelected) {
      return dataForSelected;
    }
    return  {};
  });

  let contributionGraphData = $derived.by(() => {
    if (allDaysChronological.length === 0) {
      return { weekColumns: [], monthHeaders: [] };
    }

    const weekColumns: Array<Array<Date | null>> = [];
    const dayMap = new Map(
      allDaysChronological.map((d) => [format(d, "yyyy-MM-dd"), d]),
    );

    const firstDataDate = allDaysChronological[0];
    const lastDataDate = allDaysChronological[allDaysChronological.length - 1];

    let currentDayIter = startOfWeek(firstDataDate, { weekStartsOn: 0 }); // Start from Sunday of the week of the first data point
    const gridEndDate = endOfWeek(lastDataDate, { weekStartsOn: 0 }); // End on Saturday of the week of the last data point

    let currentWeek: Array<Date | null> = [];
    while (currentDayIter <= gridEndDate) {
      const dayStr = format(currentDayIter, "yyyy-MM-dd");
      if (dayMap.has(dayStr)) {
        currentWeek.push(new Date(dayMap.get(dayStr)!));
      } else {
        currentWeek.push(null); // Placeholder for days outside the 90-day range or for padding
      }

      if (currentDayIter.getDay() === 6) { // Saturday, end of a week column
        weekColumns.push(currentWeek);
        currentWeek = [];
      }
      currentDayIter = addDays(currentDayIter, 1);
    }
    if (currentWeek.length > 0) { // Should not happen if gridEndDate is Saturday
        while(currentWeek.length < 7) currentWeek.push(null);
        weekColumns.push(currentWeek);
    }

    const monthHeadersRaw: Array<{ name: string; startColumnIndex: number; year: number }> = [];
    const processedMonthYearKeys = new Set<string>(); // To store 'YYYY-MMM'

    if (weekColumns.length > 0) {
      weekColumns.forEach((weekCol, colIndex) => {
        let firstActualDayInColumn: Date | null = null;
        for (const day of weekCol) {
          if (day && day >= firstDataDate && day <= lastDataDate) {
            firstActualDayInColumn = day;
            break;
          }
        }

        if (firstActualDayInColumn) {
          const monthName = format(firstActualDayInColumn, "MMM");
          const year = firstActualDayInColumn.getFullYear();
          const monthYearKey = `${year}-${monthName}`;

          if (!processedMonthYearKeys.has(monthYearKey)) {
            monthHeadersRaw.push({ name: monthName, startColumnIndex: colIndex, year: year });
            processedMonthYearKeys.add(monthYearKey);
          }
        }
      });
    }

    const finalMonthHeaders = monthHeadersRaw.map((header, idx) => {
      const nextHeaderStartIndex = (idx + 1 < monthHeadersRaw.length) ? monthHeadersRaw[idx + 1].startColumnIndex : weekColumns.length;
      return {
        name: header.name,
        columnSpan: nextHeaderStartIndex - header.startColumnIndex,
        // year: header.year // Potentially useful for display like "Jan 2023"
      };
    }).filter(mh => mh.columnSpan > 0);

    return { weekColumns, monthHeaders: finalMonthHeaders };
  });

  // Load data when dialog opens or profile data changes
  $effect(() => {
    if (show && profileData?.handle) {
      loadActivityData();
    }
  });


  // Function to process message data into heatmap format
  async function loadActivityData() {
    if (!profileData?.handle || !globalState.roomy) {
      isLoading = false;
      return;
    }

    isLoading = true;
    const newHeatmapData: Record<string, Record<string, number>> = { all: {} };
    // Initialize heatmap data for all days in the chronological list
    allDaysChronological.forEach(
      (day) => (newHeatmapData["all"][format(day, "yyyy-MM-dd")] = 0),
    );
    let newSpacesList: { id: string; name: string; messageCount: number }[] = [];

    try {
      // Fetch user's spaces to populate the dropdown
      const userSpaces = await globalState.roomy.spaces.items();
      
      // Initialize spaces list with 0 counts
      newSpacesList = userSpaces.map((s) => ({
        id: s.id,
        name: s.name || s.id,
        messageCount: 0
      }));

      // Search for messages by the current user
      if (profileData.did) {
        const messages = await searchActivityByAuthor(profileData.did);
        
        // Process messages and update counts
        for (const msgDoc of messages) {
          const doc = msgDoc.doc;
          const dayStr = format(new Date(doc.timestamp), "yyyy-MM-dd");
          
          // Initialize space data if it doesn't exist
          if (!newHeatmapData[doc.spaceId]) {
            newHeatmapData[doc.spaceId] = {};
          }
          if (!newHeatmapData[doc.spaceId][dayStr]) {
            newHeatmapData[doc.spaceId][dayStr] = 0;
          }
          
          // Update counts
          newHeatmapData["all"][dayStr]++;
          newHeatmapData[doc.spaceId][dayStr]++;
          
          // Update message count for the space in spacesList
          const space = newSpacesList.find(s => s.id === doc.spaceId);
          if (space) {
            space.messageCount++;
          }
        }
      }

      // Filter out spaces with zero messages and sort by message count (descending)
      newSpacesList = newSpacesList
        .filter(space => space.messageCount > 0)
        .sort((a, b) => b.messageCount - a.messageCount);

      heatmapData = newHeatmapData;
      spacesList = newSpacesList;
    } catch (error) {
      console.error("Error loading activity data:", error);
      // Optionally, set an error state to display to the user
    } finally {
      isLoading = false;
    }
  }

  // Helper function to get color class based on message count
  function getColorClass(count: number): string {
    if (count === 0) return "bg-base-200";
    if (count < 3) return "bg-primary/20";
    if (count < 5) return "bg-primary/40";
    if (count < 8) return "bg-primary/60";
    return "bg-primary";
  }
</script>

{#if show}
  <div class="fixed inset-0 z-50 overflow-y-auto">
    <!-- Overlay -->
    <div
      class="fixed inset-0 bg-black/50 transition-opacity"
      onclick={onClose}
    ></div>

    <!-- Dialog Content -->
    <div class="flex items-center justify-center min-h-screen p-4">
      <div
        class="relative bg-base-100 rounded-lg shadow-xl w-full max-w-5xl max-h-[90vh] overflow-hidden"
      >
        <!-- Header -->
        <div class="p-4 border-b border-base-200">
          <div class="flex justify-between items-center">
            <h2 class="text-xl font-bold">
              {profileData.displayName || profileData.handle || "User"}'s
              Activity
            </h2>
            <button
              class="p-1 hover:bg-base-200 rounded-full"
              onclick={onClose}
              aria-label="Close profile"
            >
              <Icon icon="lucide:x" class="w-5 h-5" />
            </button>
          </div>
          <p class="sr-only">
            View {profileData.displayName || profileData.handle || "user"}'s
            message activity and statistics
          </p>
        </div>
        <!-- Content -->
        <div class="overflow-y-auto max-h-[calc(90vh-150px)] p-4">
          <!-- Space Selector -->
          <div class="mb-4">
            <label
              for="space-select"
              class="block text-sm font-medium text-base-content/80 mb-1"
              >Select Space:</label
            >
            <select
              id="space-select"
              class="select select-bordered w-full"
              bind:value={selectedSpaceId}
            >
              <option value="all">
                All Spaces ({Object.values(heatmapData.all || {}).reduce((a, b) => a + b, 0)})
              </option>
              {#each spacesList as space}
                <option value={space.id}>
                  {space.name} ({space.messageCount})
                </option>
              {/each}
            </select>
          </div>
          {#if isLoading || globalState.indexing}
            <div class="flex justify-center items-center h-64">
              <div
                class="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-primary"
              ></div>
            </div>
          {:else}
            <!-- Heatmap -->
            <div class="mb-6">
              <h3 class="text-lg font-semibold mb-2">Message Activity</h3>

              <!-- Month Headers -->
              {#if contributionGraphData.monthHeaders.length > 0}
                <div class="grid grid-flow-col-dense gap-x-1 ml-[calc(theme(spacing.8)_+_theme(spacing.1))] mb-1 tabular-nums" style={`grid-template-columns: repeat(${contributionGraphData.weekColumns.length}, minmax(0, calc(theme(spacing.3)_+_theme(spacing.px))))`}>
                  {#each contributionGraphData.monthHeaders as month}
                    <div class="text-xs text-left text-base-content/60 overflow-hidden whitespace-nowrap" style={`grid-column: span ${month.columnSpan} / span ${month.columnSpan};`}>
                      {month.name}
                    </div>
                  {/each}
                </div>
              {/if}

              <div class="flex gap-x-1 tabular-nums">
                <!-- Day of Week Labels (Mon, Wed, Fri) -->
                <div class="grid grid-rows-7 gap-y-1 w-8 mr-1 flex-shrink-0 text-xs text-base-content/60">
                  <div class="h-3"></div> <!-- Spacer for Sun -->
                  <div class="h-3 flex items-center">Mon</div>
                  <div class="h-3"></div> <!-- Spacer for Tue -->
                  <div class="h-3 flex items-center">Wed</div>
                  <div class="h-3"></div> <!-- Spacer for Thu -->
                  <div class="h-3 flex items-center">Fri</div>
                  <div class="h-3"></div> <!-- Spacer for Sat -->
                </div>

                <!-- Activity Grid -->
                <div class="grid grid-flow-col auto-cols-[calc(theme(spacing.3)_+_theme(spacing.px))] gap-x-1">
                  {#each contributionGraphData.weekColumns as weekColumn}
                    <div class="grid grid-rows-7 gap-y-1">
                      {#each weekColumn as day}
                        {#if day}
                          <div class="relative group">
                            <div
                              class={`w-3 h-3 rounded-sm ${getColorClass(currentHeatmapData[format(day, "yyyy-MM-dd")] || 0)}`}
                              title={`${format(day, "MMM d, yyyy")}: ${currentHeatmapData[format(day, "yyyy-MM-dd")] || 0} messages`}
                            >
                              <!-- Cell content removed for GitHub style -->
                            </div>
                          </div>
                        {:else}
                          <div class="w-3 h-3 rounded-sm bg-base-200/30"></div> <!-- Placeholder for empty cells -->
                        {/if}
                      {/each}
                    </div>
                  {/each}
                </div>
              </div>

              <div
                class="flex justify-end items-center mt-2 text-xs text-base-content/60"
              >
                <div class="flex items-center gap-2">
                  <span>Less</span>
                  <div class="flex gap-1">
                    <div class="w-3 h-3 bg-base-200"></div>
                    <div class="w-3 h-3 bg-primary/20"></div>
                    <div class="w-3 h-3 bg-primary/40"></div>
                    <div class="w-3 h-3 bg-primary/60"></div>
                    <div class="w-3 h-3 bg-primary"></div>
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
                  {Object.values(currentHeatmapData).filter(
                    (count) => count > 0,
                  ).length}
                </p>
              </div>
            </div>
          {/if}
        </div>
      </div>
    </div>
  </div>
{/if}

<script lang="ts">
  let { count = 5 }: { count?: number } = $props();
</script>

<div class="flex flex-col w-full">
  {#each Array(count) as _, i}
    <div class="flex flex-col gap-2 p-4">
      <!-- Header row: avatar + channel/thread name + time ago -->
      <div class="flex items-center gap-2">
        <div class="size-[30px] rounded-full bg-base-200 dark:bg-base-800 animate-pulse shrink-0"></div>
        <div class="h-4 w-24 bg-base-200 dark:bg-base-800 rounded animate-pulse"></div>
        <div class="h-4 w-16 bg-base-200 dark:bg-base-800 rounded animate-pulse ml-auto"></div>
      </div>

      <!-- Preceding context messages (stacked, capped height) -->
      <div class="flex flex-col gap-1.5 pl-1">
        <div class="flex items-start gap-2">
          <div class="size-[18px] rounded-full bg-base-200 dark:bg-base-800 animate-pulse shrink-0 mt-0.5"></div>
          <div class="flex-1 space-y-1.5">
            <div class="h-3 w-20 bg-base-200 dark:bg-base-800 rounded animate-pulse"></div>
            <div class="h-3 w-3/4 bg-base-200 dark:bg-base-800 rounded animate-pulse"></div>
          </div>
        </div>
        <div class="flex items-start gap-2">
          <div class="size-[18px] rounded-full bg-base-200 dark:bg-base-800 animate-pulse shrink-0 mt-0.5"></div>
          <div class="flex-1 space-y-1.5">
            <div class="h-3 w-16 bg-base-200 dark:bg-base-800 rounded animate-pulse"></div>
            <div class="h-3 w-2/3 bg-base-200 dark:bg-base-800 rounded animate-pulse"></div>
          </div>
        </div>
      </div>

      <!-- Most recent message -->
      <div class="flex items-start gap-2 pl-1">
        <div class="size-[18px] rounded-full bg-base-200 dark:bg-base-800 animate-pulse shrink-0 mt-0.5"></div>
        <div class="flex-1 space-y-1.5">
          <div class="h-3 w-24 bg-base-200 dark:bg-base-800 rounded animate-pulse"></div>
          <div class="h-3 w-5/6 bg-base-200 dark:bg-base-800 rounded animate-pulse"></div>
        </div>
      </div>
    </div>

    {#if i < count - 1}
      <hr class="border-base-200 dark:border-base-800" />
    {/if}
  {/each}
</div>

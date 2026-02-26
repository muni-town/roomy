<script lang="ts">
  let {
    mergeWithPrevious = false,
    lines = 1,
  }: {
    mergeWithPrevious?: boolean;
    lines?: number;
  } = $props();

  function chooseRandomWidth() {
    const random = Math.floor(Math.random() * 5) * 10;
    const base = 30;
    return base + random;
  }
</script>

<div class="flex flex-col w-full relative max-w-full isolate px-4">
  <div
    class={[
      "relative group w-full flex flex-col px-2 rounded",
      mergeWithPrevious ? "mt-1" : "mt-5 pt-1",
    ]}
  >
    <div class="group relative flex w-full justify-start gap-3">
      <!-- Avatar or spacer -->
      {#if !mergeWithPrevious}
        <div class="size-8 sm:size-10 shrink-0">
          <div
            class="size-8 sm:size-10 rounded-full bg-base-200 dark:bg-base-600 animate-pulse"
          ></div>
        </div>
      {:else}
        <div class="w-8 shrink-0 sm:w-10"></div>
      {/if}

      <div class="flex flex-col w-full gap-1.5">
        <!-- Username + timestamp -->
        {#if !mergeWithPrevious}
          <div class="flex items-center gap-2 h-5">
            <div
              class="h-3.5 w-24 rounded bg-base-200 dark:bg-base-600 animate-pulse"
            ></div>
            <div
              class="h-3 w-16 rounded bg-base-200 dark:bg-base-600 animate-pulse opacity-60"
            ></div>
          </div>
        {/if}

        <!-- Message lines -->
        <div class="flex flex-col gap-1.5">
          {#each { length: lines } as _, i}
            <div
              class="h-3.5 rounded bg-base-200 dark:bg-base-600 animate-pulse"
              style:width={i === lines - 1 && lines > 1
                ? "60%"
                : `${chooseRandomWidth()}%`}
            ></div>
          {/each}
        </div>
      </div>
    </div>
  </div>
</div>

<script lang="ts">
  // Theme selection logic adapted from @fuxui/colors by Florian
  // https://flo-bit.dev/ui-kit/components/colors/color-select
  import {
    Accordion,
    AccordionItem,
    AccordionTrigger,
    AccordionContent,
    ThemeToggle,
  } from "@fuxui/base";
  import { onMount } from "svelte";

  const accentColors = [
    "red",
    "orange",
    "amber",
    "yellow",
    "lime",
    "green",
    "emerald",
    "teal",
    "cyan",
    "sky",
    "blue",
    "indigo",
    "violet",
    "purple",
    "fuchsia",
    "pink",
    "rose",
  ];

  const baseColors = ["gray", "stone", "zinc", "neutral", "slate"];

  let accentColor = $state("pink");
  let baseColor = $state("stone");
  let openItem = $state("");

  function colorVar(color: string) {
    return `var(--color-${color}-500)`;
  }

  onMount(() => {
    const savedAccent = localStorage.getItem("accentColor");
    if (savedAccent) {
      accentColor = JSON.parse(savedAccent);
    }

    const savedBase = localStorage.getItem("baseColor");
    if (savedBase) {
      baseColor = JSON.parse(savedBase);
    }
  });

  function selectAccentColor(color: string) {
    const previous = accentColor;
    accentColor = color;

    document.documentElement.classList.remove(previous);
    document.documentElement.classList.add(color);
    localStorage.setItem("accentColor", JSON.stringify(color));

    window.dispatchEvent(
      new CustomEvent("theme-changed", { detail: { accentColor: color } }),
    );
    openItem = "";
  }

  function selectBaseColor(color: string) {
    const previous = baseColor;
    baseColor = color;

    document.documentElement.classList.remove(previous);
    document.documentElement.classList.add(color);
    localStorage.setItem("baseColor", JSON.stringify(color));

    window.dispatchEvent(
      new CustomEvent("theme-changed", { detail: { baseColor: color } }),
    );
    openItem = "";
  }
</script>

<div class="flex flex-col w-full">
  <div class="flex items-center justify-between py-2 pr-0.5">
    <span class="text-sm font-medium">
      <span class="dark:hidden">Light Mode</span>
      <span class="hidden dark:inline">Dark Mode</span>
    </span>
    <ThemeToggle />
  </div>

  <Accordion type="single" bind:value={openItem}>
    <AccordionItem value="accent" class="border-b-0">
      <AccordionTrigger class="py-2 my-0">
        <div class="flex items-center justify-between flex-1 pr-2">
          <span class="text-sm font-medium">Accent</span>
          <div
            class="size-6 rounded-full"
            style="background-color: {colorVar(accentColor)}"
          ></div>
        </div>
      </AccordionTrigger>
      <AccordionContent class="pt-0 pb-3">
        <div class="flex overflow-x-auto gap-3 py-1.5">
          {#each accentColors as color}
            <button
              type="button"
              aria-label={color}
              onclick={() => selectAccentColor(color)}
              class="shrink-0 size-7 rounded-full ring-offset-2 ring-offset-base-100 dark:ring-offset-base-900 transition-all hover:scale-110 active:scale-95"
              class:ring-2={accentColor === color}
              style="background-color: {colorVar(color)}; {accentColor === color
                ? `--tw-ring-color: ${colorVar(color)}`
                : ''}"
            ></button>
          {/each}
        </div>
      </AccordionContent>
    </AccordionItem>

    <AccordionItem value="base" class="border-b-0">
      <AccordionTrigger class="py-2 my-0">
        <div class="flex items-center justify-between flex-1 pr-2">
          <span class="text-sm font-medium">Base</span>
          <div
            class="size-6 rounded-full"
            style="background-color: {colorVar(baseColor)}"
          ></div>
        </div>
      </AccordionTrigger>
      <AccordionContent class="pt-0 pb-3">
        <div class="flex overflow-x-auto gap-3 py-1.5">
          {#each baseColors as color}
            <button
              type="button"
              aria-label={color}
              onclick={() => selectBaseColor(color)}
              class="size-7 rounded-full ring-offset-2 ring-offset-base-100 dark:ring-offset-base-900 transition-all hover:scale-110 active:scale-95"
              class:ring-2={baseColor === color}
              style="background-color: {colorVar(color)}; {baseColor === color
                ? `--tw-ring-color: ${colorVar(color)}`
                : ''}"
            ></button>
          {/each}
        </div>
      </AccordionContent>
    </AccordionItem>
  </Accordion>
</div>

<style>
  :global([data-accordion-trigger] > svg) {
    display: none;
  }
  :global([data-accordion-content]) {
    overflow: hidden;
  }
  :global([data-accordion-content][data-state="open"]) {
    animation: accordion-down 200ms ease-out;
  }
  :global([data-accordion-content][data-state="closed"]) {
    animation: accordion-up 200ms ease-out;
  }
  @keyframes accordion-down {
    from {
      height: 0;
      opacity: 0;
    }
    to {
      height: var(--bits-accordion-content-height);
      opacity: 1;
    }
  }
  @keyframes accordion-up {
    from {
      height: var(--bits-accordion-content-height);
      opacity: 1;
    }
    to {
      height: 0;
      opacity: 0;
    }
  }
</style>

<script lang="ts">
  import { Select } from "bits-ui";
  import { themes, type ThemeName } from "../themes";
  import Icon from "@iconify/svelte";
  import { onMount } from "svelte";
  import { setTheme } from "$lib/utils.svelte";

  let currentTheme = $state<ThemeName>();

  onMount(() => {
    // Note: could get this from context if it were available
    // but that might be overkill. Worth considering in the future.
    const theme = window.localStorage.getItem("theme") as ThemeName;
    currentTheme = theme;
  });

  function formatThemeLabel(t: string): string {
    if (typeof t === "string" && t.length > 0) {
      return (t[0]?.toUpperCase() ?? "") + t.slice(1);
    }
    return "";
  }

  const selectItems = Object.entries(themes).map(([name, themeObj]) => {
    const t = themeObj as Record<string, string>;
    const baseColor = t["base-100"] || "#fff";
    const baseContent = t["base-content"] || "#fff";
    const isDark = t["color-scheme"] === "dark";

    return {
      value: name as ThemeName,
      label: formatThemeLabel(name),
      colors: {
        primary: t.primary,
        secondary: t.secondary,
        accent: t.accent,
        baseContent,
        base: baseColor,
      },
      isDark,
    };
  });

  function handleSetTheme(theme: ThemeName) {
    currentTheme = theme;
    setTheme(theme);
  }
</script>

<Select.Root
  type="single"
  items={selectItems}
  onValueChange={(theme) => handleSetTheme(theme as ThemeName)}
  value={currentTheme}
>
  <Select.Trigger
    class="w-full flex justify-center items-center aspect-square rounded-lg hover:bg-base-200 cursor-pointer"
    title="theme"
  >
    <Icon icon="material-symbols:palette-outline" class="size-6" />
  </Select.Trigger>
  <Select.Portal>
    <Select.Content
      side="right"
      sideOffset={8}
      class="w-fit h-48 bg-base-300 p-2 rounded z-10 border border-base-100"
    >
      <Select.Viewport>
        {#each selectItems as theme, i (i + theme.value)}
          <Select.Item value={theme.value} label={theme.label}>
            {#snippet children({ selected })}
              <span
                class="px-1 py-2 rounded cursor-pointer hover:bg-base-100 flex gap-2 items-center"
              >
                <span
                  class="w-6 h-6 rounded-lg border inline-flex items-center justify-center mr-2"
                  style="background: {theme.colors.base};
                    border-color: {theme.isDark ? '#555' : '#bbb'};"
                >
                  <span class="grid grid-cols-2 grid-rows-2 gap-0.5 w-4 h-4">
                    <span
                      class="w-2 h-2 rounded-full"
                      style="background: {theme.colors.baseContent};"
                    ></span>
                    <span
                      class="w-2 h-2 rounded-full"
                      style="background: {theme.colors.primary};"
                    ></span>
                    <span
                      class="w-2 h-2 rounded-full"
                      style="background: {theme.colors.accent};"
                    ></span>
                    <span
                      class="w-2 h-2 rounded-full"
                      style="background: {theme.colors.secondary};"
                    ></span>
                  </span>
                </span>
                {theme.label}
                {#if selected}
                  <Icon icon="material-symbols:check-rounded" />
                {/if}
              </span>
            {/snippet}
          </Select.Item>
        {/each}
      </Select.Viewport>
    </Select.Content>
  </Select.Portal>
</Select.Root>

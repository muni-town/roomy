<script lang="ts">
  import { Select } from "bits-ui";
  import { themes } from "../themes";
  import Icon from "@iconify/svelte";

  let currentTheme = $state("synthwave");

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
      value: name,
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

  function setTheme(theme: string) {
    window.localStorage.setItem("theme", theme);
    document.documentElement.setAttribute("data-theme", theme);
    currentTheme = theme;
  }
</script>

<Select.Root
  type="single"
  items={selectItems}
  onValueChange={setTheme}
  value={currentTheme}
>
  <Select.Trigger
    class="w-full flex justify-center items-center aspect-square rounded-lg hover:bg-base-200 cursor-pointer"
  >
    <Icon icon="material-symbols:palette-outline" class="size-6" />
  </Select.Trigger>
  <Select.Portal>
    <Select.Content
      side="right"
      sideOffset={8}
      class="w-fit h-48 bg-base-300 p-2 rounded z-10"
    >
      <Select.Viewport>
        {#each selectItems as theme, i (i + theme.value)}
          <Select.Item value={theme.value} label={theme.label}>
            {#snippet children({ selected })}
              <span
                class="px-1 py-2 rounded cursor-pointer hover:bg-base-100 flex gap-2 items-center"
              >
                <span
                  class="w-6 h-6 rounded-lg border flex items-center justify-center mr-2"
                  style="background: {theme.colors.base};
                    border-color: {theme.isDark
                    ? '#555'
                    : '#bbb'}; display: inline-flex;"
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

<script lang="ts">
  import { Select } from "bits-ui";
  import { themes } from "../themes";
  import Icon from "@iconify/svelte";

  let currentTheme = $state("");
  let previewTheme = $state("");

  // Extract theme names and color values from the themes object
  function getThemeName(selector: string): string {
    // e.g. "[data-theme=aqua]" => "aqua"
    const match = selector.match(/^\[data-theme=(.+)\]$/);
    return match?.[1] ?? "";
  }

  function formatThemeLabel(t: string): string {
    if (typeof t === "string" && t.length > 0) {
      return (t[0]?.toUpperCase() ?? "") + t.slice(1);
    }
    return "";
  }

  // Helper function to determine if a theme is dark based on its base-100 color
  function isDarkTheme(baseColor: string): boolean {
    try {
      // Convert hex to RGB and calculate luminance
      const hex = baseColor.replace('#', '');
      // Handle both 3-digit and 6-digit hex codes
      const fullHex = hex.length === 3
        ? `${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`
        : hex;

      if (fullHex.length < 6) return false; // Default to light theme if invalid hex

      const r = Number.parseInt(fullHex.substring(0, 2), 16) / 255;
      const g = Number.parseInt(fullHex.substring(2, 4), 16) / 255;
      const b = Number.parseInt(fullHex.substring(4, 6), 16) / 255;

      // Calculate relative luminance using the formula for perceived brightness
      const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;

      // If luminance is less than 0.5, consider it a dark theme
      return luminance < 0.5;
    } catch (e) {
      // If there's any error in calculation, default to light theme
      return false;
    }
  }

  const selectItems = Object.entries(themes).map(([selector, themeObj]) => {
    const name = getThemeName(selector);
    const t = themeObj as Record<string, string>;
    const baseColor = t["base-100"] || "#fff";
    const isDark = isDarkTheme(baseColor);

    return {
      value: name,
      label: formatThemeLabel(name),
      colors: {
        primary: t.primary,
        secondary: t.secondary,
        accent: t.accent,
        neutral: t.neutral,
        base100: baseColor
      },
      isDark
    }
  });

  $effect(() => {
    if (typeof window !== "undefined") {
      const theme = window.localStorage.getItem("theme");
      if (theme) {
        document.documentElement.setAttribute("data-theme", theme);
        currentTheme = theme;
      } else {
        // default: synthwave
        window.localStorage.setItem("theme", "synthwave");
        document.documentElement.setAttribute("data-theme", "synthwave");
        currentTheme = "synthwave";
      }
    }
  });

  function setTheme(theme: string) {
    window.localStorage.setItem("theme", theme);
    document.cookie = `theme=${theme}; path=/`;
    document.documentElement.setAttribute("data-theme", theme);
    currentTheme = theme;
    previewTheme = "";
  }

  function previewThemeOnHover(theme: string) {
    if (theme !== currentTheme) {
      previewTheme = theme;
      document.documentElement.setAttribute("data-theme", theme);
    }
  }

  function resetPreview() {
    if (previewTheme) {
      document.documentElement.setAttribute("data-theme", currentTheme);
      previewTheme = "";
    }
  }
</script>

<Select.Root type="single" items={selectItems} onValueChange={setTheme}>
  <Select.Trigger class="btn btn-ghost hover:bg-base-200 cursor-pointer">
    <Icon icon="material-symbols:palette-outline" class="size-6" />
  </Select.Trigger>
  <Select.Portal>
    <Select.Content
      side="right"
      sideOffset={8}
      class="w-fit h-48 bg-base-300 p-2 rounded"
    >
      <Select.Viewport>
        {#each selectItems as theme, i (i + theme.value)}
          <Select.Item value={theme.value} label={theme.label}>
            {#snippet children({ selected })}
              <span class="px-1 py-2 rounded cursor-pointer hover:bg-base-100 flex gap-2 items-center">
                <span
                  class="w-6 h-6 rounded-lg border flex items-center justify-center mr-2"
                  style="background: {theme.isDark ? '#333' : '#fff'}; border-color: {theme.isDark ? '#555' : '#bbb'}; display: inline-flex;"
                >
                  <span class="grid grid-cols-2 grid-rows-2 gap-0.5 w-4 h-4">
                    <span class="w-2 h-2 rounded-full" style="background: {theme.colors.primary};"></span>
                    <span class="w-2 h-2 rounded-full" style="background: {theme.colors.secondary};"></span>
                    <span class="w-2 h-2 rounded-full" style="background: {theme.colors.accent};"></span>
                    <span class="w-2 h-2 rounded-full" style="background: {theme.colors.neutral};"></span>
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

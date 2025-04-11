<script lang="ts">
  import { Select } from "bits-ui";
  import { themes } from "../themes";
  import Icon from "@iconify/svelte";

  let {
    class: classNames = "",
  }: {
    class?: string
  } = $props();
  let currentTheme = $state("");
  const selectItems = themes.map((t) => {
    return {
      value: t,
      label: `${t[0]?.toUpperCase()}${t.slice(1)}`,
    };
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
  }
</script>

<Select.Root type="single" items={selectItems} onValueChange={setTheme}>
  <Select.Trigger class="btn btn-ghost hover:bg-base-200 cursor-pointer {classNames}">
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
            {#snippet children({ selected }: { selected: boolean })}
              <span
                class="px-1 py-2 rounded cursor-pointer hover:bg-base-100 flex gap-2 items-center"
              >
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

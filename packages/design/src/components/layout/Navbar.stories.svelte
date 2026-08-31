<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import Navbar from "./Navbar.svelte";
  import { IconBell, IconSearch } from "../../icons/index";

  const { Story } = defineMeta({
    title: "Layout/Navbar",
    component: Navbar,
  });

  type Args = {
    hasSidebar: boolean;
    compact: boolean;
  };
</script>

{#snippet template(args: Args)}
  <div class="p-4">
    <Navbar {...(args as any)}>
      {#snippet children()}
        <div class="relative flex items-center">
          <IconSearch class="size-4 absolute left-3 text-base-400" />
          <input
            type="text"
            placeholder="Search…"
            class="w-72 rounded-lg border border-base-500 dark:border-base-800 bg-base-50 dark:bg-transparent pl-9 pr-3 py-1.5 text-sm text-base-900 dark:text-base-100 placeholder:text-base-400 focus:outline-none focus:ring-2 focus:ring-accent-500/50"
          />
        </div>
        <div class="flex items-center gap-2">
          <button
            type="button"
            aria-label="Notifications"
            class="p-2 rounded-lg text-base-600 dark:text-base-300 hover:bg-base-200/50 dark:hover:bg-base-800/50 cursor-pointer"
          >
            <IconBell class="size-5" />
          </button>
          <div
            class="size-8 rounded-full bg-accent-500 text-white flex items-center justify-center text-xs font-semibold"
            >MF</div
          >
        </div>
      {/snippet}
    </Navbar>
  </div>
{/snippet}

<Story name="Default" args={{ hasSidebar: true, compact: false }} {template} />

<Story name="Compact" args={{ hasSidebar: true, compact: true }} {template} />

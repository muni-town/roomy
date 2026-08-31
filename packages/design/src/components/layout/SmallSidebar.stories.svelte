<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import SmallSidebar from "./SmallSidebar.svelte";
  import { IconBell, IconHome, IconSearch, IconSettings } from "../../icons/index";

  const { Story } = defineMeta({
    title: "Layout/SmallSidebar",
    component: SmallSidebar,
  });

  type Args = {
    hasSidebar: boolean;
  };
</script>

{#snippet template(args: Args)}
  <div class="p-4">
    <div class="h-96">
      <SmallSidebar {...(args as any)}>
        {#snippet children()}
          <div
            class="flex flex-col justify-between h-full w-full items-center py-2"
          >
            <div class="flex flex-col items-center gap-2">
              <button
                type="button"
                aria-label="Home"
                class="p-2 rounded-lg text-base-600 dark:text-base-300 hover:bg-base-200/50 dark:hover:bg-base-800/50 cursor-pointer"
              >
                <IconHome class="size-5" />
              </button>
              <button
                type="button"
                aria-label="Search"
                class="p-2 rounded-lg text-base-600 dark:text-base-300 hover:bg-base-200/50 dark:hover:bg-base-800/50 cursor-pointer"
              >
                <IconSearch class="size-5" />
              </button>
              <button
                type="button"
                aria-label="Notifications"
                class="p-2 rounded-lg text-base-600 dark:text-base-300 hover:bg-base-200/50 dark:hover:bg-base-800/50 cursor-pointer"
              >
                <IconBell class="size-5" />
              </button>
            </div>
            <div class="flex flex-col items-center gap-2">
              <button
                type="button"
                aria-label="Settings"
                class="p-2 rounded-lg text-base-600 dark:text-base-300 hover:bg-base-200/50 dark:hover:bg-base-800/50 cursor-pointer"
              >
                <IconSettings class="size-5" />
              </button>
              <div
                class="size-8 rounded-full bg-accent-500 text-white flex items-center justify-center text-xs font-semibold"
                >MF</div
              >
            </div>
          </div>
        {/snippet}
      </SmallSidebar>
    </div>
  </div>
{/snippet}

<Story name="Default" args={{ hasSidebar: true }} {template} />

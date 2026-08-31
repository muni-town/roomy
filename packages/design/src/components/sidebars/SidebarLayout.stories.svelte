<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import SidebarLayout from "./SidebarLayout.svelte";
  import { IconHome } from "../../icons/index";

  const { Story } = defineMeta({
    title: "Sidebars/SidebarLayout",
    component: SidebarLayout,
    parameters: { layout: "fullscreen" },
  });

  type Args = {
    loading: boolean;
  };
</script>

{#snippet template(args: Args)}
  <div class="h-96 w-64 border-r border-base-200 dark:border-base-800 bg-base-50 dark:bg-base-950">
    <SidebarLayout {...(args as any)}>
      {#snippet header()}
        <div class="flex flex-col p-2">
          <div class="flex items-center gap-2">
            <div
              class="size-8 rounded-xl bg-accent-500 text-white flex items-center justify-center text-xs font-bold"
              >MF</div
            >
            <span class="text-sm font-semibold text-base-900 dark:text-base-100"
              >Meri Forest</span
            >
          </div>
        </div>
      {/snippet}
      {#snippet body()}
        <div class="flex flex-col gap-1 px-2">
          <a
            href="#/home"
            class="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-base-700 dark:text-base-300 hover:bg-base-200/50 dark:hover:bg-base-800/50 no-underline"
          >
            <IconHome class="size-4" /> Home
          </a>
          <span class="text-[11px] font-semibold uppercase tracking-wider text-base-400 px-1 pt-2">
            Channels
          </span>
          <a
            href="#/general"
            class="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-base-700 dark:text-base-300 hover:bg-base-200/50 dark:hover:bg-base-800/50 no-underline"
          >
            # General
          </a>
          <a
            href="#/random"
            class="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-base-700 dark:text-base-300 hover:bg-base-200/50 dark:hover:bg-base-800/50 no-underline"
          >
            # Random
          </a>
        </div>
      {/snippet}
      {#snippet footer()}
        <div
          class="flex items-center gap-2 p-2 border-t border-base-200 dark:border-base-800"
        >
          <div
            class="size-8 rounded-full bg-accent-500 text-white flex items-center justify-center text-xs font-semibold"
            >MF</div
          >
          <span class="text-sm text-base-800 dark:text-base-200 truncate"
            >Meri</span
          >
        </div>
      {/snippet}
    </SidebarLayout>
  </div>
{/snippet}

<Story name="Default" args={{ loading: false }} {template} />

<Story name="Loading" args={{ loading: true }} {template} />

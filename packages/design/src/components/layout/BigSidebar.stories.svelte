<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import BigSidebar from "./BigSidebar.svelte";
  import { IconHome, IconHashtag, IconSettings } from "../../icons/index";

  const { Story } = defineMeta({
    title: "Layout/BigSidebar",
    component: BigSidebar,
  });

  type Args = {
    showBranding: boolean;
  };
</script>

{#snippet template(args: Args)}
  <div class="p-4">
    <div class="h-96">
      <BigSidebar {...(args as any)}>
        {#snippet children()}
          <nav class="flex flex-col gap-1 p-2">
            <a
              href="#/home"
              class="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-base-700 dark:text-base-300 hover:bg-base-200/50 dark:hover:bg-base-800/50 no-underline"
            >
              <IconHome class="size-4" /> Home
            </a>
            <a
              href="#/general"
              class="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-base-700 dark:text-base-300 hover:bg-base-200/50 dark:hover:bg-base-800/50 no-underline"
            >
              <IconHashtag class="size-4" /> General
            </a>
            <a
              href="#/random"
              class="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-base-700 dark:text-base-300 hover:bg-base-200/50 dark:hover:bg-base-800/50 no-underline"
            >
              <IconHashtag class="size-4" /> Random
            </a>
          </nav>
        {/snippet}
        {#snippet footer()}
          <div
            class="flex items-center gap-2 p-2 border-t border-base-200 dark:border-base-800"
          >
            <div
              class="size-8 rounded-full bg-accent-500 text-white flex items-center justify-center text-xs font-semibold shrink-0"
              >MF</div
            >
            <span class="text-sm text-base-800 dark:text-base-200 truncate"
              >Meri</span
            >
            <span class="ml-auto text-base-400"
              ><IconSettings class="size-4" /></span
            >
          </div>
        {/snippet}
      </BigSidebar>
    </div>
  </div>
{/snippet}

<Story name="Default" args={{ showBranding: true }} {template} />

<Story
  name="NoBranding"
  args={{ showBranding: false }}
  {template}
/>

<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import { Popover as BPopover } from "bits-ui";
  import PopoverContent from "./PopoverContent.svelte";

  const { Story } = defineMeta({
    title: "UI/PopoverContent",
    component: PopoverContent,
  });
</script>

{#snippet template()}
  <div class="flex h-96 w-full items-center justify-center p-4">
    <BPopover.Root open={true}>
      {#snippet children()}
        <div>
          <button
            class="rounded-md border border-base-300 px-3 py-1"
            type="button"
          >
            Open popover
          </button>
          <PopoverContent>Popover content here</PopoverContent>
        </div>
      {/snippet}
    </BPopover.Root>
  </div>
{/snippet}

<Story name="Default" {template} />

<script lang="ts">
  /***
   * From Fox UI by Flo-bit
   * https://github.com/flo-bit/ui-kit/tree/main/packages/text/src/lib/components/rich-text-editor
   */

  import { cn } from "@foxui/core";
  import type { Editor, Range } from "@tiptap/core";
  import Icon from "../Icon.svelte";
  import type { RichTextTypes } from "..";

  type Props = {
    items: {
      value: RichTextTypes;
      label: string;
      command: ({ editor, range }: { editor: Editor; range: Range }) => void;
    }[];
    range: Range;
    editor: Editor;
    active?: number;
  };

  let { items, range, editor, active }: Props = $props();

  let activeIndex = $state(active ?? 0);

  export function setItems(value: any[]) {
    items = value;
  }

  export function setRange(value: Range) {
    range = value;
  }

  export function onKeyDown(event: KeyboardEvent) {
    if (event.repeat) {
      return false;
    }
    switch (event.key) {
      case "ArrowUp": {
        if (activeIndex <= 0) {
          activeIndex = items.length - 1;
        } else {
          activeIndex--;
        }
        return true;
      }
      case "ArrowDown": {
        if (activeIndex >= items.length - 1) {
          activeIndex = 0;
        } else {
          activeIndex++;
        }
        return true;
      }
      case "Enter": {
        const selected = items[activeIndex];

        if (selected) {
          selected.command({ editor, range });
          return true;
        }
      }
    }

    return false;
  }
</script>

<menu
  class={cn(
    "bg-base-50/50 border-base-500/20 overflow-hidden rounded-2xl border shadow-lg backdrop-blur-xl",
    "dark:bg-base-900/50 dark:border-base-500/10",
    "motion-safe:animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
    "divide-base-300/30 dark:divide-base-800 divide-y text-sm",
  )}
>
  {#each items as item, index}
    <button
      onclick={() => item.command({ editor, range })}
      class={cn(
        "text-base-900 dark:text-base-200 group relative isolate flex min-w-28 w-full cursor-pointer items-center gap-3 px-3 py-2 font-medium [&_svg]:size-3.5",
        activeIndex === index
          ? "text-accent-700 dark:text-accent-400 bg-accent-500/10"
          : "hover:bg-accent-500/10",
      )}
    >
      <Icon name={item.value} />
      {item.label}
    </button>
  {/each}
</menu>

<script lang="ts">
  import { cn } from "../../../utils/index.js";
  import { buttonVariants } from "../button/Button.svelte";

  let {
    name,
    value = $bindable(),
    options,
    onchange,
  }: {
    name: string;
    value?: string;
    options: { label: string; value: string }[];
    /** Fired with the newly selected value when the user picks an option. */
    onchange?: (value: string) => void;
  } = $props();

  function select(next: string): void {
    value = next;
    onchange?.(next);
  }
</script>

<div class="flex gap-2" role="group">
  {#each options as option}
    <label
      class={cn(
        buttonVariants({
          variant: value === option.value ? "toggle" : "ghost",
        }),
        "cursor-pointer",
      )}
    >
      <input
        type="radio"
        {name}
        value={option.value}
        checked={value === option.value}
        onchange={() => select(option.value)}
        class="sr-only"
      />
      {option.label}
    </label>
  {/each}
</div>

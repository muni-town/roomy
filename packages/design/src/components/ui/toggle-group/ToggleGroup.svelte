<script lang="ts">
  import { cn } from "../../../utils/index.js";
  import { buttonVariants } from "../button/Button.svelte";

  let {
    name,
    value = $bindable(),
    options,
    onchange,
    disabled = false,
  }: {
    name: string;
    value?: string;
    options: { label: string; value: string; disabled?: boolean }[];
    /** Fired with the newly selected value when the user picks an option. */
    onchange?: (value: string) => void;
    /** Disable the whole group. */
    disabled?: boolean;
  } = $props();

  function select(next: string): void {
    if (disabled) return;
    const option = options.find((o) => o.value === next);
    if (option?.disabled) return;
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
        option.disabled ? "pointer-events-none opacity-40" : "",
      )}
    >
      <input
        type="radio"
        {name}
        value={option.value}
        checked={value === option.value}
        onchange={() => select(option.value)}
        disabled={disabled || option.disabled}
        class="sr-only"
      />
      {option.label}
    </label>
  {/each}
</div>

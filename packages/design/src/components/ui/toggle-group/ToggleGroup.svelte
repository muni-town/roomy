<script lang="ts">
  import { cn } from "../../../utils/index.js";
  import { buttonVariants } from "../button/Button.svelte";

  let {
    name,
    value = $bindable(),
    options,
  }: {
    name: string;
    value?: string;
    options: { label: string; value: string }[];
  } = $props();
</script>

<div class="flex gap-2" role="group">
  {#each options as option}
    <label
      class={cn(
        buttonVariants({
          variant: value === option.value ? "primary" : "ghost",
        }),
        "cursor-pointer",
      )}
    >
      <input
        type="radio"
        {name}
        value={option.value}
        checked={value === option.value}
        onchange={() => (value = option.value)}
        class="sr-only"
      />
      {option.label}
    </label>
  {/each}
</div>

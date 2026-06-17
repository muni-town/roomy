<script lang="ts">
  import { IconSmileyXEyes } from "@roomy/design/icons";

  let {
    message,
    class: className = "",
    iconSize = "size-5",
  }: {
    message: string;
    class?: string;
    iconSize?: string;
  } = $props();
</script>

<div class="flex items-center gap-2 {className}">
  <IconSmileyXEyes class="{iconSize} text-base-400 shrink-0" />
  <p class="text-sm text-base-500">{message}</p>
</div>

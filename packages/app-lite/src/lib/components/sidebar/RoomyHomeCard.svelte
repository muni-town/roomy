<script lang="ts">
  import { IconArrowLeft } from "@roomy/design/icons";

    let { onClick, small = false }: { onClick: () => void, small: boolean } = $props();
</script>

<button
  onclick={onClick}
  class={["flex items-center rounded-lg mx-2 mt-2 px-3 py-2 group transition-colors text-left w-60 cursor-pointer", small ? "gap-1" : "gap-3"]}
>
  {#if small}
    <IconArrowLeft />
    {/if}
  <img
    src="/logo/roomy_blob_flat.png"
    alt="Roomy"
    class={["shrink-0 ", small ? "size-5 mr-1" : "size-9"]}
  />
  <span class={["font-black text-base-700 tracking-[-0.015em] dark:text-base-300 truncate ", small ? "text-lg group-hover:underline" : "text-2xl"]}>
    Roomy
  </span>
</button>
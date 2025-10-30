<script lang="ts">
  import type {EdgeLink} from "$lib/workers/materializer"
  let {
    embed: e,
    url,
  }: {
    embed: EdgeLink['data'];
    url: string;
  } = $props();

  /** add value with separator if it is not undefined */
  const cr = (value: string | undefined, seperator = ""): string =>
    value !== undefined ? ` ${seperator} ${value}` : "";
</script>

<!--TODO: Switch breakpoints to container queries -->
<div
  class="not-prose max-w-[70ch] rounded-sm border-l-4 border-l-base-300 dark:border-l-base-700 bg-base-100/50 dark:bg-base-900/50 flex flex-col justify-stretch gap-4 min-[500px]:flex-row"
>
  <div class="min-w-0 flex-1 px-3 py-2 flex flex-col">
    {#if e}
      <p class="mb-1 mt-0 text-sm leading-none opacity-70">
        {cr(e.p?.n)}
        {cr(e.au?.n, "-")}
      </p>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        class="mb-1 mt-1 line-clamp-2 max-w-prose leading-snug text-accent-600 dark:text-accent-400 hover:text-primary-focus font-bold"
      >
        {e.t}
      </a>
      <p class="my-0 line-clamp-2 max-w-prose text-sm leading-tight">
        {cr(e.d)}
      </p>
      <div class="grow py-2"></div>
      {#if e.footer}
        <p class="mt-2 mb-0 text-sm">{e.footer.t}</p>
      {/if}
    {/if}
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      class="text-sm leading-tight underline text-base-600 dark:text-base-400"
    >
      {url}
    </a>
  </div>

  {#if e}
    {#if e.imgs && e.imgs.length}
      <div class=" w-full flex-shrink-0 p-2 min-[500px]:max-w-40">
        <img
          alt={e.imgs[0]?.d ?? ""}
          class="m-0 h-full w-full rounded object-cover"
          src={e.imgs[0]?.u}
        />
      </div>
    {/if}
    {#if e.vid}
      <div class=" w-full flex-shrink-0 p-2 min-[500px]:max-w-40">
        <video
          muted
          class="my-0 h-full w-full rounded object-cover"
          poster={e.thumb?.u}
          src={e.vid.u}
        >
        </video>
      </div>
    {/if}
  {/if}
</div>

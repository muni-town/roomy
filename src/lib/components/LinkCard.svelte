<script lang="ts">
  let { data, url } = $props();
  const cr = (value: string | undefined, seperator = ""): string =>
    value !== undefined ? ` ${seperator} ${value}` : "";
</script>

<div
  class="flex border rounded-xs text-sm border-base-content/30 bg-base-content/5 max-w-[60ch] justify-stretch gap-4 flex-row"
>
  <div class="min-w-0 flex-1 pl-3 py-2 flex flex-col">
    <p class="mb-1 mt-1 line-clamp-2 leading-snug">
      <b class="font-bold">{data.t}</b>
    </p>
    <p class="my-0 line-clamp-4 leading-tight">{cr(data.d)}</p>
    <div class="grow py-2"></div>
    {#if data.footer}
      <p class="mt-2 mb-0 text-sm">{data.footer.t}</p>
    {/if}
    <a
      href={url}
      class=" leading-tight mb-1 mt-0 text-xs dz-link-hover truncate hover:underline"
    >
      {cr(data.p?.n)}
      {cr(data.au?.n, "-")} | {url}
    </a>
  </div>
  {#if data.imgs && data.imgs.length}
    <div class=" w-full flex-shrink-0 max-w-40">
      <img
        class="my-0 h-full w-full object-cover"
        alt="link preview"
        src={data.imgs[0].u}
      />
    </div>
  {/if}
  {#if data.vid}
    <div class=" w-full flex-shrink-0 p-2 aspect-auto">
      <video
        class="my-0 h-full w-full rounded object-cover"
        poster={data.thumb?.u}
        src={data.vid.u}
      ></video>
    </div>
  {/if}
</div>

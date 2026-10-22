<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import type { AsyncStateWithIdle } from "@roomy-space/sdk";
  import StateSuspense from "./StateSuspense.svelte";

  const { Story } = defineMeta({
    title: "Helper/StateSuspense",
    component: StateSuspense,
    render: template,
  });

  type MockState = AsyncStateWithIdle<string>;
  type Args = { state: MockState; label: string };
</script>

{#snippet template(args: Args)}
  <div class="p-4">
    <StateSuspense state={args.state} loadingDelay={0}>
      {#snippet pending()}
        <div class="text-sm text-base-500">Loading…</div>
      {/snippet}
      {#snippet error(err: { message: string })}
        <div class="text-sm text-red-500">Error: {err.message}</div>
      {/snippet}
      {#snippet idle()}
        <div class="text-sm text-base-500">Idle — no query started.</div>
      {/snippet}
      {#snippet children(value: any)}
        <div class="text-sm">Value: {value}</div>
      {/snippet}
    </StateSuspense>
  </div>
{/snippet}

<Story
  name="Success"
  args={{
    state: { status: "success", data: "hello" },
    label: "Success",
  }}
  {template}
/>

<Story
  name="Loading"
  args={{
    state: { status: "loading" },
    label: "Loading",
  }}
  {template}
/>

<Story
  name="Error"
  args={{
    state: { status: "error", message: "Failed to fetch" },
    label: "Error",
  }}
  {template}
/>

<Story
  name="Idle"
  args={{
    state: { status: "idle" },
    label: "Idle",
  }}
  {template}
/>

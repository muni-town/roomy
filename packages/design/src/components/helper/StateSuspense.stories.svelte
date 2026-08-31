<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import StateSuspense from "./StateSuspense.svelte";

  const { Story } = defineMeta({
    title: "Helper/StateSuspense",
    component: StateSuspense,
  });

  type MockState = {
    status: "idle" | "loading" | "error" | "success";
    data?: unknown;
    message?: string;
    stale?: boolean;
  };
</script>

{#snippet template(args: { state: MockState; label: string })}
  <div class="p-4">
    <StateSuspense state={args.state as any} loadingDelay={0}>
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
    state: { status: "success", data: "hello", message: "", stale: false },
    label: "Success",
  }}
  {template}
/>

<Story
  name="Loading"
  args={{
    state: { status: "loading", data: null, message: "" },
    label: "Loading",
  }}
  {template}
/>

<Story
  name="Error"
  args={{
    state: { status: "error", data: null, message: "Failed to fetch" },
    label: "Error",
  }}
  {template}
/>

<Story
  name="Idle"
  args={{
    state: { status: "idle", data: null, message: "" },
    label: "Idle",
  }}
  {template}
/>

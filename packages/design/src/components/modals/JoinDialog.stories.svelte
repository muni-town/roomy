<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import JoinDialog from "./JoinDialog.svelte";

  const { Story } = defineMeta({
    title: "Modals/JoinDialog",
    component: JoinDialog,
  });

  type Args = {
    resolveState: {
      status: "loading" | "error" | "success";
      message?: string;
      data?: { name: string; allowPublicJoin: boolean };
    };
    joinState: {
      status: "idle" | "loading" | "success" | "error";
      message?: string;
    };
    pushEnabled: boolean;
  };
</script>

{#snippet template(args: Args)}
  <div class="p-4 h-96">
    <JoinDialog
      {...(args as any)}
      onJoin={() => {
        /* no-op in story */
      }}
    >
      {#snippet avatar()}
        <div
          class="size-12 rounded-xl bg-accent-500 text-white flex items-center justify-center text-sm font-bold shrink-0"
          >MF</div
        >
      {/snippet}
    </JoinDialog>
  </div>
{/snippet}

<Story
  name="Default"
  args={{
    resolveState: {
      status: "success",
      data: { name: "Meri Forest", allowPublicJoin: true },
    },
    joinState: { status: "idle" },
    pushEnabled: false,
  }}
  {template}
/>

<Story
  name="InviteOnly"
  args={{
    resolveState: {
      status: "success",
      data: { name: "Meri Forest", allowPublicJoin: false },
    },
    joinState: { status: "idle" },
    pushEnabled: false,
  }}
  {template}
/>

<Story
  name="Error"
  args={{
    resolveState: { status: "error", message: "Space not found" },
    joinState: { status: "idle" },
    pushEnabled: false,
  }}
  {template}
/>

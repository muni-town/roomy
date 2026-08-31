<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import Alert from "./Alert.svelte";

  const { Story } = defineMeta({
    title: "UI/Alert",
    component: Alert,
  });

  type Args = {
    title?: string;
    type?: "info" | "warning" | "success" | "error";
    variant?: string;
  };
</script>

{#snippet template(args: Args)}
  <div class="p-8">
    <Alert title={args.title} type={args.type} variant={args.variant as any}>
      {#snippet children()}
        <p>
          This is an alert message. Pass `type` to pick the semantic color + icon,
          or set `variant` directly for the full palette.
        </p>
      {/snippet}
    </Alert>
  </div>
{/snippet}

<Story name="Info" args={{ type: "info" }} {template} />
<Story name="Warning" args={{ type: "warning" }} {template} />
<Story name="Success" args={{ type: "success" }} {template} />
<Story name="Error" args={{ type: "error" }} {template} />
<Story name="Secondary" args={{ variant: "secondary" }} {template} />

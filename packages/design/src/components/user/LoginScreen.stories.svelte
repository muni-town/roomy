<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import LoginScreen from "./LoginScreen.svelte";

  const { Story } = defineMeta({
    title: "User/LoginScreen",
    component: LoginScreen,
  });
</script>

{#snippet template(args: { error?: string | null })}
  <div class="flex items-center justify-center min-h-screen w-full p-4 bg-base-50 dark:bg-base-950">
    <LoginScreen
      handle="alice@example.com"
      password="hunter2"
      tab="Login"
      loading={false}
      error={(args as any).error ?? null}
      handleSuffix="@example.com"
      onLogin={() => {}}
      onRegister={() => {}}
    />
  </div>
{/snippet}

<Story
  name="Default"
  args={{ error: null }}
  {template}
  parameters={{ layout: "fullscreen" }}
/>

<Story
  name="Error"
  args={{ error: "Invalid handle" }}
  {template}
  parameters={{ layout: "fullscreen" }}
/>

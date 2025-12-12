<script lang="ts">
  import { Alert } from "@fuxui/base";

  let { message } = $props<{ message: string }>();
</script>

<div class="w-full h-screen flex items-center justify-center">
  <Alert
    title="Error"
    type="error"
    class="max-w-sm text-ellipsis overflow-x-clip"
  >
    <h6 class="mb-2 max-w-full text-ellipsis overflow-hidden">{message}</h6>
    <span
      >You can let us know on <a
        href="https://github.com/muni-town/roomy/issues/new"
        class="text-accent-600 dark:text-accent-200">Github</a
      >,
      <a
        href="https://discord.gg/bGMESxp7ff"
        class="text-accent-600 dark:text-accent-200">Discord</a
      >
      or
      <a
        href="https://bsky.app/profile/roomy.space"
        class="text-accent-600 dark:text-accent-200">Bluesky</a
      ></span
    >
  </Alert>
</div>

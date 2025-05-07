<script lang="ts">
  import "../app.css";
  import { Button } from "bits-ui";
  import { goto } from "$app/navigation";
</script>

<div class="dz-hero bg-base-200 min-h-screen">
  <div class="dz-hero-content">
    <div class="flex flex-col gap-8 items-center">
      <h1 class="text-5xl font-bold text-center">Something went wrong</h1>
      <p class="text-lg font-medium max-w-2xl text-center">
        The page you are looking for could not be found.
      </p>
      <div class="divider">
        <Button.Root
          class="dz-btn dz-btn-primary"
          onclick={() => goto("/home")}
        >
          Go back Home
        </Button.Root>
      </div>
    </div>
  </div>
</div>

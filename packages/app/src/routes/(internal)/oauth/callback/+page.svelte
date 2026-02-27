<script lang="ts">
  import { goto } from "$app/navigation";
  import { peer } from "$lib/workers";
  import { Alert } from "$lib/components/ui/alert";
  import Button from "$lib/components/ui/button/Button.svelte";
  import { trace, context, SpanStatusCode } from "@opentelemetry/api";
  import { onMount } from "svelte";
  import { IconLoading } from "@roomy/design/icons";

  let error = $state("");

  onMount(async () => {
    tracer.startActiveSpan(
      "OAuth Callback",
      {},
      trace.setSpan(context.active(), globalInitSpan),
      (span) => {
        const searchParams = new URL(globalThis.location.href).searchParams;

        peer
          .initializePeer(searchParams.toString())
          .then(({ did }) => {
            span.setAttribute("userDid", did || "");
            span.setStatus({ code: SpanStatusCode.OK });
            span.end();

            localStorage.setItem("just-logged-in", "1");
            goto(localStorage.getItem("redirect-after-login") || "/home");
          })
          .catch((e) => {
            error = e.toString();
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: e.toString(),
            });
            span.end();
          });
      },
    );
  });
</script>

<div
  class="flex h-screen w-screen justify-center items-center fixed top-0 left-0 bg-base-50 dark:bg-base-950 z-50"
>
  {#if error}
    <Alert class="text-lg w-auto flex flex-col items-center gap-2">
      <p class="text-base-900 dark:text-base-100">
        Error logging in: {error}.
      </p>
      <Button href="/">Go Home</Button>
    </Alert>
  {:else}
    <IconLoading font-size="8em" class="animate-spin text-primary" />
  {/if}
</div>

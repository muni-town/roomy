<script lang="ts">
  import { goto } from "$app/navigation";
  import { backend } from "$lib/workers";
  import { trace, context, SpanStatusCode } from "@opentelemetry/api";
  import { onMount } from "svelte";

  let error = $state("");

  onMount(async () => {
    tracer.startActiveSpan(
      "OAuth Callback",
      {},
      trace.setSpan(context.active(), globalInitSpan),
      (span) => {
        const searchParams = new URL(globalThis.location.href).searchParams;

        backend
          .oauthCallback(searchParams.toString())
          .then(({ did }) => {
            span.setAttribute("userDid", did);
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

{#if error}
  <p class="text-base-900 dark:text-base-100">
    Error logging in: {error}.
  </p>
  <p class="text-base-900 dark:text-base-100">
    <a href="/">Go Home</a>
  </p>
{/if}

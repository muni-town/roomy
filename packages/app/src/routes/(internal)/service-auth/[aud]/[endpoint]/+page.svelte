<script lang="ts">
  import { page } from "$app/state";
  import { user } from "$lib/user.svelte";
  import { onMount } from "svelte";

  let token = $state(new Promise(() => {})) as Promise<string>;

  onMount(() => {
    user.init();
  });

  $effect(() => {
    user.agent;
    if (!user.agent) return;
    token = (async () => {
      if (!user.agent) return "no user";
      const resp = await user.agent.com.atproto.server.getServiceAuth({
        aud: page.params.aud!,
        lxm: page.params.endpoint,
      });
      console.log(resp);

      return resp?.data.token || "error";
    })();
  });
</script>

<div class="flex items-center justify-center h-screen">
  <div class="text-2xl">
    <table>
      <tbody>
        <tr>
          <td class="pr-5">Audience:</td>
          <td>{page.params.aud}</td>
        </tr>
        <tr>
          <td class="pr-5">Endpoint:</td>
          <td>{page.params.endpoint}</td>
        </tr>
        <tr>
          <td>Token:</td>
          <td>

            {#await token}
              Loading...
            {:then t}
            <pre class="max-w-[20em] overflow-x-auto">{t}</pre>
            {/await}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</div>

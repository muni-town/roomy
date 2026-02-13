<!-- Clone of fox UI login form without being a modal: https://github.com/flo-bit/ui-kit/tree/main/packages/social/src/lib/components/bluesky-login -->
<script lang="ts">
  import { env } from "$env/dynamic/public";
  import { peer } from "$lib/workers";

  import {
    Button,
    Subheading,
    Label,
    Input,
    Avatar,
    Box,
    Tabs,
    toast,
  } from "@fuxui/base";
  import { Handle } from "@roomy/sdk";
  import { onMount } from "svelte";

  const tabs = ["Login", "Register"] as const;
  let tab = $state(tabs[0]) as (typeof tabs)[number];

  let handle = $state("");
  let error: string | null = $state(null);
  let loading = $state(false);

  let { ...props } = $props();

  async function login(evt: Event) {
    evt.preventDefault();

    if (loading) return;

    localStorage.setItem("redirect-after-login", window.location.href);

    loading = true;
    error = null;

    let cleanHandle = handle.trim().replace("@", "");

    try {
      const redirect = await peer.login(Handle.assert(cleanHandle));

      console.log("redirect", redirect);

      window.location.href = redirect;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  let input: HTMLInputElement | null = $state(null);

  let lastLogin: { handle: string; did: string; avatar: string } | undefined =
    $state(undefined);

  async function xrpcFetch<T>(
    xrpc: string,
    opts?: { query?: { [key: string]: string }; body?: any; admin?: boolean },
  ): Promise<T> {
    if (!env.PUBLIC_PDS) throw new Error("No public PDS defined");

    const url = new URL(env.PUBLIC_PDS);
    url.pathname = `/xrpc/${xrpc}`;
    if (opts?.query) {
      for (const [key, value] of Object.values(opts.query)) {
        if (key && value) url.searchParams.set(key, value);
      }
    }
    const resp = await fetch(url, {
      headers: [["content-type", "application/json"]],
      method: opts?.body ? "post" : "get",
      body: opts?.body ? JSON.stringify(opts.body) : undefined,
    });
    if (!resp.ok) throw await resp.text();

    return await resp.json();
  }

  let password = $state("");
  let email = $state("");
  async function createAccountWithInviteCode() {
    try {
      const { did } = await xrpcFetch<{
        accessJwt: string;
        refreshJwt: string;
        handle: string;
        did: string;
        didDoc?: unknown;
      }>(`com.atproto.server.createAccount`, {
        body: {
          email,
          inviteCode: env.PUBLIC_PDS_INVITE_CODE,
          handle: `${handle}${env.PUBLIC_PDS_HANDLE_SUFFIX}`,
          password,
        },
      });
      console.log("Created account", did);
      toast.success(`Created account, you may now login.`);
      tab = "Login";
      handle = `${handle}${env.PUBLIC_PDS_HANDLE_SUFFIX}`;
    } catch (e) {
      console.error(e);
      toast.error(`Error creating account: ${e}`);
    }
  }

  onMount(() => {
    lastLogin = JSON.parse(localStorage.getItem("last-login") || "null");
  });
</script>

<Box {...props}>
  <div class="flex justify-center mb-3">
    <Tabs
      items={tabs.map((x) => ({ name: x, onclick: () => (tab = x) }))}
      active={tab}
    />
  </div>

  {#if tab == "Login"}
    <form onsubmit={login} class="flex flex-col gap-2 items-center">
      <Subheading
        class="mb-1 items-center gap-2 text-xl font-bold text-center max-w-80"
      >
        Login with your Atmosphere account</Subheading
      >

      {#if lastLogin?.handle}
        <Label for="atproto-handle" class="mt-4 text-sm w-full"
          >Recent login:</Label
        >
        <Button
          class="overflow-x-hidden justify-start truncate self-stretch w-full"
          variant="primary"
          onclick={(evt) => {
            handle = lastLogin?.handle ?? "";
            login(evt);
          }}
          disabled={loading}
        >
          <Avatar src={lastLogin.avatar} class="size-6" />

          <div
            class="text-accent-600 dark:text-accent-400 text-md max-w-full truncate overflow-x-hidden font-semibold"
          >
            <p>{loading ? "Loading..." : lastLogin.handle}</p>
          </div>
        </Button>
      {/if}

      <div class="mt-4 w-full">
        <Label for="atproto-handle" class="text-sm flex justify-between"
          ><span>Your handle</span>
          <div class="inline-flex gap-1">
            <svg
              version="1.1"
              id="svg1"
              class="size-4 text-base-500 dark:text-base-500 hover:text-black hover:dark:text-white"
              viewBox="0 0 25 25"
              xmlns="http://www.w3.org/2000/svg"
            >
              <g id="g1" transform="translate(-0.42924038,-0.87777209)">
                <path
                  class="dolly"
                  fill="currentColor"
                  style="stroke-width:0.111183;"
                  d="m 16.775491,24.987061 c -0.78517,-0.0064 -1.384202,-0.234614 -2.033994,-0.631295 -0.931792,-0.490188 -1.643475,-1.31368 -2.152014,-2.221647 C 11.781409,23.136647 10.701392,23.744942 9.4922931,24.0886 8.9774725,24.238111 8.0757679,24.389777 6.5811304,23.84827 4.4270703,23.124679 2.8580086,20.883331 3.0363279,18.599583 3.0037061,17.652919 3.3488675,16.723769 3.8381157,15.925061 2.5329485,15.224503 1.4686756,14.048584 1.0611184,12.606459 0.81344502,11.816973 0.82385989,10.966486 0.91519098,10.154906 1.2422711,8.2387903 2.6795811,6.5725716 4.5299585,5.9732484 5.2685364,4.290122 6.8802592,3.0349975 8.706276,2.7794663 c 1.2124148,-0.1688264 2.46744,0.084987 3.52811,0.7011837 1.545426,-1.7139736 4.237779,-2.2205077 6.293579,-1.1676231 1.568222,0.7488935 2.689625,2.3113526 2.961888,4.0151464 1.492195,0.5977882 2.749007,1.8168898 3.242225,3.3644951 0.329805,0.9581836 0.340709,2.0135956 0.127128,2.9974286 -0.381606,1.535184 -1.465322,2.842146 -2.868035,3.556463 0.0034,0.273204 0.901506,2.243045 0.751284,3.729647 -0.03281,1.858525 -1.211631,3.619894 -2.846433,4.475452 -0.953967,0.556812 -2.084452,0.546309 -3.120531,0.535398 z m -4.470079,-5.349839 c 1.322246,-0.147248 2.189053,-1.300106 2.862307,-2.338363 0.318287,-0.472954 0.561404,-1.002348 0.803,-1.505815 0.313265,0.287151 0.578698,0.828085 1.074141,0.956909 0.521892,0.162542 1.133743,0.03052 1.45325,-0.443554 0.611414,-1.140449 0.31004,-2.516537 -0.04602,-3.698347 C 18.232844,11.92927 17.945151,11.232927 17.397785,10.751793 17.514522,9.9283111 17.026575,9.0919791 16.332883,8.6609491 15.741721,9.1323278 14.842258,9.1294949 14.271975,8.6252369 13.178927,9.7400102 12.177239,9.7029996 11.209704,8.8195135 10.992255,8.6209543 10.577326,10.031484 9.1211947,9.2324497 8.2846288,9.9333947 7.6359672,10.607693 7.0611981,11.578553 6.5026891,12.62523 5.9177873,13.554793 5.867393,14.69141 c -0.024234,0.66432 0.4948601,1.360337 1.1982269,1.306329 0.702996,0.06277 1.1815208,-0.629091 1.7138087,-0.916491 0.079382,0.927141 0.1688108,1.923227 0.4821259,2.828358 0.3596254,1.171275 1.6262605,1.915695 2.8251855,1.745211 0.08481,-0.0066 0.218672,-0.01769 0.218672,-0.0176 z m 0.686342,-3.497495 c -0.643126,-0.394168 -0.33365,-1.249599 -0.359402,-1.870938 0.064,-0.749774 0.115321,-1.538054 0.452402,-2.221125 0.356724,-0.487008 1.226721,-0.299139 1.265134,0.325689 -0.02558,0.628509 -0.314101,1.25416 -0.279646,1.9057 -0.07482,0.544043 0.05418,1.155133 -0.186476,1.652391 -0.197455,0.275121 -0.599638,0.355105 -0.892012,0.208283 z m -2.808766,-0.358124 c -0.605767,-0.328664 -0.4133176,-1.155655 -0.5083256,-1.73063 0.078762,-0.66567 0.013203,-1.510085 0.5705316,-1.976886 0.545037,-0.380109 1.286917,0.270803 1.029164,0.868384 -0.274913,0.755214 -0.09475,1.580345 -0.08893,2.34609 -0.104009,0.451702 -0.587146,0.691508 -1.002445,0.493042 z"
                  id="path4"
                ></path>
              </g>
            </svg>
            <svg
              fill="none"
              viewBox="0 0 285 243"
              width="32"
              class={[
                "text-base-500 dark:text-base-500 hover:text-[#070C0C] hover:dark:text-white size-4",
              ]}
              ><g clip-path="url(#clip0_1011_989)"
                ><path
                  d="M148.846 144.562C148.846 159.75 161.158 172.062 176.346 172.062H207.012V185.865H176.346C161.158 185.865 148.846 198.177 148.846 213.365V243.045H136.029V213.365C136.029 198.177 123.717 185.865 108.529 185.865H77.8633V172.062H108.529C123.717 172.062 136.029 159.75 136.029 144.562V113.896H148.846V144.562Z"
                  fill="currentColor"
                ></path><path
                  d="M170.946 31.8766C160.207 42.616 160.207 60.0281 170.946 70.7675L192.631 92.4516L182.871 102.212L161.186 80.5275C150.447 69.7881 133.035 69.7881 122.296 80.5275L101.309 101.514L92.2456 92.4509L113.232 71.4642C123.972 60.7248 123.972 43.3128 113.232 32.5733L91.5488 10.8899L101.309 1.12988L122.993 22.814C133.732 33.5533 151.144 33.5534 161.884 22.814L183.568 1.12988L192.631 10.1925L170.946 31.8766Z"
                  fill="currentColor"
                ></path><path
                  d="M79.0525 75.3259C75.1216 89.9962 83.8276 105.076 98.498 109.006L128.119 116.943L124.547 130.275L94.9267 122.338C80.2564 118.407 65.1772 127.113 61.2463 141.784L53.5643 170.453L41.1837 167.136L48.8654 138.467C52.7963 123.797 44.0902 108.718 29.4199 104.787L-0.201172 96.8497L3.37124 83.5173L32.9923 91.4542C47.6626 95.3851 62.7419 86.679 66.6728 72.0088L74.6098 42.3877L86.9895 45.7048L79.0525 75.3259Z"
                  fill="currentColor"
                ></path><path
                  d="M218.413 71.4229C222.344 86.093 237.423 94.7992 252.094 90.8683L281.715 82.9313L285.287 96.2628L255.666 104.2C240.995 108.131 232.29 123.21 236.22 137.88L243.902 166.55L231.522 169.867L223.841 141.198C219.91 126.528 204.831 117.822 190.16 121.753L160.539 129.69L156.967 116.357L186.588 108.42C201.258 104.49 209.964 89.4103 206.033 74.74L198.096 45.1189L210.476 41.8018L218.413 71.4229Z"
                  fill="currentColor"
                ></path></g
              ><defs
                ><clipPath id="clip0_1011_989"
                  ><rect width="285" height="243" fill="currentColor"
                  ></rect></clipPath
                ></defs
              ></svg
            >
            <svg
              fill="currentColor"
              xmlns="http://www.w3.org/2000/svg"
              viewBox="-40 -40 680 620"
              version="1.1"
              class={[
                "text-base-500 dark:text-base-500 hover:text-[rgb(0,106,255)] size-4",
              ]}
              aria-hidden="true"
            >
              <path
                d="m135.72 44.03c66.496 49.921 138.02 151.14 164.28 205.46 26.262-54.316 97.782-155.54 164.28-205.46 47.98-36.021 125.72-63.892 125.72 24.795 0 17.712-10.155 148.79-16.111 170.07-20.703 73.984-96.144 92.854-163.25 81.433 117.3 19.964 147.14 86.092 82.697 152.22-122.39 125.59-175.91-31.511-189.63-71.766-2.514-7.3797-3.6904-10.832-3.7077-7.8964-0.0174-2.9357-1.1937 0.51669-3.7077 7.8964-13.714 40.255-67.233 197.36-189.63 71.766-64.444-66.128-34.605-132.26 82.697-152.22-67.108 11.421-142.55-7.4491-163.25-81.433-5.9562-21.282-16.111-152.36-16.111-170.07 0-88.687 77.742-60.816 125.72-24.795z"
              />
            </svg>
          </div></Label
        >
        <div class="mt-2">
          <Input
            bind:ref={input}
            type="text"
            name="atproto-handle"
            id="atproto-handle"
            placeholder="yourname.bsky.social"
            class="w-full"
            bind:value={handle}
          />
        </div>
      </div>

      {#if error}
        <p class="text-accent-500 mt-2 text-sm font-medium">{error}</p>
      {/if}

      <Button
        type="submit"
        class="mt-2 ml-auto w-full md:w-auto"
        disabled={loading}>{loading ? "Loading..." : "Login"}</Button
      >
    </form>
  {:else if tab == "Register"}
    <Subheading
      class="mb-3 inline-flex items-center gap-2 text-xl font-bold text-center"
    >
      Register for a Roomy Account
    </Subheading>
    <form class="flex flex-col gap-2" onsubmit={createAccountWithInviteCode}>
      <Label for="atproto-reg-handle" class="text-sm flex justify-between"
        ><span>Your handle</span></Label
      >
      <div class="flex items-center relative h-9">
        <Input
          class="shrink grow min-w-0 flex justify-between absolute inset-0"
          type="username"
          bind:value={handle}
          id="atproto-reg-handle"
          placeholder="yourname"
        ></Input>
        <span class="absolute right-4 opacity-80"
          >{env.PUBLIC_PDS_HANDLE_SUFFIX}</span
        >
      </div>
      <Label for="atproto-reg-password" class="text-sm flex justify-between"
        ><span>Password</span></Label
      >
      <Input
        type="password"
        bind:value={password}
        placeholder="Password"
        id="atproto-reg-password"
      />
      <Label for="atproto-reg-email" class="text-sm flex justify-between"
        ><span>Email</span></Label
      >
      <Input
        type="email"
        bind:value={email}
        placeholder="Email"
        id="atproto-reg-email"
      />
      <Button type="submit" class="mt-3">Register Account</Button>
    </form>
  {/if}
</Box>

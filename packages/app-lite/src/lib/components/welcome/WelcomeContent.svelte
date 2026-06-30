<script lang="ts">
  import FeatureDemoCards from "./FeatureDemoCards.svelte";
  import SpaceCards from "./SpaceCards.svelte";
  import WelcomeActions from "./WelcomeActions.svelte";
  import DiscoverSpacesSection from "./DiscoverSpacesSection.svelte";
  import { auth } from "$lib/auth.svelte";

  let {
    spaces = [],
    returning = false,
  }: {
    /** Spaces the user has joined. When non-empty, space cards are shown
     *  instead of the feature demo cards. */
    spaces?: { id: string; name?: string; avatar?: string }[];
    /** Whether the user is in any spaces (a returning user). */
    returning?: boolean;
  } = $props();

  // AT Protocol profile display name, if available.
  const displayName = $derived(auth.profile?.displayName);
  const heading = $derived(
    returning && displayName ? `Hey ${displayName}` : "Welcome to Roomy",
  );
</script>

<div class="flex flex-col items-center gap-6 pt-4 pb-12 w-full">
  <div class="flex items-start gap-6 px-4 max-w-2xl mx-auto w-full welcome-header">
    <!-- Light mode: original blob logo with dark base outline and light inner gradient -->
    <svg
      viewBox="0 0 219 204"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      class="size-28 shrink-0 text-base-800 dark:hidden"
    >
      <defs>
        <mask id="welcome-blob-mask-light" style="mask-type:alpha" maskUnits="userSpaceOnUse" x="2" y="2" width="215" height="200">
          <path d="M42.5547 21.9875C71.367 4.72979 111.814 1.8211 149.517 3.35962C170.681 4.22328 185.83 12.4772 196.227 24.9182C206.648 37.3889 212.355 54.141 214.449 72.0618C216.542 89.9757 215.016 108.985 211.041 125.887C207.062 142.805 200.652 157.523 193.047 166.907C162.475 204.631 122.369 201.87 90.3682 198.37C74.4108 196.625 55.3409 193.012 39.1621 182.724C23.0319 172.466 9.69688 155.523 5.2627 126.925C0.895417 98.7579 3.07222 76.8165 9.89062 59.7903C16.7034 42.7783 28.1798 30.5978 42.5547 21.9875Z" fill="black" stroke="black" stroke-width="2" stroke-linecap="round"/>
        </mask>
        <radialGradient id="welcome-blob-gradient-light" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(129.5 44.0002) rotate(105.063) scale(196.243 150.914)">
          <stop stop-color="#ffffff"/>
          <stop offset="1" stop-color="#FCF4C3"/>
        </radialGradient>
      </defs>
      <path d="M41.5264 20.2719C70.8782 2.69085 111.846 -0.179833 149.599 1.36072C171.302 2.2464 186.987 10.7431 197.762 23.6361C208.511 36.4995 214.313 53.6652 216.436 71.8295C218.559 90.0008 217.01 109.245 212.988 126.345C208.97 143.43 202.463 158.464 194.601 168.166C163.3 206.789 122.15 203.858 90.1514 200.358C74.109 198.603 54.6639 194.952 38.0889 184.411C21.465 173.84 7.80712 156.39 3.28613 127.232C-1.11919 98.8193 1.04586 76.4955 8.0332 59.0472C15.0262 41.585 26.8194 29.081 41.5264 20.2719Z" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <g mask="url(#welcome-blob-mask-light)">
        <path d="M80.2344 52.9739C96.0089 45.1894 114.987 43.0735 130.312 43.5676C143.004 43.977 152.04 51.0739 158.392 62.009C164.732 72.9249 168.426 87.7048 170.472 103.618C174.565 135.453 172.084 172.028 170.787 191.813L170.772 192.04L170.591 192.178C162.894 198.027 154.869 202.038 146.733 204.714L146.058 204.936L146.078 204.224C146.564 187.449 148.795 154.125 145.734 123.872C144.204 108.746 141.354 94.4302 136.325 83.3577C131.298 72.29 124.134 64.5403 114.004 62.3674C91.5135 58.4535 77.0778 62.0439 68.0332 70.2913C58.9714 78.5545 55.1946 91.6033 54.291 106.894C53.388 122.174 55.3592 139.588 57.6904 156.476C60.0183 173.339 62.7086 189.696 63.2148 202.782L63.2412 203.461L62.5859 203.285C60.9811 202.855 59.3727 202.387 57.7646 201.881L57.4443 201.781L57.416 201.447C56.0248 185.04 53.0942 167.291 50.9668 149.35C48.8426 131.435 47.5274 113.373 49.3945 96.4602C51.8453 74.2614 64.4355 60.7704 80.2344 52.9739Z" fill="url(#welcome-blob-gradient-light)"/>
        <path d="M122.13 121.827C125.884 119.406 130.094 120.267 132.931 122.943C135.766 125.617 137.246 130.103 135.662 134.981C135.104 136.701 134.262 137.955 133.216 138.787C132.167 139.621 130.943 140.005 129.668 140.036C127.139 140.098 124.404 138.775 122.247 136.822C120.087 134.865 118.425 132.199 118.119 129.464C117.809 126.685 118.909 123.905 122.13 121.827Z" fill="url(#welcome-blob-gradient-light)"/>
      </g>
    </svg>

    <!-- Dark mode: animated glow effect -->
    <div class="relative hidden dark:block shrink-0" style="width: min(24vw, 5rem); aspect-ratio: 124 / 161;">
      <!-- Glow layer -->
      <svg
        class="absolute inset-0 w-full h-full"
        style="filter: blur(20px); animation: hero-glow-pulse 4s ease-in-out infinite; z-index: -1; overflow: visible;"
        viewBox="0 0 124 161" aria-hidden="true"
      >
        <path d="M0.89114 52.5148C5.74879 8.5145 50.7373 -0.91772 81.2964 0.0675208C131.191 1.67688 123.884 108.194 121.289 147.779C113.639 153.593 105.664 157.579 97.5777 160.238C98.5486 126.744 106.51 26.7415 65.0982 17.8761C-25.1882 2.15781 11.6956 106.588 13.7154 158.802C12.1171 158.374 10.5156 157.909 8.91458 157.404C6.13105 124.579 -2.83023 86.2244 0.89114 52.5148Z" fill="oklch(0.828 0.119 74.5 / 0.7)"/>
        <path d="M86.187 90.826C89.2356 81.4371 80.4693 73.6875 73.4013 78.2469C61.1191 86.1699 81.9066 104.008 86.187 90.826Z" fill="oklch(0.828 0.119 74.5 / 0.7)"/>
      </svg>
      <!-- Logo with radial gradient fill, masked by external SVG -->
      <div
        class="w-full h-full"
        style="background: radial-gradient(ellipse 200% 100% at 40% 50%, white 0%, oklch(0.828 0.119 74.5) 100%); mask: url(/roomy-logo.svg); -webkit-mask: url(/roomy-logo.svg); mask-size: contain; -webkit-mask-size: contain; mask-repeat: no-repeat; -webkit-mask-repeat: no-repeat; mask-position: center; -webkit-mask-position: center;"
      ></div>
    </div>

    <div class="text-left">
      <h1 class="text-4xl font-black tracking-tight text-base-900 dark:text-base-50 mt-4">
        {heading}
      </h1>
      <p class="text-lg text-base-600 dark:text-base-400 max-w-xs leading-relaxed mt-2">
        {#if returning}
          Welcome back ☺️
        {:else}
          A digital gardening platform for communities. Create Spaces to
          curate knowledge, share conversations, and grow together.
        {/if}
      </p>
    </div>
  </div>

  {#if spaces.length > 0}
    <div class="mt-10 flex flex-col items-center w-full">
      <SpaceCards {spaces} />
    </div>
  {:else}
    <div class="mt-10 flex flex-col items-center w-full">
      <FeatureDemoCards />
    </div>
  {/if}

  <DiscoverSpacesSection />

  <div class="px-4 max-w-2xl mx-auto w-full welcome-actions">
    <WelcomeActions />
  </div>
</div>

<style>
  @keyframes hero-glow-pulse {
    0%, 100% {
      opacity: 0.5;
      transform: scale(1);
    }
    50% {
      opacity: 0.8;
      transform: scale(1.08);
    }
  }

  @media (min-width: 930px) {
    .welcome-header,
    .welcome-actions {
      max-width: none;
      display: flex;
      justify-content: center;
    }

    .welcome-header {
      align-items: flex-start;
    }
  }
</style>
<script lang="ts">
  import { page } from "$app/state";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import PricingTiers from "@roomy/design/components/marketing/PricingTiers.svelte";
  import { IconCheck, IconAlertCircle, IconArrowRight } from "@roomy/design/icons";
  import { createMembershipStatusQuery } from "$lib/queries/membership-status";
  import { createFeatureFlagsQuery } from "$lib/queries/feature-flags";

  // The SDK lexicon doesn't type space.roomy.user.getMembershipStatus yet, so
  // px().query returns a union — narrow the shape we render here.
  type MembershipStatus = {
    isPro: boolean;
    capacity: number;
    stale: boolean;
    checkedAt: number;
  };

  function isMembershipStatus(value: unknown): value is MembershipStatus {
    return (
      typeof value === "object" &&
      value !== null &&
      "isPro" in value &&
      "capacity" in value &&
      "stale" in value
    );
  }

  // Polar checkout URL for Roomy Pro (billed via polar.sh).
  const CHECKOUT_URL = "https://buy.polar.sh/polar_cl_lsCqRe7pBprn4yTCjKcdJ8ShjMQGnEXPoUPoG3xUIPl";

  // The pro-subscription flag gates this page (direct navigation lands
  // here even when the sidebar tab is hidden).
  const flagsQuery = createFeatureFlagsQuery();
  const proEnabled = $derived(
    flagsQuery.data?.flags.includes("pro-subscription") ?? false,
  );

  // After a successful checkout Polar redirects back to this page with
  // ?checkout={CHECKOUT_ID}. Passing it to the status query forces a
  // non-cached Polar refresh so the new membership shows immediately.
  // Read once at mount: the param is fixed by the redirect and never
  // changes while this page is mounted.
  const checkoutId = $state(page.url.searchParams.get("checkout") ?? undefined);
  const statusQuery = createMembershipStatusQuery(() => checkoutId);

  const status = $derived(
    isMembershipStatus(statusQuery.data) ? statusQuery.data : undefined,
  );

  // Highlight the tier the user is on: Pro members see Pro selected,
  // everyone else sees Free.
  const activeTier = $derived(status?.isPro ? "Pro" : "Free");

  // Tier cards tailored to this page: no "Open Roomy" CTA on Free (the user
  // is already in the app), Pro links straight to checkout, and Custom
  // frames the over-1000 case as negotiable.
  const tiers = [
    {
      name: "Free",
      features: [
        [{ text: "All standard Roomy features" }],
        [{ text: "Bridge Discord guild up to " }, { text: "50 members", bold: true }],
        [{ text: "Community support" }],
      ],
    },
    {
      name: "Pro",
      cta: { label: "Subscribe", href: CHECKOUT_URL },
      features: [
        [
          { text: "Bridge " },
          { text: "one Discord guild", bold: true },
          { text: " up to " },
          { text: "1000 members", bold: true },
        ],
        [
          { text: "Access to " },
          { text: "members area", bold: true },
          { text: " with chat-based staff support" },
        ],
        [{ text: "Help us survive as an open source community chat app!" }],
      ],
      price: { old: "$60", current: "$30", per: "/month", badge: "Introductory pricing" },
    },
    {
      name: "Custom",
      features: [
        [{ text: "Bridge Discord guilds with up to " }, { text: "100k or more members", bold: true }],
        [{ text: "Priority support", bold: true }, { text: " with migration, uptime" }],
        [{ text: "Bespoke features and integrations" }],
      ],
      cta: { label: "Talk to us", href: "mailto:hello@roomy.space" },
    },
  ];

  const faqs: { q: string; a: string }[] = [
    {
      q: "What does the Free tier include?",
      a: "All standard Roomy features, plus a Discord Bridge for guilds up to 50 members, with community support. The hosted instance is free to use.",
    },
    {
      q: "What does Roomy Pro include?",
      a: "Pro lets you bridge one Discord guild of up to 1000 members, unlocks the members area with chat-based staff support, and helps us survive as an open source community chat app. It's $30/month at introductory pricing.",
    },
    {
      q: "What if my community is bigger than 1000 members?",
      a: "We can negotiate a price that works for you and be responsive to your needs — talk to us at hello@roomy.space.",
    },
    {
      q: "How is Roomy Pro billed?",
      a: "Subscriptions are billed through Polar (polar.sh). After checkout, your membership status on this page updates automatically.",
    },
    {
      q: "Is Roomy open source?",
      a: "Yes — Roomy is open source and the hosted instance is free to use. You can find the code on GitHub (github.com/muni-town/roomy).",
    },
  ];
</script>

<div class="flex flex-col gap-12">
  {#if !proEnabled}
    <div class="flex flex-col items-center gap-4 py-12">
      <p class="text-sm text-base-500 dark:text-base-400">
        Roomy Pro is not enabled for your account yet.
      </p>
    </div>
  {:else}
    {#if checkoutId}
      <div
        class="flex items-start gap-2 rounded-lg border border-green-600/30 bg-green-50 dark:bg-green-950/30 px-3 py-2.5"
      >
        <IconCheck class="size-4 shrink-0 mt-0.5 text-green-700 dark:text-green-400" />
        <p class="text-sm text-green-800 dark:text-green-300">
          Checkout complete — confirming your subscription…
        </p>
      </div>
    {/if}

    <!-- Hero -->
    <section class="text-center pt-4">
      <h1 class="text-3xl sm:text-4xl font-black tracking-tight text-base-900 dark:text-base-50">
        Your community needs its own space.
      </h1>
      <p class="text-lg text-base-600 dark:text-base-400 max-w-xl mx-auto mt-3 leading-relaxed">
        Roomy is an open platform for cozy communities — no ads, no selling
        your data, no lock in. Bridge your Discord guild and grow together.
      <div class="mt-6 flex flex-col items-center justify-center gap-3">
        {#if status?.isPro}
          <span
            class="inline-flex items-center gap-1.5 rounded-full border border-green-600/30 bg-green-50 dark:bg-green-950/30 px-3 py-1.5 text-sm font-medium text-green-800 dark:text-green-300"
          >
            <IconCheck class="size-4" />
            You're a Roomy Pro member
          </span>
        {:else}
          <Button href={CHECKOUT_URL} variant="cta" size="lg">
            Subscribe to Roomy Pro
            <IconArrowRight class="size-5" />
          </Button>
        {/if}
        {#if status?.stale}
          <p class="text-sm text-base-400 flex items-center gap-1.5">
            <IconAlertCircle class="size-4 shrink-0 text-base-400" />
            We couldn't reach the billing provider just now — showing the
            last known status. Try again in a moment.
          </p>
        {/if}
      </div>
    </section>

    <PricingTiers {activeTier} {tiers} />

    <!-- FAQ -->
    <section aria-labelledby="faq-heading">
      <h2
        id="faq-heading"
        class="text-2xl sm:text-3xl font-bold tracking-tight text-base-900 dark:text-base-50 text-center"
      >
        Frequently asked questions
      </h2>
      <ul class="mt-8 flex flex-col gap-3 max-w-2xl mx-auto w-full">
        {#each faqs as item, i (item.q)}
          <li
            class="rounded-xl border border-base-200 dark:border-base-800 bg-base-50 dark:bg-base-900 overflow-hidden"
          >
            <details open={i === 0}>
              <summary
                class="flex items-center justify-between gap-4 px-5 py-4 text-base font-semibold text-base-900 dark:text-base-100 cursor-pointer list-none [&::-webkit-details-marker]:hidden"
              >
                {item.q}
                <span class="text-base-400 dark:text-base-500 text-xl leading-none" aria-hidden="true">
                  {i === 0 ? "–" : "+"}
                </span>
              </summary>
              <p class="px-5 pb-4 text-sm text-base-600 dark:text-base-400 leading-relaxed">
                {item.a}
              </p>
            </details>
          </li>
        {/each}
      </ul>
    </section>

    <!-- Closing CTA -->
    <section class="text-center pb-4">
      <p class="text-lg text-base-600 dark:text-base-400 max-w-xl mx-auto">
        If you're on Bluesky or the Atmosphere, you already have an account.
      </p>
      <div class="mt-4">
        <Button href={CHECKOUT_URL} variant="cta" size="lg">
          Subscribe to Roomy Pro
          <IconArrowRight class="size-5" />
        </Button>
      </div>
    </section>
  {/if}
</div>

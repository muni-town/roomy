<script lang="ts">
  import Button from "../ui/button/Button.svelte";
  import { IconCheck } from "../../icons/index";

  type FeaturePart = { text: string; bold?: boolean };
  type Tier = {
    name: string;
    features: FeaturePart[][];
    price?: { old: string; current: string; per: string; badge?: string };
    cta?: { label: string; href: string };
  };

  let {
    heading = "A bridge for your community",
    intro = "Roomy is open source and our hosted instance is free to use. We also provide a Discord Bridge with a free tier, and you can subscribe to bridge bigger communities.",
    activeTier = undefined,
    tiers = [
      {
        name: "Free",
        cta: { label: "Open Roomy", href: "https://roomy.space" },
        features: [
          [{ text: "All standard Roomy features" }],
          [{ text: "Bridge Discord guild up to " }, { text: "50 members", bold: true }],
          [{ text: "Community support" }],
        ],
      },
      {
        name: "Pro",
        cta: { label: "Sign Up", href: "https://roomy.space" },
        features: [
          [{ text: "Bridge Discord guild up to " }, { text: "1000 members", bold: true }],
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
          [{ text: "Bridge Discord guilds with " }, { text: "100k+ members", bold: true }],
          [{ text: "Priority support", bold: true }, { text: " with migration, uptime" }],
          [{ text: "Bespoke features and integrations" }],
        ],
        cta: { label: "Talk to us", href: "mailto:hello@roomy.space" },
      },
    ] satisfies Tier[],
  }: {
    heading?: string;
    intro?: string;
    /** Name of the tier to highlight as the user's current plan. */
    activeTier?: string;
    tiers?: Tier[];
  } = $props();

  // Group hover: while a card is hovered it takes over the "selected" look
  // (accent ring) and the active tier's ring is suppressed. The "Your plan"
  // badge stays on the real active tier.
  let hoveredTier = $state<string | null>(null);
</script>

<div class="pricing">
  <h2 class="text-2xl sm:text-3xl font-bold tracking-tight text-base-900 dark:text-base-50 text-center">
    {heading}
  </h2>
  <p class="intro text-base-600 dark:text-base-400 text-center mx-auto mt-3 max-w-xl">
  </p>

  <div class="cards mt-10">
    {#each tiers as tier (tier.name)}
      <article
        class="card"
        class:active={tier.name === activeTier}
        class:hovered={tier.name === hoveredTier}
        onmouseenter={() => (hoveredTier = tier.name)}
        onmouseleave={() => (hoveredTier = null)}
      >
        {#if tier.name === activeTier}
          <span
            class="self-center mb-4 px-3 py-1 rounded-full text-[11px] font-semibold uppercase tracking-wider bg-accent-400/20 text-accent-700 dark:text-accent-300"
          >
            Your plan
          </span>
        {/if}
        <h3 class="text-xl font-bold text-base-900 dark:text-base-50 text-center mb-6">
          {tier.name}
        </h3>
        <ul class="features">
          {#each tier.features as feature (feature)}
            <li class="flex items-start gap-2 text-base-700 dark:text-base-300">
              <IconCheck class="size-4 shrink-0 mt-0.5 text-accent-600 dark:text-accent-400" />
              <span>
                {#each feature as part (part.text)}
                  <span class:bold={part.bold}>{part.text}</span>
                {/each}
              </span>
            </li>
          {/each}
        </ul>
        {#if tier.price}
          <p class="price text-center mt-auto mb-2">
            <del class="text-base-400 dark:text-base-500 mr-2">{tier.price.old}</del>
            <strong class="text-2xl font-bold text-base-900 dark:text-base-50">
              {tier.price.current}
            </strong>
            <span class="text-base-500 dark:text-base-400">{tier.price.per}</span>
          </p>
          {#if tier.price.badge}
            <span class="price-badge">{tier.price.badge}</span>
          {/if}
        {/if}
        {#if tier.cta && tier.name !== activeTier}
          <Button href={tier.cta.href} variant="primary" class="cta no-underline">
            {tier.cta.label}
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M5 12h14" />
              <path d="m12 5 7 7-7 7" />
            </svg>
          </Button>
        {/if}
      </article>
    {/each}
  </div>
</div>

<style>
  .cards {
    display: grid;
    gap: 2rem;
    grid-template-columns: 1fr;
    max-width: 62rem;
    margin-inline: auto;
  }

  @media (width >= 768px) {
    .cards {
      grid-template-columns: repeat(3, 1fr);
      align-items: stretch;
    }
  }

  .card {
    background: var(--color-base-50);
    border: 1px solid var(--color-base-200);
    border-radius: 12px;
    padding: 2rem 1.75rem 2.5rem;
    text-align: center;
    display: flex;
    flex-direction: column;
    /* Shadow-lift: resting slightly lowered, lifting on hover with a hard
       offset shadow underneath. Bigger than the shared `shadow-lift`
       utility (4px vs 2px) so the pricing cards read as more tactile. */
    translate: 0 2px;
    outline: 1px solid transparent;
    transition:
      translate 0.075s ease-in,
      box-shadow 0.075s ease-in,
      border-color 0.15s ease,
      outline-color 0.15s ease;
  }

  .card:hover {
    translate: 0 0;
    box-shadow: 0 4px 0 0 var(--color-base-300);
  }

  :global(.dark) .card:hover {
    box-shadow: 0 4px 0 0 var(--color-base-800);
  }

  :global(.dark) .card {
    background: var(--color-base-900);
    border-color: var(--color-base-800);
  }

  .card.active,
  .card.hovered {
    border-color: var(--color-accent-400);
    outline-color: var(--color-accent-400);
  }

  :global(.dark) .card.active,
  :global(.dark) .card.hovered {
    border-color: var(--color-accent-500);
    outline-color: var(--color-accent-500);
  }

  /* Group hover: hovering any card takes over the selected look. The
     active tier keeps a lighter, lower-contrast accent border so it still
     reads as the user's plan, and its ring fades out. */
  .cards:hover .card.active:not(:hover) {
    border-color: color-mix(in oklab, var(--color-accent-400) 35%, var(--color-base-200));
    outline-color: transparent;
  }

  :global(.dark) .cards:hover .card.active:not(:hover) {
    border-color: color-mix(in oklab, var(--color-accent-500) 35%, var(--color-base-800));
  }

  @media (width >= 768px) {
    .card {
      text-align: left;
    }
  }

  .features {
    list-style: none;
    margin: 0 0 2rem;
    padding: 0;
    display: grid;
    gap: 1rem;
  }

  .features li {
    font-size: 0.9375rem;
    line-height: 1.45;
  }

  .features :global(span.bold) {
    font-weight: 700;
  }

  .card :global(.cta) {
    margin-top: auto;
    align-self: center;
  }
  .price-badge {
    display: block;
    width: fit-content;
    margin: 0 auto 1.5rem;
    padding: 0.25rem 0.75rem;
    border-radius: 9999px;
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    background: color-mix(in oklab, var(--color-accent-400) 15%, transparent);
    color: var(--color-accent-700);
  }

  :global(.dark) .price-badge {
    background: color-mix(in oklab, var(--color-accent-500) 20%, transparent);
    color: var(--color-accent-300);
  }
</style>

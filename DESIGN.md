---
name: Roomy
description: A calm, empowering group messaging app where communities cultivate shared knowledge together
colors:
  surface-warm-light: "oklch(98.5% 0.001 106)"
  surface-warm: "oklch(97% 0.001 106)"
  surface-warm-mid: "oklch(92.8% 0.003 49)"
  border-subtle: "oklch(86.9% 0.005 56)"
  text-muted: "oklch(71.5% 0.011 56)"
  text-secondary: "oklch(47.6% 0.010 62)"
  text-primary: "oklch(26.3% 0.005 13)"
  surface-dark: "oklch(19.3% 0.003 265)"
  surface-darkest: "oklch(13% 0.004 286)"
  accent-wash: "oklch(89.9% 0.061 343)"
  accent-mid: "oklch(71.8% 0.202 350)"
  accent-primary: "oklch(65.6% 0.241 354)"
  accent-deep: "oklch(59.2% 0.249 1)"
typography:
  display:
    fontFamily: "Hanken Grotesk, system-ui, sans-serif"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.025em"
  headline:
    fontFamily: "Hanken Grotesk, system-ui, sans-serif"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.015em"
  body:
    fontFamily: "Hanken Grotesk, system-ui, sans-serif"
    fontWeight: 400
    fontSize: "1rem"
    lineHeight: 1.6
  label:
    fontFamily: "Hanken Grotesk, system-ui, sans-serif"
    fontWeight: 500
    fontSize: "0.875rem"
    lineHeight: 1.4
  caption:
    fontFamily: "Hanken Grotesk, system-ui, sans-serif"
    fontWeight: 400
    fontSize: "0.75rem"
    lineHeight: 1.5
rounded:
  pill: "16px"
  full: "9999px"
spacing:
  xs: "4px"
  sm: "6px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.accent-wash}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.pill}"
    padding: "6px 12px"
  button-secondary:
    backgroundColor: "{colors.surface-warm-mid}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.pill}"
    padding: "6px 12px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.pill}"
    padding: "6px 12px"
  input-primary:
    backgroundColor: "{colors.accent-wash}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.pill}"
    padding: "6px 12px"
  badge-primary:
    backgroundColor: "{colors.accent-wash}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.pill}"
    padding: "2px 8px"
---

# Design System: Roomy

## 1. Overview

**Creative North Star: "The Inhabited Garden"**

Roomy's visual language is built around the feeling of a space that has been tended over time — not the pristine emptiness of a productivity tool, nor the noisy overgrowth of a Discord server, but a room that shows signs of habitation. The design carries warmth without sentimentality: warm stone surfaces, soft frosted-glass components that let the underlying warmth breathe through, and a color accent system that is personal to each community.

Where Discord optimizes for stimulation (red badges, dark chrome, notification anxiety), Roomy optimizes for settledness. The frosted-glass component system — backdrop blur with accent-colored inset glow and shadow — gives the interface a soft physical presence without weight. Nothing demands attention. The accent color adapts to each space, which is the system's most important design statement: this place belongs to the people in it.

Information is layered but navigable. The app holds depth — threads spiral into documents, channels nest into categories, messages grow into pages — but the surface reads calm. The typography and spacing prevent density from tipping into overwhelm. A full screen should feel like a well-stocked library, not a dashboard.

**Key Characteristics:**
- Stone-warm neutrals as the canvas; everything sits on earth, not gray plastic
- Frosted glass components with accent-colored atmospheric halos
- Single swappable accent color per space — identity through theming, not chrome
- `rounded-2xl` (16px) radius throughout — consistent, unhurried pill shape
- Three-speed motion: deliberate default (800ms), responsive hover (300ms), snappy active (100ms)
- Full dark mode with matched warmth — dark surfaces are stone-950, not black

## 2. Colors: The Garden Palette

A restrained two-role palette: warm stone neutrals carry the canvas; a single swappable accent color carries community identity. The neutrals are definitively warm — stone, not gray — which keeps the app from feeling like infrastructure.

### Primary (Accent — space-configurable)

The accent system is the heart of the design. Every space chooses its own accent color, which propagates through all interactive elements, focus rings, unread indicators, and themed components. Pink is the system default.

- **Rosy Bloom** (oklch(65.6% 0.241 354) / pink-500): Focus rings, unread indicator dots, the most saturated accent appearance. Used sparingly — the accent's rarity signals importance.
- **Bloom Mid** (oklch(71.8% 0.202 350) / pink-400): Active/hover text in dark mode; subtle presence without full saturation.
- **Bloom Wash** (oklch(89.9% 0.061 343) / pink-200): Tinted fill for buttons and badges at 50% opacity — the accent's primary surface appearance. Atmospheric rather than saturated.
- **Bloom Deep** (oklch(59.2% 0.249 1) / pink-600): Button and badge text in light mode; readable contrast against the wash.

**The One Accent Rule.** Any given space has one accent color. It appears in button fills, focus rings, unread dots, and themed UI surfaces. It does not appear as a decorative gradient, a text highlight, or a stripe. Its restraint is the point — when the accent fires, something matters.

**The Swappable Garden Rule.** The accent system is a CSS custom property architecture, not a hardcoded palette. When designing for Roomy, always treat accent colors as semantic (`accent-500`, `accent-200/50`) rather than as fixed values like "pink". Components built with hardcoded accent hues are wrong.

### Neutral (Stone Canvas)

The stone scale is the canvas. It reads warmer than gray or slate — there is a faint clay undertone at every lightness level that keeps the UI from feeling cold or corporate.

- **Parchment** (oklch(98.5% 0.001 106) / stone-50): Primary light mode background. Body-level surface.
- **Pale Stone** (oklch(97% 0.001 106) / stone-100): Secondary light surface, login panels.
- **Warm Chalk** (oklch(92.8% 0.003 49) / stone-200): Borders, dividers, button secondary fills at opacity.
- **Dusty Edge** (oklch(86.9% 0.005 56) / stone-300): Subtle borders, hover overlays.
- **Faded Ink** (oklch(71.5% 0.011 56) / stone-400): Placeholder text, disabled text, metadata.
- **Ash Text** (oklch(47.6% 0.010 62) / stone-600): Secondary text, sidebar labels at rest.
- **Dark Peat** (oklch(26.3% 0.005 13) / stone-800): Primary body text in light mode.
- **Night Soil** (oklch(19.3% 0.003 265) / stone-900): Dark mode surface, high-level containers.
- **Deep Root** (oklch(13% 0.004 286) / stone-950): Darkest dark mode background, overlay scrims.

**The No-Black Rule.** Never use `#000` or `#fff`. Even stone-950 has a trace of warmth in it. Tint every neutral toward the brand hue. Pure black makes the app feel like a terminal; pure white makes it feel like a hospital.

## 3. Typography

**Primary Font:** Hanken Grotesk (system-ui, sans-serif fallback)

A humanist grotesque with warm stroke endings and comfortable proportions. It reads well at small sizes without feeling clinical, and at large display sizes it carries enough personality to anchor a header without a separate display face. The single-family stack communicates Roomy's design ethos: unhurried clarity over typographic theater.

**Character:** Reliable, slightly warm, quietly confident. Not the geometric grotesque that signals "tech startup" — Hanken has optical corrections that make long passages less tiring. Display weights use tight tracking to anchor space headings; body is loose enough to breathe.

### Hierarchy

- **Display** (700 weight, tracking-tight, leading-none): Space names, major page titles. Used rarely — when it appears, the weight contrast marks a genuine hierarchy shift.
- **Headline** (600 weight, tracking-tight, leading-snug): Channel names, section headers, modal titles. Medium presence, high legibility.
- **Body** (400 weight, 1rem / 16px, leading-relaxed): Message content, long-form text. Cap at 65–75ch for readable line length in page/document views.
- **Label** (500 weight, 0.875rem / 14px): Button labels, nav items, metadata. The most common weight in the UI — text-sm with medium weight.
- **Caption** (400 weight, 0.75rem / 12px, optional tracking): Timestamps, read receipts, secondary metadata. Light presence.

**The One Family Rule.** Hanken Grotesk handles every role. No separate mono font for code (the app uses a prose code component with CSS styling), no decorative serif for marketing copy inside the app. One family, varied by weight and size.

## 4. Elevation

Roomy uses a frosted glass elevation model rather than traditional drop shadows. Surfaces float through atmospheric color rather than hard casting. Every interactive component is frosted — it has a `backdrop-blur-md` + `backdrop-brightness-105` base, an inset highlight glow, and an outer shadow tinted to the current accent color at 2–5% opacity. The result: components feel physically present without creating visual noise.

Flat surfaces (sidebar backgrounds, message area, page canvas) have no shadow and no blur. Chrome is minimized; content is the surface.

### Shadow Vocabulary

- **Atmospheric Halo** (`shadow-lg` + accent-500/5 color): The outer shadow on buttons, badges, and pills. At 5% opacity, it is barely visible in isolation — its purpose is to lift the element microscopically off the background, not to cast a hard shadow.
- **Inset Glow** (`inset-shadow-sm` + accent-700/5): Inner top highlight that gives glass components a subtle lit-from-above quality. Matches the halo in hue.
- **Active Flatten** (`shadow-md`): Used on `active:` state to compress the atmospheric halo, giving physical feedback that the button was pressed.
- **Popover/Panel** (`shadow-lg` without color tint): Larger layered elements — popovers, modals, floating panels — use a neutral shadow to separate from the page without referencing the accent.

**The Frosted-Not-Glass Rule.** The blur + inset system creates a frosted glass effect, not a "glassmorphism" effect. The distinction: glassmorphism uses blur and tint as decoration on arbitrary surfaces. Frosted glass in Roomy is a systematic state — it marks interactive elements as distinct from passive content. Do not apply backdrop-blur to non-interactive containers.

**The Colored Shadow Rule.** Outer shadows on interactive elements are tinted to the accent at 2–5% opacity, never neutral gray. The halo color reinforces the component's accent membership. On hover, the accent fill increases in opacity — the shadow stays constant.

## 5. Components

### Buttons

Buttons carry the frosted glass treatment most explicitly. They float slightly above the surface, respond with scale micro-animations, and maintain a thin accent border as a secondary signal.

- **Shape:** Pill-like rounded corners (16px / rounded-2xl), consistent across all sizes
- **Primary:** Accent wash fill (accent-200/50 light, accent-950/20 dark), accent border at 15% opacity, accent-tinted outer shadow. Text: accent-950 light / accent-400 dark. Padding: 6px 12px default, 4px 8px small, 8px 16px large.
- **Hover:** Fill increases to accent-200/60 (light) / accent-950/25 (dark). Duration 300ms.
- **Active:** Fill stays, shadow reduces to shadow-md. Scale compresses to 98%. Duration 100ms (snap).
- **Focus:** 2px outline in accent-500 at offset 2.
- **Secondary:** Stone fill (base-300/40 light, base-800/30 dark), stone border, stone shadow. Same shape and motion.
- **Ghost:** Transparent background. Text accent-800 at rest, shifts to accent-600 on hover with a faint accent wash (accent-400/5). Used in sidebar navigation — low visual weight, high information density.
- **Disabled:** 60% opacity, pointer-events none. Scale locked at 100%.

**The Scale-Not-Lift Rule.** Buttons respond to interaction through scale (hover: 101%, active: 98%), not through color saturation increases or lift animations. The compressed active state gives tactile feedback without animation expense. Do not use `translateY` lifts on buttons.

### Badges and Chips

Badges use the identical frosted glass treatment as buttons — same radius, same inset glow, same accent-tinted shadow — but without scale animations. They are semantic labels, not calls to action.

- **Primary badge:** Same accent wash + glass system. Compact padding (2px 8px small, 4px 12px medium).
- **Secondary badge:** Stone fill, stone border. For neutral metadata.
- **Hue-shifted variants:** Roomy supports a `primary_shift` variant that rotates the accent hue by 35° (and `primary_shift_2` by 70°) using CSS `oklch(from var(--color-accent-500) l c calc(h+35))`. This enables harmonic multi-badge UI without introducing a separate secondary color.

### Inputs and Fields

- **Shape:** Pill-like rounded corners (16px), consistent with buttons
- **Style:** Ring-based (not border): `ring-1 ring-inset` at rest, `ring-2` on focus. Ring color at accent-500/30 rest, accent-500 focused.
- **Fill:** Accent-tinted surface (accent-400/5 light, accent-600/5 dark) — the same wash as primary buttons, slightly more transparent.
- **Focus treatment:** Ring scales from 1px to 2px with a 300ms transition. No glow, no outline (the ring IS the focus indicator for a11y). Focus-visible only.
- **Secondary variant:** Stone ring (base-200/base-800 tone), base-100/base-900 fill. For neutral forms outside accent context.
- **Placeholder:** 50% opacity of the text color. Never a separate gray.

### Navigation (Sidebar)

The sidebar is the densest surface in the app. Navigation items use ghost button variants — no background at rest, faint accent wash on hover, accent text + wash on active (current route).

- **Channel items:** `#` icon + channel name left-justified. Unread indicator: 5px dot at position absolute top-left, accent-500 fill. Unread count: small light-weight number right-aligned, 60% opacity.
- **Active state:** `data-[current=true]` triggers accent text (accent-600 light / accent-400 dark) + faint accent fill (accent-500/5). No border, no pill, no sidebar stripe.
- **Space navigation:** The inter-space navigation (spaces list) lives in a narrow far-left rail.

**The No-Sidebar-Stripe Rule.** Active sidebar items are never marked with a colored left-border stripe. This is the most overused pattern in chat/collaboration tools and is explicitly prohibited. Active state uses text color shift and background tint only.

### Unread Indicators

- **Dot:** 5px filled circle in accent-500, absolutely positioned at the top-left of the nav item's button. Visible only when `hasUnread && !isActive`.
- **Count:** Light-weight small number, 60% opacity, right-aligned in the nav item. Not a badge, not a pill — just a number.

### Signature Component: The Space Accent System

Roomy's most distinctive design feature is that each space carries its own CSS custom property accent color, propagated through the entire UI. When a user enters a space, all interactive chrome — buttons, inputs, badges, focus rings, unread dots, highlights — adopts that space's chosen hue while the neutral canvas stays constant.

This is not theming as a cosmetic option. It is the design system's identity system. A community's accent is how it looks from the outside (in the space list) and how it feels from the inside. The frosted glass system makes this work at all opacity levels — the accent wash shows enough color to feel distinctive at 5–15% without overwhelming the neutral content.

## 6. Do's and Don'ts

### Do:

- **Do** use `rounded-2xl` (16px) as the default radius for all interactive elements — buttons, inputs, badges, chips, popovers. Consistency here is load-bearing.
- **Do** treat accent colors semantically (`accent-500`, `accent-200/50`) rather than as fixed values. Every component should work across the full hue range.
- **Do** use stone neutrals, not gray. Stone has warmth; gray reads as infrastructure. When reaching for a neutral, check that it comes from the stone/warm family.
- **Do** keep the frosted glass treatment (backdrop-blur + inset-shadow + accent-tinted outer shadow) reserved for interactive elements. It marks affordance.
- **Do** use the three-speed motion system: 800ms default, 300ms hover, 100ms active. The snap on active state is the most important — it reads as physically responsive.
- **Do** mark active sidebar items with text color shift and faint tinted fill only. No stripe, no border, no left-side bar.
- **Do** scale buttons on interaction (hover: 101%, active: 98%). This is the primary tactile feedback mechanism.
- **Do** use `motion-safe:` conditionals on transform animations. Respect reduced-motion preferences.
- **Do** keep accent presence below 15% saturation on surface fills. The wash (`accent-200/50`) is how accents appear on surfaces — not solid accent fills.
- **Do** let dark mode surfaces use stone-900 / stone-950 (Night Soil / Deep Root). They carry the stone warmth into the dark.

### Don't:

- **Don't** use Discord's patterns: red notification badges engineered for urgency, unread counts that scream, sidebar chrome that competes with content. Roomy is explicitly the opposite of this. Unread indicators are a quiet dot and a light number, not an alarm.
- **Don't** use Slack's visual language: corporate blues, tight-radius pills, dense toolbar rows, feature-announcement visual hierarchy.
- **Don't** use gradient text (`background-clip: text` with a gradient). Ever. The accent system already provides color; gradients are decorative noise.
- **Don't** use left-border stripes greater than 1px as the active-state indicator on sidebar items or list elements. This is the canonical sidebar anti-pattern and it is prohibited.
- **Don't** apply backdrop-blur to passive containers (cards, message bubbles, content sections). The blur system marks interactive affordance. Non-interactive surfaces are flat and warm.
- **Don't** use `#000` or `#fff`. Stone-950 is the darkest available surface; stone-50 is the lightest. Tint every neutral.
- **Don't** use drop shadows in gray (`rgba(0,0,0,x)` or Tailwind's default shadow palette). Shadows on interactive elements are tinted to the accent. Non-interactive shadows should use a warm, very-low-opacity stone shadow.
- **Don't** design for a single accent color. The entire system must work across pink, teal, violet, amber, and every other hue. If a design only looks right in pink, it's wrong.
- **Don't** add notification anxiety patterns: pulsing badges, red indicators, numeric counts on anything that isn't a direct message. Calm density means information is available, not demanding.
- **Don't** use modal dialogs as the first solution. Inline editing, progressive disclosure, and drawer panels are preferred. Modals are a last resort.
- **Don't** use the SaaS dashboard clichés: hero metrics with big numbers, identical card grids with icon + heading + text, gradient text callouts. These make the app look like a product, not a place.

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

Roomy's visual language is built around the feeling of a space that has been tended over time — not the pristine emptiness of a productivity tool, nor the noisy overgrowth of a Discord server, but a room that shows signs of habitation. The design carries warmth without sentimentality: warm stone surfaces, tactile components that sit *on* the page rather than float above it, and a color accent system that is personal to each community.

Where Discord optimizes for stimulation (red badges, dark chrome, notification anxiety), Roomy optimizes for settledness. Interactive elements read as physical: they rest a couple of pixels low and, on hover, rise just enough to reveal a hard offset shadow beneath them — the visual grammar of a key on a keyboard. Nothing demands attention. The accent color adapts to each space, which is the system's most important design statement: this place belongs to the people in it.

Information is layered but navigable. The app holds depth — threads spiral into documents, channels nest into categories, messages grow into pages — but the surface reads calm. The typography and spacing prevent density from tipping into overwhelm. A full screen should feel like a well-stocked library, not a dashboard.

**Key Characteristics:**
- Stone-warm neutrals as the canvas; everything sits on earth, not gray plastic
- Hard-offset element shadows (no blur) on anything tactile; soft shadows and backdrop blur reserved for floating overlays
- Single swappable accent color per space — identity through theming, not chrome
- `rounded-2xl` (16px) radius throughout — consistent, unhurried pill shape
- Snap-fast motion: 75ms for the tactile lift/press, 300ms for colour and fill transitions
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

Roomy has two distinct shadow tiers, and they do not mix.

**Tactile elements are hard.** Buttons, cards, rows and anything else a user presses or hovers rest a couple of pixels below their natural position and rise on interaction to reveal a **hard, un-blurred offset shadow** directly beneath them. The shadow is a flat colour at full opacity with zero blur radius — `2px 2px 0 0` on buttons and inputs, `0 2px 0 0` on the shared `shadow-lift` rows, `0 4px 0 0` at card scale. This is the app's primary spatial metaphor: surfaces sit *on* the page, like keys on a keyboard, they do not float above it. Pressing flattens the element back down and removes the shadow in the same 75ms snap.

**Floating overlays are soft.** Anything genuinely detached from the page flow — popovers, context menus, select menus, tooltips, modals — uses a blurred `shadow-lg` plus `backdrop-blur` to separate itself from the content beneath. Badges and alerts borrow this treatment because they read as detached chips rather than pressable controls. This is the only tier where blur and soft shadow appear, and it always means "this layer sits above the page" — never mere decoration.

Flat surfaces (sidebar backgrounds, message area, page canvas) have neither shadow nor blur. Chrome is minimized; content is the surface.

### Shadow Vocabulary

- **Hard Offset** (`2px 2px 0 0 var(--shadow-button-color)`): the button and input lift shadow. Zero blur, full opacity, tinted to the accent (or the stone scale for neutral controls) through `--shadow-button-color`. Appears on hover; absent at rest and while pressed.
- **Row Lift** (`0 2px 0 0 var(--shadow-button-color)`): the `shadow-lift` utility for sidebar items, tabs and link rows — 2px of hard shadow beneath a row that rests a pixel low.
- **Card Lift** (`0 4px 0 0 var(--shadow-button-color)`): the same idiom at card scale, sized 4px so larger surfaces read as proportionally physical.
- **Overlay Shadow** (`shadow-lg`, neutral or accent-tinted at 2–5%): the soft, blurred shadow on floating overlays and frosted chips. Never used on tactile elements.

**The Hard-Element Rule.** If a user can press, hover or focus it in place, its shadow is hard, offset and un-blurred. Soft shadows and backdrop blur belong to overlays only. A soft, glowing shadow on a button or card is wrong — it makes a tactile object read as if it were floating.

**The Tinted-Not-Grey Rule.** Hard shadows are never black or grey. They take the accent (`--color-accent-700`) via `--shadow-button-color`, or the stone scale (`base-300` light / `base-800` dark) for neutral controls.

## 5. Components

### Buttons

Buttons are tactile: they sit 2px low, carry a thin accent border, and lift on hover to reveal a hard offset shadow beneath them.

- **Shape:** Pill-like rounded corners (16px / rounded-2xl), consistent across all sizes
- **Primary:** Accent fill (accent-300/90 light, accent-600/90 dark), accent border, frosted with `backdrop-blur-md`. Text: accent-950 light / accent-50 dark. Padding: 6px 12px default, 4px 8px small, 8px 16px large.
- **Hover:** Fill brightens and the hard offset shadow appears (`hover:shadow-button`). Duration 75ms (snap).
- **Active:** The button presses down 2px and the shadow disappears (`active:translate-[2px] active:shadow-none`). Duration 100ms.
- **Focus:** 2px outline in accent-500 at offset 2.
- **Secondary / coloured variants:** Stone or hue-specific fill, the same hard-lift motion, and a matching `--shadow-button-color`.
- **Disabled:** 60% opacity, pointer-events none, no lift.

**The Lift-Not-Scale Rule.** Buttons respond to interaction by moving into and out of their shadow — resting 2px low, rising on hover, pressing flat on active — never by scaling or by floating uniformly. The hard offset shadow and the translate move together; that press is what makes the control feel physical. Do not use `scale` micro-animations or soft `translateY` lifts with blurred shadows on buttons.

### Badges and Chips

Badges are frosted chips: they borrow the floating-overlay treatment (soft `shadow-lg`, accent-tinted inset glow, `backdrop-blur`) rather than the hard element shadow, and carry no lift animation. They are semantic labels, not calls to action.

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

This is not theming as a cosmetic option. It is the design system's identity system. A community's accent is how it looks from the outside (in the space list) and how it feels from the inside. The accent wash and `--shadow-button-color` make this work at every level — the wash shows enough color to feel distinctive at 5–15% without overwhelming the neutral content, and even the hard lift shadow carries the space's hue.

## 6. Do's and Don'ts

### Do:

- **Do** use `rounded-2xl` (16px) as the default radius for all interactive elements — buttons, inputs, badges, chips, popovers. Consistency here is load-bearing.
- **Do** treat accent colors semantically (`accent-500`, `accent-200/50`) rather than as fixed values. Every component should work across the full hue range.
- **Do** use stone neutrals, not gray. Stone has warmth; gray reads as infrastructure. When reaching for a neutral, check that it comes from the stone/warm family.
- **Do** keep frosted glass and soft shadows for floating overlays only (popovers, menus, modals, tooltips, badges). Tactile elements — buttons, cards, rows — use hard offset shadows.
- **Do** keep motion snap-fast: 75ms for the tactile lift/press, 300ms for colour and fill changes. The snap on press is the most important — it reads as physically responsive.
- **Do** mark active sidebar items with text color shift and faint tinted fill only. No stripe, no border, no left-side bar.
- **Do** move buttons into and out of their hard offset shadow (rest 2px low, hover to lift, press flat on active) rather than scaling them. That translate is the tactile feedback.
- **Do** use `motion-reduce:` conditionals on transform and shadow animations. Respect reduced-motion preferences.
- **Do** keep accent presence below 15% saturation on surface fills. The wash (`accent-200/50`) is how accents appear on surfaces — not solid accent fills.
- **Do** let dark mode surfaces use stone-900 / stone-950 (Night Soil / Deep Root). They carry the stone warmth into the dark.

### Don't:

- **Don't** use Discord's patterns: red notification badges engineered for urgency, unread counts that scream, sidebar chrome that competes with content. Roomy is explicitly the opposite of this. Unread indicators are a quiet dot and a light number, not an alarm.
- **Don't** use Slack's visual language: corporate blues, tight-radius pills, dense toolbar rows, feature-announcement visual hierarchy.
- **Don't** use gradient text (`background-clip: text` with a gradient). Ever. The accent system already provides color; gradients are decorative noise.
- **Don't** use left-border stripes greater than 1px as the active-state indicator on sidebar items or list elements. This is the canonical sidebar anti-pattern and it is prohibited.
- **Don't** apply backdrop-blur or soft shadows to passive content or tactile elements (cards, message bubbles, buttons). Blur and soft shadow mark the floating-overlay layer.
- **Don't** use `#000` or `#fff`. Stone-950 is the darkest available surface; stone-50 is the lightest. Tint every neutral.
- **Don't** use grey or black shadows (`rgba(0,0,0,x)` or Tailwind's default shadow palette) on tactile elements. Hard shadows are tinted to the accent via `--shadow-button-color`, or to the stone scale for neutral controls.
- **Don't** design for a single accent color. The entire system must work across pink, teal, violet, amber, and every other hue. If a design only looks right in pink, it's wrong.
- **Don't** add notification anxiety patterns: pulsing badges, red indicators, numeric counts on anything that isn't a direct message. Calm density means information is available, not demanding.
- **Don't** use modal dialogs as the first solution. Inline editing, progressive disclosure, and drawer panels are preferred. Modals are a last resort.
- **Don't** use the SaaS dashboard clichés: hero metrics with big numbers, identical card grids with icon + heading + text, gradient text callouts. These make the app look like a product, not a place.

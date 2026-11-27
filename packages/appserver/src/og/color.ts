/**
 * The invite card's colours, tinted to the space.
 *
 * DESIGN.md's Swappable Garden Rule: each space carries its own colour, and
 * Roomy's pink is only the default. The card goes further than the app's
 * accent: canvas, ink and accents are all drawn from the space's avatar
 * (`paletteForAvatar`), keeping the site card's layout and its roles — a pale
 * page, deep ink, a vivid accent, hard shadows — so a card is recognisably
 * Roomy's and recognisably the space's at once. Contrast is enforced after
 * the colours are chosen, never assumed. An avatar with no colour to speak of
 * (grey, black and white, a photo of fog) keeps the site card's palette.
 */

import { clampChroma, converter, formatHex, wcagContrast } from "culori";
import { Jimp } from "jimp";

export interface CardPalette {
  canvas: string;
  ink: string;
  inkSoft: string;
  wordmark: string;
  discShadow: string;
  pill: string;
  pillShadow: string;
}

/** The site card's palette, sampled from `roomy-og.png`. */
export const DEFAULT_PALETTE: CardPalette = {
  canvas: "#fff4e5",
  ink: "#250041",
  inkSoft: "#4a2a66",
  wordmark: "#e60076",
  discShadow: "#fda5d5",
  pill: "#fffaf4",
  pillShadow: "#c6005c",
};

// ─── OKLCH ────────────────────────────────────────────────────────────────

export interface Oklch {
  l: number;
  c: number;
  /** degrees, 0–360 */
  h: number;
}

const toOklch = converter("oklch");

export function hexToOklch(hex: string): Oklch {
  const { l, c, h } = toOklch(hex)!;
  return { l, c, h: h ?? 0 };
}

/**
 * An OKLCH colour as `#rrggbb`. One outside sRGB loses chroma until it fits,
 * keeping its lightness and hue — the two the card's contrast and identity
 * rest on.
 */
export function oklchToHex(color: Oklch): string {
  return formatHex(clampChroma({ mode: "oklch", ...color }, "oklch"));
}

// ─── The avatar's colours ─────────────────────────────────────────────────

/** Below this chroma a colour reads as grey and lends the card nothing. */
const MIN_CHROMA = 0.05;
/** A colour covering less of the avatar than this is a detail, not its colour. */
const MIN_WEIGHT = 0.04;

/** WCAG floors the derived palette is held to. */
const MIN_CONTRAST = {
  /** The wordmark is 40px bold — large text, so 3:1. */
  wordmark: 3,
  ink: 7,
  inkSoft: 4.5,
} as const;

export type AvatarImage = Awaited<ReturnType<typeof Jimp.read>>;

export interface AvatarColour extends Oklch {
  /** The share of the avatar it covers, 0–1. */
  weight: number;
}

/**
 * The avatar's main colours that carry any colour, most common first.
 *
 * Sampled at 2,500 points rather than Jimp's default 10,000: on a 1000×1000
 * avatar that halves the cost (~140 → ~75 ms) with the same leading colours.
 */
export function avatarColours(avatar: AvatarImage): AvatarColour[] {
  return avatar
    .palette(8, { sampleSize: 2_500 })
    .map(({ color, weight }) => ({
      // `color` is RGBA as a number; drop the alpha byte for `#rrggbb`.
      ...hexToOklch(`#${(color >>> 8).toString(16).padStart(6, "0")}`),
      weight,
    }))
    .filter((c) => c.weight >= MIN_WEIGHT && c.c >= MIN_CHROMA && c.l > 0.15 && c.l < 0.97);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * `color` darkened, a step at a time, until it reaches `ratio` against
 * `background`. Hue and chroma are kept; only lightness gives way.
 */
export function withContrast(color: Oklch, background: string, ratio: number): string {
  let l = color.l;
  let hex = oklchToHex(color);
  while (wcagContrast(hex, background) < ratio && l > 0) {
    l = Math.max(0, l - 0.01);
    hex = oklchToHex({ ...color, l });
  }
  return hex;
}

/**
 * The card's palette, drawn from the avatar's own colours.
 *
 *  - The **canvas** is a pale tint of the avatar's main colour — the one
 *    covering most of it — and the pill faces a near-white of the same hue,
 *    so the card reads as the space's before a word of it is.
 *  - The **accent** is the avatar's most vivid colour that covers a
 *    noticeable part of it (a bright logo on a white field, a gold detail
 *    on navy), used as it is in the avatar: its own hue and
 *    chroma, with its lightness moved only into the band each role needs —
 *    the wordmark, the pill shadows, and the paler disc shadow.
 *  - The **ink** is a deep shade of the canvas's hue, like the site card's
 *    plum is to its pink.
 *
 * Every text colour is then held to a WCAG floor against what it sits on,
 * darkened until it meets it, so no avatar can make the card unreadable.
 * An avatar with no colour in it — grey, black and white, absent — keeps the
 * site card's palette.
 */
export function paletteForAvatar(avatar: AvatarImage | null): CardPalette {
  return paletteFromColours(avatar ? avatarColours(avatar) : []);
}

/** The card's palette for an avatar's colours (see {@link paletteForAvatar}). */
export function paletteFromColours(colours: AvatarColour[]): CardPalette {
  if (colours.length === 0) return DEFAULT_PALETTE;

  const base = colours.reduce((a, b) => (b.weight > a.weight ? b : a));
  // The canvas already carries the colour that covers the most, so the
  // accent is the most vivid one: a gold detail on a navy avatar, not more navy.
  const accent = colours.reduce((a, b) => (b.c > a.c ? b : a));

  const canvas = oklchToHex({ l: 0.965, c: clamp(base.c * 0.3, 0.015, 0.045), h: base.h });
  const pill = oklchToHex({ l: 0.992, c: clamp(base.c * 0.1, 0.005, 0.015), h: base.h });
  const accentC = Math.min(accent.c, 0.26);

  return {
    canvas,
    pill,
    ink: withContrast(
      { l: 0.22, c: clamp(base.c * 0.6, 0.03, 0.11), h: base.h },
      canvas,
      MIN_CONTRAST.ink,
    ),
    inkSoft: withContrast(
      { l: 0.38, c: clamp(base.c * 0.5, 0.03, 0.1), h: base.h },
      canvas,
      MIN_CONTRAST.inkSoft,
    ),
    wordmark: withContrast(
      { l: clamp(accent.l, 0.3, 0.68), c: accentC, h: accent.h },
      canvas,
      MIN_CONTRAST.wordmark,
    ),
    discShadow: oklchToHex({ l: clamp(accent.l, 0.72, 0.86), c: accentC, h: accent.h }),
    pillShadow: oklchToHex({ l: clamp(accent.l, 0.42, 0.6), c: accentC, h: accent.h }),
  };
}

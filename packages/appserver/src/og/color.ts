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

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const fromLinear = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToOklch(r: number, g: number, b: number): Oklch {
  const [lr, lg, lb] = [r, g, b].map((v) => toLinear(v / 255)) as [number, number, number];
  const l_ = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m_ = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s_ = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  const h = (Math.atan2(B, A) * 180) / Math.PI;
  return { l: L, c: Math.hypot(A, B), h: h < 0 ? h + 360 : h };
}

export function hexToOklch(hex: string): Oklch {
  return rgbToOklch(...hexToRgb(hex));
}

/** Linear sRGB for an OKLCH colour; out of gamut when any channel leaves 0–1. */
function oklchToLinear({ l, c, h }: Oklch): [number, number, number] {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

const inGamut = (rgb: number[]) => rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

/**
 * An OKLCH colour as `#rrggbb`. One outside sRGB loses chroma until it fits,
 * keeping its lightness and hue — the two the card's contrast and identity
 * rest on.
 */
export function oklchToHex(color: Oklch): string {
  let lo = 0;
  let hi = color.c;
  if (!inGamut(oklchToLinear(color))) {
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinear({ ...color, c: mid }))) lo = mid;
      else hi = mid;
    }
    hi = lo;
  }
  const rgb = oklchToLinear({ ...color, c: hi });
  return `#${rgb
    .map((v) => Math.round(Math.min(1, Math.max(0, fromLinear(Math.min(1, Math.max(0, v))))) * 255))
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")}`;
}

/** WCAG 2 contrast ratio between two `#rrggbb` colours. */
export function contrastRatio(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, bl] = hexToRgb(hex).map((v) => toLinear(v / 255)) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
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

/** The avatar's main colours that carry any colour, most common first. */
export function avatarColours(avatar: AvatarImage): AvatarColour[] {
  return avatar
    .palette(8)
    .map(({ color, weight }) => ({
      ...rgbToOklch((color >>> 24) & 255, (color >>> 16) & 255, (color >>> 8) & 255),
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
  while (contrastRatio(hex, background) < ratio && l > 0) {
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
  const colours = avatar ? avatarColours(avatar) : [];
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

/**
 * The invite card: a 1200×630 Open Graph image for one space.
 *
 * It is drawn in the design language of the site-wide card
 * (`packages/app-lite/static/roomy-og.png`): the same cream canvas, plum ink
 * and pink wordmark, a plum disc resting on a hard pink offset shadow where
 * that card has its door, and white pills with a plum outline and a hard
 * shadow carrying the facts. Where that card carries Roomy's tagline, this one
 * carries the space: its name, description, avatar, member count, handle and
 * whether anyone can join — and, where the avatar has a colour, the space's
 * own accent in place of the pink (see `color.ts`).
 *
 * Pure: the caller supplies the data and, when it has one, the decoded avatar.
 * Fetching lives in `card.ts`, so a render is deterministic and testable
 * without a network.
 *
 * Drawn with `@jimp/layout`, which is plain JavaScript — no native module, no
 * WebAssembly — so it runs in the appserver's Bun image as it is.
 */

import { Box, Image, Text, render, type LayoutNode } from "@jimp/layout";
import { Jimp } from "jimp";
import { loadTTF } from "jimp/load-ttf";
import { fileURLToPath } from "node:url";
import { paletteForAvatar, type AvatarImage, type CardPalette } from "./color.ts";

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

/** What the card says about a space. Absent fields are left off the card. */
export interface SpaceCardData {
  name: string;
  description?: string;
  /** DNS handle, without a leading `@`. */
  handle?: string;
  memberCount?: number;
  /** `true` → "Open to join"; `false` → "Invite only"; absent → no pill. */
  allowPublicJoin?: boolean;
}

export type { AvatarImage } from "./color.ts";

type Font = Awaited<ReturnType<typeof loadTTF>>;
interface Fonts {
  regular: Font;
  medium: Font;
  semibold: Font;
  bold: Font;
}

let fontsPromise: Promise<Fonts> | null = null;

/** Hanken Grotesk, the app's one family (DESIGN.md §3), loaded once. */
function fonts(): Promise<Fonts> {
  fontsPromise ??= (async () => {
    // Read the bytes here rather than handing `loadTTF` a path: it treats a
    // string as something to fetch, and a percent-encoded file path is not one.
    const load = async (weight: string) =>
      loadTTF(
        await Bun.file(
          fileURLToPath(new URL(`./fonts/HankenGrotesk-${weight}.ttf`, import.meta.url)),
        ).arrayBuffer(),
      );
    const [regular, medium, semibold, bold] = await Promise.all([
      load("Regular"),
      load("Medium"),
      load("SemiBold"),
      load("Bold"),
    ]);
    return { regular, medium, semibold, bold };
  })().catch((err) => {
    // A failed load must not be cached: the next render retries.
    fontsPromise = null;
    throw err;
  });
  return fontsPromise;
}

const numberFormat = new Intl.NumberFormat("en-US");

export function memberLabel(count: number): string {
  return `${numberFormat.format(count)} ${count === 1 ? "member" : "members"}`;
}

/** The first letter (or symbol) of the name, for a space with no avatar. */
export function initialOf(name: string): string {
  const first = [...name.trim()][0];
  return first ? first.toLocaleUpperCase() : "R";
}

/**
 * `text` on one line, keeping only what `font` can draw: a character it has no
 * glyph for (emoji, most CJK in this Latin face) would print as a box. Runs of
 * whitespace, line breaks included, become one space, since the card sets
 * its own lines.
 */
export function drawable(text: string, font: Font): string {
  let out = "";
  for (const char of text) {
    if (/\s/u.test(char)) out += " ";
    else if ((font.opentype.stringToGlyphs(char)[0]?.index ?? 0) > 0) out += char;
  }
  return out.replace(/ {2,}/g, " ").trim();
}

// The disc sits where the site card's door blob does.
const DISC = { left: 772, top: 138, size: 360, ring: 18 } as const;

function pill(
  label: string,
  font: Font,
  colors: CardPalette,
  position: Record<string, number>,
): LayoutNode {
  const placed = Object.keys(position).length > 0;
  return Box({
    ...(placed ? { position: "absolute" as const, ...position } : {}),
    // A long label (a handle) is cut by width with an ellipsis, not overflowed.
    maxWidth: 420,
    padding: [12, 28],
    radius: 999,
    background: colors.pill,
    borderWidth: 3,
    borderColor: colors.ink,
    shadow: [{ x: 3, y: 5, blur: 0, color: colors.pillShadow }],
    children: Text({ font, fontSize: 30, color: colors.ink, maxLines: 1, children: label }),
  });
}

/** Render the card for `data` as PNG bytes. */
export async function renderSpaceCard(
  data: SpaceCardData,
  avatar: AvatarImage | null,
): Promise<Buffer> {
  const f = await fonts();
  // The accent roles and ink take the avatar's hue (color.ts); no avatar, or
  // one with no colour in it, keeps the site card's pink.
  const colors = paletteForAvatar(avatar);
  const inner = DISC.size - DISC.ring * 2;
  // Every weight is the same family, so one font answers "can it draw this".
  const name = drawable(data.name, f.regular) || "A Roomy space";
  const description = data.description ? drawable(data.description, f.regular) : "";
  const handle = data.handle ? drawable(data.handle, f.regular) : "";

  const discContent: LayoutNode = avatar
    ? Image({ src: avatar, width: inner, height: inner, radius: inner / 2, fit: "cover" })
    : Box({
        width: inner,
        height: inner,
        justify: "center",
        align: "center",
        children: Text({
          font: f.semibold,
          fontSize: 200,
          color: colors.canvas,
          children: initialOf(name),
        }),
      });

  // Two pills ride the disc's upper edge and one sits under it, the way the
  // site card hangs its three around the door.
  const pills: LayoutNode[] = [];
  if (data.memberCount !== undefined && data.memberCount > 0) {
    pills.push(pill(memberLabel(data.memberCount), f.medium, colors, { left: 676, top: 190 }));
  }
  if (data.allowPublicJoin !== undefined) {
    pills.push(
      pill(data.allowPublicJoin ? "Open to join" : "Invite only", f.medium, colors, {
        right: 44,
        top: 104,
      }),
    );
  }
  if (handle) {
    // Centred under the disc: a full-width row, since a handle's width varies.
    pills.push(
      Box({
        position: "absolute",
        left: DISC.left - 120,
        top: DISC.top + DISC.size - 34,
        width: DISC.size + 240,
        direction: "row",
        justify: "center",
        children: pill(`@${handle}`, f.medium, colors, {}),
      }),
    );
  }

  // A long name steps down a size and takes a third line rather than being
  // cut at two.
  const longName = [...name].length > 24;

  const tree = Box({
    width: OG_WIDTH,
    height: OG_HEIGHT,
    background: colors.canvas,
    children: [
      // The text column. Its width stops short of the disc and its pills.
      Box({
        position: "absolute",
        left: 72,
        top: 0,
        width: 600,
        height: OG_HEIGHT,
        justify: "center",
        children: [
          Text({ font: f.bold, fontSize: 40, color: colors.wordmark, children: "Roomy" }),
          Text({
            font: f.medium,
            fontSize: 34,
            color: colors.inkSoft,
            margin: [18, 0, 6, 0],
            children: "You're invited to join",
          }),
          Text({
            font: f.semibold,
            fontSize: longName ? 64 : 80,
            lineHeight: longName ? 72 : 88,
            color: colors.ink,
            maxLines: longName ? 3 : 2,
            children: name,
          }),
          ...(description
            ? [
                Text({
                  font: f.regular,
                  fontSize: 30,
                  lineHeight: 40,
                  color: colors.inkSoft,
                  maxLines: longName ? 2 : 3,
                  margin: [22, 0, 0, 0],
                  children: description,
                }),
              ]
            : []),
        ],
      }),
      Box({
        position: "absolute",
        left: DISC.left,
        top: DISC.top,
        width: DISC.size,
        height: DISC.size,
        radius: DISC.size / 2,
        padding: DISC.ring,
        background: colors.ink,
        shadow: [{ x: 22, y: 18, blur: 0, color: colors.discShadow }],
        children: discContent,
      }),
      ...pills,
    ],
  });

  const image = await render(tree, { width: OG_WIDTH, height: OG_HEIGHT, Jimp });
  return image.getBuffer("image/png");
}

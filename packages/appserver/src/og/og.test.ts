/**
 * The invite card's pure parts: what may be fetched, what is decoded, what is
 * drawn, and the page a crawler reads.
 *
 * Run: bun test --cwd packages/appserver src/og/og.test.ts
 */

import { describe, expect, test } from "bun:test";
import { wcagContrast } from "culori";
import { Jimp } from "jimp";
import { metricEndpoint } from "../appserver.ts";
import { imageDimensions, isFetchableUrl, parseAtblob } from "./card.ts";
import { SITE_OG_IMAGE, escapeHtml, renderInvitePage } from "./html.ts";
import { initialOf, memberLabel, renderSpaceCard, truncate } from "./render.ts";
import { cardVersion } from "./routes.ts";
import {
  DEFAULT_PALETTE,
  avatarColours,
  hexToOklch,
  oklchToHex,
  paletteForAvatar,
  paletteFromColours,
  type AvatarColour,
  type CardPalette,
} from "./color.ts";

/** `#rrggbb` of the pixel at (x, y). */
function hexAt(image: Awaited<ReturnType<typeof Jimp.read>>, x: number, y: number): string {
  const rgba = image.getPixelColor(x, y);
  return `#${(rgba >>> 8).toString(16).padStart(6, "0")}`;
}

describe("isFetchableUrl", () => {
  test("allows a public https host", () => {
    expect(isFetchableUrl("https://cdn.bsky.app/img/avatar/plain/did:plc:x/cid@jpeg")).toBe(true);
    expect(isFetchableUrl("https://pds.example.com/xrpc/com.atproto.sync.getBlob")).toBe(true);
  });

  test.each([
    ["plain http", "http://cdn.bsky.app/a.png"],
    ["an IPv4 literal", "https://169.254.169.254/latest/meta-data"],
    ["an IPv6 literal", "https://[::1]/a.png"],
    ["localhost", "https://localhost/a.png"],
    ["a bare service name", "https://appserver/a.png"],
    ["a private-network name", "https://postgres.railway.internal/a.png"],
    ["an mDNS name", "https://printer.local/a.png"],
    ["credentials in the URL", "https://user:pw@cdn.bsky.app/a.png"],
    ["a non-URL", "atblob://did:plc:x/cid"],
    ["garbage", "not a url"],
  ])("refuses %s", (_label, url) => {
    expect(isFetchableUrl(url)).toBe(false);
  });
});

describe("parseAtblob", () => {
  test("splits a blob ref", () => {
    expect(parseAtblob("atblob://did:plc:abc/bafkreiabc")).toEqual({
      did: "did:plc:abc",
      cid: "bafkreiabc",
    });
  });

  test("ignores a query or fragment", () => {
    expect(parseAtblob("atblob://did:plc:abc/bafkreiabc?x=1")?.cid).toBe("bafkreiabc");
  });

  test.each(["https://x.example/a.png", "atblob://did:plc:abc", "atblob:///cid", "atblob://nodid/cid", "atblob://did:plc:a/b/c"])(
    "rejects %s",
    (ref) => {
      expect(parseAtblob(ref)).toBeNull();
    },
  );
});

describe("imageDimensions", () => {
  test("reads a PNG and a JPEG header", async () => {
    const image = new Jimp({ width: 37, height: 21, color: 0xff0000ff });
    expect(imageDimensions(await image.getBuffer("image/png"))).toEqual({ width: 37, height: 21 });
    expect(imageDimensions(await image.getBuffer("image/jpeg"))).toEqual({ width: 37, height: 21 });
  });

  test("reports what a header declares, so a decompression bomb is caught before decoding", async () => {
    const png = Buffer.from(await new Jimp({ width: 1, height: 1 }).getBuffer("image/png"));
    png.writeUInt32BE(20_000, 16);
    png.writeUInt32BE(20_000, 20);
    expect(imageDimensions(png)).toEqual({ width: 20_000, height: 20_000 });
  });

  test("anything else is not an image it will decode", () => {
    expect(imageDimensions(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBeNull();
    expect(imageDimensions(Buffer.from("<svg/>"))).toBeNull();
  });
});

describe("card text", () => {
  test("member label", () => {
    expect(memberLabel(1)).toBe("1 member");
    expect(memberLabel(48213)).toBe("48,213 members");
  });

  test("initial", () => {
    expect(initialOf("  roomy")).toBe("R");
    expect(initialOf("été")).toBe("É");
    expect(initialOf("")).toBe("R");
  });

  test("truncate counts code points and ends in an ellipsis", () => {
    expect(truncate("short", 10)).toBe("short");
    expect(truncate("abcdefghij", 5)).toBe("abcd…");
    expect([...truncate("🌱🌱🌱🌱🌱🌱", 4)]).toHaveLength(4);
  });
});

describe("renderSpaceCard", () => {
  test("draws a 1200×630 PNG on the site card's canvas, with the disc in plum", async () => {
    const png = await renderSpaceCard(
      {
        name: "Roomy Space",
        description: "Come say hi 🌱",
        handle: "home.roomy.space",
        memberCount: 12,
        allowPublicJoin: false,
      },
      null,
    );
    const image = await Jimp.read(png);
    expect(image.width).toBe(1200);
    expect(image.height).toBe(630);
    expect(hexAt(image, 10, 10)).toBe("#fff4e5"); // canvas
    expect(hexAt(image, 781, 318)).toBe("#250041"); // the disc's ring
  });

  test("draws the avatar inside the disc", async () => {
    const avatar = new Jimp({ width: 64, height: 64, color: 0x00a0ffff });
    const image = await Jimp.read(await renderSpaceCard({ name: "Blue" }, avatar));
    expect(hexAt(image, 952, 318)).toBe("#00a0ff");
  });

  test("survives a name made only of glyphs the font lacks", async () => {
    const image = await Jimp.read(await renderSpaceCard({ name: "🌱🌱🌱" }, null));
    expect(image.width).toBe(1200);
  });
});

describe("renderInvitePage", () => {
  test("names the space and uses its card", () => {
    const html = renderInvitePage({
      appHref: "/join?space=did:plc:x&invite=abc",
      space: {
        name: "Gardeners",
        description: "We grow things.",
        imageUrl: "https://api.example/og/space/did%3Aplc%3Ax.png?v=1",
      },
    });
    expect(html).toContain('<meta property="og:title" content="Join Gardeners on Roomy" />');
    expect(html).toContain('<meta property="og:description" content="We grow things." />');
    expect(html).toContain(
      '<meta property="og:image" content="https://api.example/og/space/did%3Aplc%3Ax.png?v=1" />',
    );
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(html).toContain('href="/join?space=did:plc:x&amp;invite=abc"');
  });

  test("a space with no description gets an invitation line", () => {
    const html = renderInvitePage({
      appHref: "/join",
      space: { name: "Gardeners", imageUrl: "https://api.example/x.png" },
    });
    expect(html).toContain('content="You&#39;re invited to join Gardeners on Roomy."');
  });

  test("escapes what a space admin wrote", () => {
    const html = renderInvitePage({
      appHref: '/join?space="><script>',
      space: {
        name: '"><script>alert(1)</script>',
        imageUrl: "https://api.example/x.png",
      },
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain(escapeHtml('"><script>alert(1)</script>'));
  });

  test("an unknown space unfurls as the site", () => {
    const html = renderInvitePage({ appHref: "/join?space=nope" });
    expect(html).toContain(`<meta property="og:image" content="${SITE_OG_IMAGE}" />`);
    expect(html).toContain('<meta property="og:title" content="Roomy" />');
  });
});

describe("cardVersion", () => {
  test("changes with anything the card shows, and only then", () => {
    const base = { name: "A", memberCount: 3, allowPublicJoin: true };
    expect(cardVersion(base)).toBe(cardVersion({ ...base }));
    expect(cardVersion(base)).not.toBe(cardVersion({ ...base, name: "B" }));
    expect(cardVersion(base)).not.toBe(cardVersion({ ...base, memberCount: 4 }));
    expect(cardVersion(base)).not.toBe(cardVersion({ ...base, avatarRef: "atblob://did:plc:a/b" }));
  });
});

describe("metricEndpoint", () => {
  test("folds each Open Graph route to one label", () => {
    const none = new Set<string>();
    expect(metricEndpoint("/og/space/did%3Aplc%3Aabc.png", none)).toBe("/og/space");
    expect(metricEndpoint("/og/join", none)).toBe("/og/join");
    expect(metricEndpoint("/og/join/home.example.com", none)).toBe("/og/join");
  });
});

describe("the space's colour", () => {
  const rgba = (hex: string) => (Number.parseInt(hex.slice(1), 16) * 256 + 0xff) >>> 0;

  /** A square avatar in `background`, with a `size`-pixel square of `spot` in its middle. */
  function avatar(background: number, spot?: number, size = 40) {
    const image = new Jimp({ width: 200, height: 200, color: background });
    if (spot !== undefined) {
      const from = 100 - size / 2;
      for (let y = from; y < from + size; y++) {
        for (let x = from; x < from + size; x++) image.setPixelColor(spot, x, y);
      }
    }
    return image;
  }

  const hueOf = (hex: string) => hexToOklch(hex).h;
  const near = (a: number, b: number, within: number) =>
    Math.abs(((a - b + 540) % 360) - 180) <= within;

  test("the default palette survives the round trip through OKLCH", () => {
    for (const hex of Object.values(DEFAULT_PALETTE)) {
      expect(oklchToHex(hexToOklch(hex))).toBe(hex);
    }
  });

  /** Every text colour of `p` meets its WCAG floor; `where` names the case on failure. */
  function expectReadable(p: CardPalette, where: string) {
    // The wordmark is 40px bold — large text, so WCAG's floor is 3:1.
    expect(wcagContrast(p.wordmark, p.canvas), where).toBeGreaterThanOrEqual(3);
    expect(wcagContrast(p.ink, p.canvas), where).toBeGreaterThanOrEqual(7);
    expect(wcagContrast(p.inkSoft, p.canvas), where).toBeGreaterThanOrEqual(4.5);
    expect(wcagContrast(p.ink, p.pill), where).toBeGreaterThanOrEqual(7);
  }

  // Avatar colours straight into the derivation: the guarantee is about the
  // palette maths, not the quantizer, and skipping it keeps this exhaustive.
  const grid = (hueStep: number, ls: number[], cs: number[]): AvatarColour[] => {
    const out: AvatarColour[] = [];
    for (let h = 0; h < 360; h += hueStep) {
      for (const l of ls) for (const c of cs) out.push({ ...hexToOklch(oklchToHex({ l, c, h })), weight: 1 });
    }
    return out;
  };

  test("no single avatar colour makes the text unreadable", () => {
    for (const colour of grid(10, [0.2, 0.4, 0.6, 0.8, 0.95], [0.06, 0.15, 0.3])) {
      expectReadable(paletteFromColours([colour]), JSON.stringify(colour));
    }
  });

  test("no pairing of main colour and accent makes the text unreadable", () => {
    const colours = grid(45, [0.25, 0.6, 0.9], [0.08, 0.3]);
    for (const main of colours) {
      for (const accent of colours) {
        // `main` covers more of the avatar; `accent` is more vivid.
        const pair = [
          { ...main, weight: 0.7 },
          { ...accent, c: Math.max(accent.c, main.c + 0.01), weight: 0.3 },
        ];
        expectReadable(paletteFromColours(pair), JSON.stringify(pair));
      }
    }
  });

  test("the canvas is a pale tint of the colour covering most of the avatar", () => {
    const teal = "#15897f";
    const p = paletteForAvatar(avatar(rgba(teal), 0xf26b1dff, 30));
    expect(near(hueOf(p.canvas), hueOf(teal), 10)).toBe(true);
    expect(hexToOklch(p.canvas).l).toBeGreaterThan(0.93);
    expect(near(hueOf(p.ink), hueOf(teal), 10)).toBe(true);
  });

  test("the accent is the most vivid colour, not the most common", () => {
    const gold = "#e2b43c";
    const p = paletteForAvatar(avatar(0x101b3dff, rgba(gold), 60)); // gold on navy
    expect(p.discShadow).toBe(gold);
    expect(near(hueOf(p.wordmark), hueOf(gold), 10)).toBe(true);
    expect(near(hueOf(p.canvas), hueOf("#101b3d"), 10)).toBe(true);
  });

  test("a small vivid logo on a white field still colours the card", () => {
    const p = paletteForAvatar(avatar(0xfafafaff, 0xf26b1dff)); // orange on white
    expect(near(hueOf(p.wordmark), hueOf("#f26b1d"), 10)).toBe(true);
  });

  test.each([
    ["grey", avatar(0x707070ff, 0xd0d0d0ff)],
    ["black and white", avatar(0x000000ff, 0xffffffff, 80)],
    ["grey with a speck of colour", avatar(0x707070ff, 0xff0000ff, 4)],
    ["fully transparent", avatar(0x00000000)],
  ])("a %s avatar keeps the site card's palette", (_label, image) => {
    expect(avatarColours(image)).toEqual([]);
    expect(paletteForAvatar(image)).toEqual(DEFAULT_PALETTE);
  });

  test("the card is drawn in the avatar's palette", async () => {
    const teal = avatar(0x15897fff);
    const palette = paletteForAvatar(teal);
    const tinted = await Jimp.read(await renderSpaceCard({ name: "Tidepool" }, teal));
    const plain = await Jimp.read(await renderSpaceCard({ name: "Tidepool" }, null));
    // Just right of the disc: only its hard shadow is there.
    expect(hexAt(tinted, 1142, 318)).toBe(palette.discShadow);
    expect(hexAt(tinted, 10, 10)).toBe(palette.canvas);
    expect(hexAt(plain, 1142, 318)).toBe(DEFAULT_PALETTE.discShadow);
    expect(hexAt(plain, 10, 10)).toBe(DEFAULT_PALETTE.canvas);
  });
});

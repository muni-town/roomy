/**
 * Generates fake Discord export JSON files matching the shape of the
 * real Discord exports in gitignore/MuniTown/.
 *
 * Uses @faker-js/faker to produce realistic-looking random data.
 * All names (guild, category, channel, thread, role, emoji) are generated
 * dynamically using diverse faker sources. Image URLs use faker.image.
 *
 * Usage:
 *   bun run src/scripts/generate-fake-data.ts
 *   bun run src/scripts/generate-fake-data.ts --count 10
 *   bun run src/scripts/generate-fake-data.ts --outdir /tmp/fake-discord-exports
 *
 * Output: One JSON file per generated channel/thread, in Discord Export v1 format.
 */

import { faker } from "@faker-js/faker";
import * as fs from "node:fs/promises";
import * as path from "node:path";

// ─── Types matching the Discord export JSON schema ────────────────────────

interface DiscordRole {
  id: string;
  name: string;
  color: string | null;
  position: number;
}

interface DiscordUser {
  id: string;
  name: string;
  discriminator: string;
  nickname: string;
  color: string | null;
  isBot: boolean;
  roles: DiscordRole[];
  avatarUrl: string;
}

interface DiscordReactionEmoji {
  id: string;
  name: string;
  code: string;
  isAnimated: boolean;
  imageUrl: string;
}

interface DiscordReaction {
  emoji: DiscordReactionEmoji;
  count: number;
  users: DiscordUser[];
}

interface DiscordEmbedImage {
  url: string;
  width: number;
  height: number;
}

interface DiscordEmbedAuthor {
  name: string;
  url: string | null;
}

interface DiscordEmbedFooter {
  text: string;
  iconUrl: string | null;
}

interface DiscordEmbedField {
  name: string;
  value: string;
  inline: boolean;
}

interface DiscordEmbedInlineEmoji {
  id: string;
  name: string;
  code: string;
  isAnimated: boolean;
  imageUrl: string;
}

interface DiscordEmbed {
  title: string | null;
  url: string | null;
  timestamp: string | null;
  description: string | null;
  color: string | null;
  thumbnail: DiscordEmbedImage | null;
  images: DiscordEmbedImage[];
  fields: DiscordEmbedField[];
  author: DiscordEmbedAuthor | null;
  footer: DiscordEmbedFooter | null;
  inlineEmojis: DiscordEmbedInlineEmoji[];
}

interface DiscordAttachment {
  id: string;
  url: string;
  fileName: string;
  fileSizeBytes: number;
}

interface DiscordSticker {
  id: string;
  name: string;
  formatType: number;
}

interface DiscordReference {
  messageId: string | null;
  channelId: string;
  guildId: string;
}

interface DiscordInlineEmoji {
  id: string;
  name: string;
  code: string;
  isAnimated: boolean;
  imageUrl: string;
}

interface DiscordMessage {
  id: string;
  type: string | number;
  timestamp: string;
  timestampEdited: string | null;
  callEndedTimestamp: string | null;
  isPinned: boolean;
  content: string;
  author: DiscordUser;
  attachments: DiscordAttachment[];
  embeds: DiscordEmbed[];
  stickers: DiscordSticker[];
  reactions: DiscordReaction[];
  mentions: DiscordUser[];
  reference?: DiscordReference;
  inlineEmojis: DiscordInlineEmoji[];
}

interface DiscordExport {
  guild: {
    id: string;
    name: string;
    iconUrl: string;
  };
  channel: {
    id: string;
    type: string;
    categoryId: string;
    category: string;
    name: string;
    topic: string | null;
  };
  dateRange: {
    after: string | null;
    before: string | null;
  };
  exportedAt: string;
  messageCount: number;
  messages: DiscordMessage[];
}

/** Lightweight channel descriptor used to wire thread→parent associations. */
interface ChannelInfo {
  id: string;
  name: string;
  categoryId: string;
  category: string;
}

// ─── Shared constants (not dependent on seed, purely static) ─────────────

const GUILD_ID = "938334993191686174";

const EMOJI_DATA: Array<{
  name: string;
  code: string;
  imageUrl: string;
}> = [
  {
    name: "👍",
    code: "thumbsup",
    imageUrl:
      "https://cdn.jsdelivr.net/gh/twitter/twemoji@latest/assets/svg/1f44d.svg",
  },
  {
    name: "❤️",
    code: "heart",
    imageUrl:
      "https://cdn.jsdelivr.net/gh/twitter/twemoji@latest/assets/svg/2764.svg",
  },
  {
    name: "🤗",
    code: "hugging",
    imageUrl:
      "https://cdn.jsdelivr.net/gh/twitter/twemoji@latest/assets/svg/1f917.svg",
  },
  {
    name: "👀",
    code: "eyes",
    imageUrl:
      "https://cdn.jsdelivr.net/gh/twitter/twemoji@latest/assets/svg/1f440.svg",
  },
  {
    name: "👋",
    code: "wave",
    imageUrl:
      "https://cdn.jsdelivr.net/gh/twitter/twemoji@latest/assets/svg/1f44b.svg",
  },
  {
    name: "🚀",
    code: "rocket",
    imageUrl:
      "https://cdn.jsdelivr.net/gh/twitter/twemoji@latest/assets/svg/1f680.svg",
  },
  {
    name: "🔥",
    code: "fire",
    imageUrl:
      "https://cdn.jsdelivr.net/gh/twitter/twemoji@latest/assets/svg/1f525.svg",
  },
  {
    name: "🎉",
    code: "party",
    imageUrl:
      "https://cdn.jsdelivr.net/gh/twitter/twemoji@latest/assets/svg/1f389.svg",
  },
  {
    name: "😄",
    code: "smile",
    imageUrl:
      "https://cdn.jsdelivr.net/gh/twitter/twemoji@latest/assets/svg/1f604.svg",
  },
];

const DISCORD_COLORS: (string | null)[] = [
  "#11806A",
  "#1ABC9C",
  "#3498DB",
  "#9B59B6",
  "#E91E63",
  "#F1C40F",
  "#E67E22",
  "#E74C3C",
  "#95A5A6",
  "#607D8B",
  null,
];

// ─── Seeded state — id counters ──────────────────────────────────────────

let messageIdCounter = 938337338277363773n;
let userIdCounter = 662272582422102016n;
let roleIdCounter = 991620648554209280n;
let channelIdCounter = 938334993191686179n;
let attachmentIdCounter = 978932012247289876n;
let categoryIdCounter = 938334993100000600n;

function nextMessageId(): string {
  messageIdCounter += BigInt(faker.number.int({ min: 1000, max: 50000 }));
  return messageIdCounter.toString();
}

function nextUserId(): string {
  userIdCounter += BigInt(faker.number.int({ min: 100, max: 10000 }));
  return userIdCounter.toString();
}

function nextRoleId(): string {
  roleIdCounter += BigInt(faker.number.int({ min: 10, max: 100 }));
  return roleIdCounter.toString();
}

function nextChannelId(): string {
  channelIdCounter += BigInt(faker.number.int({ min: 1000, max: 50000 }));
  return channelIdCounter.toString();
}

function nextAttachmentId(): string {
  attachmentIdCounter += BigInt(faker.number.int({ min: 1, max: 100 }));
  return attachmentIdCounter.toString();
}

function nextCategoryId(): string {
  categoryIdCounter += BigInt(faker.number.int({ min: 1000, max: 50000 }));
  return categoryIdCounter.toString();
}

// ─── Dynamic name generators ─────────────────────────────────────────────

function pick<T>(arr: readonly T[]): T {
  return faker.helpers.arrayElement([...arr]);
}

function generateGuildName(): string {
  const sources = [
    () => faker.company.name(),
    () => `${faker.location.city()} Dev Community`,
    () => `${faker.hacker.adjective()} ${faker.hacker.noun()}s`,
    () => `${faker.word.adjective()} ${faker.music.genre()} Squad`,
    () => `${faker.animal.type()} Club`,
    () => `${faker.company.buzzNoun()} Collective`,
    () => `${faker.person.jobArea()} Guild`,
  ];
  return faker.helpers.arrayElement(sources)();
}

function generateCategoryName(): string {
  const sources = [
    () => faker.commerce.department(),
    () => `${faker.hacker.noun()} ${faker.hacker.verb().replace(/\d+$/, "")}`,
    () => faker.music.genre(),
    () => faker.science.chemicalElement().name,
    () => faker.animal.type(),
    () => faker.company.buzzNoun(),
    () => faker.location.country(),
    () => faker.word.noun(),
  ];
  return faker.helpers.arrayElement(sources)().replace(/\s+/g, " ").trim();
}

function generateCategories(
  count: number,
): Array<{ name: string; id: string }> {
  const categories: Array<{ name: string; id: string }> = [];
  const seen = new Set<string>();
  for (let i = 0; i < count; i++) {
    let name: string;
    do {
      name = generateCategoryName();
    } while (seen.has(name));
    seen.add(name);
    categories.push({ name, id: nextCategoryId() });
  }
  return categories;
}

function generateChannelName(): string {
  const sources = [
    () => faker.hacker.noun(),
    () => `${faker.hacker.adjective()}-${faker.hacker.noun()}`,
    () => faker.animal.type().toLowerCase(),
    () => faker.color.human().toLowerCase(),
    () => faker.person.jobArea().toLowerCase(),
    () => faker.science.unit().name.toLowerCase(),
    () => faker.vehicle.type().toLowerCase().replace(/\s+/g, "-"),
    () => faker.food.fruit().toLowerCase(),
    () => `${faker.hacker.noun()}-${faker.hacker.noun()}`,
    () => faker.word.noun(),
  ];
  return faker.helpers.arrayElement(sources)().slice(0, 40);
}

function generateThreadName(): string {
  // Produce short sentence-style names like real Discord threads
  const sources = [
    // topic phrases
    () => `${faker.word.adjective()} ${faker.word.noun()}`,
    () => `${faker.hacker.noun()} brainstorm`,
    () =>
      `${faker.hacker.ingverb().replace(/\d+$/, "")} the ${faker.hacker.noun()}`,
    // questions / conversational
    () =>
      faker.helpers.arrayElement([
        `Anyone else ${faker.hacker.verb().replace(/\d+$/, "")} ${faker.hacker.noun()}?`,
        `${faker.word.verb()} ${faker.word.noun()}?`,
        `${faker.hacker.adjective()} ${faker.hacker.noun()} in practice?`,
        `Thoughts on ${faker.commerce.productName().toLowerCase()}?`,
        `What's the best ${faker.hacker.noun()}?`,
        `How do you ${faker.hacker.verb().replace(/\d+$/, "")} ${faker.hacker.noun()}?`,
        `${faker.hacker.adjective()} ${faker.hacker.noun()} tips?`,
      ]),
    // chopped sentence start (like Discord pulls from first message)
    () => {
      const sent = faker.lorem.sentence({ min: 4, max: 9 });
      return sent
        .slice(0, faker.number.int({ min: 25, max: Math.max(25, sent.length) }))
        .replace(/\.\.\.?$/, "...");
    },
    // clipped phrase
    () => faker.lorem.words({ min: 3, max: 6 }),
    // project/product reference
    () => `${faker.hacker.noun()} integration`,
    () => `${faker.commerce.productName()} setup`,
  ];
  return faker.helpers
    .arrayElement(sources)()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function generateChannelTopic(): string | null {
  if (faker.helpers.maybe(() => true, { probability: 0.15 })) return null;
  const sources = [
    () =>
      `${faker.hacker.ingverb().replace(/\d+$/, "")} about ${faker.hacker.noun()} and ${faker.hacker.noun()}.`,
    () =>
      `All things ${faker.commerce.department().toLowerCase()} — share resources and ideas.`,
    () => faker.lorem.sentence({ min: 6, max: 14 }),
    () =>
      `A place to discuss ${faker.company.buzzNoun().toLowerCase()} and ${faker.company.buzzNoun().toLowerCase()}.`,
    () => `${faker.hacker.phrase().replace(/^./, (c) => c.toUpperCase())}.`,
    () => `Please keep ${faker.hacker.noun()} discussions on-topic.`,
    () => `Weekly check-in: what are you working on?`,
    () => `Ask questions and share ${faker.hacker.noun()} tips.`,
  ];
  return faker.helpers.arrayElement(sources)();
}

function generateRoleName(): string {
  const sources = [
    () => faker.hacker.noun(),
    () => faker.hacker.abbreviation().toUpperCase(),
    () => faker.commerce.department().toLowerCase().replace(/\s+/g, "-"),
    () => faker.animal.type().toLowerCase(),
    () => `${faker.word.adjective()}-${faker.hacker.noun()}`,
    () => `${faker.word.adjective()} ${faker.person.jobTitle().split(" ")[0]}`,
  ];
  return faker.helpers.arrayElement(sources)().slice(0, 24);
}

function generateCustomEmojiName(): string {
  const prefixes = [
    "blob",
    "party",
    "pepe",
    "ferris",
    "think",
    "crab",
    "hype",
    "pog",
    "cat",
    "hyper",
  ];
  const suffixes = [
    "Wave",
    "Heart",
    "Fire",
    "Think",
    "Smile",
    "Eyes",
    "Party",
    "Pog",
    "Sad",
    "Happy",
    "Cry",
  ];
  return (
    faker.helpers.arrayElement(prefixes) + faker.helpers.arrayElement(suffixes)
  );
}

// ─── Image URL generators (all use faker.image) ──────────────────────────

/** Generate a guild icon URL. */
function generateGuildIconUrl(): string {
  return faker.image.urlPicsumPhotos({ width: 512, height: 512 });
}

/** Generate a user avatar URL. */
function generateAvatarUrl(): string {
  return faker.image.avatar();
}

/** Generate a custom emoji image URL. */
function generateCustomEmojiUrl(): string {
  return faker.image.urlPicsumPhotos({ width: 48, height: 48 });
}

/** Generate an embed image URL. */
function generateEmbedImageUrl(): string {
  return faker.image.url({ width: faker.number.int({ min: 400, max: 1600 }) });
}

/** Generate an attachment URL (still uses Discord CDN style for realism). */
function generateAttachmentUrl(): string {
  return faker.image.url({ width: faker.number.int({ min: 200, max: 1920 }) });
}

/** Generate a favicon-style URL for embed footers. */
function generateFaviconUrl(): string {
  return faker.image.url({ width: 32, height: 32 });
}

// ─── Role generator ──────────────────────────────────────────────────────

function generateRoles(count: number): DiscordRole[] {
  const roles: DiscordRole[] = [];
  const usedNames = new Set<string>();
  for (let i = 0; i < count; i++) {
    let name: string;
    do {
      name = generateRoleName();
    } while (usedNames.has(name));
    usedNames.add(name);
    roles.push({
      id: nextRoleId(),
      name,
      color: pick(DISCORD_COLORS),
      position: faker.number.int({ min: 1, max: 15 }),
    });
  }
  return roles.sort((a, b) => b.position - a.position);
}

// ─── User generator ─────────────────────────────────────────────────────

function generateUser(): DiscordUser {
  const firstName = faker.person.firstName();
  const lastName = faker.person.lastName();
  const username = faker.internet
    .username({ firstName, lastName })
    .toLowerCase();
  const nick =
    faker.helpers.maybe(() => faker.person.firstName(), { probability: 0.6 }) ??
    null;
  const userId = nextUserId();
  return {
    id: userId,
    name: username,
    discriminator: "0000",
    nickname: nick ?? username,
    color: pick(DISCORD_COLORS),
    isBot: faker.helpers.maybe(() => true, { probability: 0.02 }) ?? false,
    roles:
      faker.helpers.maybe(
        () => generateRoles(faker.number.int({ min: 0, max: 4 })),
        { probability: 0.5 },
      ) ?? [],
    avatarUrl: generateAvatarUrl(),
  };
}

// ─── Content generators ──────────────────────────────────────────────────

function generateContent(): string {
  const patterns = [
    () => faker.lorem.sentence({ min: 5, max: 20 }),
    () => faker.lorem.paragraph({ min: 1, max: 4 }),
    () =>
      `${faker.lorem.sentence({ min: 3, max: 10 })}\n\n${faker.lorem.paragraph({ min: 2, max: 6 })}`,
    () => {
      return pick([
        `https://github.com/${faker.string.alphanumeric(8)}/${faker.string.alphanumeric(10)}`,
        `https://news.ycombinator.com/item?id=${faker.number.int({ min: 100, max: 9999 })}`,
        `https://twitter.com/${faker.internet.username()}/status/${faker.number.int({ min: 100000, max: 999999 })}`,
        `https://${faker.internet.domainName()}/${faker.lorem.slug()}`,
      ]);
    },
    () => {
      const lines = faker.lorem.sentences({ min: 2, max: 5 });
      return `> ${lines.split(". ").slice(0, 1).join(". ")}.\n\n${faker.lorem.paragraph({ min: 1, max: 3 })}`;
    },
  ];
  return pick(patterns)();
}

function generateReplyContent(): string {
  const replies = [
    () => faker.lorem.sentence({ min: 3, max: 12 }),
    () =>
      `@${faker.person.firstName().toLowerCase()} ${faker.lorem.sentence({ min: 5, max: 15 })}`,
    () =>
      `${faker.lorem.sentence({ min: 2, max: 6 })}\n\n${faker.lorem.sentence({ min: 5, max: 14 })}`,
    () =>
      pick([
        "+1",
        "👍",
        "this",
        "great point!",
        "agreed",
        "Yes, exactly this.",
        "Interesting take.",
        "Thanks for sharing!",
      ]),
  ];
  return pick(replies)();
}

function generateTimestamp(date: Date): string {
  return date.toISOString().replace("Z", "+00:00");
}

function generateEditedTimestamp(): string | null {
  return (
    faker.helpers.maybe(
      () => {
        const date = faker.date.recent({ days: 30 });
        return date.toISOString().replace("Z", "+00:00");
      },
      { probability: 0.08 },
    ) ?? null
  );
}

// ─── Emoji / reaction / embed / attachment / sticker generators ──────────

function generateEmoji(): DiscordReactionEmoji {
  if (faker.helpers.maybe(() => true, { probability: 0.2 })) {
    const name = generateCustomEmojiName();
    const id = faker.number
      .int({ min: 590685315161915000, max: 590685315161915999 })
      .toString();
    const animated =
      faker.helpers.maybe(() => true, { probability: 0.4 }) ?? false;
    return {
      id,
      name,
      code: name,
      isAnimated: animated,
      imageUrl: generateCustomEmojiUrl(),
    };
  }
  const emoji = pick(EMOJI_DATA);
  return {
    id: "",
    name: emoji.name,
    code: emoji.code,
    isAnimated: false,
    imageUrl: emoji.imageUrl,
  };
}

function generateInlineEmoji(): DiscordInlineEmoji {
  const emoji = pick(EMOJI_DATA);
  return {
    id: "",
    name: emoji.name,
    code: emoji.code,
    isAnimated: false,
    imageUrl: emoji.imageUrl,
  };
}

function generateReaction(users: DiscordUser[]): DiscordReaction {
  const emoji = generateEmoji();
  const count = faker.number.int({ min: 1, max: Math.min(users.length, 5) });
  return {
    emoji,
    count,
    users: faker.helpers.arrayElements(users, count),
  };
}

function generateEmbed(): DiscordEmbed {
  const website = faker.internet.domainName();

  return {
    title:
      faker.helpers.maybe(() => faker.lorem.sentence({ min: 3, max: 8 }), {
        probability: 0.9,
      }) ?? null,
    url: `https://${website}/`,
    timestamp:
      faker.helpers.maybe(() => generateTimestamp(faker.date.past()), {
        probability: 0.3,
      }) ?? null,
    description:
      faker.helpers.maybe(() => faker.lorem.sentence({ min: 5, max: 15 }), {
        probability: 0.6,
      }) ?? null,
    color: pick(["#1E2327", "#1DA1F2", "#FF6600", "#5865F2", "#FF0000", null]),
    thumbnail:
      faker.helpers.maybe(
        () => ({
          url: generateEmbedImageUrl(),
          width: faker.number.int({ min: 400, max: 1600 }),
          height: faker.number.int({ min: 300, max: 1200 }),
        }),
        { probability: 0.5 },
      ) ?? null,
    images:
      faker.helpers.maybe(
        () => [
          {
            url: generateEmbedImageUrl(),
            width: faker.number.int({ min: 400, max: 1600 }),
            height: faker.number.int({ min: 300, max: 1200 }),
          },
        ],
        { probability: 0.15 },
      ) ?? [],
    fields:
      faker.helpers.maybe(
        () =>
          Array.from({ length: faker.number.int({ min: 1, max: 3 }) }, () => ({
            name: faker.lorem.words({ min: 2, max: 5 }),
            value: faker.lorem.sentence({ min: 5, max: 15 }),
            inline:
              faker.helpers.maybe(() => true, { probability: 0.5 }) ?? false,
          })),
        { probability: 0.2 },
      ) ?? [],
    author:
      faker.helpers.maybe(
        () => ({
          name: faker.person.fullName(),
          url:
            faker.helpers.maybe(
              () =>
                `https://${faker.internet.domainName()}/${faker.internet.username()}`,
              { probability: 0.7 },
            ) ?? null,
        }),
        { probability: 0.15 },
      ) ?? null,
    footer:
      faker.helpers.maybe(
        () => ({
          text: pick([website, "Twitter", "GitHub", "Hacker News", "Reddit"]),
          iconUrl:
            faker.helpers.maybe(() => generateFaviconUrl(), {
              probability: 0.5,
            }) ?? null,
        }),
        { probability: 0.2 },
      ) ?? null,
    inlineEmojis:
      faker.helpers.maybe(
        () =>
          Array.from({ length: faker.number.int({ min: 1, max: 2 }) }, () =>
            generateInlineEmoji(),
          ),
        { probability: 0.1 },
      ) ?? [],
  };
}

function generateAttachment(): DiscordAttachment {
  const ext = pick(["png", "jpg", "gif", "pdf", "zip"]);
  const attId = nextAttachmentId();
  return {
    id: attId,
    url: generateAttachmentUrl(),
    fileName: pick([
      `${faker.string.alphanumeric(8)}.${ext}`,
      `screenshot-${faker.date.recent().toISOString().slice(0, 10)}.${ext}`,
      `${faker.hacker.noun()}.${ext}`,
      `image.${ext}`,
      `photo-${faker.number.int({ min: 1, max: 999 })}.jpg`,
      `archive-${faker.number.int({ min: 1, max: 99 })}.zip`,
    ]),
    fileSizeBytes: faker.number.int({ min: 1000, max: 500000 }),
  };
}

// ─── Message generators ──────────────────────────────────────────────────

function generateDefaultMessage(
  users: DiscordUser[],
  currentTime: Date,
): DiscordMessage {
  const hasContent =
    faker.helpers.maybe(() => true, { probability: 0.97 }) ?? false;
  const hasEmbeds =
    !hasContent || faker.helpers.maybe(() => true, { probability: 0.08 });
  const hasAttachments = faker.helpers.maybe(() => true, { probability: 0.03 });
  const hasReactions = faker.helpers.maybe(() => true, { probability: 0.15 });
  const hasMentions = faker.helpers.maybe(() => true, { probability: 0.05 });
  const hasInlineEmojis = faker.helpers.maybe(() => true, { probability: 0.2 });
  const isPinned =
    faker.helpers.maybe(() => true, { probability: 0.002 }) === true;

  const author = pick(users);

  return {
    id: nextMessageId(),
    type: "Default",
    timestamp: generateTimestamp(currentTime),
    timestampEdited: generateEditedTimestamp(),
    callEndedTimestamp: null,
    isPinned,
    content: hasContent ? generateContent() : "",
    author,
    attachments: hasAttachments
      ? Array.from({ length: faker.number.int({ min: 1, max: 3 }) }, () =>
          generateAttachment(),
        )
      : [],
    embeds: hasEmbeds ? [generateEmbed()] : [],
    stickers: [],
    reactions: hasReactions
      ? Array.from({ length: faker.number.int({ min: 1, max: 3 }) }, () =>
          generateReaction(users),
        )
      : [],
    mentions: hasMentions
      ? faker.helpers.arrayElements(users, faker.number.int({ min: 1, max: 2 }))
      : [],
    inlineEmojis: hasInlineEmojis
      ? Array.from({ length: faker.number.int({ min: 1, max: 3 }) }, () =>
          generateInlineEmoji(),
        )
      : [],
  };
}

function generateReplyMessage(
  users: DiscordUser[],
  currentTime: Date,
): DiscordMessage {
  const msg = generateDefaultMessage(users, currentTime);
  return {
    ...msg,
    type: "Reply",
    content: generateReplyContent(),
    reference: {
      messageId:
        faker.helpers.maybe(() => nextMessageId(), { probability: 0.9 }) ??
        null,
      channelId: nextChannelId(),
      guildId: GUILD_ID,
    },
  };
}

function generateGuildMemberJoin(
  users: DiscordUser[],
  currentTime: Date,
): DiscordMessage {
  const author = pick(users);
  return {
    id: nextMessageId(),
    type: "GuildMemberJoin",
    timestamp: generateTimestamp(currentTime),
    timestampEdited: null,
    callEndedTimestamp: null,
    isPinned: false,
    content: "Joined the server.",
    author,
    attachments: [],
    embeds: [],
    stickers: [],
    reactions: [],
    mentions: [],
    inlineEmojis: [],
  };
}

function generateThreadCreated(
  users: DiscordUser[],
  currentTime: Date,
): DiscordMessage {
  const author = pick(users);
  return {
    id: nextMessageId(),
    type: "ThreadCreated",
    timestamp: generateTimestamp(currentTime),
    timestampEdited: null,
    callEndedTimestamp: null,
    isPinned: false,
    content: "Started a thread.",
    author,
    attachments: [],
    embeds: [],
    stickers: [],
    reactions: [],
    mentions: [],
    reference: {
      messageId: null,
      channelId: nextChannelId(),
      guildId: GUILD_ID,
    },
    inlineEmojis: [],
  };
}

const MESSAGE_GENERATORS = [
  { gen: generateDefaultMessage, weight: 0.75 },
  { gen: generateReplyMessage, weight: 0.18 },
  { gen: generateGuildMemberJoin, weight: 0.05 },
  { gen: generateThreadCreated, weight: 0.02 },
];

function pickMessageGenerator() {
  const r = faker.number.float();
  let cumulative = 0;
  for (const entry of MESSAGE_GENERATORS) {
    cumulative += entry.weight;
    if (r <= cumulative) return entry.gen;
  }
  return generateDefaultMessage;
}

function generateMessages(
  users: DiscordUser[],
  count: number,
  startDate: Date,
): DiscordMessage[] {
  const messages: DiscordMessage[] = [];
  const endDate = new Date("2024-06-01");

  for (let i = 0; i < count; i++) {
    const progress = i / count;
    const time = new Date(
      startDate.getTime() +
        (endDate.getTime() - startDate.getTime()) * progress,
    );
    time.setHours(time.getHours() + faker.number.int({ min: -12, max: 12 }));
    time.setMinutes(faker.number.int({ min: 0, max: 59 }));

    const gen = pickMessageGenerator();
    messages.push(gen(users, time));
  }

  return messages;
}

// ─── Channel / export generators ──────────────────────────────────────────

function generateTextChannelExport(
  category: { name: string; id: string },
  users: DiscordUser[],
  messageCount: number,
): DiscordExport & { channelInfo: ChannelInfo } {
  const channelId = nextChannelId();
  const channelName = generateChannelName();
  const channelTopic = generateChannelTopic();
  const startDate = new Date("2022-02-01");

  return {
    guild: {
      id: GUILD_ID,
      name: generateGuildName(),
      iconUrl: generateGuildIconUrl(),
    },
    channel: {
      id: channelId,
      type: "GuildTextChat",
      categoryId: category.id,
      category: category.name,
      name: channelName,
      topic: channelTopic,
    },
    dateRange: {
      after: null,
      before: null,
    },
    exportedAt: "2025-02-19T01:39:29.8139051+00:00",
    messageCount,
    messages: generateMessages(users, messageCount, startDate),
    channelInfo: {
      id: channelId,
      name: channelName,
      categoryId: category.id,
      category: category.name,
    },
  };
}

function generateThreadExport(
  parentChannel: ChannelInfo,
  users: DiscordUser[],
  messageCount: number,
): DiscordExport {
  const channelId = nextChannelId();
  const threadName = generateThreadName();
  const startDate = new Date("2022-06-01");

  return {
    guild: {
      id: GUILD_ID,
      name: generateGuildName(),
      iconUrl: generateGuildIconUrl(),
    },
    channel: {
      id: channelId,
      type: "GuildPublicThread",
      categoryId: parentChannel.categoryId,
      category: parentChannel.category,
      name: threadName,
      topic: null,
    },
    dateRange: {
      after: null,
      before: null,
    },
    exportedAt: "2025-02-19T04:14:32.4806343+00:00",
    messageCount,
    messages: generateMessages(users, messageCount, startDate),
  };
}

function generateVoiceChannelExport(category: {
  name: string;
  id: string;
}): DiscordExport {
  const channelId = nextChannelId();
  return {
    guild: {
      id: GUILD_ID,
      name: generateGuildName(),
      iconUrl: generateGuildIconUrl(),
    },
    channel: {
      id: channelId,
      type: "GuildVoiceChat",
      categoryId: category.id,
      category: category.name,
      name: faker.helpers.arrayElement([
        "Lounge",
        "General",
        "Hangout",
        "Chill",
        "Conference",
      ]),
      topic: null,
    },
    dateRange: {
      after: null,
      before: null,
    },
    exportedAt: "2025-02-19T04:14:32.4806343+00:00",
    messageCount: 0,
    messages: [],
  };
}

function generateAnnouncementChannelExport(
  category: { name: string; id: string },
  users: DiscordUser[],
  messageCount: number,
): DiscordExport {
  const channelId = nextChannelId();
  const startDate = new Date("2023-01-01");

  return {
    guild: {
      id: GUILD_ID,
      name: generateGuildName(),
      iconUrl: generateGuildIconUrl(),
    },
    channel: {
      id: channelId,
      type: "GuildNews",
      categoryId: category.id,
      category: category.name,
      name: "announcements",
      topic: generateChannelTopic() ?? "Official announcements.",
    },
    dateRange: {
      after: null,
      before: null,
    },
    exportedAt: "2025-02-19T04:14:32.4806343+00:00",
    messageCount,
    messages: generateMessages(users, messageCount, startDate),
  };
}

function sanitizeFileName(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Generate fake Discord export JSON files matching the shape of real
Discord exports in gitignore/MuniTown/.

All names (guild, category, channel, thread, role, emoji) are generated
dynamically from diverse faker sources. Image URLs use faker.image.

Usage:
  bun run src/scripts/generate-fake-data.ts [options]

Options:
  --channels <n>     Number of text channels (default: random 8-19)
  --threads <n>      Number of threads (default: random 100-300)
  --messages <n>     Messages per channel (default: random 600-12000 each)
  --thread-msgs <n>  Messages per thread (default: random 2-50 each)
  --outdir <dir>     Output directory (default: ./data/fake-exports)
  --seed <n>         Random seed for reproducibility (default: 42)
  --quick            Small-scale run for testing (8 channels, 20 threads,~50 msgs)
  --help, -h         Show this help message

Examples:
  bun run src/scripts/generate-fake-data.ts --seed 1
  bun run src/scripts/generate-fake-data.ts --quick
  bun run src/scripts/generate-fake-data.ts --channels 12 --threads 200 --outdir ./my-data
`);
    process.exit(0);
  }

  const isQuick = args.includes("--quick");

  const channelFlag = args.indexOf("--channels");
  const threadFlag = args.indexOf("--threads");
  const messageFlag = args.indexOf("--messages");
  const threadMsgFlag = args.indexOf("--thread-msgs");
  const outdirFlag = args.indexOf("--outdir");
  const seedFlag = args.indexOf("--seed");

  const channelCount = isQuick
    ? 8
    : channelFlag >= 0
      ? parseInt(args[channelFlag + 1] ?? "12", 10)
      : faker.number.int({ min: 8, max: 19 });
  const threadCount = isQuick
    ? 20
    : threadFlag >= 0
      ? parseInt(args[threadFlag + 1] ?? "150", 10)
      : faker.number.int({ min: 100, max: 300 });
  const messagesPerChannelRange = isQuick
    ? { min: 30, max: 80 }
    : messageFlag >= 0
      ? {
          min: parseInt(args[messageFlag + 1] ?? "3000", 10),
          max: parseInt(args[messageFlag + 1] ?? "3000", 10),
        }
      : { min: 600, max: 12000 };
  const messagesPerThreadRange = isQuick
    ? { min: 2, max: 10 }
    : threadMsgFlag >= 0
      ? {
          min: parseInt(args[threadMsgFlag + 1] ?? "10", 10),
          max: parseInt(args[threadMsgFlag + 1] ?? "10", 10),
        }
      : { min: 2, max: 50 };
  const seed = seedFlag >= 0 ? parseInt(args[seedFlag + 1] ?? "42", 10) : 42;
  const outdir =
    outdirFlag >= 0
      ? (args[outdirFlag + 1] ?? "./data/fake-exports")
      : "./data/fake-exports";

  faker.seed(seed);

  // Generate consistent user pool
  const userCount = faker.number.int({ min: 40, max: 120 });
  const users = Array.from({ length: userCount }, () => generateUser());

  // Generate dynamic categories
  const categories = generateCategories(channelCount);
  const voiceCategory = { name: "Voice Channels", id: "938334993191690000" };

  console.log(`Generating fake Discord export data...`);
  console.log(`  Seed: ${seed}`);
  console.log(`  Users: ${userCount}`);
  console.log(
    `  Channels: ${channelCount} (${messagesPerChannelRange.min.toLocaleString()}–${messagesPerChannelRange.max.toLocaleString()} msgs each)`,
  );
  console.log(
    `  Threads: ${threadCount} (${messagesPerThreadRange.min}–${messagesPerThreadRange.max} msgs each)`,
  );
  console.log(`  Output: ${outdir}`);
  console.log();

  // Wipe any previous data and recreate
  await fs.rm(outdir, { recursive: true, force: true });
  await fs.mkdir(outdir, { recursive: true });

  // ────── Step 1: Generate text channels ──────
  console.log("Generating channels...");
  const channelExports: Array<DiscordExport & { channelInfo: ChannelInfo }> =
    [];
  for (const category of categories) {
    const msgCount = faker.number.int(messagesPerChannelRange);
    const exp = generateTextChannelExport(category, users, msgCount);
    channelExports.push(exp);
    console.log(`  📁 ${exp.channel.name} (${msgCount.toLocaleString()} msgs)`);
  }

  // ────── Step 2: Generate threads, distributed across channels ──────
  console.log("Generating threads...");
  const channelInfos = channelExports.map((e) => e.channelInfo);
  const threadExports: DiscordExport[] = [];
  for (let i = 0; i < threadCount; i++) {
    const parentChannel = faker.helpers.arrayElement(channelInfos);
    const msgCount = faker.number.int(messagesPerThreadRange);
    const exp = generateThreadExport(parentChannel, users, msgCount);
    threadExports.push(exp);
    if ((i + 1) % 50 === 0) {
      console.log(`  🧵 ${i + 1}/${threadCount} threads`);
    }
  }
  console.log(`  🧵 ${threadCount}/${threadCount} threads — done`);

  // ────── Step 3: Voice channel ──────
  const voiceExport = generateVoiceChannelExport(voiceCategory);

  // ────── Step 4: Announcement channel ──────
  const firstCat = categories[0];
  const announcementExport = firstCat
    ? generateAnnouncementChannelExport(
        firstCat,
        users,
        faker.number.int({ min: 5, max: 40 }),
      )
    : null;

  // ────── Step 5: Write all exports ──────
  const allExports = [
    ...channelExports,
    ...threadExports,
    voiceExport,
    ...(announcementExport ? [announcementExport] : []),
  ];

  console.log();
  console.log(`Writing ${allExports.length} files...`);

  for (const exp of allExports) {
    // Strip internal-only channelInfo before writing
    const raw = exp as unknown as Record<string, unknown>;
    const cleaned: Record<string, unknown> = {};
    for (const key of Object.keys(raw)) {
      if (key !== "channelInfo") cleaned[key] = raw[key]!;
    }
    const category = sanitizeFileName(exp.channel.category);
    const channelName = sanitizeFileName(exp.channel.name);
    const channelId = exp.channel.id;
    const fileName = `Fake Town - ${category} - ${channelName} [${channelId}].json`;
    const filePath = path.join(outdir, fileName);
    await fs.writeFile(filePath, JSON.stringify(cleaned, null, 2), "utf-8");
  }

  const totalMessages =
    channelExports.reduce((s, e) => s + e.messages.length, 0) +
    threadExports.reduce((s, e) => s + e.messages.length, 0) +
    (announcementExport?.messages.length ?? 0);

  console.log();
  console.log("Summary:");
  console.log(`  Channels:       ${channelExports.length}`);
  console.log(`  Threads:        ${threadExports.length}`);
  console.log(`  Voice:          1`);
  console.log(`  Announcements:  ${announcementExport ? 1 : 0}`);
  console.log(`  Total files:    ${allExports.length}`);
  console.log(`  Total messages: ${totalMessages.toLocaleString()}`);
  console.log(`  Written to:     ${outdir}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

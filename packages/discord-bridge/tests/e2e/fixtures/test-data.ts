/**
 * E2E test fixtures.
 * Expected test data structure based on the manual test guild.
 */

/**
 * Test guild structure (ID: 1465918107951562837).
 *
 * This is the "source of truth" for what the test guild contains.
 * If the guild structure changes, update this file.
 */

export const TEST_GUILD_ID = "1465918107951562837";

export interface ExpectedChannel {
  /** Channel name */
  name: string;
  /** Channel ID (snowflake) */
  id: string;
  /** Parent category name, if any */
  parent?: string;
  /** Expected message count */
  messageCount: number;
  /** Whether this is a forum channel */
  isForum?: boolean;
}

export interface ExpectedCategory {
  /** Category name */
  name: string;
  /** Channels in this category */
  channels: ExpectedChannel[];
}

/**
 * Expected test guild structure.
 */
export const TEST_GUILD_STRUCTURE: {
  categories: ExpectedCategory[];
  orphanChannels: ExpectedChannel[];
} = {
  categories: [
    {
      name: "Text Channels",
      channels: [
        {
          name: "general",
          id: "1465918108652695552",
          messageCount: 5,
        },
        {
          name: "forum-channel",
          id: "1469103021765038284",
          isForum: true,
          messageCount: 0,
        },
      ],
    },
    {
      name: "Voice Channels",
      channels: [
        {
          name: "General",
          id: "1469103327533527066",
          messageCount: 0,
        },
      ],
    },
    {
      name: "Development",
      channels: [
        {
          name: "dev-general",
          id: "1469103195146817576",
          messageCount: 1,
        },
        {
          name: "bugs",
          id: "1469103211076325396",
          messageCount: 1,
        },
      ],
    },
  ],
  orphanChannels: [],
};

/**
 * Get all expected text channels (excluding forums and voice).
 */
export function getExpectedTextChannels(): ExpectedChannel[] {
  const textChannels: ExpectedChannel[] = [];

  for (const cat of TEST_GUILD_STRUCTURE.categories) {
    for (const ch of cat.channels) {
      // Skip forums and voice channels
      if (!ch.isForum && ch.messageCount >= 0) {
        textChannels.push(ch);
      }
    }
  }

  return textChannels;
}

/**
 * Get expected channels by category.
 */
export function getExpectedChannelsByCategory(): Map<string, ExpectedChannel[]> {
  const byCategory = new Map<string, ExpectedChannel[]>();

  for (const cat of TEST_GUILD_STRUCTURE.categories) {
    byCategory.set(cat.name, cat.channels);
  }

  return byCategory;
}

/**
 * Expected messages in #general.
 */
export const EXPECTED_GENERAL_MESSAGES = [
  "a message that becomes the start of a thread",
  "a message I have edited",
  "message with an image attachment",
] as const;

/**
 * Expected messages in #dev-general.
 */
export const EXPECTED_DEV_GENERAL_MESSAGES = [
  "dev channel message",
] as const;

/**
 * Expected messages in #bugs.
 */
export const EXPECTED_BUGS_MESSAGES = [
  "bugs channel message",
] as const;

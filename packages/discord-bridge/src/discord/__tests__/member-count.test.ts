/**
 * Unit tests for DiscordMemberCountProvider.
 *
 * Covers: cached-members path (members.size), the getGuild counts fallback,
 * and the undefined-on-error path.
 */

import { describe, expect, test } from "bun:test";
import { DiscordMemberCountProvider } from "../member-count.ts";

const GUILD = "123456789012345670";
const GUILD_ID = BigInt(GUILD);

interface FakeBot {
	cache: {
		guilds: {
			memory: {
				get: (id: bigint) =>
					| { members?: { size: number } }
					| undefined;
			};
		};
	};
	helpers: {
		getGuild: (
			id: bigint,
			opts?: { counts?: boolean },
		) => Promise<{ approximateMemberCount?: number }>;
	};
}

function makeBot(): FakeBot & {
	calls: { getGuild: Array<{ id: bigint; opts?: { counts?: boolean } }> };
} {
	const calls: { getGuild: Array<{ id: bigint; opts?: { counts?: boolean } }> } =
		{ getGuild: [] };
	const bot: FakeBot = {
		cache: {
			guilds: {
				memory: {
					get: () => undefined,
				},
			},
		},
		helpers: {
			getGuild: async (id, opts) => {
				calls.getGuild.push({ id, opts });
				return { approximateMemberCount: 42 };
			},
		},
	};
	return { ...bot, calls };
}

function provider(bot: FakeBot): DiscordMemberCountProvider {
	return new DiscordMemberCountProvider(bot as never);
}

describe("DiscordMemberCountProvider", () => {
	test("uses the cached members collection size when present", async () => {
		const bot = makeBot();
		bot.cache.guilds.memory.get = () => ({ members: { size: 7 } });
		const p = provider(bot);

		expect(await p.getMemberCount(GUILD)).toBe(7);
		expect(bot.calls.getGuild.length).toBe(0);
	});

	test("falls back to getGuild with counts when no cached members", async () => {
		const bot = makeBot();
		const p = provider(bot);

		expect(await p.getMemberCount(GUILD)).toBe(42);
		expect(bot.calls.getGuild).toEqual([
			{ id: GUILD_ID, opts: { counts: true } },
		]);
	});

	test("returns undefined when getGuild throws", async () => {
		const bot = makeBot();
		bot.helpers.getGuild = async () => {
			throw new Error("rate limited");
		};
		const p = provider(bot);

		expect(await p.getMemberCount(GUILD)).toBeUndefined();
	});
});

/**
 * DiscordMemberCountProvider: supplies a bridged guild's current member
 * count for capacity checks.
 *
 * Source order (per the capacity contract):
 * 1. Guild cache from @discordeno/bot — when the cached guild carries a
 *    `members` collection (only populated when members are cached in
 *    memory), the count is `members.size`.
 * 2. Fallback: `getGuild(guildId, { counts: true })` → `approximateMemberCount`
 *    (Discord's `with_counts` REST param).
 *
 * The bridge's cache config does not cache members in memory, so the
 * fallback is the effective path today; the cache branch exists so the
 * provider stays correct if the cache config changes.
 *
 * Bots count as members: Discord's member count (both the cached members
 * collection and `approximateMemberCount`) includes bots, and the capacity
 * contract treats every guild member as capacity-consuming. No precedent in
 * the codebase excludes bots, so none is applied here.
 */

import type { DiscordBotWithCache } from "./cache.ts";
import type { MemberCountProvider } from "../roomy/capacity.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("member-count");

export class DiscordMemberCountProvider implements MemberCountProvider {
	#bot: DiscordBotWithCache;

	constructor(bot: DiscordBotWithCache) {
		this.#bot = bot;
	}

	async getMemberCount(guildId: string): Promise<number | undefined> {
		const id = BigInt(guildId);

		const cached = this.#bot.cache.guilds.memory.get(id);
		if (cached?.members) {
			return cached.members.size;
		}

		try {
			const guild = await this.#bot.helpers.getGuild(id, { counts: true });
			return guild.approximateMemberCount;
		} catch (err) {
			log.warn(`getMemberCount failed for guild ${guildId}`, err);
			return undefined;
		}
	}
}

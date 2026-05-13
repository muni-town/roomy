/**
 * Discovers all DIDs with records in the space.roomy.space.personal.dev collection
 * via com.atproto.sync.listReposByCollection on the relay.
 *
 * Usage: bun run scripts/discover-personal-streams.ts
 */

const COLLECTION = "space.roomy.space.personal";
const RELAY = "https://bsky.network";
const LIMIT = 2000;

interface RepoEntry {
  did: string;
}

interface ListReposResponse {
  cursor?: string;
  repos: RepoEntry[];
}

async function discoverAllDIDs(): Promise<string[]> {
  const allDids: string[] = [];
  let cursor: string | undefined;
  let page = 0;

  while (true) {
    const params = new URLSearchParams({
      collection: COLLECTION,
      limit: String(LIMIT),
    });
    if (cursor) params.set("cursor", cursor);

    const url = `${RELAY}/xrpc/com.atproto.sync.listReposByCollection?${params}`;
    const res = await fetch(url);

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status}: ${body}`);
    }

    const data = (await res.json()) as ListReposResponse;
    page++;

    console.log(
      `Page ${page}: got ${data.repos.length} DIDs (total: ${allDids.length + data.repos.length})`
    );

    for (const repo of data.repos) {
      allDids.push(repo.did);
    }

    if (!data.cursor || data.repos.length < LIMIT) break;
    cursor = data.cursor;
  }

  return allDids;
}

const dids = await discoverAllDIDs();
console.log(`\nTotal DIDs with ${COLLECTION} records: ${dids.length}`);
await Bun.write(
  "scripts/discovered-personal-streams.json",
  JSON.stringify({ collection: COLLECTION, count: dids.length, dids }, null, 2)
);
console.log("Written to scripts/discovered-personal-streams.json");

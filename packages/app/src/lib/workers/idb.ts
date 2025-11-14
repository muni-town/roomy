import { CONFIG } from "$lib/config";
import Dexie, { type EntityTable } from "dexie";

interface KeyValue {
  key: string;
  value: string;
}
export const db = new Dexie("mini-shared-worker-db") as Dexie & {
  kv: EntityTable<KeyValue, "key">;
  streamCursors: EntityTable<
    { streamId: string; latestEvent: number },
    "streamId"
  >;
};
db.version(1).stores({
  kv: `key`,
  streamCursors: `streamId`,
});

// Helpers for caching the personal stream ID in the key-value store.
export const personalStream = {
  async getIdCache(did: string): Promise<string | undefined> {
    return (
      await db.kv.get(`personalStreamId-${CONFIG.streamSchemaVersion}-${did}`)
    )?.value;
  },
  async setIdCache(did: string, value: string): Promise<void> {
    await db.kv.put({
      key: `personalStreamId-${CONFIG.streamSchemaVersion}-${did}`,
      value,
    });
  },
  async clearIdCache() {
    await db.kv.filter((x) => x.key.startsWith("personalStreamId-")).delete();
  },
};

// Helpers for getting/setting the previous stream schema version in the key-value store.
export const prevStream = {
  async getSchemaVersion(): Promise<string | undefined> {
    return (await db.kv.get("previousStreamSchemaVersion"))?.value;
  },
  async setSchemaVersion(version: string) {
    await db.kv.put({ key: "previousStreamSchemaVersion", value: version });
  },
};

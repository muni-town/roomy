import { CONFIG } from "$lib/config";
import Dexie, { type EntityTable } from "dexie";
import type { DidStream } from "$lib/schema";

interface KeyValue {
  key: string;
  value: string;
}
export const db = new Dexie("mini-shared-worker-db") as Dexie & {
  kv: EntityTable<KeyValue, "key">;
};
db.version(1).stores({
  kv: `key`,
});

// Helpers for caching the personal stream ID in the key-value store.
export const personalStream = {
  async getIdCache(did: string): Promise<DidStream | undefined> {
    return (
      await db.kv.get(`personalStreamId-${CONFIG.streamSchemaVersion}-${did}`)
    )?.value as DidStream;
  },
  async setIdCache(did: string, value: DidStream): Promise<void> {
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

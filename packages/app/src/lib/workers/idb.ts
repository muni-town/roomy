import { CONFIG } from "$lib/config";
import Dexie, { type EntityTable } from "dexie";
import type { StreamHashId } from "./types";

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
  async getIdCache(did: string): Promise<StreamHashId | undefined> {
    return (
      await db.kv.get(`personalStreamId-${CONFIG.streamSchemaVersion}-${did}`)
    )?.value as StreamHashId;
  },
  async setIdCache(did: string, value: StreamHashId): Promise<void> {
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

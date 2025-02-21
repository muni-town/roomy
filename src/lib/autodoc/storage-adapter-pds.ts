import { Agent } from "@atproto/api";
import type { StorageInterface } from "./storage";
import * as base64 from "js-base64";
import { resolveDid } from "../utils";

export class RoomyPdsStorageAdapter implements StorageInterface {
  agent: Agent;

  /** Additional DIDs that records will be _downloaded from_. Obviously we cannot delete or change
   * the records, but they can contribute to our synchronization. */
  additionalDids: string[];
  additionalAgents: Promise<{ [did: string]: Agent }> = Promise.resolve({});

  static async buildKey(key: string[]): Promise<string> {
    if (key.some((x) => x.includes("\0")))
      throw "Cannot encode paths containing null bytes";
    const data = new Uint8Array(new TextEncoder().encode(key.join("\0")));
    const hash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(data)),
    );
    return base64.fromUint8Array(hash, true);
  }

  constructor(agent: Agent, ...additionalDids: string[]) {
    this.agent = agent;
    this.additionalDids = additionalDids;
    this.additionalAgents = (async () => {
      const agents: { [did: string]: Agent } = {};
      for (const did of additionalDids) {
        const didDoc = await resolveDid(did);
        if (!didDoc) throw `Could not resolve DID doc for ${did}`;
        const pdsService = (didDoc.service || []).find(
          (x) => x.id === "#atproto_pds",
        );
        if (!pdsService || typeof pdsService.serviceEndpoint !== "string")
          throw `Could not resolve PDS service for ${did}`;
        agents[did] = new Agent(pdsService.serviceEndpoint);
      }

      return agents;
    })();
  }

  static async *listRecords(
    agent: Agent,
    did: string,
    prefix: string[],
  ): AsyncIterable<{ key: string[]; blobCid: string; did: string }> {
    let cursor: string | undefined;

    do {
      const resp = await agent.com.atproto.repo.listRecords({
        collection: "chat.roomy.v1.store",
        repo: did,
        cursor,
        limit: 100,
      });
      if (!resp.success) throw `Error listing records from PDS: ${resp}`;

      cursor = resp.data.cursor;

      for (const record of resp.data.records) {
        const rdata = record.value as {
          key: string[];
          data: { ref: { toString(): string } };
        };
        let prefixMatches = true;
        for (let i = 0; i < prefix.length; i++) {
          if (prefix[i] != rdata.key[i]) {
            prefixMatches = false;
            break;
          }
        }
        if (prefixMatches) {
          yield {
            blobCid: rdata.data.ref.toString(),
            key: rdata.key,
            did: did,
          };
        }
      }
    } while (cursor);
  }

  async load(key: string[]): Promise<Uint8Array | undefined> {
    const resp = await this.agent.com.atproto.repo.getRecord({
      collection: "chat.roomy.v1.store",
      repo: this.agent.assertDid,
      rkey: await RoomyPdsStorageAdapter.buildKey(key),
    });
    if (!resp.success) return undefined;
    const blob = await this.agent.com.atproto.sync.getBlob({
      cid: resp.data.ref!.toString(),
      did: this.agent.assertDid,
    });
    if (!blob.success) return undefined;
    return blob.data;
  }
  async save(key: string[], data: Uint8Array): Promise<void> {
    const resp = await this.agent.uploadBlob(data);
    if (!resp.success)
      throw `Error uploading blob to PDS ( \`${key}\` ): ${resp}`;
    const putResp = await this.agent.com.atproto.repo.putRecord({
      collection: "chat.roomy.v1.store",
      repo: this.agent.assertDid,
      rkey: await RoomyPdsStorageAdapter.buildKey(key),
      record: {
        key,
        data: resp.data.blob,
      },
    });
    if (!putResp.success) throw `Error putting store record to PDS: ${resp}`;
  }
  async remove(key: string[]): Promise<void> {
    const resp = await this.agent.com.atproto.repo.deleteRecord({
      collection: "chat.roomy.v1.store",
      repo: this.agent.assertDid,
      rkey: await RoomyPdsStorageAdapter.buildKey(key),
    });
    if (!resp.success)
      throw `Error deleting record from PDS ( \`${key}\` ): ${resp}`;
  }
  async loadRange(
    key: string[],
  ): Promise<{ key: string[]; data: Uint8Array | undefined }[]> {
    const records: { key: string[]; data: Uint8Array | undefined }[] = [];

    for (const did of [this.agent.assertDid, ...this.additionalDids]) {
      const a =
        did == this.agent.assertDid
          ? this.agent
          : (await this.additionalAgents)[did];

      for await (const record of RoomyPdsStorageAdapter.listRecords(
        a,
        did,
        key,
      )) {
        const resp = await a.com.atproto.sync.getBlob({
          cid: record.blobCid,
          did,
        });
        if (!resp.success) console.warn("Error downloading blob", resp);
        records.push({
          key: record.key,
          data: resp.success ? new Uint8Array(resp.data.buffer) : undefined,
        });
      }
    }

    return records;
  }
  async removeRange(key: string[]): Promise<void> {
    for await (const record of RoomyPdsStorageAdapter.listRecords(
      this.agent,
      this.agent.assertDid,
      key,
    )) {
      if (record.did == this.agent.assertDid) {
        const resp = await this.agent.com.atproto.repo.deleteRecord({
          repo: this.agent.assertDid,
          collection: "chat.roomy.v1.store",
          rkey: await RoomyPdsStorageAdapter.buildKey(record.key),
        });
        if (!resp.success) console.warn("Error deleting record", resp.data);
      }
    }
  }
}

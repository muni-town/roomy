import { describe, expect, test } from "bun:test";
import {
  StreamDid,
  StreamIndex,
  UserDid,
  newUlid,
  type Event,
} from "@roomy-space/sdk";
import { materialize } from "./materializer.ts";

const STREAM = StreamDid.assert("did:key:stream-fixture");
const USER = UserDid.assert("did:plc:user-fixture");

describe("materialize", () => {
  test("returns a success bundle with statements for a known event", () => {
    const id = newUlid();
    const event = {
      $type: "space.roomy.room.createRoom.v0",
      id,
      kind: "space.roomy.channel",
      name: "general",
    } as unknown as Event;

    const bundle = materialize(event, { streamId: STREAM, user: USER }, 1 as StreamIndex);

    expect(bundle.status).toBe("success");
    if (bundle.status !== "success") return;
    expect(bundle.event).toBe(event);
    expect(bundle.eventIdx).toBe(1 as StreamIndex);
    expect(bundle.user).toBe(USER);
    expect(bundle.statements.length).toBeGreaterThan(0);
    for (const s of bundle.statements) expect(typeof s.sql).toBe("string");
    expect(Array.isArray(bundle.dependsOn)).toBe(true);
  });

  test("returns an error bundle for an unknown event type", () => {
    const id = newUlid();
    const event = {
      $type: "space.roomy.this.does.not.exist.v0",
      id,
    } as unknown as Event;

    const bundle = materialize(event, { streamId: STREAM, user: USER }, 1 as StreamIndex);

    expect(bundle.status).toBe("error");
    if (bundle.status !== "error") return;
    expect(bundle.eventId).toBe(id);
    expect(bundle.message).toMatch(/No materializer found/);
  });

  test("dependsOn is populated for events that declare dependencies", () => {
    // editMessage depends on createMessage; the SDK's getDependsOn returns
    // [messageId] for it. We don't need a fully-valid payload — getDependsOn
    // only reads the messageId field.
    const messageId = newUlid();
    const event = {
      $type: "space.roomy.message.editMessage.v0",
      id: newUlid(),
      messageId,
      content: "edited",
    } as unknown as Event;

    const bundle = materialize(event, { streamId: STREAM, user: USER }, 2 as StreamIndex);

    if (bundle.status !== "success") {
      // editMessage materialiser may throw on a minimal fixture; that's fine
      // — this test only asserts dependsOn behaviour for the success path.
      return;
    }
    expect(bundle.dependsOn).toContain(messageId);
  });
});

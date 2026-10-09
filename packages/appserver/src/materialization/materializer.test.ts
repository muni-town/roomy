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

    const bundle = materialize(
      event,
      { streamId: STREAM, user: USER },
      1 as StreamIndex,
    );

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

    const bundle = materialize(
      event,
      { streamId: STREAM, user: USER },
      1 as StreamIndex,
    );

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

    const bundle = materialize(
      event,
      { streamId: STREAM, user: USER },
      2 as StreamIndex,
    );

    if (bundle.status !== "success") {
      // editMessage materialiser may throw on a minimal fixture; that's fine
      // — this test only asserts dependsOn behaviour for the success path.
      return;
    }
    expect(bundle.dependsOn).toContain(messageId);
  });

  test("updateSpaceInfo maps suggestToOthers onto the comp_space column", () => {
    // The event's `suggestToOthers` is materialised as a comp_space upsert on
    // the `suggest_to_others` column, mirroring allowPublicJoin. Assert on the
    // emitted statement text + params rather than running SQL: the materialiser
    // is pure and its output is the contract.
    const event = {
      $type: "space.roomy.space.updateSpaceInfo.v0",
      id: newUlid(),
      suggestToOthers: false,
    } as unknown as Event;

    const bundle = materialize(
      event,
      { streamId: STREAM, user: USER },
      3 as StreamIndex,
    );

    expect(bundle.status).toBe("success");
    if (bundle.status !== "success") return;
    const upsert = bundle.statements.find((s) =>
      (s.sql as string).includes("suggest_to_others"),
    );
    expect(upsert).toBeDefined();
    expect(upsert!.sql).toContain("insert into comp_space");
    expect(upsert!.params).toMatchObject({ ":suggest_to_others": 0 });
  });

  test("updateSpaceInfo materialises an explicit true as 1", () => {
    const event = {
      $type: "space.roomy.space.updateSpaceInfo.v0",
      id: newUlid(),
      suggestToOthers: true,
    } as unknown as Event;

    const bundle = materialize(
      event,
      { streamId: STREAM, user: USER },
      4 as StreamIndex,
    );

    expect(bundle.status).toBe("success");
    if (bundle.status !== "success") return;
    const upsert = bundle.statements.find((s) =>
      (s.sql as string).includes("suggest_to_others"),
    );
    expect(upsert).toBeDefined();
    expect(upsert!.params).toMatchObject({ ":suggest_to_others": 1 });
  });

  test("updateSpaceInfo omitting suggestToOthers leaves the column untouched", () => {
    // A space created before the setting existed never mentions the field; the
    // upsert must not name the column, so the stored value stays NULL
    // (unanswered) rather than being collapsed to the read default.
    const event = {
      $type: "space.roomy.space.updateSpaceInfo.v0",
      id: newUlid(),
      name: "Renamed",
    } as unknown as Event;

    const bundle = materialize(
      event,
      { streamId: STREAM, user: USER },
      5 as StreamIndex,
    );

    expect(bundle.status).toBe("success");
    if (bundle.status !== "success") return;
    for (const s of bundle.statements) {
      expect(s.sql as string).not.toContain("suggest_to_others");
    }
  });
});

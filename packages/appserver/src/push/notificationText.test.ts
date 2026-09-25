import { describe, expect, test } from "bun:test";
// The visible-notification renderer lives in app-lite (it's what the
// service worker runs on every decrypted push); the contract test lives here
// with the rest of the push-payload tests because app-lite has no test
// suite (see AGENTS.md) and this is exactly the server↔client payload
// contract the appserver owns. It renders synthetic payloads the way the
// service worker does, including the payload shape the server must never
// emit: authorName absent but authorDid known must still render the author,
// never "New message".
import { notificationText } from "../../../app-lite/src/lib/notificationText";

const DID = "did:plc:abcdef";
const ROOM = "general";

describe("push/notificationText — visible notification render", () => {
  test("message push renders the author in the title", () => {
    const { title, body } = notificationText({
      type: "message",
      roomName: ROOM,
      authorName: "Alice",
      messageContent: "hello world",
    });
    expect(title).toBe("Alice in general");
    expect(body).toBe("hello world");
  });

  test("message push body names the author when there is no content", () => {
    const { title, body } = notificationText({
      type: "message",
      roomName: ROOM,
      authorName: "Alice",
    });
    expect(title).toBe("Alice in general");
    expect(body).toBe("Alice sent a message");
  });

  test("authorName absent but authorDid known renders the DID, not 'New message'", () => {
    // Legacy/synthetic payload: the server always resolves a name now, but a
    // payload missing authorName must still name the author by DID.
    const { title, body } = notificationText({
      type: "message",
      roomName: ROOM,
      authorDid: DID,
    });
    expect(title).toBe(`${DID} in general`);
    expect(body).toBe(`${DID} sent a message`);
    expect(title).not.toContain("New message");
    expect(body).not.toBe("New message");
  });

  test("no author at all still falls back to 'New message' (no DID to name)", () => {
    const { title, body } = notificationText({
      type: "message",
      roomName: ROOM,
    });
    expect(title).toBe("New message in general");
    expect(body).toBe("New message");
  });

  test("digest push renders the author in the title", () => {
    const { title, body } = notificationText({
      type: "digest",
      roomName: ROOM,
      authorName: "Alice",
      count: 5,
    });
    expect(title).toBe("Alice in general");
    expect(body).toBe("5 new messages");
  });

  test("digest with authorDid only still names the author", () => {
    const { title } = notificationText({
      type: "digest",
      roomName: ROOM,
      authorDid: DID,
      count: 3,
    });
    expect(title).toBe(`${DID} in general`);
  });

  test("digest without any author keeps the count-based title (legacy payloads)", () => {
    const { title, body } = notificationText({
      type: "digest",
      roomName: ROOM,
      count: 5,
    });
    expect(title).toBe("5 new messages in general");
    expect(body).toBe("5 new messages");
  });

  test("empty payload (malformed push) renders the generic fallback", () => {
    const { title, body } = notificationText({});
    expect(title).toBe("New message in a room");
    expect(body).toBe("New message");
  });
});

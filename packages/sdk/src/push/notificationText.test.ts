import { describe, expect, it } from "vitest";
// The visible-notification renderer. It lives in the SDK because the appserver
// (which renders the APNs `aps.alert` and FCM `notification` text at send time)
// and the browser service worker (which renders a decrypted web push) must
// agree: the same payload has to read the same way whichever transport carried
// it. The test covers the shape of every payload the server builds, including
// one it must never emit — authorName absent but authorDid known, which must
// still name the author rather than reading "New message".
import { notificationText } from "../../src/push/notificationText";

const DID = "did:plc:abcdef";
const ROOM = "general";

describe("push/notificationText — visible notification render", () => {
  it("message push renders the author in the title", () => {
    const { title, body } = notificationText({
      type: "message",
      roomName: ROOM,
      authorName: "Alice",
      messageContent: "hello world",
    });
    expect(title).toBe("Alice in general");
    expect(body).toBe("hello world");
  });

  it("message push body names the author when there is no content", () => {
    const { title, body } = notificationText({
      type: "message",
      roomName: ROOM,
      authorName: "Alice",
    });
    expect(title).toBe("Alice in general");
    expect(body).toBe("Alice sent a message");
  });

  it("authorName absent but authorDid known renders the DID, not 'New message'", () => {
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

  it("no author at all still falls back to 'New message' (no DID to name)", () => {
    const { title, body } = notificationText({
      type: "message",
      roomName: ROOM,
    });
    expect(title).toBe("New message in general");
    expect(body).toBe("New message");
  });

  it("digest push renders the author in the title", () => {
    const { title, body } = notificationText({
      type: "digest",
      roomName: ROOM,
      authorName: "Alice",
      count: 5,
    });
    expect(title).toBe("Alice in general");
    expect(body).toBe("5 new messages");
  });

  it("digest with authorDid only still names the author", () => {
    const { title } = notificationText({
      type: "digest",
      roomName: ROOM,
      authorDid: DID,
      count: 3,
    });
    expect(title).toBe(`${DID} in general`);
  });

  it("digest without any author keeps the count-based title (legacy payloads)", () => {
    const { title, body } = notificationText({
      type: "digest",
      roomName: ROOM,
      count: 5,
    });
    expect(title).toBe("5 new messages in general");
    expect(body).toBe("5 new messages");
  });

  it("empty payload (malformed push) renders the generic fallback", () => {
    const { title, body } = notificationText({});
    expect(title).toBe("New message in a room");
    expect(body).toBe("New message");
  });
});

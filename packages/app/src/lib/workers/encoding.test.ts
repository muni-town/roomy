import { assert, expect, test, describe } from "vitest";

import { Hash, id, IdCodec, Ulid, Kinds2, eventCodec } from "./encoding";
import { monotonicFactory, ulid } from "ulidx";
import { Struct, str, u32, _void } from "scale-ts";

const exampleHash =
  "fbef79b1f9e2facd237e0b131b96c17a47b2e9ea9c9f7e0632c0816b905e0e9d";
const exampleDiscordDid = "did:discord:429339531339060482";

test("ulid encoding round trip", () => {
  // Round trip 15 ulids
  for (let i = 0; i < 15; i++) {
    const u = ulid();
    const u2 = Ulid.dec(Ulid.enc(u));
    assert(u2 == u, `${u} != ${u2}`);
  }
});

test("ulid monotonic factory encoding round trip", () => {
  const ulid = monotonicFactory();
  // Round trip 15 ulids
  for (let i = 0; i < 15; i++) {
    const u = ulid();
    const u2 = Ulid.dec(Ulid.enc(u));

    assert(u == u2, `${u} != ${u2}`);
  }
});

test("hash encoding round trip", () => {
  assert(Hash.dec(Hash.enc(exampleHash)) == exampleHash);
});

test("ID encoding round trip", () => {
  assert(IdCodec.dec(id(exampleDiscordDid)) == exampleDiscordDid);
  assert(IdCodec.dec(id(exampleHash)) == exampleHash);
  const u = ulid();
  assert(IdCodec.dec(id(u)) == u);
});

describe("Kinds codec", () => {
  // Create a test codec with several variants
  const testKindsCodec = Kinds2({
    "test.void": _void,
    "test.string": str,
    "test.number": u32,
    "test.struct": Struct({
      name: str,
      value: u32,
    }),
  });

  test("known variant round-trip: void", () => {
    const data = { kind: "test.void" as const, data: undefined };
    const encoded = testKindsCodec.enc(data);
    const decoded = testKindsCodec.dec(encoded);

    expect(decoded.kind).toBe("test.void");
    expect(decoded.data).toBeUndefined();
  });

  test("known variant round-trip: string", () => {
    const data = { kind: "test.string" as const, data: "Hello, World!" };
    const encoded = testKindsCodec.enc(data);
    const decoded = testKindsCodec.dec(encoded);

    expect(decoded.kind).toBe("test.string");
    expect(decoded.data).toBe("Hello, World!");
  });

  test("known variant round-trip: number", () => {
    const data = { kind: "test.number" as const, data: 42 };
    const encoded = testKindsCodec.enc(data);
    const decoded = testKindsCodec.dec(encoded);

    expect(decoded.kind).toBe("test.number");
    expect(decoded.data).toBe(42);
  });

  test("known variant round-trip: struct", () => {
    const data = {
      kind: "test.struct" as const,
      data: { name: "Alice", value: 123 },
    };
    const encoded = testKindsCodec.enc(data);
    const decoded = testKindsCodec.dec(encoded);

    expect(decoded.kind).toBe("test.struct");
    expect(decoded.data).toEqual({ name: "Alice", value: 123 });
  });

  test("unknown variant is returned as raw bytes", () => {
    // Create a codec that has an extra variant
    const extendedCodec = Kinds2({
      "test.void": _void,
      "test.string": str,
      "test.number": u32,
      "test.struct": Struct({
        name: str,
        value: u32,
      }),
      "test.future": str, // This is the "future" variant
    });

    // Encode with the extended codec
    const futureData = {
      kind: "test.future" as const,
      data: "Future value",
    };
    const encoded = extendedCodec.enc(futureData);

    // Decode with the original codec (doesn't know about "test.future")
    const decoded = testKindsCodec.dec(encoded);

    expect(decoded.kind).toBe("test.future");
    expect(decoded.data).toBeInstanceOf(Uint8Array);

    // Verify we can re-decode the raw bytes with the proper codec
    const reDecoded = str.dec(decoded.data as unknown as Uint8Array);
    expect(reDecoded).toBe("Future value");
  });

  test("multiple unknown variants can be skipped", () => {
    // Create a codec with multiple extra variants
    const extendedCodec = Kinds2({
      "test.void": _void,
      "test.string": str,
      "test.number": u32,
      "test.struct": Struct({
        name: str,
        value: u32,
      }),
      "test.future1": str,
      "test.future2": u32,
    });

    // Encode multiple variants including unknown ones
    const variant1 = extendedCodec.enc({
      kind: "test.future1" as const,
      data: "Unknown 1",
    });
    const variant2 = extendedCodec.enc({
      kind: "test.string" as const,
      data: "Known",
    });
    const variant3 = extendedCodec.enc({
      kind: "test.future2" as const,
      data: 999,
    });

    // Decode each with the original codec
    const decoded1 = testKindsCodec.dec(variant1);
    expect(decoded1.kind).toBe("test.future1");
    expect(decoded1.data).toBeInstanceOf(Uint8Array);

    const decoded2 = testKindsCodec.dec(variant2);
    expect(decoded2.kind).toBe("test.string");
    expect(decoded2.data).toBe("Known");

    const decoded3 = testKindsCodec.dec(variant3);
    expect(decoded3.kind).toBe("test.future2");
    expect(decoded3.data).toBeInstanceOf(Uint8Array);
  });

  test("empty data is handled correctly", () => {
    const data = { kind: "test.void" as const, data: undefined };
    const encoded = testKindsCodec.enc(data);
    const decoded = testKindsCodec.dec(encoded);

    expect(decoded.kind).toBe("test.void");
    expect(decoded.data).toBeUndefined();
  });

  test("large data is handled correctly", () => {
    // Create a large string (> 256 bytes to test compact encoding)
    const largeString = "a".repeat(1000);
    const data = { kind: "test.string" as const, data: largeString };
    const encoded = testKindsCodec.enc(data);
    const decoded = testKindsCodec.dec(encoded);

    expect(decoded.kind).toBe("test.string");
    expect(decoded.data).toBe(largeString);
  });
});

describe("space.roomy.message.create.1 codec", () => {
  test("message with image extension round-trip", () => {
    const messageId = ulid();
    const event = {
      ulid: messageId,
      parent: undefined,
      variant: {
        kind: "space.roomy.message.create.1" as const,
        data: {
          content: {
            mimeType: "text/plain",
            content: new TextEncoder().encode("Hello world!"),
          },
          extensions: [
            {
              kind: "space.roomy.image.0" as const,
              data: {
                uri: "https://example.com/image.jpg",
                mimeType: "image/jpeg",
                alt: "A test image",
                height: 1080,
                width: 1920,
                blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
                size: 524288,
              },
            },
          ],
        },
      },
    };

    const encoded = eventCodec.enc(event);
    console.log(`Encoded message size: ${encoded.length} bytes`);
    console.log("First 50 bytes:", Array.from(encoded.slice(0, 50)));

    const decoded = eventCodec.dec(encoded);

    expect(decoded.ulid).toBe(messageId);
    expect(decoded.parent).toBeUndefined();
    expect(decoded.variant.kind).toBe("space.roomy.message.create.1");

    // Type narrowing
    if (decoded.variant.kind !== "space.roomy.message.create.1") {
      throw new Error("Wrong variant kind");
    }

    expect(decoded.variant.data.extensions).toHaveLength(1);
    expect(decoded.variant.data.extensions[0]?.kind).toBe(
      "space.roomy.image.0",
    );
    expect(decoded.variant.data.extensions[0]?.data).toEqual({
      uri: "https://example.com/image.jpg",
      mimeType: "image/jpeg",
      alt: "A test image",
      height: 1080,
      width: 1920,
      blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
      size: 524288,
    });
  });

  test("message with video extension round-trip", () => {
    const messageId = ulid();
    const event = {
      ulid: messageId,
      parent: undefined,
      variant: {
        kind: "space.roomy.message.create.1" as const,
        data: {
          content: {
            mimeType: "text/plain",
            content: new TextEncoder().encode("Check this out!"),
          },
          extensions: [
            {
              kind: "space.roomy.video.0" as const,
              data: {
                uri: "https://example.com/video.mp4",
                mimeType: "video/mp4",
                alt: "A test video",
                height: 720,
                width: 1280,
                length: 120,
                blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
                size: 10485760,
              },
            },
          ],
        },
      },
    };

    const encoded = eventCodec.enc(event);
    const decoded = eventCodec.dec(encoded);

    expect(decoded.variant.kind).toBe("space.roomy.message.create.1");

    // Type narrowing
    if (decoded.variant.kind !== "space.roomy.message.create.1") {
      throw new Error("Wrong variant kind");
    }

    expect(decoded.variant.data.extensions[0]?.kind).toBe(
      "space.roomy.video.0",
    );
  });

  test("message with multiple extensions round-trip", () => {
    const messageId = ulid();
    const event = {
      ulid: messageId,
      parent: undefined,
      variant: {
        kind: "space.roomy.message.create.1" as const,
        data: {
          content: {
            mimeType: "text/plain",
            content: new TextEncoder().encode("Multiple attachments"),
          },
          extensions: [
            {
              kind: "space.roomy.image.0" as const,
              data: {
                uri: "https://example.com/image1.jpg",
                mimeType: "image/jpeg",
                alt: undefined,
                height: 1080,
                width: 1920,
                blurhash: undefined,
                size: 524288,
              },
            },
            {
              kind: "space.roomy.link.0" as const,
              data: {
                uri: "https://example.com",
                showPreview: true,
              },
            },
            {
              kind: "space.roomy.file.0" as const,
              data: {
                uri: "https://example.com/document.pdf",
                mimeType: "application/pdf",
                name: "document.pdf",
                size: 1048576,
              },
            },
          ],
        },
      },
    };

    const encoded = eventCodec.enc(event);
    console.log(
      `Encoded message with multiple extensions size: ${encoded.length} bytes`,
    );

    const decoded = eventCodec.dec(encoded);

    expect(decoded.variant.kind).toBe("space.roomy.message.create.1");

    // Type narrowing
    if (decoded.variant.kind !== "space.roomy.message.create.1") {
      throw new Error("Wrong variant kind");
    }

    expect(decoded.variant.data.extensions).toHaveLength(3);
    expect(decoded.variant.data.extensions[0]?.kind).toBe(
      "space.roomy.image.0",
    );
    expect(decoded.variant.data.extensions[1]?.kind).toBe("space.roomy.link.0");
    expect(decoded.variant.data.extensions[2]?.kind).toBe("space.roomy.file.0");
  });

  test("message with empty extensions array", () => {
    const messageId = ulid();
    const event = {
      ulid: messageId,
      parent: undefined,
      variant: {
        kind: "space.roomy.message.create.1" as const,
        data: {
          content: {
            mimeType: "text/plain",
            content: new TextEncoder().encode("No extensions"),
          },
          extensions: [],
        },
      },
    };

    const encoded = eventCodec.enc(event);
    const decoded = eventCodec.dec(encoded);

    expect(decoded.variant.kind).toBe("space.roomy.message.create.1");

    // Type narrowing
    if (decoded.variant.kind !== "space.roomy.message.create.1") {
      throw new Error("Wrong variant kind");
    }

    expect(decoded.variant.data.extensions).toHaveLength(0);
  });
});

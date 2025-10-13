import { assert, expect, test } from "vitest";

import { Hash, id, IdCodec, Ulid } from "./encoding";
import { monotonicFactory, ulid } from "ulidx";

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

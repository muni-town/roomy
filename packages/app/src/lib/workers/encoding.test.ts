import { expect, test } from "vitest";

import { Hash, id, IdCodec, Ulid } from "./encoding";
import { ulid } from "ulidx";

const exampleHash =
  "fbef79b1f9e2facd237e0b131b96c17a47b2e9ea9c9f7e0632c0816b905e0e9d";
const exampleDiscordDid = "did:discord:429339531339060482";

test("ulid encoding round trip", () => {
  // Round trip 15 ulids
  for (let i = 0; i < 15; i++) {
    const u = ulid();
    expect(Ulid.dec(Ulid.enc(u)), u);
  }
});

test("hash encoding round trip", () => {
  expect(Hash.dec(Hash.enc(exampleHash)), exampleHash);
});

test("ID encoding round trip", () => {
  expect(IdCodec.dec(id(exampleDiscordDid)), exampleDiscordDid);
  expect(IdCodec.dec(id(exampleHash)), exampleHash);
  const u = ulid();
  expect(IdCodec.dec(id(u)), u);
});

import { expect, test } from "vitest";

import { Hash, Ulid } from "./encoding";
import { ulid } from "ulidx";

test("ulid encoding round trip", () => {
  // Round trip 15 ulids
  for (let i = 0; i < 15; i++) {
    const u = ulid();
    expect(Ulid.dec(Ulid.enc(u)), u);
  }
});

test("hash encoding round trip", () => {
  const id = "fbef79b1f9e2facd237e0b131b96c17a47b2e9ea9c9f7e0632c0816b905e0e9d";
  expect(Hash.dec(Hash.enc(id)), id);
});

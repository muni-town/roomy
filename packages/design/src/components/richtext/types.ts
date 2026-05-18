import type { Ulid } from "@roomy-space/sdk";

export type Comment = {
  snippet?: string; // limit length
  docVersion: Ulid; // ULID of the edit version
  from: number;
  to: number;
};

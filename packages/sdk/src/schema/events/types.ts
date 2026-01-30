import { Type } from "arktype";
import type { SqlStatement } from "../../types";
import { Event } from "../envelope";
import { Ulid, StreamDid, UserDid } from "../primitives";

/** Envelope fields added to all events */

export interface EventEnvelope {
  id: typeof Ulid.infer;
  room?: typeof Ulid.infer;
}
/** Context passed to materializer functions */

export interface MaterializeContext<T extends { $type: string }> {
  streamId: typeof StreamDid.infer;
  user: typeof UserDid.infer;
  event: Event<T["$type"]>;
}
/** Materializer function type */

export type MaterializeFn<T extends { $type: string }> = (
  ctx: MaterializeContext<T>,
) => SqlStatement[];
/** DependsOn function type - returns IDs that define causal dependencies */

export type DependsOnFn<T> = (
  event: T & EventEnvelope,
) => (typeof Ulid.infer)[];
/** Type for a defined event with materialize and optional dependsOn */

export type DefinedEvent<
  TSchema extends Type<{ $type: string }>,
  HasDependsOn extends boolean = false,
> = {
  schema: TSchema;
  materialize: MaterializeFn<TSchema["infer"]>;
  dependsOn: HasDependsOn extends true
    ? DependsOnFn<TSchema["infer"]>
    : undefined;
  create: (
    id: Ulid,
    data: TSchema["infer"] & { room?: Ulid },
  ) => Event<TSchema["infer"]["$type"]>;
};

type DeepMutable<T> = {
  -readonly [K in keyof T]: T[K] extends object ? DeepMutable<T[K]> : T[K];
};

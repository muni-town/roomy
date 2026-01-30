import { Type } from "arktype";
import { decodeTime } from "ulidx";
import type { EdgesMap, EdgesWithPayload, SqlStatement } from "../../types";
import { sql } from "../../utils/sqlTemplate";
import { DefinedEvent, DependsOnFn, MaterializeFn } from "./types";

/**
 * Define an event schema with materialize and dependsOn functions.
 */
export function defineEvent<TSchema extends Type<{ $type: string }>>(
  schema: TSchema,
  materialize: MaterializeFn<TSchema["infer"]>,
  dependsOn: DependsOnFn<TSchema["infer"]>,
): DefinedEvent<TSchema, true>;

/**
 * Define an event schema with only a materialize function.
 */
export function defineEvent<TSchema extends Type<{ $type: string }>>(
  schema: TSchema,
  materialize: MaterializeFn<TSchema["infer"]>,
): DefinedEvent<TSchema, false>;

export function defineEvent<TSchema extends Type<{ $type: string }>>(
  schema: TSchema,
  materialize: MaterializeFn<TSchema["infer"]>,
  dependsOn?: DependsOnFn<TSchema["infer"]>,
): DefinedEvent<TSchema, boolean> {
  return {
    schema,
    materialize,
    dependsOn,
  } as DefinedEvent<TSchema, boolean>;
}

/** Helper to create typed edge payloads */
export function edgePayload<EdgeLabelKey extends keyof EdgesWithPayload>(
  payload: EdgesMap[EdgeLabelKey],
): string {
  return JSON.stringify(payload);
}

/** Helper to ensure an entity exists in the database */
export function ensureEntity(
  streamId: string,
  entityId: string,
  room?: string,
): SqlStatement {
  let unixTimeMs = Date.now();

  try {
    // Try to decode timestamp from ULID
    unixTimeMs = decodeTime(entityId);
  } catch (_) {}

  return sql`
    insert into entities (id, stream_id, room, created_at)
    values (
      ${entityId},
      ${streamId},
      ${room ? room : undefined},
      ${unixTimeMs}
    )
    on conflict(id) do update set
      room = coalesce(entities.room, excluded.room),
      updated_at = case
        when entities.room is null and excluded.room is not null
        then excluded.updated_at
        else entities.updated_at
      end
  `;
}

/**
 * Shared types for the SDK
 */

/** A SQL statement with optional parameters */
export interface SqlStatement {
  sql: string;
  params?: BindingSpec;
  /** If true, the query will be pre-compiled and cached */
  cache?: boolean;
}

/** Copied from SQLite WASM Exports */

/** Types of values that can be passed to/retrieved from SQLite. */
declare type SqlValue =
  | string
  | number
  | null
  | bigint
  | Uint8Array
  | Int8Array
  | ArrayBuffer;

/** Types of values that can be passed to SQLite. */
declare type BindableValue =
  | SqlValue
  /** Converted to NULL */
  | undefined
  /** Converted to INTEGER */
  | boolean;

/** Specifies parameter bindings. */
declare type BindingSpec =
  | readonly BindableValue[]
  | { [paramName: string]: BindableValue }
  /** Assumed to have binding index `1` */
  | (SqlValue | boolean);

/** Schema Edges */

// Edge types for relationships
export type EdgeLabel = "member" | "ban" | "link";

export interface EdgeBan {
  reason: string;
  banned_by: string;
}

export interface EdgeMember {
  can: "read" | "post" | "admin";
}

export interface EdgesWithPayload {
  ban: EdgeBan;
  member: EdgeMember;
}

export type EdgesMap = {
  [K in Exclude<EdgeLabel, keyof EdgesWithPayload>]: null;
} & EdgesWithPayload;

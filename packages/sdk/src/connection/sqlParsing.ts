import type { SqlValue } from "@muni-town/leaf-client";

/**
 * Type helper: Convert SqlValue wrapper type to its primitive value type.
 *
 * Examples:
 * - { $type: "muni.town.sqliteValue.integer", value: 42 } → number
 * - { $type: "muni.town.sqliteValue.text", value: "hello" } → string
 * - { $type: "muni.town.sqliteValue.null" } → null
 * - undefined → undefined
 */
export type SqlValueToPrimitive<T> =
  T extends { $type: 'muni.town.sqliteValue.null' } ? null :
  T extends { $type: 'muni.town.sqliteValue.integer', value: infer V } ? V :
  T extends { $type: 'muni.town.sqliteValue.real', value: infer V } ? V :
  T extends { $type: 'muni.town.sqliteValue.text', value: infer V } ? V :
  T extends { $type: 'muni.town.sqliteValue.blob', value: infer V } ? V :
  T extends undefined ? undefined :
  unknown;

/**
 * Unwrap a single SQLite value wrapper.
 *
 * Extracts the `.value` property from SQLite value wrappers,
 * providing type narrowing based on the $type field.
 *
 * @param value - A SQLite value wrapper or undefined
 * @returns The unwrapped primitive value (null | number | string | Uint8Array | undefined)
 *
 * @example
 * ```typescript
 * const wrapped = { $type: "muni.town.sqliteValue.text", value: "hello" };
 * const unwrapped = unwrapSqlValue(wrapped); // "hello"
 * ```
 */
export function unwrapSqlValue<T extends SqlValue>(
  value: T | undefined
): SqlValueToPrimitive<T> {
  if (value === undefined || value === null) {
    return undefined as any;
  }
  if (value.$type === 'muni.town.sqliteValue.null') {
    return null as any;
  }
  // All other types have a .value property
  return (value as any).value;
}

/**
 * Unwrap all values in a SQL row.
 *
 * Converts a row of SQLite value wrappers to their primitive types.
 *
 * @param row - A SQL row with wrapped values
 * @returns A new object with unwrapped primitive values
 *
 * @example
 * ```typescript
 * const row = {
 *   id: { $type: "muni.town.sqliteValue.integer", value: 42 },
 *   name: { $type: "muni.town.sqliteValue.text", value: "Alice" },
 * };
 * const unwrapped = unwrapSqlRow(row); // { id: 42, name: "Alice" }
 * ```
 */
export function unwrapSqlRow<T extends Record<string, SqlValue>>(
  row: T
): { [K in keyof T]: SqlValueToPrimitive<T[K]> } {
  const unwrapped = {} as any;
  for (const key in row) {
    unwrapped[key] = unwrapSqlValue(row[key]);
  }
  return unwrapped;
}

/**
 * Unwrap all rows in a SQL result set.
 *
 * Converts an array of rows with wrapped values to their primitive types.
 *
 * @param rows - An array of SQL rows with wrapped values
 * @returns An array of rows with unwrapped primitive values
 *
 * @example
 * ```typescript
 * const rows = [
 *   { id: { $type: "muni.town.sqliteValue.integer", value: 1 } },
 *   { id: { $type: "muni.town.sqliteValue.integer", value: 2 } },
 * ];
 * const unwrapped = unwrapSqlRows(rows); // [{ id: 1 }, { id: 2 }]
 * ```
 */
export function unwrapSqlRows<T extends Record<string, SqlValue>>(
  rows: T[]
): Array<{ [K in keyof T]: SqlValueToPrimitive<T[K]> }> {
  return rows.map(unwrapSqlRow);
}

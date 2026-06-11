import { expect } from "bun:test";

/** Assert that a value is defined (NonNullable) — narrows the type for TypeScript. */
export function expectToBeDefined<T>(
	value: T,
): asserts value is NonNullable<T> {
	expect(value).toBeDefined();
}

export function expectToBe<T, V extends T>(
	value: T,
	toBe: V,
): asserts value is V {
	expect(value).toBe(toBe);
}

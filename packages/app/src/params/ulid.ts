import { type, Ulid } from "@roomy/sdk";
import type { ParamMatcher } from "@sveltejs/kit";

export const match = ((param: string) => {
  try {
    const result = Ulid(param);
    if (result instanceof type.errors) return false;
    else return true;
  } catch (_) {
    return false;
  }
}) satisfies ParamMatcher;

import { Did, type } from "$lib/schema";
import type { ParamMatcher } from "@sveltejs/kit";

export const match = ((param: string) => {
  try {
    const result = Did(param);
    if (result instanceof type.errors) return false;
    else return true;
  } catch (_) {
    return false;
  }
}) satisfies ParamMatcher;

import { did, type } from "$lib/schema";
import type { ParamMatcher } from "@sveltejs/kit";

export const match = ((param: string) => {
  try {
    const result = did(param);
    if (result instanceof type.errors) return false;
    else return true;
  } catch (_) {
    return false;
  }
}) satisfies ParamMatcher;

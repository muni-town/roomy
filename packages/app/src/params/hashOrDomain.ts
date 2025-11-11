import type { ParamMatcher } from "@sveltejs/kit";
import { Hash } from "$lib/workers/encoding";

export const match = ((param: string) => {
  try {
    Hash.dec(param);
    return true;
  } catch (_) {
    return param.includes(".");
  }
}) satisfies ParamMatcher;

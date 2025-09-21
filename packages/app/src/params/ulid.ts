import type { ParamMatcher } from "@sveltejs/kit";
import { Ulid } from "$lib/workers/encoding";

export const match = ((param: string) => {
  try {
    Ulid.dec(param);
    return true;
  } catch (_) {
    return false;
  }
}) satisfies ParamMatcher;

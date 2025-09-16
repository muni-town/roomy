import type { ParamMatcher } from "@sveltejs/kit";
import { hex } from "@scure/base";

export const match = ((param: string) => {
  try {
    const bytes = hex.decode(param);
    return bytes.length == 32;
  } catch (_) {
    return false;
  }
}) satisfies ParamMatcher;

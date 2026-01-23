import type { ParamMatcher } from "@sveltejs/kit";

import { match as didMatch } from "./did";
import { match as domainMatch } from "./domain";

export const match = ((param: string) => {
  return domainMatch(param) || didMatch(param);
}) satisfies ParamMatcher;

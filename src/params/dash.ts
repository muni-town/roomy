import type { ParamMatcher } from "@sveltejs/kit";

export const match = ((param: string) => {
  return param === "-";
}) satisfies ParamMatcher;

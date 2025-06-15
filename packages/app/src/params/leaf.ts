import type { ParamMatcher } from "@sveltejs/kit";

export const match = ((param: string) => {
  return param.startsWith("leaf:");
}) satisfies ParamMatcher;

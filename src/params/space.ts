import type { ParamMatcher } from "@sveltejs/kit";

export const match = ((param: string) => {
  return param.startsWith("leaf:") || param.includes(".");
}) satisfies ParamMatcher;

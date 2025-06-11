import type { ParamMatcher } from "@sveltejs/kit";

export const match = ((param: string) => {
  return param.startsWith("co_");
}) satisfies ParamMatcher;

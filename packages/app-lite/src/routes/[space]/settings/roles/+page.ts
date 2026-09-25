import { redirect } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

// Deep links to the retired Roles route redirect to Permissions so bookmarks
// keep working.
export const load: PageLoad = ({ params }) => {
  throw redirect(307, `/${params.space}/settings/permissions`);
};

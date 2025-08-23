import type { Reroute } from "@sveltejs/kit";

export const reroute: Reroute = ({ url }) => {
  // FIXME: hack to make muni.town resolve for now
  const muniTown = "/muni.town";
  console.log("url", url.pathname);
  if (url.pathname.startsWith(muniTown)) {
    return (
      "/co_zgr1XyZyG3MHjswMoep5Na2eKr9" + url.pathname.slice(muniTown.length)
    );
  }
};

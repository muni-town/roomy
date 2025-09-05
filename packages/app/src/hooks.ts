import type { Reroute } from "@sveltejs/kit";

export const reroute: Reroute = ({ url }) => {
  // FIXME: hack to make muni.town resolve for now
  const muniTown = "/muni.town";
  const spicyLobster = "/spicylobster.itch.io";
  if (url.pathname.startsWith(muniTown)) {
    return (
      "/co_zgr1XyZyG3MHjswMoep5Na2eKr9" + url.pathname.slice(muniTown.length)
    );
  } else if (url.pathname.startsWith(spicyLobster)) {
    return (
      "/co_zGrLp9i59rcFeZCoW9KjULCbPkg" +
      url.pathname.slice(spicyLobster.length)
    );
  }
};

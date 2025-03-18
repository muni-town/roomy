import { y as pop, w as push } from "../../../../../chunks/index.js";
import "@atproto/oauth-client-browser";
import "../../../../../chunks/user.svelte.js";
function _page($$payload, $$props) {
  push();
  {
    $$payload.out += "<!--[!-->";
  }
  $$payload.out += `<!--]-->`;
  pop();
}
export {
  _page as default
};

import { y as pop, w as push } from "../../../../../chunks/index.js";
import "@atproto/oauth-client-browser";
import "@atproto/api";
import "@automerge/automerge-repo-storage-indexeddb";
import "@atproto/lexicon";
import "base32-encode";
import "base32-decode";
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

import "./client.js";
import { T as getContext } from "./index.js";
function context() {
  return getContext("__request__");
}
const page$1 = {
  get error() {
    return context().page.error;
  },
  get params() {
    return context().page.params;
  },
  get status() {
    return context().page.status;
  },
  get url() {
    return context().page.url;
  }
};
const page = page$1;
export {
  page as p
};

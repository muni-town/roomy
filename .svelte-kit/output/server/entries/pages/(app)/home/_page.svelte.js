import { I as ensure_array_like, z as escape_html, K as attr, y as pop, w as push } from "../../../../chunks/index.js";
import { g } from "../../../../chunks/global.svelte.js";
function _page($$payload, $$props) {
  push();
  let servers = g.catalog?.view.spaces.map((x) => x.id) || [];
  $$payload.out += `<header class="hero bg-base-200 min-h-screen"><div class="hero-content"><div class="flex flex-col gap-8 items-center"><h1 class="text-5xl font-bold">Hello Roomy</h1> <p class="text-lg font-medium max-w-2xl text-center">A digital gardening platform for communities. Built on the AT Protocol. 
        Flourish in Spaces, curating knowledge and conversations together.</p> <div class="divider"></div> `;
  if (servers.length > 0) {
    $$payload.out += "<!--[-->";
    const each_array = ensure_array_like(servers);
    $$payload.out += `<h2 class="text-3xl font-bold">Your Spaces</h2> <section class="flex gap-4 flex-wrap justify-center max-w-5xl"><!--[-->`;
    for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
      let server = each_array[$$index];
      const space = g.spaces[server];
      if (space) {
        $$payload.out += "<!--[-->";
        $$payload.out += `<div class="card card-dash bg-base-100 w-96"><div class="card-body"><h2 class="card-title">${escape_html(space.view.name)}</h2> <div class="card-actions justify-end"><a${attr("href", `/space/${server}`)} class="btn btn-primary">Join Space</a></div></div></div>`;
      } else {
        $$payload.out += "<!--[!-->";
      }
      $$payload.out += `<!--]-->`;
    }
    $$payload.out += `<!--]--></section>`;
  } else {
    $$payload.out += "<!--[!-->";
    $$payload.out += `<p>No servers found.</p>`;
  }
  $$payload.out += `<!--]--></div></div></header>`;
  pop();
}
export {
  _page as default
};

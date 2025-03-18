function Layout($$payload, $$props) {
  let { children } = $$props;
  children($$payload);
  $$payload.out += `<!---->`;
}
export {
  Layout as default
};

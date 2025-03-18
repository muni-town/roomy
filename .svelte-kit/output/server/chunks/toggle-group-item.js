import { A as once, w as push, G as spread_attributes, E as bind_props, y as pop } from "./index.js";
import { E as ENTER, S as SPACE, C as Context, p as useRovingFocus, q as getDataOrientation, h as getDataDisabled, w as getAriaChecked, x as getAriaPressed, i as getDisabled, l as useId, n as noop, b as box, m as mergeProps } from "./button.js";
const TOGGLE_GROUP_ROOT_ATTR = "data-toggle-group-root";
const TOGGLE_GROUP_ITEM_ATTR = "data-toggle-group-item";
class ToggleGroupBaseState {
  opts;
  rovingFocusGroup;
  constructor(opts) {
    this.opts = opts;
    this.rovingFocusGroup = useRovingFocus({
      candidateAttr: TOGGLE_GROUP_ITEM_ATTR,
      rootNodeId: opts.id,
      loop: opts.loop,
      orientation: opts.orientation
    });
  }
  #props = once(() => ({
    id: this.opts.id.current,
    [TOGGLE_GROUP_ROOT_ATTR]: "",
    role: "group",
    "data-orientation": getDataOrientation(this.opts.orientation.current),
    "data-disabled": getDataDisabled(this.opts.disabled.current)
  }));
  get props() {
    return this.#props();
  }
}
class ToggleGroupSingleState extends ToggleGroupBaseState {
  opts;
  isMulti = false;
  #anyPressed = once(() => this.opts.value.current !== "");
  get anyPressed() {
    return this.#anyPressed();
  }
  constructor(opts) {
    super(opts);
    this.opts = opts;
  }
  includesItem(item) {
    return this.opts.value.current === item;
  }
  toggleItem(item, id) {
    if (this.includesItem(item)) {
      this.opts.value.current = "";
    } else {
      this.opts.value.current = item;
      this.rovingFocusGroup.setCurrentTabStopId(id);
    }
  }
}
class ToggleGroupMultipleState extends ToggleGroupBaseState {
  opts;
  isMulti = true;
  #anyPressed = once(() => this.opts.value.current.length > 0);
  get anyPressed() {
    return this.#anyPressed();
  }
  constructor(opts) {
    super(opts);
    this.opts = opts;
  }
  includesItem(item) {
    return this.opts.value.current.includes(item);
  }
  toggleItem(item, id) {
    if (this.includesItem(item)) {
      this.opts.value.current = this.opts.value.current.filter((v) => v !== item);
    } else {
      this.opts.value.current = [...this.opts.value.current, item];
      this.rovingFocusGroup.setCurrentTabStopId(id);
    }
  }
}
class ToggleGroupItemState {
  opts;
  root;
  #isDisabled = once(() => this.opts.disabled.current || this.root.opts.disabled.current);
  constructor(opts, root) {
    this.opts = opts;
    this.root = root;
    this.onclick = this.onclick.bind(this);
    this.onkeydown = this.onkeydown.bind(this);
  }
  #toggleItem() {
    if (this.#isDisabled()) return;
    this.root.toggleItem(this.opts.value.current, this.opts.id.current);
  }
  onclick(_) {
    if (this.#isDisabled()) return;
    this.root.toggleItem(this.opts.value.current, this.opts.id.current);
  }
  onkeydown(e) {
    if (this.#isDisabled()) return;
    if (e.key === ENTER || e.key === SPACE) {
      e.preventDefault();
      this.#toggleItem();
      return;
    }
    if (!this.root.opts.rovingFocus.current) return;
    this.root.rovingFocusGroup.handleKeydown(this.opts.ref.current, e);
  }
  #isPressed = once(() => this.root.includesItem(this.opts.value.current));
  get isPressed() {
    return this.#isPressed();
  }
  #ariaChecked = once(() => {
    return this.root.isMulti ? void 0 : getAriaChecked(this.isPressed, false);
  });
  #ariaPressed = once(() => {
    return this.root.isMulti ? getAriaPressed(this.isPressed) : void 0;
  });
  #tabIndex = 0;
  #snippetProps = once(() => ({ pressed: this.isPressed }));
  get snippetProps() {
    return this.#snippetProps();
  }
  #props = once(() => ({
    id: this.opts.id.current,
    role: this.root.isMulti ? void 0 : "radio",
    tabindex: this.#tabIndex,
    "data-orientation": getDataOrientation(this.root.opts.orientation.current),
    "data-disabled": getDataDisabled(this.#isDisabled()),
    "data-state": getToggleItemDataState(this.isPressed),
    "data-value": this.opts.value.current,
    "aria-pressed": this.#ariaPressed(),
    "aria-checked": this.#ariaChecked(),
    disabled: getDisabled(this.#isDisabled()),
    [TOGGLE_GROUP_ITEM_ATTR]: "",
    //
    onclick: this.onclick,
    onkeydown: this.onkeydown
  }));
  get props() {
    return this.#props();
  }
}
function getToggleItemDataState(condition) {
  return condition ? "on" : "off";
}
const ToggleGroupRootContext = new Context("ToggleGroup.Root");
function useToggleGroupRoot(props) {
  const { type, ...rest } = props;
  const rootState = type === "single" ? new ToggleGroupSingleState(rest) : new ToggleGroupMultipleState(rest);
  return ToggleGroupRootContext.set(rootState);
}
function useToggleGroupItem(props) {
  return new ToggleGroupItemState(props, ToggleGroupRootContext.get());
}
function Toggle_group($$payload, $$props) {
  push();
  let {
    id = useId(),
    ref = null,
    value = void 0,
    onValueChange = noop,
    type,
    disabled = false,
    loop = true,
    orientation = "horizontal",
    rovingFocus = true,
    child,
    children,
    $$slots,
    $$events,
    ...restProps
  } = $$props;
  if (value === void 0) {
    const defaultValue = type === "single" ? "" : [];
    value = defaultValue;
  }
  const rootState = useToggleGroupRoot({
    id: box.with(() => id),
    value: box.with(() => value, (v) => {
      value = v;
      onValueChange(v);
    }),
    disabled: box.with(() => disabled),
    loop: box.with(() => loop),
    orientation: box.with(() => orientation),
    rovingFocus: box.with(() => rovingFocus),
    type,
    ref: box.with(() => ref, (v) => ref = v)
  });
  const mergedProps = mergeProps(restProps, rootState.props);
  if (child) {
    $$payload.out += "<!--[-->";
    child($$payload, { props: mergedProps });
    $$payload.out += `<!---->`;
  } else {
    $$payload.out += "<!--[!-->";
    $$payload.out += `<div${spread_attributes({ ...mergedProps }, null)}>`;
    children?.($$payload);
    $$payload.out += `<!----></div>`;
  }
  $$payload.out += `<!--]-->`;
  bind_props($$props, { ref, value });
  pop();
}
function Toggle_group_item($$payload, $$props) {
  push();
  let {
    children,
    child,
    ref = null,
    value,
    disabled = false,
    id = useId(),
    type = "button",
    $$slots,
    $$events,
    ...restProps
  } = $$props;
  const itemState = useToggleGroupItem({
    id: box.with(() => id),
    value: box.with(() => value),
    disabled: box.with(() => disabled ?? false),
    ref: box.with(() => ref, (v) => ref = v)
  });
  const mergedProps = mergeProps(restProps, itemState.props, { type });
  if (child) {
    $$payload.out += "<!--[-->";
    child($$payload, { props: mergedProps, ...itemState.snippetProps });
    $$payload.out += `<!---->`;
  } else {
    $$payload.out += "<!--[!-->";
    $$payload.out += `<button${spread_attributes({ ...mergedProps }, null)}>`;
    children?.($$payload, itemState.snippetProps);
    $$payload.out += `<!----></button>`;
  }
  $$payload.out += `<!--]-->`;
  bind_props($$props, { ref });
  pop();
}
export {
  Toggle_group as T,
  Toggle_group_item as a
};

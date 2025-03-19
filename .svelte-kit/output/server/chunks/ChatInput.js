import { U as is_array, V as get_prototype_of, W as object_prototype, A as once, w as push, F as spread_props, y as pop, G as spread_attributes, E as bind_props, B as copy_payload, C as assign_payload, I as ensure_array_like, z as escape_html, T as getContext, x as setContext, J as fallback, X as slot, P as store_get, Q as unsubscribe_stores, Y as sanitize_props, Z as rest_props, _ as element, $ as store_set, a0 as invalid_default_snippet, K as attr, O as attr_class, M as attr_style } from "./index.js";
import "./client.js";
import { marked } from "marked";
import { isToday, format } from "date-fns";
import { decodeTime } from "ulidx";
import { g as getProfile, o as outerWidth, i as isAnnouncement } from "./profile.svelte.js";
import { u as unmount, m as mount, o as onDestroy, t as tick, I as Icon, h as html } from "./Icon.js";
import { C as Context, u as useRefById, w as watch, E as ENTER, S as SPACE, h as getDataDisabled, F as getAriaRequired, v as getAriaChecked, m as useId, b as box, o as mergeProps, i as getDataOpenClosed, j as getAriaExpanded, G as isElement$1, n as noop$2, I as useStateMachine, t as Presence_layer, q as useRovingFocus, c as getDisabled, r as getDataOrientation, B as Button, p as user } from "./button.js";
import "emoji-picker-element";
import { i as derived, j as get, w as writable, r as readable, k as readonly } from "./exports.js";
import { H as Hidden_input, P as Popper_layer_force_mount, a as Popper_layer, n as getFloatingContentCSSVars, b as Floating_layer_anchor, F as Floating_layer, o as tabbable, q as focusable, r as isTabbable, v as getTabIndex, w as isFocusable, A as Avatar, i as Avatar_image, j as Avatar_fallback, x as AvatarBeam, k as AvatarImage } from "./Toaster.svelte_svelte_type_style_lang.js";
import { p as page } from "./index2.js";
import "@automerge/automerge";
import "base32-encode";
import "base32-decode";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { keymap } from "@tiptap/pm/keymap";
import { PluginKey } from "@tiptap/pm/state";
import Mention from "@tiptap/extension-mention";
import sanitizeHtml from "sanitize-html";
import { mergeAttributes, getSchema, Extension, generateHTML } from "@tiptap/core";
const empty = [];
function snapshot(value, skip_warning = false) {
  return clone(value, /* @__PURE__ */ new Map(), "", empty);
}
function clone(value, cloned, path, paths, original = null) {
  if (typeof value === "object" && value !== null) {
    var unwrapped = cloned.get(value);
    if (unwrapped !== void 0) return unwrapped;
    if (value instanceof Map) return (
      /** @type {Snapshot<T>} */
      new Map(value)
    );
    if (value instanceof Set) return (
      /** @type {Snapshot<T>} */
      new Set(value)
    );
    if (is_array(value)) {
      var copy = (
        /** @type {Snapshot<any>} */
        Array(value.length)
      );
      cloned.set(value, copy);
      if (original !== null) {
        cloned.set(original, copy);
      }
      for (var i2 = 0; i2 < value.length; i2 += 1) {
        var element2 = value[i2];
        if (i2 in value) {
          copy[i2] = clone(element2, cloned, path, paths);
        }
      }
      return copy;
    }
    if (get_prototype_of(value) === object_prototype) {
      copy = {};
      cloned.set(value, copy);
      if (original !== null) {
        cloned.set(original, copy);
      }
      for (var key in value) {
        copy[key] = clone(value[key], cloned, path, paths);
      }
      return copy;
    }
    if (value instanceof Date) {
      return (
        /** @type {Snapshot<T>} */
        structuredClone(value)
      );
    }
    if (typeof /** @type {T & { toJSON?: any } } */
    value.toJSON === "function") {
      return clone(
        /** @type {T & { toJSON(): any } } */
        value.toJSON(),
        cloned,
        path,
        paths,
        // Associate the instance with the toJSON clone
        value
      );
    }
  }
  if (value instanceof EventTarget) {
    return (
      /** @type {Snapshot<T>} */
      value
    );
  }
  try {
    return (
      /** @type {Snapshot<T>} */
      structuredClone(value)
    );
  } catch (e2) {
    return (
      /** @type {Snapshot<T>} */
      value
    );
  }
}
function useDebounce(callback, wait = 250) {
  let context = null;
  function debounced(...args) {
    if (context) {
      if (context.timeout) {
        clearTimeout(context.timeout);
      }
    } else {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      context = {
        timeout: null,
        runner: null,
        promise,
        resolve,
        reject
      };
    }
    context.runner = async () => {
      if (!context) return;
      const ctx = context;
      context = null;
      try {
        ctx.resolve(await callback.apply(this, args));
      } catch (error) {
        ctx.reject(error);
      }
    };
    context.timeout = setTimeout(context.runner, typeof wait === "function" ? wait() : wait);
    return context.promise;
  }
  debounced.cancel = async () => {
    if (!context || context.timeout === null) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!context || context.timeout === null) return;
    }
    clearTimeout(context.timeout);
    context.reject("Cancelled");
    context = null;
  };
  debounced.runScheduledNow = async () => {
    if (!context || !context.timeout) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!context || !context.timeout) return;
    }
    clearTimeout(context.timeout);
    context.timeout = null;
    await context.runner?.();
  };
  Object.defineProperty(debounced, "pending", {
    enumerable: true,
    get() {
      return !!context?.timeout;
    }
  });
  return debounced;
}
class IsMounted {
  #isMounted = false;
  constructor() {
  }
  get current() {
    return this.#isMounted;
  }
}
const CHECKBOX_ROOT_ATTR = "data-checkbox-root";
class CheckboxRootState {
  opts;
  group;
  #trueName = once(() => {
    if (this.group && this.group.opts.name.current) {
      return this.group.opts.name.current;
    } else {
      return this.opts.name.current;
    }
  });
  get trueName() {
    return this.#trueName();
  }
  #trueRequired = once(() => {
    if (this.group && this.group.opts.required.current) {
      return true;
    }
    return this.opts.required.current;
  });
  get trueRequired() {
    return this.#trueRequired();
  }
  #trueDisabled = once(() => {
    if (this.group && this.group.opts.disabled.current) {
      return true;
    }
    return this.opts.disabled.current;
  });
  get trueDisabled() {
    return this.#trueDisabled();
  }
  constructor(opts, group = null) {
    this.opts = opts;
    this.group = group;
    this.onkeydown = this.onkeydown.bind(this);
    this.onclick = this.onclick.bind(this);
    useRefById(opts);
    watch.pre(
      [
        () => snapshot(this.group?.opts.value.current),
        () => this.opts.value.current
      ],
      ([groupValue, value]) => {
        if (!groupValue || !value) return;
        this.opts.checked.current = groupValue.includes(value);
      }
    );
    watch.pre(() => this.opts.checked.current, (checked) => {
      if (!this.group) return;
      if (checked) {
        this.group?.addValue(this.opts.value.current);
      } else {
        this.group?.removeValue(this.opts.value.current);
      }
    });
  }
  onkeydown(e2) {
    if (this.opts.disabled.current) return;
    if (e2.key === ENTER) e2.preventDefault();
    if (e2.key === SPACE) {
      e2.preventDefault();
      this.#toggle();
    }
  }
  #toggle() {
    if (this.opts.indeterminate.current) {
      this.opts.indeterminate.current = false;
      this.opts.checked.current = true;
    } else {
      this.opts.checked.current = !this.opts.checked.current;
    }
  }
  onclick(_2) {
    if (this.opts.disabled.current) return;
    this.#toggle();
  }
  #snippetProps = once(() => ({
    checked: this.opts.checked.current,
    indeterminate: this.opts.indeterminate.current
  }));
  get snippetProps() {
    return this.#snippetProps();
  }
  #props = once(() => ({
    id: this.opts.id.current,
    role: "checkbox",
    type: this.opts.type.current,
    disabled: this.trueDisabled,
    "aria-checked": getAriaChecked(this.opts.checked.current, this.opts.indeterminate.current),
    "aria-required": getAriaRequired(this.trueRequired),
    "data-disabled": getDataDisabled(this.trueDisabled),
    "data-state": getCheckboxDataState(this.opts.checked.current, this.opts.indeterminate.current),
    [CHECKBOX_ROOT_ATTR]: "",
    //
    onclick: this.onclick,
    onkeydown: this.onkeydown
  }));
  get props() {
    return this.#props();
  }
}
class CheckboxInputState {
  root;
  #trueChecked = once(() => {
    if (this.root.group) {
      if (this.root.opts.value.current !== void 0 && this.root.group.opts.value.current.includes(this.root.opts.value.current)) {
        return true;
      }
      return false;
    }
    return this.root.opts.checked.current;
  });
  get trueChecked() {
    return this.#trueChecked();
  }
  #shouldRender = once(() => Boolean(this.root.trueName));
  get shouldRender() {
    return this.#shouldRender();
  }
  constructor(root) {
    this.root = root;
  }
  #props = once(() => ({
    type: "checkbox",
    checked: this.root.opts.checked.current === true,
    disabled: this.root.trueDisabled,
    required: this.root.trueRequired,
    name: this.root.trueName,
    value: this.root.opts.value.current
  }));
  get props() {
    return this.#props();
  }
}
function getCheckboxDataState(checked, indeterminate) {
  if (indeterminate) return "indeterminate";
  return checked ? "checked" : "unchecked";
}
const CheckboxGroupContext = new Context("Checkbox.Group");
const CheckboxRootContext = new Context("Checkbox.Root");
function useCheckboxRoot(props, group) {
  return CheckboxRootContext.set(new CheckboxRootState(props, group));
}
function useCheckboxInput() {
  return new CheckboxInputState(CheckboxRootContext.get());
}
function Checkbox_input($$payload, $$props) {
  push();
  const inputState = useCheckboxInput();
  if (inputState.shouldRender) {
    $$payload.out += "<!--[-->";
    Hidden_input($$payload, spread_props([inputState.props]));
  } else {
    $$payload.out += "<!--[!-->";
  }
  $$payload.out += `<!--]-->`;
  pop();
}
function Checkbox($$payload, $$props) {
  push();
  let {
    checked = false,
    ref = null,
    onCheckedChange,
    children,
    disabled = false,
    required = false,
    name: name2 = void 0,
    value = "on",
    id = useId(),
    indeterminate = false,
    onIndeterminateChange,
    child,
    type = "button",
    $$slots,
    $$events,
    ...restProps
  } = $$props;
  const group = CheckboxGroupContext.getOr(null);
  if (group && value) {
    if (group.opts.value.current.includes(value)) {
      checked = true;
    } else {
      checked = false;
    }
  }
  const rootState = useCheckboxRoot(
    {
      checked: box.with(() => checked, (v) => {
        checked = v;
        onCheckedChange?.(v);
      }),
      disabled: box.with(() => disabled ?? false),
      required: box.with(() => required),
      name: box.with(() => name2),
      value: box.with(() => value),
      id: box.with(() => id),
      ref: box.with(() => ref, (v) => ref = v),
      indeterminate: box.with(() => indeterminate, (v) => {
        indeterminate = v;
        onIndeterminateChange?.(v);
      }),
      type: box.with(() => type)
    },
    group
  );
  const mergedProps = mergeProps({ ...restProps }, rootState.props);
  if (child) {
    $$payload.out += "<!--[-->";
    child($$payload, { props: mergedProps, ...rootState.snippetProps });
    $$payload.out += `<!---->`;
  } else {
    $$payload.out += "<!--[!-->";
    $$payload.out += `<button${spread_attributes({ ...mergedProps }, null)}>`;
    children?.($$payload, rootState.snippetProps);
    $$payload.out += `<!----></button>`;
  }
  $$payload.out += `<!--]--> `;
  Checkbox_input($$payload);
  $$payload.out += `<!---->`;
  bind_props($$props, { checked, ref, indeterminate });
  pop();
}
class PopoverRootState {
  opts;
  contentNode = null;
  triggerNode = null;
  constructor(opts) {
    this.opts = opts;
  }
  toggleOpen() {
    this.opts.open.current = !this.opts.open.current;
  }
  handleClose() {
    if (!this.opts.open.current) return;
    this.opts.open.current = false;
  }
}
class PopoverTriggerState {
  opts;
  root;
  constructor(opts, root) {
    this.opts = opts;
    this.root = root;
    useRefById({
      ...opts,
      onRefChange: (node) => {
        this.root.triggerNode = node;
      }
    });
    this.onclick = this.onclick.bind(this);
    this.onkeydown = this.onkeydown.bind(this);
  }
  onclick(e2) {
    if (this.opts.disabled.current) return;
    if (e2.button !== 0) return;
    this.root.toggleOpen();
  }
  onkeydown(e2) {
    if (this.opts.disabled.current) return;
    if (!(e2.key === ENTER || e2.key === SPACE)) return;
    e2.preventDefault();
    this.root.toggleOpen();
  }
  #getAriaControls() {
    if (this.root.opts.open.current && this.root.contentNode?.id) {
      return this.root.contentNode?.id;
    }
    return void 0;
  }
  #props = once(() => ({
    id: this.opts.id.current,
    "aria-haspopup": "dialog",
    "aria-expanded": getAriaExpanded(this.root.opts.open.current),
    "data-state": getDataOpenClosed(this.root.opts.open.current),
    "aria-controls": this.#getAriaControls(),
    "data-popover-trigger": "",
    disabled: this.opts.disabled.current,
    //
    onkeydown: this.onkeydown,
    onclick: this.onclick
  }));
  get props() {
    return this.#props();
  }
}
class PopoverContentState {
  opts;
  root;
  constructor(opts, root) {
    this.opts = opts;
    this.root = root;
    useRefById({
      ...opts,
      deps: () => this.root.opts.open.current,
      onRefChange: (node) => {
        this.root.contentNode = node;
      }
    });
  }
  onInteractOutside = (e2) => {
    this.opts.onInteractOutside.current(e2);
    if (e2.defaultPrevented) return;
    if (!isElement$1(e2.target)) return;
    const closestTrigger = e2.target.closest(`[data-popover-trigger]`);
    if (closestTrigger === this.root.triggerNode) return;
    this.root.handleClose();
  };
  onEscapeKeydown = (e2) => {
    this.opts.onEscapeKeydown.current(e2);
    if (e2.defaultPrevented) return;
    this.root.handleClose();
  };
  onCloseAutoFocus = (e2) => {
    this.opts.onCloseAutoFocus.current(e2);
    if (e2.defaultPrevented) return;
    e2.preventDefault();
    this.root.triggerNode?.focus();
  };
  #snippetProps = once(() => ({ open: this.root.opts.open.current }));
  get snippetProps() {
    return this.#snippetProps();
  }
  #props = once(() => ({
    id: this.opts.id.current,
    tabindex: -1,
    "data-state": getDataOpenClosed(this.root.opts.open.current),
    "data-popover-content": "",
    style: { pointerEvents: "auto" }
  }));
  get props() {
    return this.#props();
  }
  popperProps = {
    onInteractOutside: this.onInteractOutside,
    onEscapeKeydown: this.onEscapeKeydown,
    onCloseAutoFocus: this.onCloseAutoFocus
  };
}
const PopoverRootContext = new Context("Popover.Root");
function usePopoverRoot(props) {
  return PopoverRootContext.set(new PopoverRootState(props));
}
function usePopoverTrigger(props) {
  return new PopoverTriggerState(props, PopoverRootContext.get());
}
function usePopoverContent(props) {
  return new PopoverContentState(props, PopoverRootContext.get());
}
function Popover_content($$payload, $$props) {
  push();
  let {
    child,
    children,
    ref = null,
    id = useId(),
    forceMount = false,
    onCloseAutoFocus = noop$2,
    onEscapeKeydown = noop$2,
    onInteractOutside = noop$2,
    trapFocus = true,
    preventScroll: preventScroll2 = false,
    $$slots,
    $$events,
    ...restProps
  } = $$props;
  const contentState = usePopoverContent({
    id: box.with(() => id),
    ref: box.with(() => ref, (v) => ref = v),
    onInteractOutside: box.with(() => onInteractOutside),
    onEscapeKeydown: box.with(() => onEscapeKeydown),
    onCloseAutoFocus: box.with(() => onCloseAutoFocus)
  });
  const mergedProps = mergeProps(restProps, contentState.props);
  if (forceMount) {
    $$payload.out += "<!--[-->";
    {
      let popper = function($$payload2, { props, wrapperProps }) {
        const finalProps = mergeProps(props, {
          style: getFloatingContentCSSVars("popover")
        });
        if (child) {
          $$payload2.out += "<!--[-->";
          child($$payload2, {
            props: finalProps,
            wrapperProps,
            ...contentState.snippetProps
          });
          $$payload2.out += `<!---->`;
        } else {
          $$payload2.out += "<!--[!-->";
          $$payload2.out += `<div${spread_attributes({ ...wrapperProps }, null)}><div${spread_attributes({ ...finalProps }, null)}>`;
          children?.($$payload2);
          $$payload2.out += `<!----></div></div>`;
        }
        $$payload2.out += `<!--]-->`;
      };
      Popper_layer_force_mount($$payload, spread_props([
        mergedProps,
        contentState.popperProps,
        {
          enabled: contentState.root.opts.open.current,
          id,
          trapFocus,
          preventScroll: preventScroll2,
          loop: true,
          forceMount: true,
          popper,
          $$slots: { popper: true }
        }
      ]));
    }
  } else if (!forceMount) {
    $$payload.out += "<!--[1-->";
    {
      let popper = function($$payload2, { props, wrapperProps }) {
        const finalProps = mergeProps(props, {
          style: getFloatingContentCSSVars("popover")
        });
        if (child) {
          $$payload2.out += "<!--[-->";
          child($$payload2, {
            props: finalProps,
            wrapperProps,
            ...contentState.snippetProps
          });
          $$payload2.out += `<!---->`;
        } else {
          $$payload2.out += "<!--[!-->";
          $$payload2.out += `<div${spread_attributes({ ...wrapperProps }, null)}><div${spread_attributes({ ...finalProps }, null)}>`;
          children?.($$payload2);
          $$payload2.out += `<!----></div></div>`;
        }
        $$payload2.out += `<!--]-->`;
      };
      Popper_layer($$payload, spread_props([
        mergedProps,
        contentState.popperProps,
        {
          present: contentState.root.opts.open.current,
          id,
          trapFocus,
          preventScroll: preventScroll2,
          loop: true,
          forceMount: false,
          popper,
          $$slots: { popper: true }
        }
      ]));
    }
  } else {
    $$payload.out += "<!--[!-->";
  }
  $$payload.out += `<!--]-->`;
  bind_props($$props, { ref });
  pop();
}
function Popover_trigger($$payload, $$props) {
  push();
  let {
    children,
    child,
    id = useId(),
    ref = null,
    type = "button",
    disabled = false,
    $$slots,
    $$events,
    ...restProps
  } = $$props;
  const triggerState = usePopoverTrigger({
    id: box.with(() => id),
    ref: box.with(() => ref, (v) => ref = v),
    disabled: box.with(() => Boolean(disabled))
  });
  const mergedProps = mergeProps(restProps, triggerState.props, { type });
  Floating_layer_anchor($$payload, {
    id,
    children: ($$payload2) => {
      if (child) {
        $$payload2.out += "<!--[-->";
        child($$payload2, { props: mergedProps });
        $$payload2.out += `<!---->`;
      } else {
        $$payload2.out += "<!--[!-->";
        $$payload2.out += `<button${spread_attributes({ ...mergedProps }, null)}>`;
        children?.($$payload2);
        $$payload2.out += `<!----></button>`;
      }
      $$payload2.out += `<!--]-->`;
    }
  });
  bind_props($$props, { ref });
  pop();
}
function useResizeObserver(node, onResize) {
}
function Popover($$payload, $$props) {
  push();
  let { open = false, onOpenChange = noop$2, children } = $$props;
  usePopoverRoot({
    open: box.with(() => open, (v) => {
      open = v;
      onOpenChange(v);
    })
  });
  Floating_layer($$payload, {
    children: ($$payload2) => {
      children?.($$payload2);
      $$payload2.out += `<!---->`;
    }
  });
  bind_props($$props, { open });
  pop();
}
function clamp(n2, min, max) {
  return Math.min(max, Math.max(min, n2));
}
const SCROLL_AREA_ROOT_ATTR = "data-scroll-area-root";
const SCROLL_AREA_VIEWPORT_ATTR = "data-scroll-area-viewport";
const SCROLL_AREA_CORNER_ATTR = "data-scroll-area-corner";
const SCROLL_AREA_THUMB_ATTR = "data-scroll-area-thumb";
const SCROLL_AREA_SCROLLBAR_ATTR = "data-scroll-area-scrollbar";
class ScrollAreaRootState {
  opts;
  scrollAreaNode = null;
  viewportNode = null;
  contentNode = null;
  scrollbarXNode = null;
  scrollbarYNode = null;
  cornerWidth = 0;
  cornerHeight = 0;
  scrollbarXEnabled = false;
  scrollbarYEnabled = false;
  constructor(opts) {
    this.opts = opts;
    useRefById({
      ...opts,
      onRefChange: (node) => {
        this.scrollAreaNode = node;
      }
    });
  }
  #props = once(() => ({
    id: this.opts.id.current,
    dir: this.opts.dir.current,
    style: {
      position: "relative",
      "--bits-scroll-area-corner-height": `${this.cornerHeight}px`,
      "--bits-scroll-area-corner-width": `${this.cornerWidth}px`
    },
    [SCROLL_AREA_ROOT_ATTR]: ""
  }));
  get props() {
    return this.#props();
  }
}
class ScrollAreaViewportState {
  opts;
  root;
  #contentId = box(useId());
  #contentRef = box(null);
  constructor(opts, root) {
    this.opts = opts;
    this.root = root;
    useRefById({
      ...opts,
      onRefChange: (node) => {
        this.root.viewportNode = node;
      }
    });
    useRefById({
      id: this.#contentId,
      ref: this.#contentRef,
      onRefChange: (node) => {
        this.root.contentNode = node;
      }
    });
  }
  #props = once(() => ({
    id: this.opts.id.current,
    style: {
      overflowX: this.root.scrollbarXEnabled ? "scroll" : "hidden",
      overflowY: this.root.scrollbarYEnabled ? "scroll" : "hidden"
    },
    [SCROLL_AREA_VIEWPORT_ATTR]: ""
  }));
  get props() {
    return this.#props();
  }
  #contentProps = once(() => ({
    id: this.#contentId.current,
    "data-scroll-area-content": "",
    /**
     * When horizontal scrollbar is visible: this element should be at least
     * as wide as its children for size calculations to work correctly.
     *
     * When horizontal scrollbar is NOT visible: this element's width should
     * be constrained by the parent container to enable `text-overflow: ellipsis`
     */
    style: {
      minWidth: this.root.scrollbarXEnabled ? "fit-content" : void 0
    }
  }));
  get contentProps() {
    return this.#contentProps();
  }
}
class ScrollAreaScrollbarState {
  opts;
  root;
  #isHorizontal = once(() => this.opts.orientation.current === "horizontal");
  get isHorizontal() {
    return this.#isHorizontal();
  }
  hasThumb = false;
  constructor(opts, root) {
    this.opts = opts;
    this.root = root;
  }
}
class ScrollAreaScrollbarHoverState {
  scrollbar;
  root;
  isVisible = false;
  constructor(scrollbar) {
    this.scrollbar = scrollbar;
    this.root = scrollbar.root;
  }
  #props = once(() => ({
    "data-state": this.isVisible ? "visible" : "hidden"
  }));
  get props() {
    return this.#props();
  }
}
class ScrollAreaScrollbarScrollState {
  scrollbar;
  root;
  machine = useStateMachine("hidden", {
    hidden: { SCROLL: "scrolling" },
    scrolling: {
      SCROLL_END: "idle",
      POINTER_ENTER: "interacting"
    },
    interacting: { SCROLL: "interacting", POINTER_LEAVE: "idle" },
    idle: {
      HIDE: "hidden",
      SCROLL: "scrolling",
      POINTER_ENTER: "interacting"
    }
  });
  #isHidden = once(() => this.machine.state.current === "hidden");
  get isHidden() {
    return this.#isHidden();
  }
  constructor(scrollbar) {
    this.scrollbar = scrollbar;
    this.root = scrollbar.root;
    useDebounce(() => this.machine.dispatch("SCROLL_END"), 100);
    this.onpointerenter = this.onpointerenter.bind(this);
    this.onpointerleave = this.onpointerleave.bind(this);
  }
  onpointerenter(_2) {
    this.machine.dispatch("POINTER_ENTER");
  }
  onpointerleave(_2) {
    this.machine.dispatch("POINTER_LEAVE");
  }
  #props = once(() => ({
    "data-state": this.machine.state.current === "hidden" ? "hidden" : "visible",
    onpointerenter: this.onpointerenter,
    onpointerleave: this.onpointerleave
  }));
  get props() {
    return this.#props();
  }
}
class ScrollAreaScrollbarAutoState {
  scrollbar;
  root;
  isVisible = false;
  constructor(scrollbar) {
    this.scrollbar = scrollbar;
    this.root = scrollbar.root;
    useDebounce(
      () => {
        const viewportNode = this.root.viewportNode;
        if (!viewportNode) return;
        const isOverflowX = viewportNode.offsetWidth < viewportNode.scrollWidth;
        const isOverflowY = viewportNode.offsetHeight < viewportNode.scrollHeight;
        this.isVisible = this.scrollbar.isHorizontal ? isOverflowX : isOverflowY;
      },
      10
    );
  }
  #props = once(() => ({
    "data-state": this.isVisible ? "visible" : "hidden"
  }));
  get props() {
    return this.#props();
  }
}
class ScrollAreaScrollbarVisibleState {
  scrollbar;
  root;
  thumbNode = null;
  pointerOffset = 0;
  sizes = {
    content: 0,
    viewport: 0,
    scrollbar: { size: 0, paddingStart: 0, paddingEnd: 0 }
  };
  #thumbRatio = once(() => getThumbRatio(this.sizes.viewport, this.sizes.content));
  get thumbRatio() {
    return this.#thumbRatio();
  }
  #hasThumb = once(() => Boolean(this.thumbRatio > 0 && this.thumbRatio < 1));
  get hasThumb() {
    return this.#hasThumb();
  }
  prevTransformStyle = "";
  constructor(scrollbar) {
    this.scrollbar = scrollbar;
    this.root = scrollbar.root;
  }
  setSizes(sizes) {
    this.sizes = sizes;
  }
  getScrollPosition(pointerPos, dir) {
    return getScrollPositionFromPointer({
      pointerPos,
      pointerOffset: this.pointerOffset,
      sizes: this.sizes,
      dir
    });
  }
  onThumbPointerUp() {
    this.pointerOffset = 0;
  }
  onThumbPointerDown(pointerPos) {
    this.pointerOffset = pointerPos;
  }
  xOnThumbPositionChange() {
    if (!(this.root.viewportNode && this.thumbNode)) return;
    const scrollPos = this.root.viewportNode.scrollLeft;
    const offset = getThumbOffsetFromScroll({
      scrollPos,
      sizes: this.sizes,
      dir: this.root.opts.dir.current
    });
    const transformStyle = `translate3d(${offset}px, 0, 0)`;
    this.thumbNode.style.transform = transformStyle;
  }
  xOnWheelScroll(scrollPos) {
    if (!this.root.viewportNode) return;
    this.root.viewportNode.scrollLeft = scrollPos;
  }
  xOnDragScroll(pointerPos) {
    if (!this.root.viewportNode) return;
    this.root.viewportNode.scrollLeft = this.getScrollPosition(pointerPos, this.root.opts.dir.current);
  }
  yOnThumbPositionChange() {
    if (!(this.root.viewportNode && this.thumbNode)) return;
    const scrollPos = this.root.viewportNode.scrollTop;
    const offset = getThumbOffsetFromScroll({ scrollPos, sizes: this.sizes });
    const transformStyle = `translate3d(0, ${offset}px, 0)`;
    this.thumbNode.style.transform = transformStyle;
  }
  yOnWheelScroll(scrollPos) {
    if (!this.root.viewportNode) return;
    this.root.viewportNode.scrollTop = scrollPos;
  }
  yOnDragScroll(pointerPos) {
    if (!this.root.viewportNode) return;
    this.root.viewportNode.scrollTop = this.getScrollPosition(pointerPos, this.root.opts.dir.current);
  }
}
class ScrollAreaScrollbarXState {
  opts;
  scrollbarVis;
  root;
  computedStyle;
  scrollbar;
  constructor(opts, scrollbarVis) {
    this.opts = opts;
    this.scrollbarVis = scrollbarVis;
    this.scrollbarVis = scrollbarVis;
    this.root = scrollbarVis.root;
    this.scrollbar = scrollbarVis.scrollbar;
    useRefById({
      ...this.scrollbar.opts,
      onRefChange: (node) => {
        this.root.scrollbarXNode = node;
      },
      deps: () => this.opts.mounted.current
    });
  }
  onThumbPointerDown = (pointerPos) => {
    this.scrollbarVis.onThumbPointerDown(pointerPos.x);
  };
  onDragScroll = (pointerPos) => {
    this.scrollbarVis.xOnDragScroll(pointerPos.x);
  };
  onThumbPointerUp = () => {
    this.scrollbarVis.onThumbPointerUp();
  };
  onThumbPositionChange = () => {
    this.scrollbarVis.xOnThumbPositionChange();
  };
  onWheelScroll = (e2, maxScrollPos) => {
    if (!this.root.viewportNode) return;
    const scrollPos = this.root.viewportNode.scrollLeft + e2.deltaX;
    this.scrollbarVis.xOnWheelScroll(scrollPos);
    if (isScrollingWithinScrollbarBounds(scrollPos, maxScrollPos)) {
      e2.preventDefault();
    }
  };
  onResize = () => {
    if (!(this.scrollbar.opts.ref.current && this.root.viewportNode && this.computedStyle)) return;
    this.scrollbarVis.setSizes({
      content: this.root.viewportNode.scrollWidth,
      viewport: this.root.viewportNode.offsetWidth,
      scrollbar: {
        size: this.scrollbar.opts.ref.current.clientWidth,
        paddingStart: toInt(this.computedStyle.paddingLeft),
        paddingEnd: toInt(this.computedStyle.paddingRight)
      }
    });
  };
  #thumbSize = once(() => {
    return getThumbSize(this.scrollbarVis.sizes);
  });
  get thumbSize() {
    return this.#thumbSize();
  }
  #props = once(() => ({
    id: this.scrollbar.opts.id.current,
    "data-orientation": "horizontal",
    style: {
      bottom: 0,
      left: this.root.opts.dir.current === "rtl" ? "var(--bits-scroll-area-corner-width)" : 0,
      right: this.root.opts.dir.current === "ltr" ? "var(--bits-scroll-area-corner-width)" : 0,
      "--bits-scroll-area-thumb-width": `${this.thumbSize}px`
    }
  }));
  get props() {
    return this.#props();
  }
}
class ScrollAreaScrollbarYState {
  opts;
  scrollbarVis;
  root;
  scrollbar;
  computedStyle;
  constructor(opts, scrollbarVis) {
    this.opts = opts;
    this.scrollbarVis = scrollbarVis;
    this.root = scrollbarVis.root;
    this.scrollbar = scrollbarVis.scrollbar;
    useRefById({
      ...this.scrollbar.opts,
      onRefChange: (node) => {
        this.root.scrollbarYNode = node;
      },
      deps: () => this.opts.mounted.current
    });
    this.onThumbPointerDown = this.onThumbPointerDown.bind(this);
    this.onDragScroll = this.onDragScroll.bind(this);
    this.onThumbPointerUp = this.onThumbPointerUp.bind(this);
    this.onThumbPositionChange = this.onThumbPositionChange.bind(this);
    this.onWheelScroll = this.onWheelScroll.bind(this);
    this.onResize = this.onResize.bind(this);
  }
  onThumbPointerDown(pointerPos) {
    this.scrollbarVis.onThumbPointerDown(pointerPos.y);
  }
  onDragScroll(pointerPos) {
    this.scrollbarVis.yOnDragScroll(pointerPos.y);
  }
  onThumbPointerUp() {
    this.scrollbarVis.onThumbPointerUp();
  }
  onThumbPositionChange() {
    this.scrollbarVis.yOnThumbPositionChange();
  }
  onWheelScroll(e2, maxScrollPos) {
    if (!this.root.viewportNode) return;
    const scrollPos = this.root.viewportNode.scrollTop + e2.deltaY;
    this.scrollbarVis.yOnWheelScroll(scrollPos);
    if (isScrollingWithinScrollbarBounds(scrollPos, maxScrollPos)) {
      e2.preventDefault();
    }
  }
  onResize() {
    if (!(this.scrollbar.opts.ref.current && this.root.viewportNode && this.computedStyle)) return;
    this.scrollbarVis.setSizes({
      content: this.root.viewportNode.scrollHeight,
      viewport: this.root.viewportNode.offsetHeight,
      scrollbar: {
        size: this.scrollbar.opts.ref.current.clientHeight,
        paddingStart: toInt(this.computedStyle.paddingTop),
        paddingEnd: toInt(this.computedStyle.paddingBottom)
      }
    });
  }
  #thumbSize = once(() => {
    return getThumbSize(this.scrollbarVis.sizes);
  });
  get thumbSize() {
    return this.#thumbSize();
  }
  #props = once(() => ({
    id: this.scrollbar.opts.id.current,
    "data-orientation": "vertical",
    style: {
      top: 0,
      right: this.root.opts.dir.current === "ltr" ? 0 : void 0,
      left: this.root.opts.dir.current === "rtl" ? 0 : void 0,
      bottom: "var(--bits-scroll-area-corner-height)",
      "--bits-scroll-area-thumb-height": `${this.thumbSize}px`
    }
  }));
  get props() {
    return this.#props();
  }
}
class ScrollAreaScrollbarSharedState {
  scrollbarState;
  root;
  scrollbarVis;
  scrollbar;
  rect = null;
  prevWebkitUserSelect = "";
  handleResize;
  handleThumbPositionChange;
  handleWheelScroll;
  handleThumbPointerDown;
  handleThumbPointerUp;
  #maxScrollPos = once(() => this.scrollbarVis.sizes.content - this.scrollbarVis.sizes.viewport);
  get maxScrollPos() {
    return this.#maxScrollPos();
  }
  constructor(scrollbarState) {
    this.scrollbarState = scrollbarState;
    this.root = scrollbarState.root;
    this.scrollbarVis = scrollbarState.scrollbarVis;
    this.scrollbar = scrollbarState.scrollbarVis.scrollbar;
    this.handleResize = useDebounce(() => this.scrollbarState.onResize(), 10);
    this.handleThumbPositionChange = this.scrollbarState.onThumbPositionChange;
    this.handleWheelScroll = this.scrollbarState.onWheelScroll;
    this.handleThumbPointerDown = this.scrollbarState.onThumbPointerDown;
    this.handleThumbPointerUp = this.scrollbarState.onThumbPointerUp;
    useResizeObserver(() => this.scrollbar.opts.ref.current, this.handleResize);
    useResizeObserver(() => this.root.contentNode, this.handleResize);
    this.onpointerdown = this.onpointerdown.bind(this);
    this.onpointermove = this.onpointermove.bind(this);
    this.onpointerup = this.onpointerup.bind(this);
  }
  handleDragScroll(e2) {
    if (!this.rect) return;
    const x2 = e2.clientX - this.rect.left;
    const y = e2.clientY - this.rect.top;
    this.scrollbarState.onDragScroll({ x: x2, y });
  }
  onpointerdown(e2) {
    if (e2.button !== 0) return;
    const target = e2.target;
    target.setPointerCapture(e2.pointerId);
    this.rect = this.scrollbar.opts.ref.current?.getBoundingClientRect() ?? null;
    this.prevWebkitUserSelect = document.body.style.webkitUserSelect;
    document.body.style.webkitUserSelect = "none";
    if (this.root.viewportNode) this.root.viewportNode.style.scrollBehavior = "auto";
    this.handleDragScroll(e2);
  }
  onpointermove(e2) {
    this.handleDragScroll(e2);
  }
  onpointerup(e2) {
    const target = e2.target;
    if (target.hasPointerCapture(e2.pointerId)) {
      target.releasePointerCapture(e2.pointerId);
    }
    document.body.style.webkitUserSelect = this.prevWebkitUserSelect;
    if (this.root.viewportNode) this.root.viewportNode.style.scrollBehavior = "";
    this.rect = null;
  }
  #props = once(() => mergeProps({
    ...this.scrollbarState.props,
    style: {
      position: "absolute",
      ...this.scrollbarState.props.style
    },
    [SCROLL_AREA_SCROLLBAR_ATTR]: "",
    onpointerdown: this.onpointerdown,
    onpointermove: this.onpointermove,
    onpointerup: this.onpointerup
  }));
  get props() {
    return this.#props();
  }
}
class ScrollAreaThumbImplState {
  opts;
  scrollbarState;
  #root;
  #removeUnlinkedScrollListener;
  #debounceScrollEnd = useDebounce(
    () => {
      if (this.#removeUnlinkedScrollListener) {
        this.#removeUnlinkedScrollListener();
        this.#removeUnlinkedScrollListener = void 0;
      }
    },
    100
  );
  constructor(opts, scrollbarState) {
    this.opts = opts;
    this.scrollbarState = scrollbarState;
    this.#root = scrollbarState.root;
    useRefById({
      ...opts,
      onRefChange: (node) => {
        this.scrollbarState.scrollbarVis.thumbNode = node;
      },
      deps: () => this.opts.mounted.current
    });
    this.onpointerdowncapture = this.onpointerdowncapture.bind(this);
    this.onpointerup = this.onpointerup.bind(this);
  }
  onpointerdowncapture(e2) {
    const thumb = e2.target;
    if (!thumb) return;
    const thumbRect = thumb.getBoundingClientRect();
    const x2 = e2.clientX - thumbRect.left;
    const y = e2.clientY - thumbRect.top;
    this.scrollbarState.handleThumbPointerDown({ x: x2, y });
  }
  onpointerup(_2) {
    this.scrollbarState.handleThumbPointerUp();
  }
  #props = once(() => ({
    id: this.opts.id.current,
    "data-state": this.scrollbarState.scrollbarVis.hasThumb ? "visible" : "hidden",
    style: {
      width: "var(--bits-scroll-area-thumb-width)",
      height: "var(--bits-scroll-area-thumb-height)",
      transform: this.scrollbarState.scrollbarVis.prevTransformStyle
    },
    onpointerdowncapture: this.onpointerdowncapture,
    onpointerup: this.onpointerup,
    [SCROLL_AREA_THUMB_ATTR]: ""
  }));
  get props() {
    return this.#props();
  }
}
class ScrollAreaCornerImplState {
  opts;
  root;
  #width = 0;
  #height = 0;
  #hasSize = once(() => Boolean(this.#width && this.#height));
  get hasSize() {
    return this.#hasSize();
  }
  constructor(opts, root) {
    this.opts = opts;
    this.root = root;
    useRefById(opts);
  }
  #props = once(() => ({
    id: this.opts.id.current,
    style: {
      width: this.#width,
      height: this.#height,
      position: "absolute",
      right: this.root.opts.dir.current === "ltr" ? 0 : void 0,
      left: this.root.opts.dir.current === "rtl" ? 0 : void 0,
      bottom: 0
    },
    [SCROLL_AREA_CORNER_ATTR]: ""
  }));
  get props() {
    return this.#props();
  }
}
const ScrollAreaRootContext = new Context("ScrollArea.Root");
const ScrollAreaScrollbarContext = new Context("ScrollArea.Scrollbar");
const ScrollAreaScrollbarVisibleContext = new Context("ScrollArea.ScrollbarVisible");
const ScrollAreaScrollbarAxisContext = new Context("ScrollArea.ScrollbarAxis");
const ScrollAreaScrollbarSharedContext = new Context("ScrollArea.ScrollbarShared");
function useScrollAreaRoot(props) {
  return ScrollAreaRootContext.set(new ScrollAreaRootState(props));
}
function useScrollAreaViewport(props) {
  return new ScrollAreaViewportState(props, ScrollAreaRootContext.get());
}
function useScrollAreaScrollbar(props) {
  return ScrollAreaScrollbarContext.set(new ScrollAreaScrollbarState(props, ScrollAreaRootContext.get()));
}
function useScrollAreaScrollbarVisible() {
  return ScrollAreaScrollbarVisibleContext.set(new ScrollAreaScrollbarVisibleState(ScrollAreaScrollbarContext.get()));
}
function useScrollAreaScrollbarAuto() {
  return new ScrollAreaScrollbarAutoState(ScrollAreaScrollbarContext.get());
}
function useScrollAreaScrollbarScroll() {
  return new ScrollAreaScrollbarScrollState(ScrollAreaScrollbarContext.get());
}
function useScrollAreaScrollbarHover() {
  return new ScrollAreaScrollbarHoverState(ScrollAreaScrollbarContext.get());
}
function useScrollAreaScrollbarX(props) {
  return ScrollAreaScrollbarAxisContext.set(new ScrollAreaScrollbarXState(props, ScrollAreaScrollbarVisibleContext.get()));
}
function useScrollAreaScrollbarY(props) {
  return ScrollAreaScrollbarAxisContext.set(new ScrollAreaScrollbarYState(props, ScrollAreaScrollbarVisibleContext.get()));
}
function useScrollAreaScrollbarShared() {
  return ScrollAreaScrollbarSharedContext.set(new ScrollAreaScrollbarSharedState(ScrollAreaScrollbarAxisContext.get()));
}
function useScrollAreaThumb(props) {
  return new ScrollAreaThumbImplState(props, ScrollAreaScrollbarSharedContext.get());
}
function useScrollAreaCorner(props) {
  return new ScrollAreaCornerImplState(props, ScrollAreaRootContext.get());
}
function toInt(value) {
  return value ? Number.parseInt(value, 10) : 0;
}
function getThumbRatio(viewportSize, contentSize) {
  const ratio = viewportSize / contentSize;
  return Number.isNaN(ratio) ? 0 : ratio;
}
function getThumbSize(sizes) {
  const ratio = getThumbRatio(sizes.viewport, sizes.content);
  const scrollbarPadding = sizes.scrollbar.paddingStart + sizes.scrollbar.paddingEnd;
  const thumbSize = (sizes.scrollbar.size - scrollbarPadding) * ratio;
  return Math.max(thumbSize, 18);
}
function getScrollPositionFromPointer({
  pointerPos,
  pointerOffset,
  sizes,
  dir = "ltr"
}) {
  const thumbSizePx = getThumbSize(sizes);
  const thumbCenter = thumbSizePx / 2;
  const offset = pointerOffset || thumbCenter;
  const thumbOffsetFromEnd = thumbSizePx - offset;
  const minPointerPos = sizes.scrollbar.paddingStart + offset;
  const maxPointerPos = sizes.scrollbar.size - sizes.scrollbar.paddingEnd - thumbOffsetFromEnd;
  const maxScrollPos = sizes.content - sizes.viewport;
  const scrollRange = dir === "ltr" ? [0, maxScrollPos] : [maxScrollPos * -1, 0];
  const interpolate = linearScale([minPointerPos, maxPointerPos], scrollRange);
  return interpolate(pointerPos);
}
function getThumbOffsetFromScroll({ scrollPos, sizes, dir = "ltr" }) {
  const thumbSizePx = getThumbSize(sizes);
  const scrollbarPadding = sizes.scrollbar.paddingStart + sizes.scrollbar.paddingEnd;
  const scrollbar = sizes.scrollbar.size - scrollbarPadding;
  const maxScrollPos = sizes.content - sizes.viewport;
  const maxThumbPos = scrollbar - thumbSizePx;
  const scrollClampRange = dir === "ltr" ? [0, maxScrollPos] : [maxScrollPos * -1, 0];
  const scrollWithoutMomentum = clamp(scrollPos, scrollClampRange[0], scrollClampRange[1]);
  const interpolate = linearScale([0, maxScrollPos], [0, maxThumbPos]);
  return interpolate(scrollWithoutMomentum);
}
function linearScale(input, output) {
  return (value) => {
    if (input[0] === input[1] || output[0] === output[1]) return output[0];
    const ratio = (output[1] - output[0]) / (input[1] - input[0]);
    return output[0] + ratio * (value - input[0]);
  };
}
function isScrollingWithinScrollbarBounds(scrollPos, maxScrollPos) {
  return scrollPos > 0 && scrollPos < maxScrollPos;
}
function Scroll_area($$payload, $$props) {
  push();
  let {
    ref = null,
    id = useId(),
    type = "hover",
    dir = "ltr",
    scrollHideDelay = 600,
    children,
    child,
    $$slots,
    $$events,
    ...restProps
  } = $$props;
  const rootState = useScrollAreaRoot({
    type: box.with(() => type),
    dir: box.with(() => dir),
    scrollHideDelay: box.with(() => scrollHideDelay),
    id: box.with(() => id),
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
  bind_props($$props, { ref });
  pop();
}
function Scroll_area_viewport($$payload, $$props) {
  push();
  let {
    ref = null,
    id = useId(),
    children,
    $$slots,
    $$events,
    ...restProps
  } = $$props;
  const viewportState = useScrollAreaViewport({
    id: box.with(() => id),
    ref: box.with(() => ref, (v) => ref = v)
  });
  const mergedProps = mergeProps(restProps, viewportState.props);
  const mergedContentProps = mergeProps({}, viewportState.contentProps);
  $$payload.out += `<div${spread_attributes({ ...mergedProps }, null)}><div${spread_attributes({ ...mergedContentProps }, null)}>`;
  children?.($$payload);
  $$payload.out += `<!----></div></div>`;
  bind_props($$props, { ref });
  pop();
}
function Scroll_area_scrollbar_shared($$payload, $$props) {
  push();
  let {
    child,
    children,
    $$slots,
    $$events,
    ...restProps
  } = $$props;
  const scrollbarSharedState = useScrollAreaScrollbarShared();
  const mergedProps = mergeProps(restProps, scrollbarSharedState.props);
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
  pop();
}
function Scroll_area_scrollbar_x($$payload, $$props) {
  push();
  let { $$slots, $$events, ...restProps } = $$props;
  const isMounted = new IsMounted();
  const scrollbarXState = useScrollAreaScrollbarX({ mounted: box.with(() => isMounted.current) });
  const mergedProps = mergeProps(restProps, scrollbarXState.props);
  Scroll_area_scrollbar_shared($$payload, spread_props([mergedProps]));
  pop();
}
function Scroll_area_scrollbar_y($$payload, $$props) {
  push();
  let { $$slots, $$events, ...restProps } = $$props;
  const isMounted = new IsMounted();
  const scrollbarYState = useScrollAreaScrollbarY({ mounted: box.with(() => isMounted.current) });
  const mergedProps = mergeProps(restProps, scrollbarYState.props);
  Scroll_area_scrollbar_shared($$payload, spread_props([mergedProps]));
  pop();
}
function Scroll_area_scrollbar_visible($$payload, $$props) {
  push();
  let { $$slots, $$events, ...restProps } = $$props;
  const scrollbarVisibleState = useScrollAreaScrollbarVisible();
  if (scrollbarVisibleState.scrollbar.opts.orientation.current === "horizontal") {
    $$payload.out += "<!--[-->";
    Scroll_area_scrollbar_x($$payload, spread_props([restProps]));
  } else {
    $$payload.out += "<!--[!-->";
    Scroll_area_scrollbar_y($$payload, spread_props([restProps]));
  }
  $$payload.out += `<!--]-->`;
  pop();
}
function Scroll_area_scrollbar_auto($$payload, $$props) {
  push();
  let {
    forceMount = false,
    $$slots,
    $$events,
    ...restProps
  } = $$props;
  const scrollbarAutoState = useScrollAreaScrollbarAuto();
  const mergedProps = mergeProps(restProps, scrollbarAutoState.props);
  {
    let presence = function($$payload2) {
      Scroll_area_scrollbar_visible($$payload2, spread_props([mergedProps]));
    };
    Presence_layer($$payload, spread_props([
      {
        present: forceMount || scrollbarAutoState.isVisible
      },
      mergedProps,
      { presence, $$slots: { presence: true } }
    ]));
  }
  pop();
}
function Scroll_area_scrollbar_scroll($$payload, $$props) {
  push();
  let {
    forceMount = false,
    $$slots,
    $$events,
    ...restProps
  } = $$props;
  const scrollbarScrollState = useScrollAreaScrollbarScroll();
  const mergedProps = mergeProps(restProps, scrollbarScrollState.props);
  {
    let presence = function($$payload2) {
      Scroll_area_scrollbar_visible($$payload2, spread_props([mergedProps]));
    };
    Presence_layer($$payload, spread_props([
      mergedProps,
      {
        present: forceMount || !scrollbarScrollState.isHidden,
        presence,
        $$slots: { presence: true }
      }
    ]));
  }
  pop();
}
function Scroll_area_scrollbar_hover($$payload, $$props) {
  push();
  let {
    forceMount = false,
    $$slots,
    $$events,
    ...restProps
  } = $$props;
  const scrollbarHoverState = useScrollAreaScrollbarHover();
  const scrollbarAutoState = useScrollAreaScrollbarAuto();
  const mergedProps = mergeProps(restProps, scrollbarHoverState.props, scrollbarAutoState.props, {
    "data-state": scrollbarHoverState.isVisible ? "visible" : "hidden"
  });
  const present = forceMount || scrollbarHoverState.isVisible && scrollbarAutoState.isVisible;
  {
    let presence = function($$payload2) {
      Scroll_area_scrollbar_visible($$payload2, spread_props([mergedProps]));
    };
    Presence_layer($$payload, spread_props([
      mergedProps,
      {
        present,
        presence,
        $$slots: { presence: true }
      }
    ]));
  }
  pop();
}
function Scroll_area_scrollbar($$payload, $$props) {
  push();
  let {
    ref = null,
    id = useId(),
    orientation,
    $$slots,
    $$events,
    ...restProps
  } = $$props;
  const scrollbarState = useScrollAreaScrollbar({
    orientation: box.with(() => orientation),
    id: box.with(() => id),
    ref: box.with(() => ref, (v) => ref = v)
  });
  const type = scrollbarState.root.opts.type.current;
  if (type === "hover") {
    $$payload.out += "<!--[-->";
    Scroll_area_scrollbar_hover($$payload, spread_props([restProps, { id }]));
  } else if (type === "scroll") {
    $$payload.out += "<!--[1-->";
    Scroll_area_scrollbar_scroll($$payload, spread_props([restProps, { id }]));
  } else if (type === "auto") {
    $$payload.out += "<!--[2-->";
    Scroll_area_scrollbar_auto($$payload, spread_props([restProps, { id }]));
  } else if (type === "always") {
    $$payload.out += "<!--[3-->";
    Scroll_area_scrollbar_visible($$payload, spread_props([restProps, { id }]));
  } else {
    $$payload.out += "<!--[!-->";
  }
  $$payload.out += `<!--]-->`;
  bind_props($$props, { ref });
  pop();
}
function Scroll_area_thumb_impl($$payload, $$props) {
  push();
  let {
    ref = null,
    id,
    child,
    children,
    present,
    $$slots,
    $$events,
    ...restProps
  } = $$props;
  const isMounted = new IsMounted();
  const thumbState = useScrollAreaThumb({
    id: box.with(() => id),
    ref: box.with(() => ref, (v) => ref = v),
    mounted: box.with(() => isMounted.current)
  });
  const mergedProps = mergeProps(restProps, thumbState.props, { style: { hidden: !present } });
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
  bind_props($$props, { ref });
  pop();
}
function Scroll_area_thumb($$payload, $$props) {
  push();
  let {
    id = useId(),
    ref = null,
    forceMount = false,
    $$slots,
    $$events,
    ...restProps
  } = $$props;
  const scrollbarState = ScrollAreaScrollbarVisibleContext.get();
  let $$settled = true;
  let $$inner_payload;
  function $$render_inner($$payload2) {
    {
      let presence = function($$payload3, { present }) {
        Scroll_area_thumb_impl($$payload3, spread_props([
          restProps,
          {
            id,
            present: present.current,
            get ref() {
              return ref;
            },
            set ref($$value) {
              ref = $$value;
              $$settled = false;
            }
          }
        ]));
      };
      Presence_layer($$payload2, spread_props([
        { present: forceMount || scrollbarState.hasThumb },
        restProps,
        { id, presence, $$slots: { presence: true } }
      ]));
    }
  }
  do {
    $$settled = true;
    $$inner_payload = copy_payload($$payload);
    $$render_inner($$inner_payload);
  } while (!$$settled);
  assign_payload($$payload, $$inner_payload);
  bind_props($$props, { ref });
  pop();
}
function Scroll_area_corner_impl($$payload, $$props) {
  push();
  let {
    ref = null,
    id,
    children,
    child,
    $$slots,
    $$events,
    ...restProps
  } = $$props;
  const cornerState = useScrollAreaCorner({
    id: box.with(() => id),
    ref: box.with(() => ref, (v) => ref = v)
  });
  const mergedProps = mergeProps(restProps, cornerState.props);
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
  bind_props($$props, { ref });
  pop();
}
function Scroll_area_corner($$payload, $$props) {
  push();
  let {
    ref = null,
    id = useId(),
    $$slots,
    $$events,
    ...restProps
  } = $$props;
  const scrollAreaState = ScrollAreaRootContext.get();
  const hasBothScrollbarsVisible = Boolean(scrollAreaState.scrollbarXNode && scrollAreaState.scrollbarYNode);
  const hasCorner = scrollAreaState.opts.type.current !== "scroll" && hasBothScrollbarsVisible;
  let $$settled = true;
  let $$inner_payload;
  function $$render_inner($$payload2) {
    if (hasCorner) {
      $$payload2.out += "<!--[-->";
      Scroll_area_corner_impl($$payload2, spread_props([
        restProps,
        {
          id,
          get ref() {
            return ref;
          },
          set ref($$value) {
            ref = $$value;
            $$settled = false;
          }
        }
      ]));
    } else {
      $$payload2.out += "<!--[!-->";
    }
    $$payload2.out += `<!--]-->`;
  }
  do {
    $$settled = true;
    $$inner_payload = copy_payload($$payload);
    $$render_inner($$inner_payload);
  } while (!$$settled);
  assign_payload($$payload, $$inner_payload);
  bind_props($$props, { ref });
  pop();
}
const TOOLBAR_ROOT_ATTR = "data-toolbar-root";
const TOOLBAR_ITEM_ATTR = "data-toolbar-item";
const TOOLBAR_BUTTON_ATTR = "data-toolbar-button";
class ToolbarRootState {
  opts;
  rovingFocusGroup;
  constructor(opts) {
    this.opts = opts;
    useRefById(opts);
    this.rovingFocusGroup = useRovingFocus({
      orientation: this.opts.orientation,
      loop: this.opts.loop,
      rootNodeId: this.opts.id,
      candidateAttr: TOOLBAR_ITEM_ATTR
    });
  }
  #props = once(() => ({
    id: this.opts.id.current,
    role: "toolbar",
    "data-orientation": this.opts.orientation.current,
    [TOOLBAR_ROOT_ATTR]: ""
  }));
  get props() {
    return this.#props();
  }
}
class ToolbarButtonState {
  opts;
  root;
  constructor(opts, root) {
    this.opts = opts;
    this.root = root;
    useRefById(opts);
    this.onkeydown = this.onkeydown.bind(this);
  }
  onkeydown(e2) {
    this.root.rovingFocusGroup.handleKeydown(this.opts.ref.current, e2);
  }
  #tabIndex = 0;
  #role = once(() => {
    if (!this.opts.ref.current) return void 0;
    const tagName = this.opts.ref.current.tagName;
    if (tagName !== "BUTTON") return "button";
    return void 0;
  });
  #props = once(() => ({
    id: this.opts.id.current,
    [TOOLBAR_ITEM_ATTR]: "",
    [TOOLBAR_BUTTON_ATTR]: "",
    role: this.#role(),
    tabindex: this.#tabIndex,
    "data-disabled": getDataDisabled(this.opts.disabled.current),
    "data-orientation": getDataOrientation(this.root.opts.orientation.current),
    disabled: getDisabled(this.opts.disabled.current),
    //
    onkeydown: this.onkeydown
  }));
  get props() {
    return this.#props();
  }
}
const ToolbarRootContext = new Context("Toolbar.Root");
function useToolbarRoot(props) {
  return ToolbarRootContext.set(new ToolbarRootState(props));
}
function useToolbarButton(props) {
  return new ToolbarButtonState(props, ToolbarRootContext.get());
}
function Toolbar($$payload, $$props) {
  push();
  let {
    ref = null,
    id = useId(),
    orientation = "horizontal",
    loop = true,
    child,
    children,
    $$slots,
    $$events,
    ...restProps
  } = $$props;
  const rootState = useToolbarRoot({
    id: box.with(() => id),
    orientation: box.with(() => orientation),
    loop: box.with(() => loop),
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
  bind_props($$props, { ref });
  pop();
}
function Toolbar_button($$payload, $$props) {
  push();
  let {
    child,
    children,
    disabled = false,
    type = "button",
    id = useId(),
    ref = null,
    $$slots,
    $$events,
    ...restProps
  } = $$props;
  const buttonState = useToolbarButton({
    id: box.with(() => id),
    disabled: box.with(() => disabled ?? false),
    ref: box.with(() => ref, (v) => ref = v)
  });
  const mergedProps = mergeProps(restProps, buttonState.props, { type });
  if (child) {
    $$payload.out += "<!--[-->";
    child($$payload, { props: mergedProps });
    $$payload.out += `<!---->`;
  } else {
    $$payload.out += "<!--[!-->";
    $$payload.out += `<button${spread_attributes({ ...mergedProps }, null)}>`;
    children?.($$payload);
    $$payload.out += `<!----></button>`;
  }
  $$payload.out += `<!--]-->`;
  bind_props($$props, { ref });
  pop();
}
function renderMarkdownSanitized(markdown) {
  return sanitizeHtml(
    marked.parse(markdown).replace("<a ", '<a target="_blank" ')
  );
}
function SuggestionSelect($$payload, $$props) {
  push();
  let activeIndex = 0;
  let { items, callback } = $$props;
  let categories = (() => {
    const name2 = /* @__PURE__ */ new Set();
    items.map((i2) => name2.add(i2.category));
    return name2.values().toArray();
  })();
  function setItems(value) {
    items = value;
  }
  function onKeyDown(event) {
    if (event.repeat) {
      return false;
    }
    switch (event.key) {
      case "ArrowUp": {
        if (activeIndex <= 0) {
          activeIndex = items.length - 1;
        } else {
          activeIndex--;
        }
        return true;
      }
      case "ArrowDown": {
        if (activeIndex >= items.length - 1) {
          activeIndex = 0;
        } else {
          activeIndex++;
        }
        return true;
      }
      case "Enter": {
        const selected = items[activeIndex];
        callback({ id: selected.value, label: selected.label });
        return true;
      }
    }
    return false;
  }
  const each_array = ensure_array_like(categories);
  $$payload.out += `<menu class="bg-violet-900 p-4 flex flex-col gap-3"><!--[-->`;
  for (let c2 = 0, $$length = each_array.length; c2 < $$length; c2++) {
    let category = each_array[c2];
    const prevCategoryLength = c2 === 0 ? 0 : items.filter((i2) => i2.category === categories[c2 - 1]).length;
    const each_array_1 = ensure_array_like(items.filter((i2) => i2.category === category));
    $$payload.out += `<h5 class="uppercase text-gray-300">${escape_html(category)}</h5> <!--[-->`;
    for (let i2 = 0, $$length2 = each_array_1.length; i2 < $$length2; i2++) {
      let { value, label, disabled } = each_array_1[i2];
      const actualIndex = i2 + prevCategoryLength;
      $$payload.out += `<!---->`;
      Button($$payload, {
        disabled,
        class: [
          actualIndex === activeIndex && "!border-white",
          "border border-violet-800 px-3 py-2 flex gap-4 bg-violet-800 text-white rounded cursor-pointer"
        ],
        onmouseover: () => activeIndex = actualIndex,
        onclick: () => callback({ id: value, label }),
        children: ($$payload2) => {
          $$payload2.out += `<!---->${escape_html(label)}`;
        },
        $$slots: { default: true }
      });
      $$payload.out += `<!---->`;
    }
    $$payload.out += `<!--]-->`;
  }
  $$payload.out += `<!--]--></menu>`;
  bind_props($$props, { setItems, onKeyDown });
  pop();
}
const initKeyboardShortcutHandler = ({ onEnter }) => Extension.create({
  name: "keyboardShortcutHandler",
  addProseMirrorPlugins() {
    return [
      keymap({
        "Enter": () => {
          onEnter();
          this.editor.commands.clearContent();
          return true;
        }
      })
    ];
  }
});
function suggestion({ items, char, pluginKey }) {
  return {
    char,
    pluginKey: new PluginKey(pluginKey),
    items: ({ query }) => {
      return items.filter(
        (item) => item.label.toLowerCase().startsWith(query.toLowerCase())
      ).slice(0, 5);
    },
    render: () => {
      let wrapper;
      let component;
      return {
        onStart: (props) => {
          wrapper = document.createElement("div");
          props.editor.view.dom.parentNode?.appendChild(wrapper);
          component = mount(SuggestionSelect, {
            props: {
              items: props.items
            }
          });
        },
        onUpdate: (props) => {
          component.setItems(props.items);
        },
        onKeyDown: (props) => {
          return component.onKeyDown(props.event);
        },
        onExit: () => {
          unmount();
        }
      };
    }
  };
}
const UserMentionExtension = Mention.extend({
  name: "userMention",
  // Used by `generateHTML`
  renderHTML({ HTMLAttributes, node }) {
    return [
      "a",
      mergeAttributes(
        {
          href: `https://${node.attrs.label}`,
          class: "mention !no-underline"
        },
        HTMLAttributes
      ),
      `@${node.attrs.label}`
    ];
  }
});
const initUserMention = ({ users }) => UserMentionExtension.configure({
  HTMLAttributes: { class: "mention" },
  suggestion: suggestion({ items: users, char: "@", pluginKey: "userMention" })
});
const SpaceContextMentionExtension = Mention.extend({
  name: "channelThreadMention",
  // Used by `generateHTML`
  renderHTML({ HTMLAttributes, node }) {
    const { ulid, space, type } = JSON.parse(node.attrs.id);
    return [
      "a",
      mergeAttributes(
        {
          href: type === "thread" ? `/space/${space}/thread/${ulid}` : `/space/${space}/${ulid}`,
          class: `mention ${type === "thread" ? "thread-mention" : "channel-mention"} !no-underline`
        },
        HTMLAttributes
      ),
      node.attrs.label
    ];
  }
});
const initSpaceContextMention = ({ context }) => SpaceContextMentionExtension.configure({
  HTMLAttributes: { class: "mention" },
  suggestion: suggestion({ items: context, char: "#", pluginKey: "spaceContextMention" }),
  renderHTML({ options, node }) {
    const { type } = JSON.parse(node.attrs.id);
    return [
      "span",
      mergeAttributes(
        {
          class: `mention ${type === "thread" ? "thread-mention" : "channel-mention"} !no-underline`
        },
        options.HTMLAttributes
      ),
      node.attrs.label
    ];
  }
});
const extensions = [
  StarterKit.configure({ heading: false }),
  UserMentionExtension,
  SpaceContextMentionExtension
];
getSchema(extensions);
function getContentHtml(content) {
  try {
    const data = JSON.parse(content);
    return generateHTML(data, extensions);
  } catch {
    return renderMarkdownSanitized(content);
  }
}
function last(array) {
  return array[array.length - 1];
}
function styleToString$2(style) {
  return Object.keys(style).reduce((str, key) => {
    if (style[key] === void 0)
      return str;
    return str + `${key}:${style[key]};`;
  }, "");
}
({
  style: styleToString$2({
    position: "absolute",
    opacity: 0,
    "pointer-events": "none",
    margin: 0,
    transform: "translateX(-100%)"
  })
});
function portalAttr(portal) {
  if (portal !== null) {
    return "";
  }
  return void 0;
}
function lightable(value) {
  function subscribe(run) {
    run(value);
    return () => {
    };
  }
  return { subscribe };
}
const hiddenAction = (obj) => {
  return new Proxy(obj, {
    get(target, prop, receiver) {
      return Reflect.get(target, prop, receiver);
    },
    ownKeys(target) {
      return Reflect.ownKeys(target).filter((key) => key !== "action");
    }
  });
};
const isFunctionWithParams = (fn) => {
  return typeof fn === "function";
};
makeElement("empty");
function makeElement(name2, args) {
  const { stores, action, returned } = args ?? {};
  const derivedStore = (() => {
    if (stores && returned) {
      return derived(stores, (values) => {
        const result = returned(values);
        if (isFunctionWithParams(result)) {
          const fn = (...args2) => {
            return hiddenAction({
              ...result(...args2),
              [`data-melt-${name2}`]: "",
              action: action ?? noop$1
            });
          };
          fn.action = action ?? noop$1;
          return fn;
        }
        return hiddenAction({
          ...result,
          [`data-melt-${name2}`]: "",
          action: action ?? noop$1
        });
      });
    } else {
      const returnedFn = returned;
      const result = returnedFn?.();
      if (isFunctionWithParams(result)) {
        const resultFn = (...args2) => {
          return hiddenAction({
            ...result(...args2),
            [`data-melt-${name2}`]: "",
            action: action ?? noop$1
          });
        };
        resultFn.action = action ?? noop$1;
        return lightable(resultFn);
      }
      return lightable(hiddenAction({
        ...result,
        [`data-melt-${name2}`]: "",
        action: action ?? noop$1
      }));
    }
  })();
  const actionFn = action ?? (() => {
  });
  actionFn.subscribe = derivedStore.subscribe;
  return actionFn;
}
function createElHelpers(prefix) {
  const name2 = (part) => part ? `${prefix}-${part}` : prefix;
  const attribute = (part) => `data-melt-${prefix}${part ? `-${part}` : ""}`;
  const selector = (part) => `[data-melt-${prefix}${part ? `-${part}` : ""}]`;
  const getEl = (part) => document.querySelector(selector(part));
  return {
    name: name2,
    attribute,
    selector,
    getEl
  };
}
const isBrowser$1 = typeof document !== "undefined";
const isFunction = (v) => typeof v === "function";
function isElement(element2) {
  return element2 instanceof Element;
}
function isHTMLElement$1(element2) {
  return element2 instanceof HTMLElement;
}
function isObject(value) {
  return value !== null && typeof value === "object";
}
function isReadable(value) {
  return isObject(value) && "subscribe" in value;
}
function executeCallbacks(...callbacks) {
  return (...args) => {
    for (const callback of callbacks) {
      if (typeof callback === "function") {
        callback(...args);
      }
    }
  };
}
function noop$1() {
}
function addEventListener$1(target, event, handler, options) {
  const events = Array.isArray(event) ? event : [event];
  events.forEach((_event) => target.addEventListener(_event, handler, options));
  return () => {
    events.forEach((_event) => target.removeEventListener(_event, handler, options));
  };
}
function addMeltEventListener(target, event, handler, options) {
  const events = Array.isArray(event) ? event : [event];
  if (typeof handler === "function") {
    const handlerWithMelt = withMelt((_event) => handler(_event));
    events.forEach((_event) => target.addEventListener(_event, handlerWithMelt, options));
    return () => {
      events.forEach((_event) => target.removeEventListener(_event, handlerWithMelt, options));
    };
  }
  return () => noop$1();
}
function dispatchMeltEvent(originalEvent) {
  const node = originalEvent.currentTarget;
  if (!isHTMLElement$1(node))
    return null;
  const customMeltEvent = new CustomEvent(`m-${originalEvent.type}`, {
    detail: {
      originalEvent
    },
    cancelable: true
  });
  node.dispatchEvent(customMeltEvent);
  return customMeltEvent;
}
function withMelt(handler) {
  return (event) => {
    const customEvent = dispatchMeltEvent(event);
    if (customEvent?.defaultPrevented)
      return;
    return handler(event);
  };
}
const safeOnDestroy$1 = (fn) => {
  try {
    onDestroy(fn);
  } catch {
    return fn;
  }
};
function omit$1(obj, ...keys) {
  const result = {};
  for (const key of Object.keys(obj)) {
    if (!keys.includes(key)) {
      result[key] = obj[key];
    }
  }
  return result;
}
function withGet(store) {
  return {
    ...store,
    get: () => get(store)
  };
}
withGet.writable = function(initial) {
  const internal = writable(initial);
  let value = initial;
  return {
    subscribe: internal.subscribe,
    set(newValue) {
      internal.set(newValue);
      value = newValue;
    },
    update(updater) {
      const newValue = updater(value);
      internal.set(newValue);
      value = newValue;
    },
    get() {
      return value;
    }
  };
};
withGet.derived = function(stores, fn) {
  const subscribers = /* @__PURE__ */ new Map();
  const get2 = () => {
    const values = Array.isArray(stores) ? stores.map((store) => store.get()) : stores.get();
    return fn(values);
  };
  const subscribe = (subscriber) => {
    const unsubscribers = [];
    const storesArr = Array.isArray(stores) ? stores : [stores];
    storesArr.forEach((store) => {
      unsubscribers.push(store.subscribe(() => {
        subscriber(get2());
      }));
    });
    subscriber(get2());
    subscribers.set(subscriber, unsubscribers);
    return () => {
      const unsubscribers2 = subscribers.get(subscriber);
      if (unsubscribers2) {
        for (const unsubscribe of unsubscribers2) {
          unsubscribe();
        }
      }
      subscribers.delete(subscriber);
    };
  };
  return {
    get: get2,
    subscribe
  };
};
const overridable$1 = (_store, onChange) => {
  const store = withGet(_store);
  const update = (updater, sideEffect) => {
    store.update((curr) => {
      const next = updater(curr);
      let res = next;
      if (onChange) {
        res = onChange({ curr, next });
      }
      sideEffect?.(res);
      return res;
    });
  };
  const set2 = (curr) => {
    update(() => curr);
  };
  return {
    ...store,
    update,
    set: set2
  };
};
function sleep$1(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
let urlAlphabet = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";
let nanoid = (size = 21) => {
  let id = "";
  let i2 = size | 0;
  while (i2--) {
    id += urlAlphabet[Math.random() * 64 | 0];
  }
  return id;
};
function generateId() {
  return nanoid(10);
}
function generateIds(args) {
  return args.reduce((acc, curr) => {
    acc[curr] = generateId();
    return acc;
  }, {});
}
const kbd = {
  ENTER: "Enter",
  ESCAPE: "Escape",
  SPACE: " "
};
const isDom = () => typeof window !== "undefined";
function getPlatform() {
  const agent = navigator.userAgentData;
  return agent?.platform ?? navigator.platform;
}
const pt = (v) => isDom() && v.test(getPlatform().toLowerCase());
const isTouchDevice = () => isDom() && !!navigator.maxTouchPoints;
const isMac$1 = () => pt(/^mac/) && !isTouchDevice();
const isApple = () => pt(/mac|iphone|ipad|ipod/i);
const isIos = () => isApple() && !isMac$1();
const LOCK_CLASSNAME = "data-melt-scroll-lock";
function assignStyle(el, style) {
  if (!el)
    return;
  const previousStyle = el.style.cssText;
  Object.assign(el.style, style);
  return () => {
    el.style.cssText = previousStyle;
  };
}
function setCSSProperty$1(el, property, value) {
  if (!el)
    return;
  const previousValue = el.style.getPropertyValue(property);
  el.style.setProperty(property, value);
  return () => {
    if (previousValue) {
      el.style.setProperty(property, previousValue);
    } else {
      el.style.removeProperty(property);
    }
  };
}
function getPaddingProperty$1(documentElement) {
  const documentLeft = documentElement.getBoundingClientRect().left;
  const scrollbarX = Math.round(documentLeft) + documentElement.scrollLeft;
  return scrollbarX ? "paddingLeft" : "paddingRight";
}
function removeScroll(_document) {
  const doc = document;
  const win = doc.defaultView ?? window;
  const { documentElement, body } = doc;
  const locked = body.hasAttribute(LOCK_CLASSNAME);
  if (locked)
    return noop$1;
  body.setAttribute(LOCK_CLASSNAME, "");
  const scrollbarWidth = win.innerWidth - documentElement.clientWidth;
  const setScrollbarWidthProperty = () => setCSSProperty$1(documentElement, "--scrollbar-width", `${scrollbarWidth}px`);
  const paddingProperty = getPaddingProperty$1(documentElement);
  const scrollbarSidePadding = win.getComputedStyle(body)[paddingProperty];
  const setStyle2 = () => assignStyle(body, {
    overflow: "hidden",
    [paddingProperty]: `calc(${scrollbarSidePadding} + ${scrollbarWidth}px)`
  });
  const setIOSStyle = () => {
    const { scrollX, scrollY, visualViewport: visualViewport2 } = win;
    const offsetLeft = visualViewport2?.offsetLeft ?? 0;
    const offsetTop = visualViewport2?.offsetTop ?? 0;
    const restoreStyle = assignStyle(body, {
      position: "fixed",
      overflow: "hidden",
      top: `${-(scrollY - Math.floor(offsetTop))}px`,
      left: `${-(scrollX - Math.floor(offsetLeft))}px`,
      right: "0",
      [paddingProperty]: `calc(${scrollbarSidePadding} + ${scrollbarWidth}px)`
    });
    return () => {
      restoreStyle?.();
      win.scrollTo(scrollX, scrollY);
    };
  };
  const cleanups = [setScrollbarWidthProperty(), isIos() ? setIOSStyle() : setStyle2()];
  return () => {
    cleanups.forEach((fn) => fn?.());
    body.removeAttribute(LOCK_CLASSNAME);
  };
}
function effect$1(stores, fn) {
  let cb = void 0;
  const destroy = derived(stores, (stores2) => {
    cb?.();
    cb = fn(stores2);
  }).subscribe(noop$1);
  const unsub = () => {
    destroy();
    cb?.();
  };
  safeOnDestroy$1(unsub);
  return unsub;
}
function toWritableStores$1(properties) {
  const result = {};
  Object.keys(properties).forEach((key) => {
    const propertyKey = key;
    const value = properties[propertyKey];
    result[propertyKey] = withGet(writable(value));
  });
  return result;
}
function getPortalParent(node) {
  let parent = node.parentElement;
  while (isHTMLElement$1(parent) && !parent.hasAttribute("data-portal")) {
    parent = parent.parentElement;
  }
  return parent || "body";
}
function getPortalDestination(node, portalProp) {
  if (portalProp !== void 0)
    return portalProp;
  const portalParent = getPortalParent(node);
  if (portalParent === "body")
    return document.body;
  return null;
}
async function handleFocus(args) {
  const { prop, defaultEl } = args;
  await Promise.all([sleep$1(1), tick]);
  if (prop === void 0) {
    defaultEl?.focus();
    return;
  }
  const returned = isFunction(prop) ? prop(defaultEl) : prop;
  if (typeof returned === "string") {
    const el = document.querySelector(returned);
    if (!isHTMLElement$1(el))
      return;
    el.focus();
  } else if (isHTMLElement$1(returned)) {
    returned.focus();
  }
}
readable(void 0, (set2) => {
  function clicked(event) {
    set2(event);
    set2(void 0);
  }
  const unsubscribe = addEventListener$1(document, "pointerup", clicked, {
    passive: false,
    capture: true
  });
  return unsubscribe;
});
const documentEscapeKeyStore$1 = readable(void 0, (set2) => {
  function keydown(event) {
    if (event && event.key === kbd.ESCAPE) {
      set2(event);
    }
    set2(void 0);
  }
  const unsubscribe = addEventListener$1(document, "keydown", keydown, {
    passive: false
  });
  return unsubscribe;
});
const useEscapeKeydown = (node, config = {}) => {
  let unsub = noop$1;
  function update(config2 = {}) {
    unsub();
    const options = { enabled: true, ...config2 };
    const enabled = isReadable(options.enabled) ? options.enabled : readable(options.enabled);
    unsub = executeCallbacks(
      // Handle escape keydowns
      documentEscapeKeyStore$1.subscribe((e2) => {
        if (!e2 || !get(enabled))
          return;
        const target = e2.target;
        if (!isHTMLElement$1(target) || target.closest("[data-escapee]") !== node) {
          return;
        }
        e2.preventDefault();
        if (options.ignore) {
          if (isFunction(options.ignore)) {
            if (options.ignore(e2))
              return;
          } else if (Array.isArray(options.ignore)) {
            if (options.ignore.length > 0 && options.ignore.some((ignoreEl) => {
              return ignoreEl && target === ignoreEl;
            }))
              return;
          }
        }
        options.handler?.(e2);
      }),
      effect$1(enabled, ($enabled) => {
        if ($enabled) {
          node.dataset.escapee = "";
        } else {
          delete node.dataset.escapee;
        }
      })
    );
  }
  update(config);
  return {
    update,
    destroy() {
      node.removeAttribute("data-escapee");
      unsub();
    }
  };
};
/*!
* focus-trap 7.6.4
* @license MIT, https://github.com/focus-trap/focus-trap/blob/master/LICENSE
*/
function _arrayLikeToArray(r2, a2) {
  (null == a2 || a2 > r2.length) && (a2 = r2.length);
  for (var e2 = 0, n2 = Array(a2); e2 < a2; e2++) n2[e2] = r2[e2];
  return n2;
}
function _arrayWithoutHoles(r2) {
  if (Array.isArray(r2)) return _arrayLikeToArray(r2);
}
function _defineProperty(e2, r2, t2) {
  return (r2 = _toPropertyKey(r2)) in e2 ? Object.defineProperty(e2, r2, {
    value: t2,
    enumerable: true,
    configurable: true,
    writable: true
  }) : e2[r2] = t2, e2;
}
function _iterableToArray(r2) {
  if ("undefined" != typeof Symbol && null != r2[Symbol.iterator] || null != r2["@@iterator"]) return Array.from(r2);
}
function _nonIterableSpread() {
  throw new TypeError("Invalid attempt to spread non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.");
}
function ownKeys(e2, r2) {
  var t2 = Object.keys(e2);
  if (Object.getOwnPropertySymbols) {
    var o2 = Object.getOwnPropertySymbols(e2);
    r2 && (o2 = o2.filter(function(r3) {
      return Object.getOwnPropertyDescriptor(e2, r3).enumerable;
    })), t2.push.apply(t2, o2);
  }
  return t2;
}
function _objectSpread2(e2) {
  for (var r2 = 1; r2 < arguments.length; r2++) {
    var t2 = null != arguments[r2] ? arguments[r2] : {};
    r2 % 2 ? ownKeys(Object(t2), true).forEach(function(r3) {
      _defineProperty(e2, r3, t2[r3]);
    }) : Object.getOwnPropertyDescriptors ? Object.defineProperties(e2, Object.getOwnPropertyDescriptors(t2)) : ownKeys(Object(t2)).forEach(function(r3) {
      Object.defineProperty(e2, r3, Object.getOwnPropertyDescriptor(t2, r3));
    });
  }
  return e2;
}
function _toConsumableArray(r2) {
  return _arrayWithoutHoles(r2) || _iterableToArray(r2) || _unsupportedIterableToArray(r2) || _nonIterableSpread();
}
function _toPrimitive(t2, r2) {
  if ("object" != typeof t2 || !t2) return t2;
  var e2 = t2[Symbol.toPrimitive];
  if (void 0 !== e2) {
    var i2 = e2.call(t2, r2);
    if ("object" != typeof i2) return i2;
    throw new TypeError("@@toPrimitive must return a primitive value.");
  }
  return ("string" === r2 ? String : Number)(t2);
}
function _toPropertyKey(t2) {
  var i2 = _toPrimitive(t2, "string");
  return "symbol" == typeof i2 ? i2 : i2 + "";
}
function _unsupportedIterableToArray(r2, a2) {
  if (r2) {
    if ("string" == typeof r2) return _arrayLikeToArray(r2, a2);
    var t2 = {}.toString.call(r2).slice(8, -1);
    return "Object" === t2 && r2.constructor && (t2 = r2.constructor.name), "Map" === t2 || "Set" === t2 ? Array.from(r2) : "Arguments" === t2 || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(t2) ? _arrayLikeToArray(r2, a2) : void 0;
  }
}
var activeFocusTraps = {
  activateTrap: function activateTrap(trapStack, trap) {
    if (trapStack.length > 0) {
      var activeTrap = trapStack[trapStack.length - 1];
      if (activeTrap !== trap) {
        activeTrap._setPausedState(true);
      }
    }
    var trapIndex = trapStack.indexOf(trap);
    if (trapIndex === -1) {
      trapStack.push(trap);
    } else {
      trapStack.splice(trapIndex, 1);
      trapStack.push(trap);
    }
  },
  deactivateTrap: function deactivateTrap(trapStack, trap) {
    var trapIndex = trapStack.indexOf(trap);
    if (trapIndex !== -1) {
      trapStack.splice(trapIndex, 1);
    }
    if (trapStack.length > 0 && !trapStack[trapStack.length - 1]._isManuallyPaused()) {
      trapStack[trapStack.length - 1]._setPausedState(false);
    }
  }
};
var isSelectableInput = function isSelectableInput2(node) {
  return node.tagName && node.tagName.toLowerCase() === "input" && typeof node.select === "function";
};
var isEscapeEvent = function isEscapeEvent2(e2) {
  return (e2 === null || e2 === void 0 ? void 0 : e2.key) === "Escape" || (e2 === null || e2 === void 0 ? void 0 : e2.key) === "Esc" || (e2 === null || e2 === void 0 ? void 0 : e2.keyCode) === 27;
};
var isTabEvent = function isTabEvent2(e2) {
  return (e2 === null || e2 === void 0 ? void 0 : e2.key) === "Tab" || (e2 === null || e2 === void 0 ? void 0 : e2.keyCode) === 9;
};
var isKeyForward = function isKeyForward2(e2) {
  return isTabEvent(e2) && !e2.shiftKey;
};
var isKeyBackward = function isKeyBackward2(e2) {
  return isTabEvent(e2) && e2.shiftKey;
};
var delay = function delay2(fn) {
  return setTimeout(fn, 0);
};
var valueOrHandler = function valueOrHandler2(value) {
  for (var _len = arguments.length, params = new Array(_len > 1 ? _len - 1 : 0), _key = 1; _key < _len; _key++) {
    params[_key - 1] = arguments[_key];
  }
  return typeof value === "function" ? value.apply(void 0, params) : value;
};
var getActualTarget = function getActualTarget2(event) {
  return event.target.shadowRoot && typeof event.composedPath === "function" ? event.composedPath()[0] : event.target;
};
var internalTrapStack = [];
var createFocusTrap$1 = function createFocusTrap(elements, userOptions) {
  var doc = (userOptions === null || userOptions === void 0 ? void 0 : userOptions.document) || document;
  var trapStack = (userOptions === null || userOptions === void 0 ? void 0 : userOptions.trapStack) || internalTrapStack;
  var config = _objectSpread2({
    returnFocusOnDeactivate: true,
    escapeDeactivates: true,
    delayInitialFocus: true,
    isKeyForward,
    isKeyBackward
  }, userOptions);
  var state = {
    // containers given to createFocusTrap()
    // @type {Array<HTMLElement>}
    containers: [],
    // list of objects identifying tabbable nodes in `containers` in the trap
    // NOTE: it's possible that a group has no tabbable nodes if nodes get removed while the trap
    //  is active, but the trap should never get to a state where there isn't at least one group
    //  with at least one tabbable node in it (that would lead to an error condition that would
    //  result in an error being thrown)
    // @type {Array<{
    //   container: HTMLElement,
    //   tabbableNodes: Array<HTMLElement>, // empty if none
    //   focusableNodes: Array<HTMLElement>, // empty if none
    //   posTabIndexesFound: boolean,
    //   firstTabbableNode: HTMLElement|undefined,
    //   lastTabbableNode: HTMLElement|undefined,
    //   firstDomTabbableNode: HTMLElement|undefined,
    //   lastDomTabbableNode: HTMLElement|undefined,
    //   nextTabbableNode: (node: HTMLElement, forward: boolean) => HTMLElement|undefined
    // }>}
    containerGroups: [],
    // same order/length as `containers` list
    // references to objects in `containerGroups`, but only those that actually have
    //  tabbable nodes in them
    // NOTE: same order as `containers` and `containerGroups`, but __not necessarily__
    //  the same length
    tabbableGroups: [],
    nodeFocusedBeforeActivation: null,
    mostRecentlyFocusedNode: null,
    active: false,
    paused: false,
    manuallyPaused: false,
    // timer ID for when delayInitialFocus is true and initial focus in this trap
    //  has been delayed during activation
    delayInitialFocusTimer: void 0,
    // the most recent KeyboardEvent for the configured nav key (typically [SHIFT+]TAB), if any
    recentNavEvent: void 0
  };
  var trap;
  var getOption = function getOption2(configOverrideOptions, optionName, configOptionName) {
    return configOverrideOptions && configOverrideOptions[optionName] !== void 0 ? configOverrideOptions[optionName] : config[configOptionName || optionName];
  };
  var findContainerIndex = function findContainerIndex2(element2, event) {
    var composedPath = typeof (event === null || event === void 0 ? void 0 : event.composedPath) === "function" ? event.composedPath() : void 0;
    return state.containerGroups.findIndex(function(_ref) {
      var container = _ref.container, tabbableNodes = _ref.tabbableNodes;
      return container.contains(element2) || // fall back to explicit tabbable search which will take into consideration any
      //  web components if the `tabbableOptions.getShadowRoot` option was used for
      //  the trap, enabling shadow DOM support in tabbable (`Node.contains()` doesn't
      //  look inside web components even if open)
      (composedPath === null || composedPath === void 0 ? void 0 : composedPath.includes(container)) || tabbableNodes.find(function(node) {
        return node === element2;
      });
    });
  };
  var getNodeForOption = function getNodeForOption2(optionName) {
    var _ref2 = arguments.length > 1 && arguments[1] !== void 0 ? arguments[1] : {}, _ref2$hasFallback = _ref2.hasFallback, hasFallback = _ref2$hasFallback === void 0 ? false : _ref2$hasFallback, _ref2$params = _ref2.params, params = _ref2$params === void 0 ? [] : _ref2$params;
    var optionValue = config[optionName];
    if (typeof optionValue === "function") {
      optionValue = optionValue.apply(void 0, _toConsumableArray(params));
    }
    if (optionValue === true) {
      optionValue = void 0;
    }
    if (!optionValue) {
      if (optionValue === void 0 || optionValue === false) {
        return optionValue;
      }
      throw new Error("`".concat(optionName, "` was specified but was not a node, or did not return a node"));
    }
    var node = optionValue;
    if (typeof optionValue === "string") {
      try {
        node = doc.querySelector(optionValue);
      } catch (err) {
        throw new Error("`".concat(optionName, '` appears to be an invalid selector; error="').concat(err.message, '"'));
      }
      if (!node) {
        if (!hasFallback) {
          throw new Error("`".concat(optionName, "` as selector refers to no known node"));
        }
      }
    }
    return node;
  };
  var getInitialFocusNode = function getInitialFocusNode2() {
    var node = getNodeForOption("initialFocus", {
      hasFallback: true
    });
    if (node === false) {
      return false;
    }
    if (node === void 0 || node && !isFocusable(node, config.tabbableOptions)) {
      if (findContainerIndex(doc.activeElement) >= 0) {
        node = doc.activeElement;
      } else {
        var firstTabbableGroup = state.tabbableGroups[0];
        var firstTabbableNode = firstTabbableGroup && firstTabbableGroup.firstTabbableNode;
        node = firstTabbableNode || getNodeForOption("fallbackFocus");
      }
    } else if (node === null) {
      node = getNodeForOption("fallbackFocus");
    }
    if (!node) {
      throw new Error("Your focus-trap needs to have at least one focusable element");
    }
    return node;
  };
  var updateTabbableNodes = function updateTabbableNodes2() {
    state.containerGroups = state.containers.map(function(container) {
      var tabbableNodes = tabbable(container, config.tabbableOptions);
      var focusableNodes = focusable(container, config.tabbableOptions);
      var firstTabbableNode = tabbableNodes.length > 0 ? tabbableNodes[0] : void 0;
      var lastTabbableNode = tabbableNodes.length > 0 ? tabbableNodes[tabbableNodes.length - 1] : void 0;
      var firstDomTabbableNode = focusableNodes.find(function(node) {
        return isTabbable(node);
      });
      var lastDomTabbableNode = focusableNodes.slice().reverse().find(function(node) {
        return isTabbable(node);
      });
      var posTabIndexesFound = !!tabbableNodes.find(function(node) {
        return getTabIndex(node) > 0;
      });
      return {
        container,
        tabbableNodes,
        focusableNodes,
        /** True if at least one node with positive `tabindex` was found in this container. */
        posTabIndexesFound,
        /** First tabbable node in container, __tabindex__ order; `undefined` if none. */
        firstTabbableNode,
        /** Last tabbable node in container, __tabindex__ order; `undefined` if none. */
        lastTabbableNode,
        // NOTE: DOM order is NOT NECESSARILY "document position" order, but figuring that out
        //  would require more than just https://developer.mozilla.org/en-US/docs/Web/API/Node/compareDocumentPosition
        //  because that API doesn't work with Shadow DOM as well as it should (@see
        //  https://github.com/whatwg/dom/issues/320) and since this first/last is only needed, so far,
        //  to address an edge case related to positive tabindex support, this seems like a much easier,
        //  "close enough most of the time" alternative for positive tabindexes which should generally
        //  be avoided anyway...
        /** First tabbable node in container, __DOM__ order; `undefined` if none. */
        firstDomTabbableNode,
        /** Last tabbable node in container, __DOM__ order; `undefined` if none. */
        lastDomTabbableNode,
        /**
         * Finds the __tabbable__ node that follows the given node in the specified direction,
         *  in this container, if any.
         * @param {HTMLElement} node
         * @param {boolean} [forward] True if going in forward tab order; false if going
         *  in reverse.
         * @returns {HTMLElement|undefined} The next tabbable node, if any.
         */
        nextTabbableNode: function nextTabbableNode(node) {
          var forward = arguments.length > 1 && arguments[1] !== void 0 ? arguments[1] : true;
          var nodeIdx = tabbableNodes.indexOf(node);
          if (nodeIdx < 0) {
            if (forward) {
              return focusableNodes.slice(focusableNodes.indexOf(node) + 1).find(function(el) {
                return isTabbable(el);
              });
            }
            return focusableNodes.slice(0, focusableNodes.indexOf(node)).reverse().find(function(el) {
              return isTabbable(el);
            });
          }
          return tabbableNodes[nodeIdx + (forward ? 1 : -1)];
        }
      };
    });
    state.tabbableGroups = state.containerGroups.filter(function(group) {
      return group.tabbableNodes.length > 0;
    });
    if (state.tabbableGroups.length <= 0 && !getNodeForOption("fallbackFocus")) {
      throw new Error("Your focus-trap must have at least one container with at least one tabbable node in it at all times");
    }
    if (state.containerGroups.find(function(g) {
      return g.posTabIndexesFound;
    }) && state.containerGroups.length > 1) {
      throw new Error("At least one node with a positive tabindex was found in one of your focus-trap's multiple containers. Positive tabindexes are only supported in single-container focus-traps.");
    }
  };
  var _getActiveElement = function getActiveElement(el) {
    var activeElement = el.activeElement;
    if (!activeElement) {
      return;
    }
    if (activeElement.shadowRoot && activeElement.shadowRoot.activeElement !== null) {
      return _getActiveElement(activeElement.shadowRoot);
    }
    return activeElement;
  };
  var _tryFocus = function tryFocus(node) {
    if (node === false) {
      return;
    }
    if (node === _getActiveElement(document)) {
      return;
    }
    if (!node || !node.focus) {
      _tryFocus(getInitialFocusNode());
      return;
    }
    node.focus({
      preventScroll: !!config.preventScroll
    });
    state.mostRecentlyFocusedNode = node;
    if (isSelectableInput(node)) {
      node.select();
    }
  };
  var getReturnFocusNode = function getReturnFocusNode2(previousActiveElement) {
    var node = getNodeForOption("setReturnFocus", {
      params: [previousActiveElement]
    });
    return node ? node : node === false ? false : previousActiveElement;
  };
  var findNextNavNode = function findNextNavNode2(_ref3) {
    var target = _ref3.target, event = _ref3.event, _ref3$isBackward = _ref3.isBackward, isBackward = _ref3$isBackward === void 0 ? false : _ref3$isBackward;
    target = target || getActualTarget(event);
    updateTabbableNodes();
    var destinationNode = null;
    if (state.tabbableGroups.length > 0) {
      var containerIndex = findContainerIndex(target, event);
      var containerGroup = containerIndex >= 0 ? state.containerGroups[containerIndex] : void 0;
      if (containerIndex < 0) {
        if (isBackward) {
          destinationNode = state.tabbableGroups[state.tabbableGroups.length - 1].lastTabbableNode;
        } else {
          destinationNode = state.tabbableGroups[0].firstTabbableNode;
        }
      } else if (isBackward) {
        var startOfGroupIndex = state.tabbableGroups.findIndex(function(_ref4) {
          var firstTabbableNode = _ref4.firstTabbableNode;
          return target === firstTabbableNode;
        });
        if (startOfGroupIndex < 0 && (containerGroup.container === target || isFocusable(target, config.tabbableOptions) && !isTabbable(target, config.tabbableOptions) && !containerGroup.nextTabbableNode(target, false))) {
          startOfGroupIndex = containerIndex;
        }
        if (startOfGroupIndex >= 0) {
          var destinationGroupIndex = startOfGroupIndex === 0 ? state.tabbableGroups.length - 1 : startOfGroupIndex - 1;
          var destinationGroup = state.tabbableGroups[destinationGroupIndex];
          destinationNode = getTabIndex(target) >= 0 ? destinationGroup.lastTabbableNode : destinationGroup.lastDomTabbableNode;
        } else if (!isTabEvent(event)) {
          destinationNode = containerGroup.nextTabbableNode(target, false);
        }
      } else {
        var lastOfGroupIndex = state.tabbableGroups.findIndex(function(_ref5) {
          var lastTabbableNode = _ref5.lastTabbableNode;
          return target === lastTabbableNode;
        });
        if (lastOfGroupIndex < 0 && (containerGroup.container === target || isFocusable(target, config.tabbableOptions) && !isTabbable(target, config.tabbableOptions) && !containerGroup.nextTabbableNode(target))) {
          lastOfGroupIndex = containerIndex;
        }
        if (lastOfGroupIndex >= 0) {
          var _destinationGroupIndex = lastOfGroupIndex === state.tabbableGroups.length - 1 ? 0 : lastOfGroupIndex + 1;
          var _destinationGroup = state.tabbableGroups[_destinationGroupIndex];
          destinationNode = getTabIndex(target) >= 0 ? _destinationGroup.firstTabbableNode : _destinationGroup.firstDomTabbableNode;
        } else if (!isTabEvent(event)) {
          destinationNode = containerGroup.nextTabbableNode(target);
        }
      }
    } else {
      destinationNode = getNodeForOption("fallbackFocus");
    }
    return destinationNode;
  };
  var checkPointerDown = function checkPointerDown2(e2) {
    var target = getActualTarget(e2);
    if (findContainerIndex(target, e2) >= 0) {
      return;
    }
    if (valueOrHandler(config.clickOutsideDeactivates, e2)) {
      trap.deactivate({
        // NOTE: by setting `returnFocus: false`, deactivate() will do nothing,
        //  which will result in the outside click setting focus to the node
        //  that was clicked (and if not focusable, to "nothing"); by setting
        //  `returnFocus: true`, we'll attempt to re-focus the node originally-focused
        //  on activation (or the configured `setReturnFocus` node), whether the
        //  outside click was on a focusable node or not
        returnFocus: config.returnFocusOnDeactivate
      });
      return;
    }
    if (valueOrHandler(config.allowOutsideClick, e2)) {
      return;
    }
    e2.preventDefault();
  };
  var checkFocusIn = function checkFocusIn2(event) {
    var target = getActualTarget(event);
    var targetContained = findContainerIndex(target, event) >= 0;
    if (targetContained || target instanceof Document) {
      if (targetContained) {
        state.mostRecentlyFocusedNode = target;
      }
    } else {
      event.stopImmediatePropagation();
      var nextNode;
      var navAcrossContainers = true;
      if (state.mostRecentlyFocusedNode) {
        if (getTabIndex(state.mostRecentlyFocusedNode) > 0) {
          var mruContainerIdx = findContainerIndex(state.mostRecentlyFocusedNode);
          var tabbableNodes = state.containerGroups[mruContainerIdx].tabbableNodes;
          if (tabbableNodes.length > 0) {
            var mruTabIdx = tabbableNodes.findIndex(function(node) {
              return node === state.mostRecentlyFocusedNode;
            });
            if (mruTabIdx >= 0) {
              if (config.isKeyForward(state.recentNavEvent)) {
                if (mruTabIdx + 1 < tabbableNodes.length) {
                  nextNode = tabbableNodes[mruTabIdx + 1];
                  navAcrossContainers = false;
                }
              } else {
                if (mruTabIdx - 1 >= 0) {
                  nextNode = tabbableNodes[mruTabIdx - 1];
                  navAcrossContainers = false;
                }
              }
            }
          }
        } else {
          if (!state.containerGroups.some(function(g) {
            return g.tabbableNodes.some(function(n2) {
              return getTabIndex(n2) > 0;
            });
          })) {
            navAcrossContainers = false;
          }
        }
      } else {
        navAcrossContainers = false;
      }
      if (navAcrossContainers) {
        nextNode = findNextNavNode({
          // move FROM the MRU node, not event-related node (which will be the node that is
          //  outside the trap causing the focus escape we're trying to fix)
          target: state.mostRecentlyFocusedNode,
          isBackward: config.isKeyBackward(state.recentNavEvent)
        });
      }
      if (nextNode) {
        _tryFocus(nextNode);
      } else {
        _tryFocus(state.mostRecentlyFocusedNode || getInitialFocusNode());
      }
    }
    state.recentNavEvent = void 0;
  };
  var checkKeyNav = function checkKeyNav2(event) {
    var isBackward = arguments.length > 1 && arguments[1] !== void 0 ? arguments[1] : false;
    state.recentNavEvent = event;
    var destinationNode = findNextNavNode({
      event,
      isBackward
    });
    if (destinationNode) {
      if (isTabEvent(event)) {
        event.preventDefault();
      }
      _tryFocus(destinationNode);
    }
  };
  var checkTabKey = function checkTabKey2(event) {
    if (config.isKeyForward(event) || config.isKeyBackward(event)) {
      checkKeyNav(event, config.isKeyBackward(event));
    }
  };
  var checkEscapeKey = function checkEscapeKey2(event) {
    if (isEscapeEvent(event) && valueOrHandler(config.escapeDeactivates, event) !== false) {
      event.preventDefault();
      trap.deactivate();
    }
  };
  var checkClick = function checkClick2(e2) {
    var target = getActualTarget(e2);
    if (findContainerIndex(target, e2) >= 0) {
      return;
    }
    if (valueOrHandler(config.clickOutsideDeactivates, e2)) {
      return;
    }
    if (valueOrHandler(config.allowOutsideClick, e2)) {
      return;
    }
    e2.preventDefault();
    e2.stopImmediatePropagation();
  };
  var addListeners = function addListeners2() {
    if (!state.active) {
      return;
    }
    activeFocusTraps.activateTrap(trapStack, trap);
    state.delayInitialFocusTimer = config.delayInitialFocus ? delay(function() {
      _tryFocus(getInitialFocusNode());
    }) : _tryFocus(getInitialFocusNode());
    doc.addEventListener("focusin", checkFocusIn, true);
    doc.addEventListener("mousedown", checkPointerDown, {
      capture: true,
      passive: false
    });
    doc.addEventListener("touchstart", checkPointerDown, {
      capture: true,
      passive: false
    });
    doc.addEventListener("click", checkClick, {
      capture: true,
      passive: false
    });
    doc.addEventListener("keydown", checkTabKey, {
      capture: true,
      passive: false
    });
    doc.addEventListener("keydown", checkEscapeKey);
    return trap;
  };
  var removeListeners = function removeListeners2() {
    if (!state.active) {
      return;
    }
    doc.removeEventListener("focusin", checkFocusIn, true);
    doc.removeEventListener("mousedown", checkPointerDown, true);
    doc.removeEventListener("touchstart", checkPointerDown, true);
    doc.removeEventListener("click", checkClick, true);
    doc.removeEventListener("keydown", checkTabKey, true);
    doc.removeEventListener("keydown", checkEscapeKey);
    return trap;
  };
  var checkDomRemoval = function checkDomRemoval2(mutations) {
    var isFocusedNodeRemoved = mutations.some(function(mutation) {
      var removedNodes = Array.from(mutation.removedNodes);
      return removedNodes.some(function(node) {
        return node === state.mostRecentlyFocusedNode;
      });
    });
    if (isFocusedNodeRemoved) {
      _tryFocus(getInitialFocusNode());
    }
  };
  var mutationObserver = typeof window !== "undefined" && "MutationObserver" in window ? new MutationObserver(checkDomRemoval) : void 0;
  var updateObservedNodes = function updateObservedNodes2() {
    if (!mutationObserver) {
      return;
    }
    mutationObserver.disconnect();
    if (state.active && !state.paused) {
      state.containers.map(function(container) {
        mutationObserver.observe(container, {
          subtree: true,
          childList: true
        });
      });
    }
  };
  trap = {
    get active() {
      return state.active;
    },
    get paused() {
      return state.paused;
    },
    activate: function activate(activateOptions) {
      if (state.active) {
        return this;
      }
      var onActivate = getOption(activateOptions, "onActivate");
      var onPostActivate = getOption(activateOptions, "onPostActivate");
      var checkCanFocusTrap = getOption(activateOptions, "checkCanFocusTrap");
      if (!checkCanFocusTrap) {
        updateTabbableNodes();
      }
      state.active = true;
      state.paused = false;
      state.nodeFocusedBeforeActivation = doc.activeElement;
      onActivate === null || onActivate === void 0 || onActivate();
      var finishActivation = function finishActivation2() {
        if (checkCanFocusTrap) {
          updateTabbableNodes();
        }
        addListeners();
        updateObservedNodes();
        onPostActivate === null || onPostActivate === void 0 || onPostActivate();
      };
      if (checkCanFocusTrap) {
        checkCanFocusTrap(state.containers.concat()).then(finishActivation, finishActivation);
        return this;
      }
      finishActivation();
      return this;
    },
    deactivate: function deactivate(deactivateOptions) {
      if (!state.active) {
        return this;
      }
      var options = _objectSpread2({
        onDeactivate: config.onDeactivate,
        onPostDeactivate: config.onPostDeactivate,
        checkCanReturnFocus: config.checkCanReturnFocus
      }, deactivateOptions);
      clearTimeout(state.delayInitialFocusTimer);
      state.delayInitialFocusTimer = void 0;
      removeListeners();
      state.active = false;
      state.paused = false;
      updateObservedNodes();
      activeFocusTraps.deactivateTrap(trapStack, trap);
      var onDeactivate = getOption(options, "onDeactivate");
      var onPostDeactivate = getOption(options, "onPostDeactivate");
      var checkCanReturnFocus = getOption(options, "checkCanReturnFocus");
      var returnFocus = getOption(options, "returnFocus", "returnFocusOnDeactivate");
      onDeactivate === null || onDeactivate === void 0 || onDeactivate();
      var finishDeactivation = function finishDeactivation2() {
        delay(function() {
          if (returnFocus) {
            _tryFocus(getReturnFocusNode(state.nodeFocusedBeforeActivation));
          }
          onPostDeactivate === null || onPostDeactivate === void 0 || onPostDeactivate();
        });
      };
      if (returnFocus && checkCanReturnFocus) {
        checkCanReturnFocus(getReturnFocusNode(state.nodeFocusedBeforeActivation)).then(finishDeactivation, finishDeactivation);
        return this;
      }
      finishDeactivation();
      return this;
    },
    pause: function pause(pauseOptions) {
      if (!state.active) {
        return this;
      }
      state.manuallyPaused = true;
      return this._setPausedState(true, pauseOptions);
    },
    unpause: function unpause(unpauseOptions) {
      if (!state.active) {
        return this;
      }
      state.manuallyPaused = false;
      if (trapStack[trapStack.length - 1] !== this) {
        return this;
      }
      return this._setPausedState(false, unpauseOptions);
    },
    updateContainerElements: function updateContainerElements(containerElements) {
      var elementsAsArray = [].concat(containerElements).filter(Boolean);
      state.containers = elementsAsArray.map(function(element2) {
        return typeof element2 === "string" ? doc.querySelector(element2) : element2;
      });
      if (state.active) {
        updateTabbableNodes();
      }
      updateObservedNodes();
      return this;
    }
  };
  Object.defineProperties(trap, {
    _isManuallyPaused: {
      value: function value() {
        return state.manuallyPaused;
      }
    },
    _setPausedState: {
      value: function value(paused, options) {
        if (state.paused === paused) {
          return this;
        }
        state.paused = paused;
        if (paused) {
          var onPause = getOption(options, "onPause");
          var onPostPause = getOption(options, "onPostPause");
          onPause === null || onPause === void 0 || onPause();
          removeListeners();
          updateObservedNodes();
          onPostPause === null || onPostPause === void 0 || onPostPause();
        } else {
          var onUnpause = getOption(options, "onUnpause");
          var onPostUnpause = getOption(options, "onPostUnpause");
          onUnpause === null || onUnpause === void 0 || onUnpause();
          updateTabbableNodes();
          addListeners();
          updateObservedNodes();
          onPostUnpause === null || onPostUnpause === void 0 || onPostUnpause();
        }
        return this;
      }
    }
  });
  trap.updateContainerElements(elements);
  return trap;
};
function createFocusTrap2(config = {}) {
  let trap;
  const { immediate, ...focusTrapOptions } = config;
  const hasFocus = writable(false);
  const isPaused = writable(false);
  const activate = (opts) => trap?.activate(opts);
  const deactivate = (opts) => {
    trap?.deactivate(opts);
  };
  const pause = () => {
    if (trap) {
      trap.pause();
      isPaused.set(true);
    }
  };
  const unpause = () => {
    if (trap) {
      trap.unpause();
      isPaused.set(false);
    }
  };
  const useFocusTrap = (node) => {
    trap = createFocusTrap$1(node, {
      ...focusTrapOptions,
      onActivate() {
        hasFocus.set(true);
        config.onActivate?.();
      },
      onDeactivate() {
        hasFocus.set(false);
        config.onDeactivate?.();
      }
    });
    if (immediate) {
      activate();
    }
    return {
      destroy() {
        deactivate();
        trap = void 0;
      }
    };
  };
  return {
    useFocusTrap,
    hasFocus: readonly(hasFocus),
    isPaused: readonly(isPaused),
    activate,
    deactivate,
    pause,
    unpause
  };
}
const visibleModals = [];
const useModal = (node, config) => {
  let unsubInteractOutside = noop$1;
  function removeNodeFromVisibleModals() {
    const index = visibleModals.indexOf(node);
    if (index >= 0) {
      visibleModals.splice(index, 1);
    }
  }
  function update(config2) {
    unsubInteractOutside();
    const { open, onClose, shouldCloseOnInteractOutside, closeOnInteractOutside } = config2;
    sleep$1(100).then(() => {
      if (open) {
        visibleModals.push(node);
      } else {
        removeNodeFromVisibleModals();
      }
    });
    function isLastModal() {
      return last(visibleModals) === node;
    }
    function closeModal() {
      if (isLastModal() && onClose) {
        onClose();
        removeNodeFromVisibleModals();
      }
    }
    function onInteractOutsideStart(e2) {
      const target = e2.target;
      if (!isElement(target))
        return;
      if (target && isLastModal()) {
        e2.preventDefault();
        e2.stopPropagation();
        e2.stopImmediatePropagation();
      }
    }
    function onInteractOutside(e2) {
      if (shouldCloseOnInteractOutside?.(e2) && isLastModal()) {
        e2.preventDefault();
        e2.stopPropagation();
        e2.stopImmediatePropagation();
        closeModal();
      }
    }
    unsubInteractOutside = useInteractOutside(node, {
      onInteractOutsideStart,
      onInteractOutside: closeOnInteractOutside ? onInteractOutside : void 0,
      enabled: open
    }).destroy;
  }
  update(config);
  return {
    update,
    destroy() {
      removeNodeFromVisibleModals();
      unsubInteractOutside();
    }
  };
};
const usePortal = (el, target = "body") => {
  let targetEl;
  if (!isHTMLElement$1(target) && typeof target !== "string") {
    return {
      destroy: noop$1
    };
  }
  async function update(newTarget) {
    target = newTarget;
    if (typeof target === "string") {
      targetEl = document.querySelector(target);
      if (targetEl === null) {
        await tick();
        targetEl = document.querySelector(target);
      }
      if (targetEl === null) {
        throw new Error(`No element found matching css selector: "${target}"`);
      }
    } else if (target instanceof HTMLElement) {
      targetEl = target;
    } else {
      throw new TypeError(`Unknown portal target type: ${target === null ? "null" : typeof target}. Allowed types: string (CSS selector) or HTMLElement.`);
    }
    el.dataset.portal = "";
    targetEl.appendChild(el);
    el.hidden = false;
  }
  function destroy() {
    el.remove();
  }
  update(target);
  return {
    update,
    destroy
  };
};
const useInteractOutside = (node, config) => {
  let unsub = noop$1;
  let unsubClick = noop$1;
  let isPointerDown = false;
  let isPointerDownInside = false;
  let ignoreEmulatedMouseEvents = false;
  function update(config2) {
    unsub();
    unsubClick();
    const { onInteractOutside, onInteractOutsideStart, enabled } = config2;
    if (!enabled)
      return;
    function onPointerDown(e2) {
      if (onInteractOutside && isValidEvent(e2, node)) {
        onInteractOutsideStart?.(e2);
      }
      const target = e2.target;
      if (isElement(target) && isOrContainsTarget(node, target)) {
        isPointerDownInside = true;
      }
      isPointerDown = true;
    }
    function triggerInteractOutside(e2) {
      onInteractOutside?.(e2);
    }
    const documentObj = getOwnerDocument(node);
    if (typeof PointerEvent !== "undefined") {
      const onPointerUp = (e2) => {
        unsubClick();
        const handler = (e3) => {
          if (shouldTriggerInteractOutside(e3)) {
            triggerInteractOutside(e3);
          }
          resetPointerState();
        };
        if (e2.pointerType === "touch") {
          unsubClick = addEventListener$1(documentObj, "click", handler, {
            capture: true,
            once: true
          });
          return;
        }
        handler(e2);
      };
      unsub = executeCallbacks(addEventListener$1(documentObj, "pointerdown", onPointerDown, true), addEventListener$1(documentObj, "pointerup", onPointerUp, true));
    } else {
      const onMouseUp = (e2) => {
        if (ignoreEmulatedMouseEvents) {
          ignoreEmulatedMouseEvents = false;
        } else if (shouldTriggerInteractOutside(e2)) {
          triggerInteractOutside(e2);
        }
        resetPointerState();
      };
      const onTouchEnd = (e2) => {
        ignoreEmulatedMouseEvents = true;
        if (shouldTriggerInteractOutside(e2)) {
          triggerInteractOutside(e2);
        }
        resetPointerState();
      };
      unsub = executeCallbacks(addEventListener$1(documentObj, "mousedown", onPointerDown, true), addEventListener$1(documentObj, "mouseup", onMouseUp, true), addEventListener$1(documentObj, "touchstart", onPointerDown, true), addEventListener$1(documentObj, "touchend", onTouchEnd, true));
    }
  }
  function shouldTriggerInteractOutside(e2) {
    if (isPointerDown && !isPointerDownInside && isValidEvent(e2, node)) {
      return true;
    }
    return false;
  }
  function resetPointerState() {
    isPointerDown = false;
    isPointerDownInside = false;
  }
  update(config);
  return {
    update,
    destroy() {
      unsub();
      unsubClick();
    }
  };
};
function isValidEvent(e2, node) {
  if ("button" in e2 && e2.button > 0)
    return false;
  const target = e2.target;
  if (!isElement(target))
    return false;
  const ownerDocument = target.ownerDocument;
  if (!ownerDocument || !ownerDocument.documentElement.contains(target)) {
    return false;
  }
  return node && !isOrContainsTarget(node, target);
}
function isOrContainsTarget(node, target) {
  return node === target || node.contains(target);
}
function getOwnerDocument(el) {
  return el?.ownerDocument ?? document;
}
({
  disabled: readable(false),
  required: readable(false),
  name: readable(void 0)
});
const defaults$1 = {
  isDateDisabled: void 0,
  isDateUnavailable: void 0,
  value: void 0,
  preventDeselect: false,
  numberOfMonths: 1,
  pagedNavigation: false,
  weekStartsOn: 0,
  fixedWeeks: false,
  calendarLabel: "Event Date",
  locale: "en",
  minValue: void 0,
  maxValue: void 0,
  disabled: false,
  readonly: false,
  weekdayFormat: "narrow"
};
({
  ...omit$1(defaults$1, "isDateDisabled", "isDateUnavailable", "value", "locale", "disabled", "readonly", "minValue", "maxValue", "weekdayFormat")
});
const { name } = createElHelpers("dialog");
const defaults = {
  preventScroll: true,
  closeOnEscape: true,
  closeOnOutsideClick: true,
  role: "dialog",
  defaultOpen: false,
  portal: void 0,
  forceVisible: false,
  openFocus: void 0,
  closeFocus: void 0,
  onOutsideClick: void 0
};
const dialogIdParts = ["content", "title", "description"];
function createDialog(props) {
  const withDefaults = { ...defaults, ...props };
  const options = toWritableStores$1(omit$1(withDefaults, "ids"));
  const { preventScroll: preventScroll2, closeOnEscape, closeOnOutsideClick, role, portal, forceVisible, openFocus, closeFocus, onOutsideClick } = options;
  const activeTrigger = withGet.writable(null);
  const ids = toWritableStores$1({
    ...generateIds(dialogIdParts),
    ...withDefaults.ids
  });
  const openWritable = withDefaults.open ?? writable(withDefaults.defaultOpen);
  const open = overridable$1(openWritable, withDefaults?.onOpenChange);
  const isVisible = derived([open, forceVisible], ([$open, $forceVisible]) => {
    return $open || $forceVisible;
  });
  let unsubScroll = noop$1;
  function handleOpen(e2) {
    const el = e2.currentTarget;
    const triggerEl = e2.currentTarget;
    if (!isHTMLElement$1(el) || !isHTMLElement$1(triggerEl))
      return;
    open.set(true);
    activeTrigger.set(triggerEl);
  }
  function handleClose() {
    open.set(false);
    handleFocus({
      prop: closeFocus.get(),
      defaultEl: activeTrigger.get()
    });
  }
  const trigger = makeElement(name("trigger"), {
    stores: [open],
    returned: ([$open]) => {
      return {
        "aria-haspopup": "dialog",
        "aria-expanded": $open,
        type: "button"
      };
    },
    action: (node) => {
      const unsub = executeCallbacks(addMeltEventListener(node, "click", (e2) => {
        handleOpen(e2);
      }), addMeltEventListener(node, "keydown", (e2) => {
        if (e2.key !== kbd.ENTER && e2.key !== kbd.SPACE)
          return;
        e2.preventDefault();
        handleOpen(e2);
      }));
      return {
        destroy: unsub
      };
    }
  });
  const overlay = makeElement(name("overlay"), {
    stores: [isVisible, open],
    returned: ([$isVisible, $open]) => {
      return {
        hidden: $isVisible ? void 0 : true,
        tabindex: -1,
        style: styleToString$2({
          display: $isVisible ? void 0 : "none"
        }),
        "aria-hidden": true,
        "data-state": $open ? "open" : "closed"
      };
    },
    action: (node) => {
      let unsubEscapeKeydown = noop$1;
      if (closeOnEscape.get()) {
        const escapeKeydown = useEscapeKeydown(node, {
          handler: () => {
            handleClose();
          }
        });
        if (escapeKeydown && escapeKeydown.destroy) {
          unsubEscapeKeydown = escapeKeydown.destroy;
        }
      }
      return {
        destroy() {
          unsubEscapeKeydown();
        }
      };
    }
  });
  const content = makeElement(name("content"), {
    stores: [isVisible, ids.content, ids.description, ids.title, open],
    returned: ([$isVisible, $contentId, $descriptionId, $titleId, $open]) => {
      return {
        id: $contentId,
        role: role.get(),
        "aria-describedby": $descriptionId,
        "aria-labelledby": $titleId,
        "aria-modal": $isVisible ? "true" : void 0,
        "data-state": $open ? "open" : "closed",
        tabindex: -1,
        hidden: $isVisible ? void 0 : true,
        style: styleToString$2({
          display: $isVisible ? void 0 : "none"
        })
      };
    },
    action: (node) => {
      let activate = noop$1;
      let deactivate = noop$1;
      const destroy = executeCallbacks(effect$1([open, closeOnOutsideClick, closeOnEscape], ([$open, $closeOnOutsideClick, $closeOnEscape]) => {
        if (!$open)
          return;
        const focusTrap = createFocusTrap2({
          immediate: false,
          escapeDeactivates: $closeOnEscape,
          clickOutsideDeactivates: $closeOnOutsideClick,
          allowOutsideClick: true,
          returnFocusOnDeactivate: false,
          fallbackFocus: node
        });
        activate = focusTrap.activate;
        deactivate = focusTrap.deactivate;
        const ac = focusTrap.useFocusTrap(node);
        if (ac && ac.destroy) {
          return ac.destroy;
        } else {
          return focusTrap.deactivate;
        }
      }), effect$1([closeOnOutsideClick, open], ([$closeOnOutsideClick, $open]) => {
        return useModal(node, {
          open: $open,
          closeOnInteractOutside: $closeOnOutsideClick,
          onClose() {
            handleClose();
          },
          shouldCloseOnInteractOutside(e2) {
            onOutsideClick.get()?.(e2);
            if (e2.defaultPrevented)
              return false;
            return true;
          }
        }).destroy;
      }), effect$1([closeOnEscape], ([$closeOnEscape]) => {
        if (!$closeOnEscape)
          return noop$1;
        return useEscapeKeydown(node, { handler: handleClose }).destroy;
      }), effect$1([isVisible], ([$isVisible]) => {
        tick().then(() => {
          if (!$isVisible) {
            deactivate();
          } else {
            activate();
          }
        });
      }));
      return {
        destroy: () => {
          unsubScroll();
          destroy();
        }
      };
    }
  });
  const portalled = makeElement(name("portalled"), {
    stores: portal,
    returned: ($portal) => ({
      "data-portal": portalAttr($portal)
    }),
    action: (node) => {
      const unsubPortal = effect$1([portal], ([$portal]) => {
        if ($portal === null)
          return noop$1;
        const portalDestination = getPortalDestination(node, $portal);
        if (portalDestination === null)
          return noop$1;
        return usePortal(node, portalDestination).destroy;
      });
      return {
        destroy() {
          unsubPortal();
        }
      };
    }
  });
  const title = makeElement(name("title"), {
    stores: [ids.title],
    returned: ([$titleId]) => ({
      id: $titleId
    })
  });
  const description = makeElement(name("description"), {
    stores: [ids.description],
    returned: ([$descriptionId]) => ({
      id: $descriptionId
    })
  });
  const close = makeElement(name("close"), {
    returned: () => ({
      type: "button"
    }),
    action: (node) => {
      const unsub = executeCallbacks(addMeltEventListener(node, "click", () => {
        handleClose();
      }), addMeltEventListener(node, "keydown", (e2) => {
        if (e2.key !== kbd.SPACE && e2.key !== kbd.ENTER)
          return;
        e2.preventDefault();
        handleClose();
      }));
      return {
        destroy: unsub
      };
    }
  });
  effect$1([open, preventScroll2], ([$open, $preventScroll]) => {
    if (!isBrowser$1)
      return;
    if ($preventScroll && $open)
      unsubScroll = removeScroll();
    if ($open) {
      const contentEl = document.getElementById(ids.content.get());
      handleFocus({ prop: openFocus.get(), defaultEl: contentEl });
    }
    return () => {
      if (!forceVisible.get()) {
        unsubScroll();
      }
    };
  });
  return {
    ids,
    elements: {
      content,
      trigger,
      title,
      description,
      overlay,
      close,
      portalled
    },
    states: {
      open
    },
    options
  };
}
function createBitAttrs(bit, parts) {
  const attrs = {};
  parts.forEach((part) => {
    attrs[part] = {
      [`data-${bit}-${part}`]: ""
    };
  });
  return (part) => attrs[part];
}
function removeUndefined$1(obj) {
  const result = {};
  for (const key in obj) {
    const value = obj[key];
    if (value !== void 0) {
      result[key] = value;
    }
  }
  return result;
}
function getOptionUpdater$1(options) {
  return function(key, value) {
    if (value === void 0)
      return;
    const store = options[key];
    if (store) {
      store.set(value);
    }
  };
}
function getDialogData() {
  const NAME = "dialog";
  const PARTS = [
    "close",
    "content",
    "description",
    "overlay",
    "portal",
    "title",
    "trigger"
  ];
  return {
    NAME,
    PARTS
  };
}
function setCtx$1(props) {
  const { NAME, PARTS } = getDialogData();
  const getAttrs = createBitAttrs(NAME, PARTS);
  const dialog = {
    ...createDialog({ ...removeUndefined$1(props), role: "dialog", forceVisible: true }),
    getAttrs
  };
  setContext(NAME, dialog);
  return {
    ...dialog,
    updateOption: getOptionUpdater$1(dialog.options)
  };
}
function getCtx$1() {
  const { NAME } = getDialogData();
  return getContext(NAME);
}
function Dialog($$payload, $$props) {
  push();
  var $$store_subs;
  let preventScroll2 = fallback($$props["preventScroll"], () => void 0, true);
  let closeOnEscape = fallback($$props["closeOnEscape"], () => void 0, true);
  let closeOnOutsideClick = fallback($$props["closeOnOutsideClick"], () => void 0, true);
  let portal = fallback($$props["portal"], () => void 0, true);
  let open = fallback($$props["open"], () => void 0, true);
  let onOpenChange = fallback($$props["onOpenChange"], () => void 0, true);
  let openFocus = fallback($$props["openFocus"], () => void 0, true);
  let closeFocus = fallback($$props["closeFocus"], () => void 0, true);
  let onOutsideClick = fallback($$props["onOutsideClick"], () => void 0, true);
  const {
    states: { open: localOpen },
    updateOption,
    ids
  } = setCtx$1({
    closeOnEscape,
    preventScroll: preventScroll2,
    closeOnOutsideClick,
    portal,
    forceVisible: true,
    defaultOpen: open,
    openFocus,
    closeFocus,
    onOutsideClick,
    onOpenChange: ({ next }) => {
      if (open !== next) {
        onOpenChange?.(next);
        open = next;
      }
      return next;
    }
  });
  const idValues = derived([ids.content, ids.description, ids.title], ([$contentId, $descriptionId, $titleId]) => ({
    content: $contentId,
    description: $descriptionId,
    title: $titleId
  }));
  open !== void 0 && localOpen.set(open);
  updateOption("preventScroll", preventScroll2);
  updateOption("closeOnEscape", closeOnEscape);
  updateOption("closeOnOutsideClick", closeOnOutsideClick);
  updateOption("portal", portal);
  updateOption("openFocus", openFocus);
  updateOption("closeFocus", closeFocus);
  updateOption("onOutsideClick", onOutsideClick);
  $$payload.out += `<!---->`;
  slot(
    $$payload,
    $$props,
    "default",
    {
      ids: store_get($$store_subs ??= {}, "$idValues", idValues)
    }
  );
  $$payload.out += `<!---->`;
  if ($$store_subs) unsubscribe_stores($$store_subs);
  bind_props($$props, {
    preventScroll: preventScroll2,
    closeOnEscape,
    closeOnOutsideClick,
    portal,
    open,
    onOpenChange,
    openFocus,
    closeFocus,
    onOutsideClick
  });
  pop();
}
function Dialog_title($$payload, $$props) {
  const $$sanitized_props = sanitize_props($$props);
  const $$restProps = rest_props($$sanitized_props, ["level", "asChild", "id", "el"]);
  push();
  var $$store_subs;
  let builder;
  let level = fallback($$props["level"], "h2");
  let asChild = fallback($$props["asChild"], false);
  let id = fallback($$props["id"], () => void 0, true);
  let el = fallback($$props["el"], () => void 0, true);
  const { elements: { title }, ids, getAttrs } = getCtx$1();
  const attrs = getAttrs("title");
  if (id) {
    ids.title.set(id);
  }
  builder = store_get($$store_subs ??= {}, "$title", title);
  Object.assign(builder, attrs);
  if (asChild) {
    $$payload.out += "<!--[-->";
    $$payload.out += `<!---->`;
    slot($$payload, $$props, "default", { builder });
    $$payload.out += `<!---->`;
  } else {
    $$payload.out += "<!--[!-->";
    element(
      $$payload,
      level,
      () => {
        $$payload.out += `${spread_attributes({ ...builder, ...$$restProps }, null)}`;
      },
      () => {
        $$payload.out += `<!---->`;
        slot($$payload, $$props, "default", { builder });
        $$payload.out += `<!---->`;
      }
    );
  }
  $$payload.out += `<!--]-->`;
  if ($$store_subs) unsubscribe_stores($$store_subs);
  bind_props($$props, { level, asChild, id, el });
  pop();
}
function Dialog_portal($$payload, $$props) {
  const $$sanitized_props = sanitize_props($$props);
  const $$restProps = rest_props($$sanitized_props, ["asChild", "el"]);
  push();
  var $$store_subs;
  let builder;
  let asChild = fallback($$props["asChild"], false);
  let el = fallback($$props["el"], () => void 0, true);
  const { elements: { portalled }, getAttrs } = getCtx$1();
  const attrs = getAttrs("portal");
  builder = store_get($$store_subs ??= {}, "$portalled", portalled);
  Object.assign(builder, attrs);
  if (asChild) {
    $$payload.out += "<!--[-->";
    $$payload.out += `<!---->`;
    slot($$payload, $$props, "default", { builder });
    $$payload.out += `<!---->`;
  } else {
    $$payload.out += "<!--[!-->";
    $$payload.out += `<div${spread_attributes({ ...builder, ...$$restProps }, null)}><!---->`;
    slot($$payload, $$props, "default", { builder });
    $$payload.out += `<!----></div>`;
  }
  $$payload.out += `<!--]-->`;
  if ($$store_subs) unsubscribe_stores($$store_subs);
  bind_props($$props, { asChild, el });
  pop();
}
function Dialog_content($$payload, $$props) {
  const $$sanitized_props = sanitize_props($$props);
  const $$restProps = rest_props($$sanitized_props, [
    "transition",
    "transitionConfig",
    "inTransition",
    "inTransitionConfig",
    "outTransition",
    "outTransitionConfig",
    "asChild",
    "id",
    "el"
  ]);
  push();
  var $$store_subs;
  let builder;
  let transition = fallback($$props["transition"], () => void 0, true);
  let transitionConfig = fallback($$props["transitionConfig"], () => void 0, true);
  let inTransition = fallback($$props["inTransition"], () => void 0, true);
  let inTransitionConfig = fallback($$props["inTransitionConfig"], () => void 0, true);
  let outTransition = fallback($$props["outTransition"], () => void 0, true);
  let outTransitionConfig = fallback($$props["outTransitionConfig"], () => void 0, true);
  let asChild = fallback($$props["asChild"], false);
  let id = fallback($$props["id"], () => void 0, true);
  let el = fallback($$props["el"], () => void 0, true);
  const {
    elements: { content },
    states: { open },
    ids,
    getAttrs
  } = getCtx$1();
  const attrs = getAttrs("content");
  if (id) {
    ids.content.set(id);
  }
  builder = store_get($$store_subs ??= {}, "$content", content);
  Object.assign(builder, attrs);
  if (asChild && store_get($$store_subs ??= {}, "$open", open)) {
    $$payload.out += "<!--[-->";
    $$payload.out += `<!---->`;
    slot($$payload, $$props, "default", { builder });
    $$payload.out += `<!---->`;
  } else if (transition && store_get($$store_subs ??= {}, "$open", open)) {
    $$payload.out += "<!--[1-->";
    $$payload.out += `<div${spread_attributes({ ...builder, ...$$restProps }, null)}><!---->`;
    slot($$payload, $$props, "default", { builder });
    $$payload.out += `<!----></div>`;
  } else if (inTransition && outTransition && store_get($$store_subs ??= {}, "$open", open)) {
    $$payload.out += "<!--[2-->";
    $$payload.out += `<div${spread_attributes({ ...builder, ...$$restProps }, null)}><!---->`;
    slot($$payload, $$props, "default", { builder });
    $$payload.out += `<!----></div>`;
  } else if (inTransition && store_get($$store_subs ??= {}, "$open", open)) {
    $$payload.out += "<!--[3-->";
    $$payload.out += `<div${spread_attributes({ ...builder, ...$$restProps }, null)}><!---->`;
    slot($$payload, $$props, "default", { builder });
    $$payload.out += `<!----></div>`;
  } else if (outTransition && store_get($$store_subs ??= {}, "$open", open)) {
    $$payload.out += "<!--[4-->";
    $$payload.out += `<div${spread_attributes({ ...builder, ...$$restProps }, null)}><!---->`;
    slot($$payload, $$props, "default", { builder });
    $$payload.out += `<!----></div>`;
  } else if (store_get($$store_subs ??= {}, "$open", open)) {
    $$payload.out += "<!--[5-->";
    $$payload.out += `<div${spread_attributes({ ...builder, ...$$restProps }, null)}><!---->`;
    slot($$payload, $$props, "default", { builder });
    $$payload.out += `<!----></div>`;
  } else {
    $$payload.out += "<!--[!-->";
  }
  $$payload.out += `<!--]-->`;
  if ($$store_subs) unsubscribe_stores($$store_subs);
  bind_props($$props, {
    transition,
    transitionConfig,
    inTransition,
    inTransitionConfig,
    outTransition,
    outTransitionConfig,
    asChild,
    id,
    el
  });
  pop();
}
function Dialog_overlay($$payload, $$props) {
  const $$sanitized_props = sanitize_props($$props);
  const $$restProps = rest_props($$sanitized_props, [
    "transition",
    "transitionConfig",
    "inTransition",
    "inTransitionConfig",
    "outTransition",
    "outTransitionConfig",
    "asChild",
    "el"
  ]);
  push();
  var $$store_subs;
  let builder;
  let transition = fallback($$props["transition"], () => void 0, true);
  let transitionConfig = fallback($$props["transitionConfig"], () => void 0, true);
  let inTransition = fallback($$props["inTransition"], () => void 0, true);
  let inTransitionConfig = fallback($$props["inTransitionConfig"], () => void 0, true);
  let outTransition = fallback($$props["outTransition"], () => void 0, true);
  let outTransitionConfig = fallback($$props["outTransitionConfig"], () => void 0, true);
  let asChild = fallback($$props["asChild"], false);
  let el = fallback($$props["el"], () => void 0, true);
  const {
    elements: { overlay },
    states: { open },
    getAttrs
  } = getCtx$1();
  const attrs = getAttrs("overlay");
  builder = store_get($$store_subs ??= {}, "$overlay", overlay);
  Object.assign(builder, attrs);
  if (asChild && store_get($$store_subs ??= {}, "$open", open)) {
    $$payload.out += "<!--[-->";
    $$payload.out += `<!---->`;
    slot($$payload, $$props, "default", { builder });
    $$payload.out += `<!---->`;
  } else if (transition && store_get($$store_subs ??= {}, "$open", open)) {
    $$payload.out += "<!--[1-->";
    $$payload.out += `<div${spread_attributes({ ...builder, ...$$restProps }, null)}></div>`;
  } else if (inTransition && outTransition && store_get($$store_subs ??= {}, "$open", open)) {
    $$payload.out += "<!--[2-->";
    $$payload.out += `<div${spread_attributes({ ...builder, ...$$restProps }, null)}></div>`;
  } else if (inTransition && store_get($$store_subs ??= {}, "$open", open)) {
    $$payload.out += "<!--[3-->";
    $$payload.out += `<div${spread_attributes({ ...builder, ...$$restProps }, null)}></div>`;
  } else if (outTransition && store_get($$store_subs ??= {}, "$open", open)) {
    $$payload.out += "<!--[4-->";
    $$payload.out += `<div${spread_attributes({ ...builder, ...$$restProps }, null)}></div>`;
  } else if (store_get($$store_subs ??= {}, "$open", open)) {
    $$payload.out += "<!--[5-->";
    $$payload.out += `<div${spread_attributes({ ...builder, ...$$restProps }, null)}></div>`;
  } else {
    $$payload.out += "<!--[!-->";
  }
  $$payload.out += `<!--]-->`;
  if ($$store_subs) unsubscribe_stores($$store_subs);
  bind_props($$props, {
    transition,
    transitionConfig,
    inTransition,
    inTransitionConfig,
    outTransition,
    outTransitionConfig,
    asChild,
    el
  });
  pop();
}
function Dialog_trigger($$payload, $$props) {
  const $$sanitized_props = sanitize_props($$props);
  const $$restProps = rest_props($$sanitized_props, ["asChild", "el"]);
  push();
  var $$store_subs;
  let builder;
  let asChild = fallback($$props["asChild"], false);
  let el = fallback($$props["el"], () => void 0, true);
  const { elements: { trigger }, getAttrs } = getCtx$1();
  const attrs = getAttrs("trigger");
  builder = store_get($$store_subs ??= {}, "$trigger", trigger);
  Object.assign(builder, attrs);
  if (asChild) {
    $$payload.out += "<!--[-->";
    $$payload.out += `<!---->`;
    slot($$payload, $$props, "default", { builder });
    $$payload.out += `<!---->`;
  } else {
    $$payload.out += "<!--[!-->";
    $$payload.out += `<button${spread_attributes({ ...builder, type: "button", ...$$restProps }, null)}><!---->`;
    slot($$payload, $$props, "default", { builder });
    $$payload.out += `<!----></button>`;
  }
  $$payload.out += `<!--]-->`;
  if ($$store_subs) unsubscribe_stores($$store_subs);
  bind_props($$props, { asChild, el });
  pop();
}
function Dialog_description($$payload, $$props) {
  const $$sanitized_props = sanitize_props($$props);
  const $$restProps = rest_props($$sanitized_props, ["asChild", "id", "el"]);
  push();
  var $$store_subs;
  let builder;
  let asChild = fallback($$props["asChild"], false);
  let id = fallback($$props["id"], () => void 0, true);
  let el = fallback($$props["el"], () => void 0, true);
  const { elements: { description }, ids, getAttrs } = getCtx$1();
  const attrs = getAttrs("description");
  if (id) {
    ids.description.set(id);
  }
  builder = store_get($$store_subs ??= {}, "$description", description);
  Object.assign(builder, attrs);
  if (asChild) {
    $$payload.out += "<!--[-->";
    $$payload.out += `<!---->`;
    slot($$payload, $$props, "default", { builder });
    $$payload.out += `<!---->`;
  } else {
    $$payload.out += "<!--[!-->";
    $$payload.out += `<div${spread_attributes({ ...builder, ...$$restProps }, null)}><!---->`;
    slot($$payload, $$props, "default", { builder });
    $$payload.out += `<!----></div>`;
  }
  $$payload.out += `<!--]-->`;
  if ($$store_subs) unsubscribe_stores($$store_subs);
  bind_props($$props, { asChild, id, el });
  pop();
}
function getOptionUpdater(options) {
  return function(key, value) {
    if (value === void 0)
      return;
    const store = options[key];
    if (store) {
      store.set(value);
    }
  };
}
const TRANSITIONS = {
  DURATION: 0.5,
  EASE: [0.32, 0.72, 0, 1]
};
const VELOCITY_THRESHOLD = 0.4;
function effect(stores, fn) {
  if (typeof document === "undefined") {
    return () => {
    };
  }
  const unsub = derivedWithUnsubscribe(stores, (stores2, onUnsubscribe) => {
    return {
      stores: stores2,
      onUnsubscribe
    };
  }).subscribe(({ stores: stores2, onUnsubscribe }) => {
    const returned = fn(stores2);
    if (returned) {
      onUnsubscribe(returned);
    }
  });
  safeOnDestroy(unsub);
  return unsub;
}
function derivedWithUnsubscribe(stores, fn) {
  let unsubscribers = [];
  const onUnsubscribe = (cb) => {
    unsubscribers.push(cb);
  };
  const unsubscribe = () => {
    unsubscribers.forEach((fn2) => fn2());
    unsubscribers = [];
  };
  const derivedStore = derived(stores, ($storeValues) => {
    unsubscribe();
    return fn($storeValues, onUnsubscribe);
  });
  safeOnDestroy(unsubscribe);
  const subscribe = (...args) => {
    const unsub = derivedStore.subscribe(...args);
    return () => {
      unsub();
      unsubscribe();
    };
  };
  return {
    ...derivedStore,
    subscribe
  };
}
const safeOnDestroy = (fn) => {
  try {
    onDestroy(fn);
  } catch {
    return fn();
  }
};
const overridable = (store, onChange) => {
  const update = (updater, sideEffect) => {
    store.update((curr) => {
      const next = updater(curr);
      let res = next;
      if (onChange) {
        res = onChange({ curr, next });
      }
      sideEffect?.(res);
      return res;
    });
  };
  const set2 = (curr) => {
    update(() => curr);
  };
  return {
    ...store,
    update,
    set: set2
  };
};
function toWritableStores(properties) {
  const result = {};
  Object.keys(properties).forEach((key) => {
    const propertyKey = key;
    const value = properties[propertyKey];
    result[propertyKey] = writable(value);
  });
  return result;
}
function omit(obj, ...keys) {
  const result = {};
  for (const key of Object.keys(obj)) {
    if (!keys.includes(key)) {
      result[key] = obj[key];
    }
  }
  return result;
}
function removeUndefined(obj) {
  const result = {};
  for (const key in obj) {
    const value = obj[key];
    if (value !== void 0) {
      result[key] = value;
    }
  }
  return result;
}
const cache = /* @__PURE__ */ new WeakMap();
function set(el, styles, ignoreCache = false) {
  if (!el || !(el instanceof HTMLElement) || !styles)
    return;
  const originalStyles = {};
  Object.entries(styles).forEach(([key, value]) => {
    if (key.startsWith("--")) {
      el.style.setProperty(key, value);
      return;
    }
    originalStyles[key] = el.style[key];
    el.style[key] = value;
  });
  if (ignoreCache)
    return;
  cache.set(el, originalStyles);
}
function reset(el, prop) {
  if (!el || !(el instanceof HTMLElement))
    return;
  const originalStyles = cache.get(el);
  if (!originalStyles) {
    return;
  }
  if (prop) {
    el.style[prop] = originalStyles[prop];
  } else {
    Object.entries(originalStyles).forEach(([key, value]) => {
      el.style[key] = value;
    });
  }
}
function getTranslate(element2, direction) {
  const style = window.getComputedStyle(element2);
  const transform = (
    // @ts-expect-error - vendor prefix
    style.transform || style.webkitTransform || style.mozTransform
  );
  let mat = transform.match(/^matrix3d\((.+)\)$/);
  if (mat) {
    return parseFloat(mat[1].split(", ")[isVertical(direction) ? 13 : 12]);
  }
  mat = transform.match(/^matrix\((.+)\)$/);
  return mat ? parseFloat(mat[1].split(", ")[isVertical(direction) ? 5 : 4]) : null;
}
function styleToString$1(style) {
  return Object.keys(style).reduce((str, key) => {
    if (style[key] === void 0)
      return str;
    return str + `${key}:${style[key]};`;
  }, "");
}
function noop() {
}
function addEventListener(target, event, handler, options) {
  const events = Array.isArray(event) ? event : [event];
  events.forEach((_event) => target.addEventListener(_event, handler, options));
  return () => {
    events.forEach((_event) => target.removeEventListener(_event, handler, options));
  };
}
const nonTextInputTypes = /* @__PURE__ */ new Set([
  "checkbox",
  "radio",
  "range",
  "color",
  "file",
  "image",
  "button",
  "submit",
  "reset"
]);
const isBrowser = typeof document !== "undefined";
function isInput(target) {
  return target instanceof HTMLInputElement && !nonTextInputTypes.has(target.type) || target instanceof HTMLTextAreaElement || target instanceof HTMLElement && target.isContentEditable;
}
function isVertical(direction) {
  if (direction === "top" || direction === "bottom")
    return true;
  return false;
}
function isBottomOrRight(direction) {
  if (direction === "bottom" || direction === "right")
    return true;
  return false;
}
function chain(...callbacks) {
  return (...args) => {
    for (const callback of callbacks) {
      if (typeof callback === "function") {
        callback(...args);
      }
    }
  };
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function handleSnapPoints({ activeSnapPoint, snapPoints, drawerRef, overlayRef, fadeFromIndex, openTime, direction }) {
  const isLastSnapPoint = derived([snapPoints, activeSnapPoint], ([$snapPoints, $activeSnapPoint]) => {
    return $activeSnapPoint === $snapPoints?.[$snapPoints.length - 1];
  });
  const shouldFade = derived([snapPoints, fadeFromIndex, activeSnapPoint], ([$snapPoints, $fadeFromIndex, $activeSnapPoint]) => {
    return $snapPoints && $snapPoints.length > 0 && ($fadeFromIndex || $fadeFromIndex === 0) && !Number.isNaN($fadeFromIndex) && $snapPoints[$fadeFromIndex] === $activeSnapPoint || !$snapPoints;
  });
  const activeSnapPointIndex = derived([snapPoints, activeSnapPoint], ([$snapPoints, $activeSnapPoint]) => $snapPoints?.findIndex((snapPoint) => snapPoint === $activeSnapPoint) ?? null);
  const snapPointsOffset = derived(snapPoints, ($snapPoints) => {
    if ($snapPoints) {
      return $snapPoints.map((snapPoint) => {
        const hasWindow = typeof window !== "undefined";
        const isPx = typeof snapPoint === "string";
        let snapPointAsNumber = 0;
        if (isPx) {
          snapPointAsNumber = parseInt(snapPoint, 10);
        }
        const $direction = get(direction);
        if (isVertical($direction)) {
          const height = isPx ? snapPointAsNumber : hasWindow ? snapPoint * window.innerHeight : 0;
          if (hasWindow) {
            return $direction === "bottom" ? window.innerHeight - height : window.innerHeight + height;
          }
          return height;
        }
        const width = isPx ? snapPointAsNumber : hasWindow ? snapPoint * window.innerWidth : 0;
        if (hasWindow) {
          return $direction === "right" ? window.innerWidth - width : window.innerWidth + width;
        }
        return width;
      });
    }
    return [];
  });
  const activeSnapPointOffset = derived([snapPointsOffset, activeSnapPointIndex], ([$snapPointsOffset, $activeSnapPointIndex]) => $activeSnapPointIndex !== null ? $snapPointsOffset?.[$activeSnapPointIndex] : null);
  effect([activeSnapPoint, drawerRef], ([$activeSnapPoint, $drawerRef]) => {
    if ($activeSnapPoint && $drawerRef) {
      const $snapPoints = get(snapPoints);
      const $snapPointsOffset = get(snapPointsOffset);
      const newIndex = $snapPoints?.findIndex((snapPoint) => snapPoint === $activeSnapPoint) ?? -1;
      if ($snapPointsOffset && newIndex !== -1 && typeof $snapPointsOffset[newIndex] === "number") {
        snapToPoint($snapPointsOffset[newIndex]);
      }
    }
  });
  function snapToPoint(dimension) {
    tick().then(() => {
      const $snapPointsOffset = get(snapPointsOffset);
      const newSnapPointIndex = $snapPointsOffset?.findIndex((snapPointDim) => snapPointDim === dimension) ?? null;
      const $drawerRef = get(drawerRef);
      const $direction = get(direction);
      onSnapPointChange(newSnapPointIndex);
      set($drawerRef, {
        transition: `transform ${TRANSITIONS.DURATION}s cubic-bezier(${TRANSITIONS.EASE.join(",")})`,
        transform: isVertical($direction) ? `translate3d(0, ${dimension}px, 0)` : `translate3d(${dimension}px, 0, 0)`
      });
      const $fadeFromIndex = get(fadeFromIndex);
      const $overlayRef = get(overlayRef);
      if (snapPointsOffset && newSnapPointIndex !== $snapPointsOffset.length - 1 && newSnapPointIndex !== $fadeFromIndex) {
        set($overlayRef, {
          transition: `opacity ${TRANSITIONS.DURATION}s cubic-bezier(${TRANSITIONS.EASE.join(",")})`,
          opacity: "0"
        });
      } else {
        set($overlayRef, {
          transition: `opacity ${TRANSITIONS.DURATION}s cubic-bezier(${TRANSITIONS.EASE.join(",")})`,
          opacity: "1"
        });
      }
      activeSnapPoint.update(() => {
        const $snapPoints = get(snapPoints);
        if (newSnapPointIndex === null || !$snapPoints)
          return null;
        return $snapPoints[newSnapPointIndex];
      });
    });
  }
  function onRelease({ draggedDistance, closeDrawer, velocity, dismissible }) {
    const $fadeFromIndex = get(fadeFromIndex);
    if ($fadeFromIndex === void 0)
      return;
    const $activeSnapPointOffset = get(activeSnapPointOffset);
    const $activeSnapPointIndex = get(activeSnapPointIndex);
    const $overlayRef = get(overlayRef);
    const $snapPointsOffset = get(snapPointsOffset);
    const $snapPoints = get(snapPoints);
    const $direction = get(direction);
    const currentPosition = $direction === "bottom" || $direction === "right" ? ($activeSnapPointOffset ?? 0) - draggedDistance : ($activeSnapPointOffset ?? 0) + draggedDistance;
    const isOverlaySnapPoint = $activeSnapPointIndex === $fadeFromIndex - 1;
    const isFirst = $activeSnapPointIndex === 0;
    const hasDraggedUp = draggedDistance > 0;
    if (isOverlaySnapPoint) {
      set($overlayRef, {
        transition: `opacity ${TRANSITIONS.DURATION}s cubic-bezier(${TRANSITIONS.EASE.join(",")})`
      });
    }
    if (velocity > 2 && !hasDraggedUp) {
      if (dismissible)
        closeDrawer();
      else
        snapToPoint($snapPointsOffset[0]);
      return;
    }
    if (velocity > 2 && hasDraggedUp && $snapPointsOffset && $snapPoints) {
      snapToPoint($snapPointsOffset[$snapPoints.length - 1]);
      return;
    }
    const closestSnapPoint = $snapPointsOffset?.reduce((prev, curr) => {
      if (typeof prev !== "number" || typeof curr !== "number")
        return prev;
      return Math.abs(curr - currentPosition) < Math.abs(prev - currentPosition) ? curr : prev;
    });
    const dim = isVertical($direction) ? window.innerHeight : window.innerWidth;
    if (velocity > VELOCITY_THRESHOLD && Math.abs(draggedDistance) < dim * 0.4) {
      const dragDirection = hasDraggedUp ? 1 : -1;
      if (dragDirection > 0 && get(isLastSnapPoint) && $snapPoints) {
        snapToPoint($snapPointsOffset[$snapPoints.length - 1]);
        return;
      }
      if (isFirst && dragDirection < 0 && dismissible) {
        closeDrawer();
      }
      if ($activeSnapPointIndex === null)
        return;
      snapToPoint($snapPointsOffset[$activeSnapPointIndex + dragDirection]);
      return;
    }
    snapToPoint(closestSnapPoint);
  }
  function onDrag({ draggedDistance }) {
    const $drawerRef = get(drawerRef);
    const $activeSnapPointOffset = get(activeSnapPointOffset);
    if ($activeSnapPointOffset === null)
      return;
    const $snapPointsOffset = get(snapPointsOffset);
    const $direction = get(direction);
    const newValue = $direction === "bottom" || $direction === "right" ? $activeSnapPointOffset - draggedDistance : $activeSnapPointOffset + draggedDistance;
    const lastSnapPoint = $snapPointsOffset[$snapPointsOffset.length - 1];
    if (isBottomOrRight($direction) && newValue < lastSnapPoint) {
      return;
    }
    if (!isBottomOrRight($direction) && newValue > lastSnapPoint) {
      return;
    }
    set($drawerRef, {
      transform: isVertical($direction) ? `translate3d(0, ${newValue}px, 0)` : `translate3d(${newValue}px, 0, 0)`
    });
  }
  function getPercentageDragged(absDraggedDistance, isDraggingDown) {
    const $activeSnapPointIndex = get(activeSnapPointIndex);
    const $snapPointsOffset = get(snapPointsOffset);
    const $snapPoints = get(snapPoints);
    const $fadeFromIndex = get(fadeFromIndex);
    if (!$snapPoints || typeof $activeSnapPointIndex !== "number" || !$snapPointsOffset || $fadeFromIndex === void 0)
      return null;
    const isOverlaySnapPoint = $activeSnapPointIndex === $fadeFromIndex - 1;
    const isOverlaySnapPointOrHigher = $activeSnapPointIndex >= $fadeFromIndex;
    if (isOverlaySnapPointOrHigher && isDraggingDown) {
      return 0;
    }
    if (isOverlaySnapPoint && !isDraggingDown)
      return 1;
    if (!get(shouldFade) && !isOverlaySnapPoint)
      return null;
    const targetSnapPointIndex = isOverlaySnapPoint ? $activeSnapPointIndex + 1 : $activeSnapPointIndex - 1;
    const snapPointDistance = isOverlaySnapPoint ? $snapPointsOffset[targetSnapPointIndex] - $snapPointsOffset[targetSnapPointIndex - 1] : $snapPointsOffset[targetSnapPointIndex + 1] - $snapPointsOffset[targetSnapPointIndex];
    const percentageDragged = absDraggedDistance / Math.abs(snapPointDistance);
    if (isOverlaySnapPoint) {
      return 1 - percentageDragged;
    } else {
      return percentageDragged;
    }
  }
  function onSnapPointChange(activeSnapPointIndex2) {
    const $snapPoints = get(snapPoints);
    const $snapPointsOffset = get(snapPointsOffset);
    if ($snapPoints && activeSnapPointIndex2 === $snapPointsOffset.length - 1) {
      openTime.set(/* @__PURE__ */ new Date());
    }
  }
  return {
    isLastSnapPoint,
    shouldFade,
    getPercentageDragged,
    activeSnapPointIndex,
    onRelease,
    onDrag,
    snapPointsOffset
  };
}
function isMac() {
  return testPlatform(/^Mac/);
}
function isIPhone() {
  return testPlatform(/^iPhone/);
}
function isIPad() {
  return testPlatform(/^iPad/) || // iPadOS 13 lies and says it's a Mac, but we can distinguish by detecting touch support.
  isMac() && navigator.maxTouchPoints > 1;
}
function isIOS() {
  return isIPhone() || isIPad();
}
function testPlatform(re) {
  return typeof window !== "undefined" && window.navigator != null ? re.test(window.navigator.platform) : void 0;
}
const visualViewport = typeof document !== "undefined" && window.visualViewport;
function isScrollable(node) {
  const style = window.getComputedStyle(node);
  return /(auto|scroll)/.test(style.overflow + style.overflowX + style.overflowY);
}
function getScrollParent(node) {
  if (isScrollable(node)) {
    node = node.parentElement;
  }
  while (node && !isScrollable(node)) {
    node = node.parentElement;
  }
  return node || document.scrollingElement || document.documentElement;
}
let preventScrollCount = 0;
let restore;
function preventScroll() {
  if (typeof document === "undefined")
    return () => {
    };
  preventScrollCount++;
  if (preventScrollCount === 1) {
    if (isIOS()) {
      restore = preventScrollMobileSafari();
    } else {
      restore = preventScrollStandard();
    }
  }
  return () => {
    preventScrollCount--;
    if (preventScrollCount === 0) {
      restore();
    }
  };
}
function getPaddingProperty(documentElement) {
  const documentLeft = documentElement.getBoundingClientRect().left;
  const scrollbarX = Math.round(documentLeft) + documentElement.scrollLeft;
  return scrollbarX ? "paddingLeft" : "paddingRight";
}
function setCSSProperty(el, property, value) {
  if (!el)
    return;
  const previousValue = el.style.getPropertyValue(property);
  el.style.setProperty(property, value);
  return () => {
    if (previousValue) {
      el.style.setProperty(property, previousValue);
    } else {
      el.style.removeProperty(property);
    }
  };
}
function preventScrollStandard() {
  if (typeof document === "undefined")
    return () => {
    };
  const win = document.defaultView ?? window;
  const { documentElement, body } = document;
  const scrollbarWidth = win.innerWidth - documentElement.clientWidth;
  const setScrollbarWidthProperty = () => setCSSProperty(documentElement, "--scrollbar-width", `${scrollbarWidth}px`);
  const paddingProperty = getPaddingProperty(documentElement);
  const scrollbarSidePadding = win.getComputedStyle(body)[paddingProperty];
  return chain(setScrollbarWidthProperty(), setStyle(body, paddingProperty, `calc(${scrollbarSidePadding} + ${scrollbarWidth}px)`), setStyle(body, "overflow", "hidden"));
}
function preventScrollMobileSafari() {
  let scrollable;
  let lastY = 0;
  const { documentElement, body, activeElement } = document;
  function onTouchStart(e2) {
    scrollable = getScrollParent(e2.target);
    if (scrollable === documentElement && scrollable === body)
      return;
    lastY = e2.changedTouches[0].pageY;
  }
  function onTouchMove(e2) {
    if (!scrollable || scrollable === documentElement || scrollable === body) {
      e2.preventDefault();
      return;
    }
    const y = e2.changedTouches[0].pageY;
    const scrollTop = scrollable.scrollTop;
    const bottom = scrollable.scrollHeight - scrollable.clientHeight;
    if (bottom === 0)
      return;
    if (scrollTop <= 0 && y > lastY || scrollTop >= bottom && y < lastY) {
      e2.preventDefault();
    }
    lastY = y;
  }
  function onTouchEnd(e2) {
    const target = e2.target;
    if (!(isInput(target) && target !== activeElement))
      return;
    e2.preventDefault();
    target.style.transform = "translateY(-2000px)";
    target.focus();
    requestAnimationFrame(() => {
      target.style.transform = "";
    });
  }
  function onFocus(e2) {
    const target = e2.target;
    if (!isInput(target))
      return;
    target.style.transform = "translateY(-2000px)";
    requestAnimationFrame(() => {
      target.style.transform = "";
      if (visualViewport) {
        if (visualViewport.height < window.innerHeight) {
          requestAnimationFrame(() => {
            scrollIntoView(target);
          });
        } else {
          visualViewport.addEventListener("resize", () => scrollIntoView(target), { once: true });
        }
      }
    });
  }
  function onWindowScroll() {
    window.scrollTo(0, 0);
  }
  const scrollX = window.pageXOffset;
  const scrollY = window.pageYOffset;
  const restoreStyles = chain(
    setStyle(documentElement, "paddingRight", `${window.innerWidth - documentElement.clientWidth}px`),
    setStyle(documentElement, "overflow", "hidden")
    // setStyle(document.body, 'marginTop', `-${scrollY}px`),
  );
  window.scrollTo(0, 0);
  const removeEvents = chain(addEventListener(document, "touchstart", onTouchStart, { passive: false, capture: true }), addEventListener(document, "touchmove", onTouchMove, { passive: false, capture: true }), addEventListener(document, "touchend", onTouchEnd, { passive: false, capture: true }), addEventListener(document, "focus", onFocus, true), addEventListener(window, "scroll", onWindowScroll));
  return () => {
    restoreStyles();
    removeEvents();
    window.scrollTo(scrollX, scrollY);
  };
}
function setStyle(element2, style, value) {
  const cur = element2.style[style];
  element2.style[style] = value;
  return () => {
    element2.style[style] = cur;
  };
}
function scrollIntoView(target) {
  const { documentElement, body, scrollingElement } = document;
  const root = scrollingElement || documentElement;
  while (target && target !== root) {
    const scrollable = getScrollParent(target);
    if (scrollable !== documentElement && scrollable !== body && scrollable !== target) {
      const scrollableTop = scrollable.getBoundingClientRect().top;
      const targetTop = target.getBoundingClientRect().top;
      const targetBottom = target.getBoundingClientRect().bottom;
      const keyboardHeight = scrollable.getBoundingClientRect().bottom;
      if (targetBottom > keyboardHeight) {
        scrollable.scrollTop += targetTop - scrollableTop;
      }
    }
    target = scrollable.parentElement;
  }
}
const documentEscapeKeyStore = readable(void 0, (set2) => {
  function keydown(event) {
    if (event && event.key === "Escape") {
      set2(event);
    }
    set2(void 0);
  }
  const unsubscribe = addEventListener(document, "keydown", keydown, {
    passive: false
  });
  return unsubscribe;
});
function handleEscapeKeydown(node, handler) {
  let unsub = noop;
  function update(handler2) {
    unsub();
    unsub = chain(
      // Handle escape keydowns
      documentEscapeKeyStore.subscribe((e2) => {
        if (!e2)
          return;
        const target = e2.target;
        if (!isHTMLElement(target) || target.closest("[data-escapee]") !== node) {
          return;
        }
        e2.preventDefault();
        handler2(e2);
      })
    );
    node.setAttribute("data-escapee", "");
  }
  update(handler);
  return () => {
    unsub();
    node.removeAttribute("data-escapee");
  };
}
function isHTMLElement(el) {
  return el instanceof HTMLElement;
}
let previousBodyPosition = null;
function handlePositionFixed({ isOpen, modal, nested, hasBeenOpened }) {
  const activeUrl = writable(typeof window !== "undefined" ? window.location.href : "");
  let scrollPos = 0;
  function setPositionFixed(open) {
    if (!(previousBodyPosition === null && open))
      return;
    previousBodyPosition = {
      position: document.body.style.position,
      top: document.body.style.top,
      left: document.body.style.left,
      height: document.body.style.height
    };
    const { scrollX, innerHeight } = window;
    document.body.style.setProperty("position", "fixed", "important");
    document.body.style.top = `${-0}px`;
    document.body.style.left = `${-scrollX}px`;
    document.body.style.right = "0px";
    document.body.style.height = "auto";
    setTimeout(() => requestAnimationFrame(() => {
      const bottomBarHeight = innerHeight - window.innerHeight;
      if (bottomBarHeight && scrollPos >= innerHeight) {
        document.body.style.top = `${-(scrollPos + bottomBarHeight)}px`;
      }
    }), 300);
  }
  function restorePositionSetting() {
    if (previousBodyPosition === null)
      return;
    const $activeUrl = get(activeUrl);
    const y = -parseInt(document.body.style.top, 10);
    const x2 = -parseInt(document.body.style.left, 10);
    document.body.style.position = previousBodyPosition.position;
    document.body.style.top = previousBodyPosition.top;
    document.body.style.left = previousBodyPosition.left;
    document.body.style.height = previousBodyPosition.height;
    document.body.style.right = "unset";
    requestAnimationFrame(() => {
      if ($activeUrl !== window.location.href) {
        activeUrl.set(window.location.href);
        return;
      }
      window.scrollTo(x2, y);
    });
    previousBodyPosition = null;
  }
  effect([isOpen, activeUrl], ([$isOpen, _2]) => {
    if (typeof document === "undefined")
      return;
    if (get(nested) || !get(hasBeenOpened))
      return;
    if ($isOpen) {
      setPositionFixed($isOpen);
      if (!get(modal)) {
        setTimeout(() => {
          restorePositionSetting();
        }, 500);
      }
    } else {
      restorePositionSetting();
    }
  });
  return { restorePositionSetting };
}
const CLOSE_THRESHOLD = 0.25;
const SCROLL_LOCK_TIMEOUT = 100;
const BORDER_RADIUS = 8;
const NESTED_DISPLACEMENT = 16;
const WINDOW_TOP_OFFSET = 26;
const DRAG_CLASS = "vaul-dragging";
const openDrawerIds = writable([]);
const defaultProps = {
  closeThreshold: CLOSE_THRESHOLD,
  shouldScaleBackground: true,
  scrollLockTimeout: SCROLL_LOCK_TIMEOUT,
  onDrag: void 0,
  onRelease: void 0,
  snapPoints: void 0,
  fadeFromIndex: void 0,
  defaultActiveSnapPoint: void 0,
  onActiveSnapPointChange: void 0,
  defaultOpen: false,
  onOpenChange: void 0,
  fixed: void 0,
  dismissible: true,
  modal: true,
  nested: false,
  onClose: void 0,
  direction: "bottom"
};
const omittedOptions = [
  "defaultOpen",
  "onOpenChange",
  "defaultActiveSnapPoint",
  "onActiveSnapPointChange",
  "onDrag",
  "onRelease",
  "onClose"
];
function createVaul(props) {
  const { snapPoints: snapPointsProp, fadeFromIndex: fadeFromIndexProp = snapPointsProp && snapPointsProp.length - 1, ...withDefaults } = { ...defaultProps, ...removeUndefined(props) };
  const options = toWritableStores(omit({
    ...withDefaults,
    snapPoints: snapPointsProp,
    fadeFromIndex: fadeFromIndexProp
  }, ...omittedOptions));
  const triggerRef = writable(void 0);
  const { onDrag: onDragProp, onRelease: onReleaseProp, onClose, onOpenChange } = withDefaults;
  const { snapPoints, fadeFromIndex, fixed, dismissible, modal, nested, shouldScaleBackground, scrollLockTimeout, closeThreshold, direction } = options;
  const openStore = writable(withDefaults.defaultOpen);
  const isOpen = overridable(openStore, withDefaults.onOpenChange);
  const hasBeenOpened = writable(false);
  const visible = writable(false);
  const justReleased = writable(false);
  const overlayRef = writable(void 0);
  const openTime = writable(null);
  const keyboardIsOpen = writable(false);
  const drawerRef = writable(void 0);
  const drawerId = writable(void 0);
  let isDragging = false;
  let dragStartTime = null;
  let isClosing = false;
  let pointerStart = 0;
  let dragEndTime = null;
  let lastTimeDragPrevented = null;
  let isAllowedToDrag = false;
  let drawerHeightRef = get(drawerRef)?.getBoundingClientRect().height || 0;
  let previousDiffFromInitial = 0;
  let initialDrawerHeight = 0;
  let nestedOpenChangeTimer = null;
  const activeSnapPoint = overridable(writable(withDefaults.defaultActiveSnapPoint), withDefaults.onActiveSnapPointChange);
  const { activeSnapPointIndex, getPercentageDragged: getSnapPointsPercentageDragged, onDrag: onDragSnapPoints, onRelease: onReleaseSnapPoints, shouldFade, snapPointsOffset } = handleSnapPoints({
    snapPoints,
    activeSnapPoint,
    drawerRef,
    fadeFromIndex,
    overlayRef,
    openTime,
    direction
  });
  const getContentStyle = derived([snapPointsOffset], ([$snapPointsOffset]) => {
    return (style = "") => {
      if ($snapPointsOffset && $snapPointsOffset.length > 0) {
        const styleProp = styleToString$1({
          "--snap-point-height": `${$snapPointsOffset[0]}px`
        });
        return style + styleProp;
      }
      return style;
    };
  });
  effect([drawerRef], ([$drawerRef]) => {
    if ($drawerRef) {
      drawerId.set($drawerRef.id);
    }
  });
  effect([isOpen], ([$open]) => {
    sleep(100).then(() => {
      const id = get(drawerId);
      if ($open && id) {
        openDrawerIds.update((prev) => {
          if (prev.includes(id)) {
            return prev;
          }
          prev.push(id);
          return prev;
        });
      } else {
        openDrawerIds.update((prev) => prev.filter((id2) => id2 !== id2));
      }
    });
  });
  effect([isOpen], ([$isOpen]) => {
    if (!$isOpen && get(shouldScaleBackground)) {
      const id = setTimeout(() => {
        reset(document.body, "background");
      }, 200);
      return () => clearTimeout(id);
    }
  });
  effect([isOpen], ([$isOpen]) => {
    let unsub = () => {
    };
    if ($isOpen) {
      unsub = preventScroll();
    }
    return unsub;
  });
  const { restorePositionSetting } = handlePositionFixed({ isOpen, modal, nested, hasBeenOpened });
  effect([drawerRef], ([$drawerRef]) => {
    let unsub = noop;
    if ($drawerRef) {
      unsub = handleEscapeKeydown($drawerRef, () => {
        closeDrawer(true);
      });
    }
    return () => {
      unsub();
    };
  });
  function openDrawer() {
    if (isClosing)
      return;
    hasBeenOpened.set(true);
    isOpen.set(true);
  }
  function onPress(event) {
    const $drawerRef = get(drawerRef);
    if (!get(dismissible) && !get(snapPoints))
      return;
    if ($drawerRef && !$drawerRef.contains(event.target))
      return;
    drawerHeightRef = $drawerRef?.getBoundingClientRect().height || 0;
    isDragging = true;
    dragStartTime = /* @__PURE__ */ new Date();
    if (isIOS()) {
      window.addEventListener("touchend", () => isAllowedToDrag = false, { once: true });
    }
    event.target.setPointerCapture(event.pointerId);
    pointerStart = isVertical(get(direction)) ? event.screenY : event.screenX;
  }
  function shouldDrag(el, isDraggingInDirection) {
    const $drawerRef = get(drawerRef);
    let element2 = el;
    const highlightedText = window.getSelection()?.toString();
    const $direction = get(direction);
    const swipeAmount = $drawerRef ? getTranslate($drawerRef, $direction) : null;
    const date = /* @__PURE__ */ new Date();
    if (element2.hasAttribute("data-vaul-no-drag") || element2.closest("[data-vaul-no-drag]")) {
      return false;
    }
    const $openTime = get(openTime);
    if ($openTime && date.getTime() - $openTime.getTime() < 500) {
      return false;
    }
    if (swipeAmount !== null) {
      if ($direction === "bottom" || $direction === "right" ? swipeAmount > 0 : swipeAmount < 0) {
        return true;
      }
    }
    if (swipeAmount !== null && swipeAmount > 0) {
      return true;
    }
    if (highlightedText && highlightedText.length > 0) {
      return false;
    }
    const $scrollLockTimeout = get(scrollLockTimeout);
    if (lastTimeDragPrevented && date.getTime() - lastTimeDragPrevented.getTime() < $scrollLockTimeout && swipeAmount === 0) {
      lastTimeDragPrevented = date;
      return false;
    }
    if (isDraggingInDirection) {
      lastTimeDragPrevented = date;
      return false;
    }
    while (element2) {
      if (element2.scrollHeight > element2.clientHeight) {
        if (element2.scrollTop !== 0) {
          lastTimeDragPrevented = /* @__PURE__ */ new Date();
          return false;
        }
        if (element2.getAttribute("role") === "dialog") {
          return true;
        }
      }
      element2 = element2.parentNode;
    }
    return true;
  }
  function onDrag(event) {
    const $drawerRef = get(drawerRef);
    if (!$drawerRef || !isDragging)
      return;
    const $direction = get(direction);
    const directionMultiplier = getDirectionMultiplier($direction);
    const draggedDistance = getDistanceMoved(pointerStart, $direction, event) * directionMultiplier;
    const isDraggingInDirection = draggedDistance > 0;
    const $activeSnapPointIndex = get(activeSnapPointIndex);
    const $snapPoints = get(snapPoints);
    if ($snapPoints && $activeSnapPointIndex === 0 && !get(dismissible))
      return;
    if (!isAllowedToDrag && !shouldDrag(event.target, isDraggingInDirection)) {
      return;
    }
    $drawerRef.classList.add(DRAG_CLASS);
    isAllowedToDrag = true;
    set($drawerRef, {
      transition: "none"
    });
    const $overlayRef = get(overlayRef);
    set($overlayRef, {
      transition: "none"
    });
    if ($snapPoints) {
      onDragSnapPoints({ draggedDistance });
    }
    if (isDraggingInDirection && !$snapPoints) {
      const dampenedDraggedDistance = dampenValue(draggedDistance);
      const translateValue = Math.min(dampenedDraggedDistance * -1, 0) * directionMultiplier;
      set($drawerRef, {
        transform: isVertical($direction) ? `translate3d(0, ${translateValue}px, 0)` : `translate3d(${translateValue}px, 0, 0)`
      });
      return;
    }
    const absDraggedDistance = Math.abs(draggedDistance);
    let percentageDragged = absDraggedDistance / drawerHeightRef;
    const snapPointPercentageDragged = getSnapPointsPercentageDragged(absDraggedDistance, isDraggingInDirection);
    if (snapPointPercentageDragged !== null) {
      percentageDragged = snapPointPercentageDragged;
    }
    const opacityValue = 1 - percentageDragged;
    const $fadeFromIndex = get(fadeFromIndex);
    const $shouldFade = get(shouldFade);
    if ($shouldFade || $fadeFromIndex && $activeSnapPointIndex === $fadeFromIndex - 1) {
      onDragProp?.(event, percentageDragged);
      set($overlayRef, {
        opacity: `${opacityValue}`,
        transition: "none"
      }, true);
    }
    const wrapper = document.querySelector("[data-vaul-drawer-wrapper]");
    if (wrapper && $overlayRef && get(shouldScaleBackground)) {
      const scaleValue = Math.min(getScale() + percentageDragged * (1 - getScale()), 1);
      const borderRadiusValue = 8 - percentageDragged * 8;
      const translateValue = Math.max(0, 14 - percentageDragged * 14);
      set(wrapper, {
        borderRadius: `${borderRadiusValue}px`,
        transform: isVertical($direction) ? `scale(${scaleValue}) translate3d(0, ${translateValue}px, 0)` : `scale(${scaleValue}) translate3d(${translateValue}px, 0, 0)`,
        transition: "none"
      }, true);
    }
    if (!$snapPoints) {
      const translateValue = absDraggedDistance * directionMultiplier;
      set($drawerRef, {
        transform: isVertical($direction) ? `translate3d(0, ${translateValue}px, 0)` : `translate3d(${translateValue}px, 0, 0)`
      });
    }
  }
  function scaleBackground(open, backgroundColor = "black") {
    const wrapper = document.querySelector("[data-vaul-drawer-wrapper]");
    if (!wrapper || !get(shouldScaleBackground))
      return;
    const $direction = get(direction);
    if (open) {
      set(document.body, {
        background: document.body.style.backgroundColor || document.body.style.background
      });
      set(document.body, {
        background: backgroundColor
      }, true);
      set(wrapper, {
        borderRadius: `${BORDER_RADIUS}px`,
        overflow: "hidden",
        ...isVertical($direction) ? {
          transform: `scale(${getScale()}) translate3d(0, calc(env(safe-area-inset-top) + 14px), 0)`,
          transformOrigin: "top"
        } : {
          transform: `scale(${getScale()}) translate3d(calc(env(safe-area-inset-top) + 14px), 0, 0)`,
          transformOrigin: "left"
        },
        transitionProperty: "transform, border-radius",
        transitionDuration: `${TRANSITIONS.DURATION}s`,
        transitionTimingFunction: `cubic-bezier(${TRANSITIONS.EASE.join(",")})`
      });
    } else {
      reset(wrapper, "overflow");
      reset(wrapper, "transform");
      reset(wrapper, "borderRadius");
      set(wrapper, {
        transitionProperty: "transform, border-radius",
        transitionDuration: `${TRANSITIONS.DURATION}s`,
        transitionTimingFunction: `cubic-bezier(${TRANSITIONS.EASE.join(",")})`
      });
    }
  }
  effect([activeSnapPointIndex, snapPoints, snapPointsOffset], ([$activeSnapPointIndex, $snapPoints, $snapPointsOffset]) => {
    function onVisualViewportChange() {
      const $drawerRef = get(drawerRef);
      if (!$drawerRef)
        return;
      const $keyboardIsOpen = get(keyboardIsOpen);
      const focusedElement = document.activeElement;
      if (isInput(focusedElement) || $keyboardIsOpen) {
        const visualViewportHeight = window.visualViewport?.height || 0;
        let diffFromInitial = window.innerHeight - visualViewportHeight;
        const drawerHeight = $drawerRef.getBoundingClientRect().height || 0;
        if (!initialDrawerHeight) {
          initialDrawerHeight = drawerHeight;
        }
        const offsetFromTop = $drawerRef.getBoundingClientRect().top;
        if (Math.abs(previousDiffFromInitial - diffFromInitial) > 60) {
          keyboardIsOpen.set(!$keyboardIsOpen);
        }
        if ($snapPoints && $snapPoints.length > 0 && $snapPointsOffset && $activeSnapPointIndex) {
          const activeSnapPointHeight = $snapPointsOffset[$activeSnapPointIndex] || 0;
          diffFromInitial += activeSnapPointHeight;
        }
        previousDiffFromInitial = diffFromInitial;
        if (drawerHeight > visualViewportHeight || $keyboardIsOpen) {
          const height = $drawerRef.getBoundingClientRect().height;
          let newDrawerHeight = height;
          if (height > visualViewportHeight) {
            newDrawerHeight = visualViewportHeight - WINDOW_TOP_OFFSET;
          }
          if (get(fixed)) {
            $drawerRef.style.height = `${height - Math.max(diffFromInitial, 0)}px`;
          } else {
            $drawerRef.style.height = `${Math.max(newDrawerHeight, visualViewportHeight - offsetFromTop)}px`;
          }
        } else {
          $drawerRef.style.height = `${initialDrawerHeight}px`;
        }
        if ($snapPoints && $snapPoints.length > 0 && !$keyboardIsOpen) {
          $drawerRef.style.bottom = `0px`;
        } else {
          $drawerRef.style.bottom = `${Math.max(diffFromInitial, 0)}px`;
        }
      }
    }
    let removeListener = noop;
    if (window.visualViewport) {
      removeListener = addEventListener(window.visualViewport, "resize", onVisualViewportChange);
    }
    return () => {
      removeListener();
    };
  });
  function closeDrawer(withKeyboard = false) {
    if (isClosing)
      return;
    const $drawerRef = get(drawerRef);
    if (!$drawerRef)
      return;
    const $direction = get(direction);
    onClose?.();
    set($drawerRef, {
      transform: isVertical($direction) ? `translate3d(0, ${$direction === "bottom" ? "100%" : "-100%"}, 0)` : `translate3d(${$direction === "right" ? "100%" : "-100%"}, 0, 0)`,
      transition: `transform ${TRANSITIONS.DURATION}s cubic-bezier(${TRANSITIONS.EASE.join(",")})`
    });
    set(get(overlayRef), {
      opacity: "0",
      transition: `opacity ${TRANSITIONS.DURATION}s cubic-bezier(${TRANSITIONS.EASE.join(",")})`
    });
    scaleBackground(false);
    isClosing = true;
    setTimeout(() => {
      visible.set(false);
      isOpen.set(false);
      isClosing = false;
      if (withKeyboard) {
        get(triggerRef)?.focus();
      }
    }, 300);
    const $snapPoints = get(snapPoints);
    setTimeout(() => {
      reset(document.documentElement, "scrollBehavior");
      if ($snapPoints) {
        activeSnapPoint.set($snapPoints[0]);
      }
    }, TRANSITIONS.DURATION * 1e3);
  }
  effect([isOpen], ([$isOpen]) => {
    if ($isOpen) {
      hasBeenOpened.set(true);
    } else {
      closeDrawer();
    }
  });
  function resetDrawer() {
    const $drawerRef = get(drawerRef);
    if (!$drawerRef)
      return;
    const $overlayRef = get(overlayRef);
    const wrapper = document.querySelector("[data-vaul-drawer-wrapper]");
    const $direction = get(direction);
    const currentSwipeAmount = getTranslate($drawerRef, $direction);
    set($drawerRef, {
      transform: "translate3d(0, 0, 0)",
      transition: `transform ${TRANSITIONS.DURATION}s cubic-bezier(${TRANSITIONS.EASE.join(",")})`
    });
    set($overlayRef, {
      transition: `opacity ${TRANSITIONS.DURATION}s cubic-bezier(${TRANSITIONS.EASE.join(",")})`,
      opacity: "1"
    });
    const $shouldScaleBackground = get(shouldScaleBackground);
    const $isOpen = get(isOpen);
    if ($shouldScaleBackground && currentSwipeAmount && currentSwipeAmount > 0 && $isOpen) {
      set(wrapper, {
        borderRadius: `${BORDER_RADIUS}px`,
        overflow: "hidden",
        ...isVertical($direction) ? {
          transform: `scale(${getScale()}) translate3d(0, calc(env(safe-area-inset-top) + 14px), 0)`,
          transformOrigin: "top"
        } : {
          transform: `scale(${getScale()}) translate3d(calc(env(safe-area-inset-top) + 14px), 0, 0)`,
          transformOrigin: "left"
        },
        transitionProperty: "transform, border-radius",
        transitionDuration: `${TRANSITIONS.DURATION}s`,
        transitionTimingFunction: `cubic-bezier(${TRANSITIONS.EASE.join(",")})`
      }, true);
    }
  }
  function onRelease(event) {
    const $drawerRef = get(drawerRef);
    if (!isDragging || !$drawerRef)
      return;
    if (isAllowedToDrag && isInput(event.target)) {
      event.target.blur();
    }
    $drawerRef.classList.remove(DRAG_CLASS);
    isAllowedToDrag = false;
    isDragging = false;
    dragEndTime = /* @__PURE__ */ new Date();
    const $direction = get(direction);
    const swipeAmount = getTranslate($drawerRef, $direction);
    if (event.target && !shouldDrag(event.target, false) || !swipeAmount || Number.isNaN(swipeAmount))
      return;
    if (dragStartTime === null)
      return;
    const timeTaken = dragEndTime.getTime() - dragStartTime.getTime();
    const distMoved = getDistanceMoved(pointerStart, $direction, event);
    const velocity = Math.abs(distMoved) / timeTaken;
    if (velocity > 0.05) {
      justReleased.set(true);
      setTimeout(() => {
        justReleased.set(false);
      }, 200);
    }
    if (get(snapPoints)) {
      onReleaseSnapPoints({
        draggedDistance: distMoved * getDirectionMultiplier($direction),
        closeDrawer,
        velocity,
        dismissible: get(dismissible)
      });
      onReleaseProp?.(event, true);
      return;
    }
    if ($direction === "bottom" || $direction === "right" ? distMoved > 0 : distMoved < 0) {
      resetDrawer();
      onReleaseProp?.(event, true);
      return;
    }
    if (velocity > VELOCITY_THRESHOLD) {
      closeDrawer();
      onReleaseProp?.(event, false);
      return;
    }
    const visibleDrawerHeight = Math.min(get(drawerRef)?.getBoundingClientRect().height ?? 0, window.innerHeight);
    if (swipeAmount >= visibleDrawerHeight * get(closeThreshold)) {
      closeDrawer();
      onReleaseProp?.(event, false);
      return;
    }
    onReleaseProp?.(event, true);
    resetDrawer();
  }
  effect([isOpen], ([$isOpen]) => {
    if (!$isOpen)
      return;
    if (isBrowser) {
      set(document.documentElement, {
        scrollBehavior: "auto"
      });
    }
    openTime.set(/* @__PURE__ */ new Date());
    scaleBackground(true, props.backgroundColor);
  });
  effect([visible], ([$visible]) => {
    if (!$visible)
      return;
    const $drawerRef = get(drawerRef);
    if (!$drawerRef)
      return;
    const children = $drawerRef.querySelectorAll("*");
    children.forEach((child) => {
      const htmlChild = child;
      if (htmlChild.scrollHeight > htmlChild.clientHeight || htmlChild.scrollWidth > htmlChild.clientWidth) {
        htmlChild.classList.add("vaul-scrollable");
      }
    });
  });
  function onNestedOpenChange(o2) {
    const $drawerRef = get(drawerRef);
    const scale = o2 ? (window.innerWidth - NESTED_DISPLACEMENT) / window.innerWidth : 1;
    const y = o2 ? -16 : 0;
    if (nestedOpenChangeTimer) {
      window.clearTimeout(nestedOpenChangeTimer);
    }
    set($drawerRef, {
      transition: `transform ${TRANSITIONS.DURATION}s cubic-bezier(${TRANSITIONS.EASE.join(",")})`,
      transform: `scale(${scale}) translate3d(0, ${y}px, 0)`
    });
    if (!o2 && $drawerRef) {
      nestedOpenChangeTimer = setTimeout(() => {
        const $direction = get(direction);
        const translateValue = getTranslate($drawerRef, $direction);
        set($drawerRef, {
          transition: "none",
          transform: isVertical($direction) ? `translate3d(0, ${translateValue}px, 0)` : `translate3d(${translateValue}px, 0, 0)`
        });
      }, 500);
    }
  }
  function onNestedDrag(_2, percentageDragged) {
    if (percentageDragged < 0)
      return;
    const initialScale = (window.innerWidth - NESTED_DISPLACEMENT) / window.innerWidth;
    const newScale = initialScale + percentageDragged * (1 - initialScale);
    const newTranslate = -16 + percentageDragged * NESTED_DISPLACEMENT;
    const $direction = get(direction);
    set(get(drawerRef), {
      transform: isVertical($direction) ? `scale(${newScale}) translate3d(0, ${newTranslate}px, 0)` : `scale(${newScale}) translate3d(${newTranslate}px, 0, 0)`,
      transition: "none"
    });
  }
  function onNestedRelease(_2, o2) {
    const $direction = get(direction);
    const dim = isVertical($direction) ? window.innerHeight : window.innerWidth;
    const scale = o2 ? (dim - NESTED_DISPLACEMENT) / dim : 1;
    const translate = o2 ? -16 : 0;
    if (o2) {
      set(get(drawerRef), {
        transition: `transform ${TRANSITIONS.DURATION}s cubic-bezier(${TRANSITIONS.EASE.join(",")})`,
        transform: isVertical($direction) ? `scale(${scale}) translate3d(0, ${translate}px, 0)` : `scale(${scale}) translate3d(${translate}px, 0, 0)`
      });
    }
  }
  return {
    states: {
      isOpen,
      hasBeenOpened,
      snapPoints,
      activeSnapPoint,
      snapPointsOffset,
      keyboardIsOpen,
      shouldFade,
      visible,
      drawerId,
      openDrawerIds
    },
    helpers: {
      getContentStyle
    },
    methods: {
      closeDrawer,
      onOpenChange,
      onPress,
      onRelease,
      onDrag,
      scaleBackground,
      onNestedDrag,
      onNestedOpenChange,
      onNestedRelease,
      restorePositionSetting,
      openDrawer
    },
    refs: {
      drawerRef,
      overlayRef,
      triggerRef
    },
    options
  };
}
function dampenValue(v) {
  return 8 * (Math.log(v + 1) - 2);
}
function getScale() {
  return (window.innerWidth - WINDOW_TOP_OFFSET) / window.innerWidth;
}
function getDistanceMoved(pointerStart, direction, event) {
  if (event.type.startsWith("touch")) {
    return getDistanceMovedForTouch(pointerStart, direction, event);
  } else {
    return getDistanceMovedForPointer(pointerStart, direction, event);
  }
}
function getDistanceMovedForPointer(pointerStart, direction, event) {
  return pointerStart - (isVertical(direction) ? event.screenY : event.screenX);
}
function getDistanceMovedForTouch(pointerStart, direction, event) {
  return pointerStart - (isVertical(direction) ? event.changedTouches[0].screenY : event.changedTouches[0].screenX);
}
function getDirectionMultiplier(direction) {
  return direction === "bottom" || direction === "right" ? 1 : -1;
}
const VAUL_ROOT = Symbol("VAUL_ROOT");
function setCtx(props = {}) {
  const vaul = createVaul(props);
  const updateOption = getOptionUpdater(vaul.options);
  setContext(VAUL_ROOT, { ...vaul, updateOption });
  return {
    ...vaul,
    updateOption
  };
}
function getCtx() {
  return getContext(VAUL_ROOT);
}
function Root($$payload, $$props) {
  const $$sanitized_props = sanitize_props($$props);
  const $$restProps = rest_props($$sanitized_props, [
    "open",
    "onOpenChange",
    "closeThreshold",
    "scrollLockTimeout",
    "snapPoints",
    "fadeFromIndex",
    "openFocus",
    "onOutsideClick",
    "closeOnOutsideClick",
    "backgroundColor",
    "nested",
    "shouldScaleBackground",
    "activeSnapPoint",
    "onActiveSnapPointChange",
    "onRelease",
    "onDrag",
    "onClose",
    "dismissible",
    "direction"
  ]);
  push();
  var $$store_subs;
  let open = fallback($$props["open"], false);
  let onOpenChange = fallback($$props["onOpenChange"], () => void 0, true);
  let closeThreshold = fallback($$props["closeThreshold"], () => void 0, true);
  let scrollLockTimeout = fallback($$props["scrollLockTimeout"], () => void 0, true);
  let snapPoints = fallback($$props["snapPoints"], () => void 0, true);
  let fadeFromIndex = fallback($$props["fadeFromIndex"], () => void 0, true);
  let openFocus = fallback($$props["openFocus"], () => void 0, true);
  let onOutsideClick = fallback($$props["onOutsideClick"], () => void 0, true);
  let closeOnOutsideClick = fallback($$props["closeOnOutsideClick"], true);
  let backgroundColor = fallback($$props["backgroundColor"], "black");
  let nested = fallback($$props["nested"], false);
  let shouldScaleBackground = fallback($$props["shouldScaleBackground"], false);
  let activeSnapPoint = fallback($$props["activeSnapPoint"], () => void 0, true);
  let onActiveSnapPointChange = fallback($$props["onActiveSnapPointChange"], () => void 0, true);
  let onRelease = fallback($$props["onRelease"], () => void 0, true);
  let onDrag = fallback($$props["onDrag"], () => void 0, true);
  let onClose = fallback($$props["onClose"], () => void 0, true);
  let dismissible = fallback($$props["dismissible"], () => void 0, true);
  let direction = fallback($$props["direction"], "bottom");
  const {
    states: {
      keyboardIsOpen,
      activeSnapPoint: localActiveSnapPoint,
      drawerId,
      openDrawerIds: openDrawerIds2,
      isOpen
    },
    methods: { closeDrawer, openDrawer },
    options: { dismissible: localDismissible },
    updateOption
  } = setCtx({
    defaultOpen: open,
    defaultActiveSnapPoint: activeSnapPoint,
    onOpenChange: ({ next }) => {
      if (open !== next) {
        onOpenChange?.(next);
        open = next;
      }
      return next;
    },
    onActiveSnapPointChange: ({ next }) => {
      if (next === void 0 && snapPoints && activeSnapPoint !== next) {
        const newNext = snapPoints[0];
        onActiveSnapPointChange?.(newNext);
        activeSnapPoint = newNext;
        return newNext;
      }
      if (activeSnapPoint !== next) {
        onActiveSnapPointChange?.(next);
        activeSnapPoint = next;
      }
      return next;
    },
    closeThreshold,
    scrollLockTimeout,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    snapPoints,
    fadeFromIndex,
    nested,
    onDrag,
    onClose,
    onRelease,
    shouldScaleBackground,
    backgroundColor,
    dismissible,
    direction
  });
  activeSnapPoint !== void 0 && localActiveSnapPoint.set(activeSnapPoint);
  updateOption("closeThreshold", closeThreshold);
  updateOption("scrollLockTimeout", scrollLockTimeout);
  updateOption("snapPoints", snapPoints);
  updateOption("fadeFromIndex", fadeFromIndex);
  updateOption("openFocus", openFocus);
  updateOption("shouldScaleBackground", shouldScaleBackground);
  updateOption("backgroundColor", backgroundColor);
  updateOption("dismissible", dismissible);
  updateOption("direction", direction);
  open && !store_get($$store_subs ??= {}, "$isOpen", isOpen) && openDrawer();
  !open && store_get($$store_subs ??= {}, "$isOpen", isOpen) && closeDrawer();
  let $$settled = true;
  let $$inner_payload;
  function $$render_inner($$payload2) {
    Dialog($$payload2, spread_props([
      {
        closeOnOutsideClick,
        closeOnEscape: false,
        preventScroll: false,
        onOpenChange: (o2) => {
          onOpenChange?.(o2);
          if (!o2) {
            closeDrawer();
          } else if (o2) {
            openDrawer();
          }
        },
        onOutsideClick: (e2) => {
          if (!closeOnOutsideClick) return;
          onOutsideClick?.(e2);
          if (e2?.defaultPrevented) return;
          if (store_get($$store_subs ??= {}, "$keyboardIsOpen", keyboardIsOpen)) {
            keyboardIsOpen.set(false);
          }
          e2.preventDefault();
          if (!store_get($$store_subs ??= {}, "$localDismissible", localDismissible)) {
            return;
          }
          const $openDialogIds = get(openDrawerIds2);
          const isLast = $openDialogIds[$openDialogIds.length - 1] === get(drawerId);
          if (isLast) {
            onOpenChange?.(false);
            closeDrawer();
          }
        }
      },
      $$restProps,
      {
        get open() {
          return open;
        },
        set open($$value) {
          open = $$value;
          $$settled = false;
        },
        children: ($$payload3) => {
          $$payload3.out += `<!---->`;
          slot($$payload3, $$props, "default", {});
          $$payload3.out += `<!---->`;
        },
        $$slots: { default: true }
      }
    ]));
  }
  do {
    $$settled = true;
    $$inner_payload = copy_payload($$payload);
    $$render_inner($$inner_payload);
  } while (!$$settled);
  assign_payload($$payload, $$inner_payload);
  if ($$store_subs) unsubscribe_stores($$store_subs);
  bind_props($$props, {
    open,
    onOpenChange,
    closeThreshold,
    scrollLockTimeout,
    snapPoints,
    fadeFromIndex,
    openFocus,
    onOutsideClick,
    closeOnOutsideClick,
    backgroundColor,
    nested,
    shouldScaleBackground,
    activeSnapPoint,
    onActiveSnapPointChange,
    onRelease,
    onDrag,
    onClose,
    dismissible,
    direction
  });
  pop();
}
function Visible($$payload, $$props) {
  push();
  const {
    states: { visible },
    methods: { scaleBackground, restorePositionSetting }
  } = getCtx();
  pop();
}
function Content($$payload, $$props) {
  const $$sanitized_props = sanitize_props($$props);
  const $$restProps = rest_props($$sanitized_props, ["style"]);
  push();
  var $$store_subs;
  const {
    refs: { drawerRef },
    states: { visible },
    helpers: { getContentStyle },
    methods: { onPress, onDrag, onRelease },
    options: { direction }
  } = getCtx();
  let style = fallback($$props["style"], "");
  let $$settled = true;
  let $$inner_payload;
  function $$render_inner($$payload2) {
    Dialog_content($$payload2, spread_props([
      {
        style: store_get($$store_subs ??= {}, "$getContentStyle", getContentStyle)(style),
        "data-vaul-drawer": "",
        "data-vaul-drawer-direction": store_get($$store_subs ??= {}, "$direction", direction),
        "data-vaul-drawer-visible": store_get($$store_subs ??= {}, "$visible", visible) ? "true" : "false"
      },
      $$restProps,
      {
        get el() {
          return store_get($$store_subs ??= {}, "$drawerRef", drawerRef);
        },
        set el($$value) {
          store_set(drawerRef, $$value);
          $$settled = false;
        },
        children: ($$payload3) => {
          Visible();
          $$payload3.out += `<!----> <!---->`;
          slot($$payload3, $$props, "default", {});
          $$payload3.out += `<!---->`;
        },
        $$slots: { default: true }
      }
    ]));
  }
  do {
    $$settled = true;
    $$inner_payload = copy_payload($$payload);
    $$render_inner($$inner_payload);
  } while (!$$settled);
  assign_payload($$payload, $$inner_payload);
  if ($$store_subs) unsubscribe_stores($$store_subs);
  bind_props($$props, { style });
  pop();
}
function Overlay($$payload, $$props) {
  const $$sanitized_props = sanitize_props($$props);
  const $$restProps = rest_props($$sanitized_props, []);
  push();
  var $$store_subs;
  let hasSnapPoints;
  const {
    refs: { overlayRef },
    states: { isOpen, visible, snapPoints, shouldFade },
    methods: { onRelease }
  } = getCtx();
  hasSnapPoints = store_get($$store_subs ??= {}, "$snapPoints", snapPoints) && store_get($$store_subs ??= {}, "$snapPoints", snapPoints).length > 0;
  let $$settled = true;
  let $$inner_payload;
  function $$render_inner($$payload2) {
    Dialog_overlay($$payload2, spread_props([
      {
        "data-vaul-drawer-visible": store_get($$store_subs ??= {}, "$visible", visible) ? "true" : "false",
        "data-vaul-overlay": "",
        "data-vaul-snap-points": store_get($$store_subs ??= {}, "$isOpen", isOpen) && hasSnapPoints ? "true" : "false",
        "data-vaul-snap-points-overlay": store_get($$store_subs ??= {}, "$isOpen", isOpen) && store_get($$store_subs ??= {}, "$shouldFade", shouldFade) ? "true" : "false"
      },
      $$restProps,
      {
        get el() {
          return store_get($$store_subs ??= {}, "$overlayRef", overlayRef);
        },
        set el($$value) {
          store_set(overlayRef, $$value);
          $$settled = false;
        }
      }
    ]));
  }
  do {
    $$settled = true;
    $$inner_payload = copy_payload($$payload);
    $$render_inner($$inner_payload);
  } while (!$$settled);
  assign_payload($$payload, $$inner_payload);
  if ($$store_subs) unsubscribe_stores($$store_subs);
  pop();
}
function Trigger_wrapper($$payload, $$props) {
  push();
  let action, rest;
  let meltBuilder = $$props["meltBuilder"];
  const { refs: { triggerRef } } = getCtx();
  const wrappedAction = (node) => {
    triggerRef.set(node);
    return action(node);
  };
  ({ action, ...rest } = meltBuilder);
  Object.assign(rest, { action: wrappedAction });
  $$payload.out += `<!---->`;
  slot($$payload, $$props, "default", { newBuilder: rest });
  $$payload.out += `<!---->`;
  bind_props($$props, { meltBuilder });
  pop();
}
function Trigger($$payload, $$props) {
  const $$sanitized_props = sanitize_props($$props);
  const $$restProps = rest_props($$sanitized_props, ["el", "asChild"]);
  push();
  const { refs: { triggerRef } } = getCtx();
  let el = fallback($$props["el"], () => void 0, true);
  let asChild = fallback($$props["asChild"], false);
  if (el) {
    triggerRef.set(el);
  }
  let $$settled = true;
  let $$inner_payload;
  function $$render_inner($$payload2) {
    if (asChild) {
      $$payload2.out += "<!--[-->";
      Dialog_trigger($$payload2, spread_props([
        { asChild },
        $$restProps,
        {
          get el() {
            return el;
          },
          set el($$value) {
            el = $$value;
            $$settled = false;
          },
          children: invalid_default_snippet,
          $$slots: {
            default: ($$payload3, { builder }) => {
              Trigger_wrapper($$payload3, {
                meltBuilder: builder,
                children: invalid_default_snippet,
                $$slots: {
                  default: ($$payload4, { newBuilder }) => {
                    $$payload4.out += `<!---->`;
                    slot($$payload4, $$props, "default", { builder: newBuilder });
                    $$payload4.out += `<!---->`;
                  }
                }
              });
            }
          }
        }
      ]));
    } else {
      $$payload2.out += "<!--[!-->";
      Dialog_trigger($$payload2, spread_props([
        $$restProps,
        {
          get el() {
            return el;
          },
          set el($$value) {
            el = $$value;
            $$settled = false;
          },
          children: invalid_default_snippet,
          $$slots: {
            default: ($$payload3, { builder }) => {
              $$payload3.out += `<!---->`;
              slot($$payload3, $$props, "default", { builder });
              $$payload3.out += `<!---->`;
            }
          }
        }
      ]));
    }
    $$payload2.out += `<!--]-->`;
  }
  do {
    $$settled = true;
    $$inner_payload = copy_payload($$payload);
    $$render_inner($$inner_payload);
  } while (!$$settled);
  assign_payload($$payload, $$inner_payload);
  bind_props($$props, { el, asChild });
  pop();
}
const Portal = Dialog_portal;
const Title = Dialog_title;
const Description = Dialog_description;
function Drawer_1($$payload, $$props) {
  push();
  let {
    title,
    description,
    isDrawerOpen = false,
    drawerTrigger,
    children
  } = $$props;
  let $$settled = true;
  let $$inner_payload;
  function $$render_inner($$payload2) {
    $$payload2.out += `<!---->`;
    Root($$payload2, {
      get open() {
        return isDrawerOpen;
      },
      set open($$value) {
        isDrawerOpen = $$value;
        $$settled = false;
      },
      children: ($$payload3) => {
        if (drawerTrigger) {
          $$payload3.out += "<!--[-->";
          $$payload3.out += `<!---->`;
          Trigger($$payload3, {
            children: ($$payload4) => {
              drawerTrigger?.($$payload4);
              $$payload4.out += `<!---->`;
            },
            $$slots: { default: true }
          });
          $$payload3.out += `<!---->`;
        } else {
          $$payload3.out += "<!--[!-->";
        }
        $$payload3.out += `<!--]--> <!---->`;
        Portal($$payload3, {
          children: ($$payload4) => {
            $$payload4.out += `<!---->`;
            Overlay($$payload4, { class: "fixed inset-0 bg-black/40" });
            $$payload4.out += `<!----> <!---->`;
            Content($$payload4, {
              class: "flex flex-col mt-24 fixed bottom-0 left-0 right-0",
              children: ($$payload5) => {
                $$payload5.out += `<div class="bg-base-300 h-fit min-h-32 rounded-t-xl px-4 py-8">`;
                if (title) {
                  $$payload5.out += "<!--[-->";
                  $$payload5.out += `<!---->`;
                  Title($$payload5, {
                    children: ($$payload6) => {
                      $$payload6.out += `<!---->${escape_html(title)}`;
                    },
                    $$slots: { default: true }
                  });
                  $$payload5.out += `<!---->`;
                } else {
                  $$payload5.out += "<!--[!-->";
                }
                $$payload5.out += `<!--]--> `;
                if (description) {
                  $$payload5.out += "<!--[-->";
                  $$payload5.out += `<!---->`;
                  Description($$payload5, {
                    children: ($$payload6) => {
                      $$payload6.out += `<!---->${escape_html(description)}`;
                    },
                    $$slots: { default: true }
                  });
                  $$payload5.out += `<!---->`;
                } else {
                  $$payload5.out += "<!--[!-->";
                }
                $$payload5.out += `<!--]--> `;
                children($$payload5);
                $$payload5.out += `<!----></div>`;
              },
              $$slots: { default: true }
            });
            $$payload4.out += `<!---->`;
          },
          $$slots: { default: true }
        });
        $$payload3.out += `<!---->`;
      },
      $$slots: { default: true }
    });
    $$payload2.out += `<!---->`;
  }
  do {
    $$settled = true;
    $$inner_payload = copy_payload($$payload);
    $$render_inner($$inner_payload);
  } while (!$$settled);
  assign_payload($$payload, $$inner_payload);
  bind_props($$props, { isDrawerOpen });
  pop();
}
function timestamp($$payload, ulid) {
  const decodedTime = decodeTime(ulid);
  const formattedDate = isToday(decodedTime) ? "Today" : format(decodedTime, "P");
  $$payload.out += `<time class="text-xs">${escape_html(formattedDate)}, ${escape_html(format(decodedTime, "pp"))}</time>`;
}
function ChatMessage($$payload, $$props) {
  push();
  let { id, message } = $$props;
  let space = getContext("space");
  let reactionHandles = Object.fromEntries(Object.entries(message.reactions).map(([reaction, dids]) => [
    reaction,
    dids.map((did) => getProfile(did).handle)
  ]));
  let isMobile = (outerWidth.current ?? 0) < 640;
  let isDrawerOpen = false;
  let isSelected = false;
  let isThreading = getContext("isThreading");
  let isEmojiDrawerPickerOpen = false;
  let isEmojiToolbarPickerOpen = false;
  let isEmojiRowPickerOpen = false;
  const isAdmin = getContext("isAdmin");
  let mayDelete = !isAnnouncement(message) && (isAdmin.value || user.agent?.did == message.author);
  const selectMessage = getContext("selectMessage");
  const deleteMessage = getContext("deleteMessage");
  const removeSelectedMessage = getContext("removeSelectedMessage");
  const setReplyTo = getContext("setReplyTo");
  const toggleReaction = getContext("toggleReaction");
  const scrollToMessage = getContext("scrollToMessage");
  function updateSelect() {
    if (isSelected) {
      selectMessage(id);
    } else {
      removeSelectedMessage(id);
    }
  }
  function scrollToReply() {
    if (isAnnouncement(message) || !message.replyTo) {
      return;
    }
    scrollToMessage(message.replyTo);
  }
  function getAnnouncementHtml(announcement) {
    const schema = { "type": "doc", "content": [] };
    switch (announcement.kind) {
      case "threadCreated": {
        const relatedThread = space.value.view.threads[announcement.relatedThreads[0]];
        schema.content.push({
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "A new thread has been created: "
            },
            {
              "type": "channelThreadMention",
              "attrs": {
                "id": JSON.stringify({
                  "ulid": announcement.relatedThreads[0],
                  "space": page.params.space,
                  "type": "thread"
                }),
                "label": relatedThread.title
              }
            }
          ]
        });
        break;
      }
      case "messageMoved": {
        const relatedThread = space.value.view.threads[announcement.relatedThreads[0]];
        schema.content.push({
          "type": "paragraph",
          "content": [
            { "type": "text", "text": "Moved to: " },
            {
              "type": "channelThreadMention",
              "attrs": {
                "id": JSON.stringify({
                  "ulid": announcement.relatedThreads[0],
                  "space": page.params.space,
                  "type": "thread"
                }),
                "label": relatedThread.title
              }
            }
          ]
        });
        break;
      }
      case "messageDeleted": {
        schema.content.push({
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "This message has been deleted"
            }
          ]
        });
        break;
      }
    }
    return getContentHtml(JSON.stringify(schema));
  }
  function announcementView($$payload2) {
    const announcement = message;
    toolbar($$payload2);
    $$payload2.out += `<!----> <div class="flex flex-col gap-4">`;
    if (announcement.kind === "threadCreated") {
      $$payload2.out += "<!--[-->";
      $$payload2.out += `<!---->`;
      Button($$payload2, {
        onclick: () => {
          if (isMobile) {
            isDrawerOpen = true;
          }
        },
        class: "flex flex-col text-start gap-2 w-full min-w-0",
        children: ($$payload3) => {
          $$payload3.out += `<section class="flex items-center gap-2 flex-wrap w-fit">`;
          timestamp($$payload3, id);
          $$payload3.out += `<!----></section> <p class="text-sm italic prose-invert prose min-w-0 max-w-full overflow-hidden text-ellipsis">${html(getAnnouncementHtml(announcement))}</p>`;
        },
        $$slots: { default: true }
      });
      $$payload2.out += `<!---->`;
    } else if (announcement.kind === "messageMoved") {
      $$payload2.out += "<!--[1-->";
      const related = space.value.view.messages[announcement.relatedMessages[0]];
      $$payload2.out += `<!---->`;
      Button($$payload2, {
        onclick: () => {
          if (isMobile) {
            isDrawerOpen = true;
          }
        },
        class: "cursor-pointer flex gap-2 text-start w-full items-center text-info-content px-4 py-1 bg-info rounded-t",
        children: ($$payload3) => {
          Icon($$payload3, {
            icon: "prime:reply",
            width: "12px",
            height: "12px"
          });
          $$payload3.out += `<!----> <p class="text-sm italic prose-invert chat min-w-0 max-w-full overflow-hidden text-ellipsis">${html(getAnnouncementHtml(announcement))}</p> `;
          timestamp($$payload3, id);
          $$payload3.out += `<!---->`;
        },
        $$slots: { default: true }
      });
      $$payload2.out += `<!----> <div class="flex items-start gap-4">`;
      messageView($$payload2, announcement.relatedMessages[0], related);
      $$payload2.out += `<!----></div>`;
    } else {
      $$payload2.out += "<!--[!-->";
    }
    $$payload2.out += `<!--]--></div>`;
  }
  function messageView($$payload2, ulid, msg) {
    const authorProfile = getProfile(msg.author);
    toolbar($$payload2, authorProfile);
    $$payload2.out += `<!----> <div class="flex gap-4"><a${attr("href", `https://bsky.app/profile/${authorProfile.handle}`)} target="_blank">`;
    AvatarImage($$payload2, {
      handle: authorProfile.handle,
      avatarUrl: authorProfile.avatarUrl
    });
    $$payload2.out += `<!----></a> <!---->`;
    Button($$payload2, {
      onclick: () => {
        if (isMobile) {
          isDrawerOpen = true;
        }
      },
      class: "flex flex-col text-start gap-2 w-full min-w-0",
      children: ($$payload3) => {
        $$payload3.out += `<section class="flex items-center gap-2 flex-wrap w-fit"><a${attr("href", `https://bsky.app/profile/${authorProfile.handle}`)} target="_blank" class="text-primary hover:underline"><h5 class="font-bold">${escape_html(authorProfile.handle)}</h5></a> `;
        timestamp($$payload3, ulid);
        $$payload3.out += `<!----></section> <span class="prose select-text">${html(getContentHtml(msg.content))}</span> `;
        if (msg.images?.length) {
          $$payload3.out += "<!--[-->";
          const each_array = ensure_array_like(msg.images);
          $$payload3.out += `<div class="flex flex-wrap gap-2 mt-2"><!--[-->`;
          for (let $$index_1 = 0, $$length = each_array.length; $$index_1 < $$length; $$index_1++) {
            let image = each_array[$$index_1];
            $$payload3.out += `<img${attr("src", image.source)}${attr("alt", image.alt || "")} class="max-w-md max-h-64 rounded-lg object-cover" loading="lazy">`;
          }
          $$payload3.out += `<!--]--></div>`;
        } else {
          $$payload3.out += "<!--[!-->";
        }
        $$payload3.out += `<!--]-->`;
      },
      $$slots: { default: true }
    });
    $$payload2.out += `<!----></div>`;
  }
  function toolbar($$payload2, authorProfile) {
    if (isMobile) {
      $$payload2.out += "<!--[-->";
      Drawer_1($$payload2, {
        get isDrawerOpen() {
          return isDrawerOpen;
        },
        set isDrawerOpen($$value) {
          isDrawerOpen = $$value;
          $$settled = false;
        },
        children: ($$payload3) => {
          $$payload3.out += `<div class="flex gap-4 justify-center mb-4"><!---->`;
          Button($$payload3, {
            onclick: () => {
              toggleReaction(id, "\u{1F44D}");
              isDrawerOpen = false;
            },
            class: "btn btn-circle",
            children: ($$payload4) => {
              $$payload4.out += `<!---->\u{1F44D}`;
            },
            $$slots: { default: true }
          });
          $$payload3.out += `<!----> <!---->`;
          Button($$payload3, {
            onclick: () => {
              toggleReaction(id, "\u{1F602}");
              isDrawerOpen = false;
            },
            class: "btn btn-circle",
            children: ($$payload4) => {
              $$payload4.out += `<!---->\u{1F602}`;
            },
            $$slots: { default: true }
          });
          $$payload3.out += `<!----> <!---->`;
          Popover($$payload3, {
            get open() {
              return isEmojiDrawerPickerOpen;
            },
            set open($$value) {
              isEmojiDrawerPickerOpen = $$value;
              $$settled = false;
            },
            children: ($$payload4) => {
              $$payload4.out += `<!---->`;
              Popover_trigger($$payload4, {
                class: "btn btn-circle",
                children: ($$payload5) => {
                  Icon($$payload5, { icon: "lucide:smile-plus" });
                },
                $$slots: { default: true }
              });
              $$payload4.out += `<!----> <!---->`;
              Popover_content($$payload4, {
                children: ($$payload5) => {
                  $$payload5.out += `<emoji-picker></emoji-picker>`;
                },
                $$slots: { default: true }
              });
              $$payload4.out += `<!---->`;
            },
            $$slots: { default: true }
          });
          $$payload3.out += `<!----></div> `;
          if (authorProfile) {
            $$payload3.out += "<!--[-->";
            $$payload3.out += `<div class="join join-vertical w-full"><!---->`;
            Button($$payload3, {
              onclick: () => {
                setReplyTo({ id, authorProfile, content: message.content });
                isDrawerOpen = false;
              },
              class: "join-item btn w-full",
              children: ($$payload4) => {
                Icon($$payload4, { icon: "fa6-solid:reply" });
                $$payload4.out += `<!----> Reply`;
              },
              $$slots: { default: true }
            });
            $$payload3.out += `<!----> `;
            if (mayDelete) {
              $$payload3.out += "<!--[-->";
              $$payload3.out += `<!---->`;
              Button($$payload3, {
                onclick: () => deleteMessage(id),
                class: "join-item btn btn-error w-full",
                children: ($$payload4) => {
                  Icon($$payload4, { icon: "tabler:trash" });
                  $$payload4.out += `<!----> Delete`;
                },
                $$slots: { default: true }
              });
              $$payload3.out += `<!---->`;
            } else {
              $$payload3.out += "<!--[!-->";
            }
            $$payload3.out += `<!--]--></div>`;
          } else {
            $$payload3.out += "<!--[!-->";
          }
          $$payload3.out += `<!--]-->`;
        },
        $$slots: { default: true }
      });
    } else {
      $$payload2.out += "<!--[!-->";
      $$payload2.out += `<!---->`;
      Toolbar($$payload2, {
        class: `${!isEmojiToolbarPickerOpen && "hidden"} group-hover:flex absolute -top-2 right-0 bg-base-300 p-1 rounded items-center`,
        children: ($$payload3) => {
          $$payload3.out += `<!---->`;
          Toolbar_button($$payload3, {
            onclick: () => toggleReaction(id, "\u{1F44D}"),
            class: "btn btn-ghost btn-square",
            children: ($$payload4) => {
              $$payload4.out += `<!---->\u{1F44D}`;
            },
            $$slots: { default: true }
          });
          $$payload3.out += `<!----> <!---->`;
          Toolbar_button($$payload3, {
            onclick: () => toggleReaction(id, "\u{1F602}"),
            class: "btn btn-ghost btn-square",
            children: ($$payload4) => {
              $$payload4.out += `<!---->\u{1F602}`;
            },
            $$slots: { default: true }
          });
          $$payload3.out += `<!----> <!---->`;
          Popover($$payload3, {
            get open() {
              return isEmojiToolbarPickerOpen;
            },
            set open($$value) {
              isEmojiToolbarPickerOpen = $$value;
              $$settled = false;
            },
            children: ($$payload4) => {
              $$payload4.out += `<!---->`;
              Popover_trigger($$payload4, {
                class: "btn btn-ghost btn-square",
                children: ($$payload5) => {
                  Icon($$payload5, { icon: "lucide:smile-plus" });
                },
                $$slots: { default: true }
              });
              $$payload4.out += `<!----> <!---->`;
              Popover_content($$payload4, {
                children: ($$payload5) => {
                  $$payload5.out += `<emoji-picker></emoji-picker>`;
                },
                $$slots: { default: true }
              });
              $$payload4.out += `<!---->`;
            },
            $$slots: { default: true }
          });
          $$payload3.out += `<!----> `;
          {
            $$payload3.out += "<!--[!-->";
          }
          $$payload3.out += `<!--]--> `;
          if (authorProfile) {
            $$payload3.out += "<!--[-->";
            $$payload3.out += `<!---->`;
            Toolbar_button($$payload3, {
              onclick: () => setReplyTo({ id, authorProfile, content: message.content }),
              class: "btn btn-ghost btn-square",
              children: ($$payload4) => {
                Icon($$payload4, { icon: "fa6-solid:reply" });
              },
              $$slots: { default: true }
            });
            $$payload3.out += `<!---->`;
          } else {
            $$payload3.out += "<!--[!-->";
          }
          $$payload3.out += `<!--]-->`;
        },
        $$slots: { default: true }
      });
      $$payload2.out += `<!---->`;
    }
    $$payload2.out += `<!--]--> `;
    if (isThreading.value && !isAnnouncement(message)) {
      $$payload2.out += "<!--[-->";
      $$payload2.out += `<!---->`;
      {
        let children = function($$payload3, { checked }) {
          $$payload3.out += `<div class="border border-primary bg-base-100 text-primary-content size-4 rounded items-center cursor-pointer">`;
          if (checked) {
            $$payload3.out += "<!--[-->";
            Icon($$payload3, {
              icon: "material-symbols:check-rounded",
              class: "bg-primary size-3.5"
            });
          } else {
            $$payload3.out += "<!--[!-->";
          }
          $$payload3.out += `<!--]--></div>`;
        };
        Checkbox($$payload2, {
          onCheckedChange: updateSelect,
          class: "absolute right-4 inset-y-0",
          get checked() {
            return isSelected;
          },
          set checked($$value) {
            isSelected = $$value;
            $$settled = false;
          },
          children,
          $$slots: { default: true }
        });
      }
      $$payload2.out += `<!---->`;
    } else {
      $$payload2.out += "<!--[!-->";
    }
    $$payload2.out += `<!--]-->`;
  }
  function reactionToggle($$payload2, reaction) {
    $$payload2.out += `<!---->`;
    Button($$payload2, {
      onclick: () => toggleReaction(id, reaction),
      class: `
      btn
      ${"bg-secondary text-secondary-content"}
    `,
      title: (reactionHandles[reaction] || []).join(", "),
      children: ($$payload3) => {
        $$payload3.out += `<!---->${escape_html(reaction)}
    ${escape_html(message.reactions[reaction].length)}`;
      },
      $$slots: { default: true }
    });
    $$payload2.out += `<!---->`;
  }
  function replyBanner($$payload2) {
    const messageRepliedTo = !isAnnouncement(message) && message.replyTo && space.value.view.messages[message.replyTo];
    const profileRepliedTo = messageRepliedTo && getProfile(messageRepliedTo.author);
    if (messageRepliedTo && profileRepliedTo) {
      $$payload2.out += "<!--[-->";
      $$payload2.out += `<!---->`;
      Button($$payload2, {
        onclick: scrollToReply,
        class: "cursor-pointer flex gap-2 text-sm text-start w-full items-center text-secondary-content px-4 py-1 bg-secondary rounded-t",
        children: ($$payload3) => {
          $$payload3.out += `<div class="flex basis-1/2 md:basis-auto gap-2 items-center">`;
          Icon($$payload3, {
            icon: "prime:reply",
            width: "12px",
            height: "12px"
          });
          $$payload3.out += `<!----> <!---->`;
          Avatar($$payload3, {
            class: "w-4",
            children: ($$payload4) => {
              $$payload4.out += `<!---->`;
              Avatar_image($$payload4, {
                src: profileRepliedTo.avatarUrl,
                class: "rounded-full"
              });
              $$payload4.out += `<!----> <!---->`;
              Avatar_fallback($$payload4, {
                children: ($$payload5) => {
                  AvatarBeam($$payload5, { name: profileRepliedTo.handle });
                },
                $$slots: { default: true }
              });
              $$payload4.out += `<!---->`;
            },
            $$slots: { default: true }
          });
          $$payload3.out += `<!----> <h5 class="text-secondary-content font-medium text-ellipsis">${escape_html(profileRepliedTo.handle)}</h5></div> <p class="line-clamp-1 basis-1/2 md:basis-auto overflow-hidden italic">${html(getContentHtml(messageRepliedTo.content))}</p>`;
        },
        $$slots: { default: true }
      });
      $$payload2.out += `<!---->`;
    } else {
      $$payload2.out += "<!--[!-->";
    }
    $$payload2.out += `<!--]-->`;
  }
  let $$settled = true;
  let $$inner_payload;
  function $$render_inner($$payload2) {
    $$payload2.out += `<li${attr("id", id)}${attr_class(`flex flex-col ${isMobile && "max-w-screen"}`)}><div class="relative group w-full h-fit flex flex-col gap-4 px-2 py-2.5 hover:bg-white/5 transition-all duration-75">`;
    if (isAnnouncement(message)) {
      $$payload2.out += "<!--[-->";
      announcementView($$payload2);
    } else {
      $$payload2.out += "<!--[!-->";
      replyBanner($$payload2);
      $$payload2.out += `<!----> `;
      messageView($$payload2, id, message);
      $$payload2.out += `<!---->`;
    }
    $$payload2.out += `<!--]--> `;
    if (Object.keys(message.reactions).length > 0) {
      $$payload2.out += "<!--[-->";
      const each_array_1 = ensure_array_like(Object.keys(message.reactions));
      $$payload2.out += `<div class="flex gap-2 flex-wrap"><!--[-->`;
      for (let $$index = 0, $$length = each_array_1.length; $$index < $$length; $$index++) {
        let reaction = each_array_1[$$index];
        reactionToggle($$payload2, reaction);
      }
      $$payload2.out += `<!--]--> <!---->`;
      Popover($$payload2, {
        get open() {
          return isEmojiRowPickerOpen;
        },
        set open($$value) {
          isEmojiRowPickerOpen = $$value;
          $$settled = false;
        },
        children: ($$payload3) => {
          $$payload3.out += `<!---->`;
          Popover_trigger($$payload3, {
            class: "p-2 hover:bg-white/5 hover:scale-105 active:scale-95 transition-all duration-150 rounded cursor-pointer",
            children: ($$payload4) => {
              Icon($$payload4, { icon: "lucide:smile-plus", color: "white" });
            },
            $$slots: { default: true }
          });
          $$payload3.out += `<!----> <!---->`;
          Popover_content($$payload3, {
            children: ($$payload4) => {
              $$payload4.out += `<emoji-picker></emoji-picker>`;
            },
            $$slots: { default: true }
          });
          $$payload3.out += `<!---->`;
        },
        $$slots: { default: true }
      });
      $$payload2.out += `<!----></div>`;
    } else {
      $$payload2.out += "<!--[!-->";
    }
    $$payload2.out += `<!--]--></div></li>`;
  }
  do {
    $$settled = true;
    $$inner_payload = copy_payload($$payload);
    $$render_inner($$inner_payload);
  } while (!$$settled);
  assign_payload($$payload, $$inner_payload);
  pop();
}
const styleToString = (obj) => {
  return Object.keys(obj).reduce((acc, k) => {
    const value = obj[k];
    if (value == null) {
      return acc;
    }
    return acc + `${k}:${value};`;
  }, "");
};
const defaultGetKey = (_data, i2) => "_" + i2;
function* iterRange([start, end]) {
  for (let i2 = start; i2 <= end; i2++) {
    yield i2;
  }
}
const e = null, { min: t, max: o, abs: n, floor: r } = Math, s = (e2, n2, r2) => t(r2, o(n2, e2)), c = (e2) => [...e2].sort((e3, t2) => e3 - t2), i = "function" == typeof queueMicrotask ? queueMicrotask : (e2) => {
  Promise.resolve().then(e2);
}, l = (e2) => {
  let t2, o2;
  return () => (t2 || (t2 = true, o2 = e2()), o2);
}, f = -1, a = (e2, t2, o2) => {
  const n2 = o2 ? "unshift" : "push";
  for (let o3 = 0; o3 < t2; o3++) e2[n2](f);
  return e2;
}, u = (e2, t2) => {
  const o2 = e2.t[t2];
  return o2 === f ? e2.o : o2;
}, d = (e2, o2, n2) => {
  const r2 = e2.t[o2] === f;
  return e2.t[o2] = n2, e2.i = t(o2, e2.i), r2;
}, $ = (e2, t2) => {
  if (!e2.l) return 0;
  if (e2.i >= t2) return e2.u[t2];
  e2.i < 0 && (e2.u[0] = 0, e2.i = 0);
  let o2 = e2.i, n2 = e2.u[o2];
  for (; o2 < t2; ) n2 += u(e2, o2), e2.u[++o2] = n2;
  return e2.i = t2, n2;
}, h = (e2, t2, o2 = 0, n2 = e2.l - 1) => {
  for (; o2 <= n2; ) {
    const s2 = r((o2 + n2) / 2), c2 = $(e2, s2);
    if (c2 <= t2) {
      if (c2 + u(e2, s2) > t2) return s2;
      o2 = s2 + 1;
    } else n2 = s2 - 1;
  }
  return s(o2, 0, e2.l - 1);
}, p = (e2, o2, n2) => {
  const r2 = o2 - e2.l;
  return e2.i = n2 ? -1 : t(o2 - 1, e2.i), e2.l = o2, r2 > 0 ? (a(e2.u, r2), a(e2.t, r2, n2), e2.o * r2) : (e2.u.splice(r2), (n2 ? e2.t.splice(0, -r2) : e2.t.splice(r2)).reduce((t2, o3) => t2 - (o3 === f ? e2.o : o3), 0));
}, m = "undefined" != typeof window, w = () => document.documentElement, b = /* @__PURE__ */ l(() => !!m && "rtl" === getComputedStyle(w()).direction), S = /* @__PURE__ */ l(() => /iP(hone|od|ad)/.test(navigator.userAgent)), I = /* @__PURE__ */ l(() => "scrollBehavior" in w().style), x = 1, _ = 4, T = 8, z = (e2) => o(e2.$getTotalSize(), e2.$getViewportSize()), R = (e2) => !!e2.$getViewportSize(), M = (r2, s2 = 40, i2 = 4, l2 = 0, m2, w2 = false) => {
  let g = !!l2, v = 1, b2 = 0, I2 = 0, y = 0, k = 0, x2 = 0, _2 = 0, T2 = 0, z2 = 0, R2 = g ? [0, o(l2 - 1, 0)] : e, M2 = [0, 0], J2 = 0;
  const P2 = ((e2, n2, r3) => ({ o: n2, t: r3 && r3[0] ? a(r3[0].slice(0, t(e2, r3[0].length)), o(0, e2 - r3[0].length)) : a([], e2), l: e2, i: -1, u: a([], e2) }))(r2, s2, m2), W2 = /* @__PURE__ */ new Set(), B2 = () => y - I2, L = () => B2() + x2 + k, O = (e2) => ((e3, o2, n2, r3) => {
    if (r3 = t(r3, e3.l - 1), $(e3, r3) <= o2) {
      const t2 = h(e3, o2 + n2, r3);
      return [h(e3, o2, r3, t2), t2];
    }
    {
      const t2 = h(e3, o2, void 0, r3);
      return [t2, h(e3, o2 + n2, t2)];
    }
  })(P2, e2, b2, M2[0]), q = () => ((e2) => e2.l ? $(e2, e2.l - 1) + u(e2, e2.l - 1) : 0)(P2), C = (e2) => $(P2, e2) - x2, U = (e2) => u(P2, e2), V = (e2) => {
    e2 && (S() && 0 !== T2 ? x2 += e2 : k += e2);
  };
  return { $getStateVersion: () => v, $getCacheSnapshot: () => ((e2) => [e2.t.slice(), e2.o])(P2), $getRange: () => {
    let e2, n2;
    return _2 ? [e2, n2] = M2 : ([e2, n2] = M2 = O(o(0, L())), R2 && (e2 = t(e2, R2[0]), n2 = o(n2, R2[1]))), 1 !== T2 && (e2 -= o(0, i2)), 2 !== T2 && (n2 += o(0, i2)), [o(e2, 0), t(n2, P2.l - 1)];
  }, $findStartIndex: () => h(P2, L()), $findEndIndex: () => h(P2, L() + b2), $isUnmeasuredItem: (e2) => P2.t[e2] === f, $: () => !!R2 && P2.t.slice(o(0, R2[0] - 1), t(P2.l - 1, R2[1] + 1) + 1).includes(f), $getItemOffset: C, $getItemSize: U, $getItemsLength: () => P2.l, $getScrollOffset: () => y, $isScrolling: () => 0 !== T2, $getViewportSize: () => b2, $getStartSpacerSize: () => I2, $getTotalSize: q, h: () => (_2 = k, k = 0, [_2, 2 === z2 || B2() + b2 >= q()]), $subscribe: (e2, t2) => {
    const o2 = [e2, t2];
    return W2.add(o2), () => {
      W2.delete(o2);
    };
  }, $update: (t2, r3) => {
    let s3, i3, l3 = 0;
    switch (t2) {
      case 1: {
        const t3 = _2;
        _2 = 0;
        const o2 = r3 - y, s4 = n(o2);
        t3 && s4 < n(t3) + 1 || 0 !== z2 || (T2 = o2 < 0 ? 2 : 1), g && (R2 = e, g = false), y = r3, l3 = 4;
        const c2 = B2();
        c2 >= -b2 && c2 <= q() && (l3 += 1, i3 = s4 > b2);
        break;
      }
      case 2:
        l3 = 8, 0 !== T2 && (s3 = true, l3 += 1), T2 = 0, z2 = 0, R2 = e;
        break;
      case 3: {
        const e2 = r3.filter(([e3, t3]) => P2.t[e3] !== t3);
        if (!e2.length) break;
        V(e2.reduce((e3, [t3, o2]) => ((2 === z2 || (R2 ? !g && t3 < R2[0] : C(t3) + (0 === T2 && 0 === z2 ? U(t3) : 0) < B2())) && (e3 += o2 - U(t3)), e3), 0));
        for (const [t3, o2] of e2) {
          const e3 = U(t3), n2 = d(P2, t3, o2);
          w2 && (J2 += n2 ? o2 : o2 - e3);
        }
        w2 && b2 && J2 > b2 && (V(((e3, t3) => {
          let n2 = 0;
          const r4 = [];
          e3.t.forEach((e4, o2) => {
            e4 !== f && (r4.push(e4), o2 < t3 && n2++);
          }), e3.i = -1;
          const s4 = c(r4), i4 = s4.length, l4 = i4 / 2 | 0, a2 = i4 % 2 == 0 ? (s4[l4 - 1] + s4[l4]) / 2 : s4[l4], u2 = e3.o;
          return ((e3.o = a2) - u2) * o(t3 - n2, 0);
        })(P2, h(P2, L()))), w2 = false), l3 = 3, i3 = true;
        break;
      }
      case 4:
        b2 !== r3 && (b2 = r3, l3 = 3);
        break;
      case 5:
        r3[1] ? (V(p(P2, r3[0], true)), z2 = 2, l3 = 1) : (p(P2, r3[0]), l3 = 1);
        break;
      case 6:
        I2 = r3;
        break;
      case 7:
        z2 = 1;
        break;
      case 8:
        R2 = O(r3), l3 = 1;
    }
    l3 && (v = 1 + (2147483647 & v), s3 && x2 && (k += x2, x2 = 0), W2.forEach(([e2, t3]) => {
      l3 & e2 && t3(i3);
    }));
  } };
}, J = setTimeout, P = (e2, t2) => t2 && b() ? -e2 : e2, W = (t2, o2, n2, r2, s2, c2) => {
  const i2 = Date.now;
  let l2 = 0, f2 = false, a2 = false, u2 = false, d2 = false;
  const $2 = (() => {
    let o3;
    const n3 = () => {
      o3 != e && clearTimeout(o3);
    }, r3 = () => {
      n3(), o3 = J(() => {
        o3 = e, (() => {
          if (f2 || a2) return f2 = false, void $2();
          u2 = false, t2.$update(2);
        })();
      }, 150);
    };
    return r3.p = n3, r3;
  })(), h2 = () => {
    l2 = i2(), u2 && (d2 = true), t2.$update(1, r2()), $2();
  }, p2 = (e2) => {
    if (f2 || !t2.$isScrolling() || e2.ctrlKey) return;
    const o3 = i2() - l2;
    150 > o3 && 50 < o3 && (n2 ? e2.deltaX : e2.deltaY) && (f2 = true);
  }, m2 = () => {
    a2 = true, u2 = d2 = false;
  }, w2 = () => {
    a2 = false, S() && (u2 = true);
  };
  return o2.addEventListener("scroll", h2), o2.addEventListener("wheel", p2, { passive: true }), o2.addEventListener("touchstart", m2, { passive: true }), o2.addEventListener("touchend", w2, { passive: true }), { m: () => {
    o2.removeEventListener("scroll", h2), o2.removeEventListener("wheel", p2), o2.removeEventListener("touchstart", m2), o2.removeEventListener("touchend", w2), $2.p();
  }, v: () => {
    const [e2, o3] = t2.h();
    e2 && (s2(P(e2, n2), o3, d2), d2 = false, o3 && t2.$getViewportSize() > t2.$getTotalSize() && t2.$update(1, r2()));
  } };
}, B = (e2, t2) => {
  let o2, n2, r2;
  const c2 = t2 ? "scrollLeft" : "scrollTop", l2 = t2 ? "overflowX" : "overflowY", f2 = async (n3, s2) => {
    if (!o2) return void i(() => f2(n3, s2));
    r2 && r2();
    const l3 = () => {
      let t3;
      return [new Promise((o3, n4) => {
        t3 = o3, r2 = n4, R(e2) && J(n4, 150);
      }), e2.$subscribe(2, () => {
        t3 && t3();
      })];
    };
    if (s2 && I()) {
      for (; e2.$update(8, n3()), e2.$(); ) {
        const [e3, t3] = l3();
        try {
          await e3;
        } catch (e4) {
          return;
        } finally {
          t3();
        }
      }
      o2.scrollTo({ [t2 ? "left" : "top"]: P(n3(), t2), behavior: "smooth" });
    } else for (; ; ) {
      const [r3, s3] = l3();
      try {
        o2[c2] = P(n3(), t2), e2.$update(7), await r3;
      } catch (e3) {
        return;
      } finally {
        s3();
      }
    }
  };
  return { $observe(s2) {
    o2 = s2, n2 = W(e2, s2, t2, () => P(s2[c2], t2), (t3, o3, n3) => {
      if (n3) {
        const e3 = s2.style, t4 = e3[l2];
        e3[l2] = "hidden", J(() => {
          e3[l2] = t4;
        });
      }
      o3 ? (s2[c2] = e2.$getScrollOffset() + t3, r2 && r2()) : s2[c2] += t3;
    });
  }, $dispose() {
    n2 && n2.m();
  }, $scrollTo(e3) {
    f2(() => e3);
  }, $scrollBy(t3) {
    t3 += e2.$getScrollOffset(), f2(() => t3);
  }, $scrollToIndex(t3, { align: o3, smooth: n3, offset: r3 = 0 } = {}) {
    if (t3 = s(t3, 0, e2.$getItemsLength() - 1), "nearest" === o3) {
      const n4 = e2.$getItemOffset(t3), r4 = e2.$getScrollOffset();
      if (n4 < r4) o3 = "start";
      else {
        if (!(n4 + e2.$getItemSize(t3) > r4 + e2.$getViewportSize())) return;
        o3 = "end";
      }
    }
    f2(() => r3 + e2.$getStartSpacerSize() + e2.$getItemOffset(t3) + ("end" === o3 ? e2.$getItemSize(t3) - e2.$getViewportSize() : "center" === o3 ? (e2.$getItemSize(t3) - e2.$getViewportSize()) / 2 : 0), n3);
  }, $fixScrollJump: () => {
    n2 && n2.v();
  } };
};
function ListItem($$payload, $$props) {
  push();
  let {
    children,
    item,
    as = "div",
    index,
    offset,
    hide,
    horizontal
  } = $$props;
  onDestroy(() => {
  });
  let style = (() => {
    const _style = {
      position: "absolute",
      [horizontal ? "height" : "width"]: "100%",
      [horizontal ? "top" : "left"]: "0px",
      [horizontal ? b() ? "right" : "left" : "top"]: offset + "px",
      visibility: hide ? "hidden" : "visible"
    };
    if (horizontal) {
      _style["display"] = "flex";
    }
    return styleToString(_style);
  })();
  element(
    $$payload,
    as,
    () => {
      $$payload.out += `${attr_style(style)}`;
    },
    () => {
      children($$payload, item, index);
      $$payload.out += `<!---->`;
    }
  );
  pop();
}
function Virtualizer($$payload, $$props) {
  push();
  let {
    data,
    getKey = defaultGetKey,
    as = "div",
    item: itemAs,
    scrollRef,
    overscan,
    itemSize,
    shift = false,
    horizontal = false,
    startMargin = 0,
    children,
    onscroll,
    onscrollend
  } = $$props;
  const store = M(data.length, itemSize, overscan, void 0, void 0, !itemSize);
  const scroller = B(store, horizontal);
  const unsubscribeStore = store.$subscribe(x, () => {
    stateVersion = store.$getStateVersion();
  });
  const unsubscribeOnScroll = store.$subscribe(_, () => {
    onscroll && onscroll(store.$getScrollOffset());
  });
  const unsubscribeOnScrollEnd = store.$subscribe(T, () => {
    onscrollend && onscrollend();
  });
  let stateVersion = store.$getStateVersion();
  let range = stateVersion && store.$getRange();
  let isScrolling = stateVersion && store.$isScrolling();
  let totalSize = stateVersion && store.$getTotalSize();
  onDestroy(() => {
    unsubscribeStore();
    unsubscribeOnScroll();
    unsubscribeOnScrollEnd();
    scroller.$dispose();
  });
  const getScrollOffset = store.$getScrollOffset;
  const getScrollSize = () => z(store);
  const getViewportSize = store.$getViewportSize;
  const findStartIndex = store.$findStartIndex;
  const findEndIndex = store.$findEndIndex;
  const getItemOffset = store.$getItemOffset;
  const getItemSize = store.$getItemSize;
  const scrollToIndex = scroller.$scrollToIndex;
  const scrollTo = scroller.$scrollTo;
  const scrollBy = scroller.$scrollBy;
  let containerStyle = styleToString({
    // contain: "content",
    "overflow-anchor": "none",
    // opt out browser's scroll anchoring because it will conflict to scroll anchoring of virtualizer
    flex: "none",
    // flex style can break layout
    position: "relative",
    visibility: "hidden",
    // TODO replace with other optimization methods
    width: horizontal ? totalSize + "px" : "100%",
    height: horizontal ? "100%" : totalSize + "px",
    "pointer-events": isScrolling ? "none" : void 0
  });
  element(
    $$payload,
    as,
    () => {
      $$payload.out += `${attr_style(containerStyle)}`;
    },
    () => {
      const each_array = ensure_array_like(iterRange(range));
      $$payload.out += `<!--[-->`;
      for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
        let index = each_array[$$index];
        const item = data[index];
        ListItem($$payload, {
          children,
          item,
          index,
          as: itemAs,
          offset: stateVersion && store.$getItemOffset(index),
          hide: stateVersion && store.$isUnmeasuredItem(index),
          horizontal
        });
      }
      $$payload.out += `<!--]-->`;
    }
  );
  bind_props($$props, {
    getScrollOffset,
    getScrollSize,
    getViewportSize,
    findStartIndex,
    findEndIndex,
    getItemOffset,
    getItemSize,
    scrollToIndex,
    scrollTo,
    scrollBy
  });
  pop();
}
function ChatArea($$payload, $$props) {
  push();
  let { source, timeline } = $$props;
  let messages = source.type == "dm" ? source.channel.view.messages : source.space.view.messages;
  setContext("scrollToMessage", (id) => {
    const idx = timeline.indexOf(id);
    if (idx !== -1 && virtualizer) virtualizer.scrollToIndex(idx, { smooth: true });
  });
  let viewport = null;
  let virtualizer = void 0;
  let $$settled = true;
  let $$inner_payload;
  function $$render_inner($$payload2) {
    $$payload2.out += `<!---->`;
    Scroll_area($$payload2, {
      type: "scroll",
      class: "h-full overflow-hidden relative",
      children: ($$payload3) => {
        $$payload3.out += `<!---->`;
        Scroll_area_viewport($$payload3, {
          class: "w-full max-w-full h-full",
          get ref() {
            return viewport;
          },
          set ref($$value) {
            viewport = $$value;
            $$settled = false;
          },
          children: ($$payload4) => {
            $$payload4.out += `<ol class="flex flex-col gap-4 max-w-full"><!---->`;
            {
              {
                let children = function($$payload5, id, _index) {
                  const message = messages[id];
                  if (message && !message.softDeleted) {
                    $$payload5.out += "<!--[-->";
                    ChatMessage($$payload5, { id, message });
                  } else {
                    $$payload5.out += "<!--[!-->";
                    $$payload5.out += `<p class="italic text-error text-sm">This message has been deleted</p>`;
                  }
                  $$payload5.out += `<!--]-->`;
                };
                Virtualizer($$payload4, {
                  data: timeline || [],
                  getKey: (k, _2) => k,
                  scrollRef: viewport,
                  children,
                  $$slots: { default: true }
                });
              }
            }
            $$payload4.out += `<!----></ol>`;
          },
          $$slots: { default: true }
        });
        $$payload3.out += `<!----> <!---->`;
        Scroll_area_scrollbar($$payload3, {
          orientation: "vertical",
          class: "flex h-full w-2.5 touch-none select-none rounded-full border-l border-l-transparent p-px transition-all hover:w-3 hover:bg-dark-10 mr-1",
          children: ($$payload4) => {
            $$payload4.out += `<!---->`;
            Scroll_area_thumb($$payload4, {
              class: "relative flex-1 rounded-full bg-base-300 transition-opacity"
            });
            $$payload4.out += `<!---->`;
          },
          $$slots: { default: true }
        });
        $$payload3.out += `<!----> <!---->`;
        Scroll_area_corner($$payload3, {});
        $$payload3.out += `<!---->`;
      },
      $$slots: { default: true }
    });
    $$payload2.out += `<!---->`;
  }
  do {
    $$settled = true;
    $$inner_payload = copy_payload($$payload);
    $$render_inner($$inner_payload);
  } while (!$$settled);
  assign_payload($$payload, $$inner_payload);
  pop();
}
function ChatInput($$payload, $$props) {
  push();
  let { content = {}, users, context, onEnter } = $$props;
  [
    StarterKit.configure({ heading: false }),
    Placeholder.configure({ placeholder: "Write something ..." }),
    initKeyboardShortcutHandler({ onEnter }),
    initUserMention({ users }),
    initSpaceContextMention({ context })
  ];
  onDestroy(() => {
  });
  $$payload.out += `<div></div>`;
  bind_props($$props, { content });
  pop();
}
export {
  ChatArea as C,
  Popover as P,
  Popover_trigger as a,
  Popover_content as b,
  ChatInput as c,
  getContentHtml as g
};

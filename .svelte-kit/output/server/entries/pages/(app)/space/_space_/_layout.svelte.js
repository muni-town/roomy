import { A as once, w as push, G as spread_attributes, E as bind_props, y as pop, x as setContext, B as copy_payload, C as assign_payload, O as attr_class, z as escape_html, S as clsx, I as ensure_array_like } from "../../../../../chunks/index.js";
import { I as Icon } from "../../../../../chunks/Icon.js";
import { ulid } from "ulidx";
import { p as page } from "../../../../../chunks/index2.js";
import { g } from "../../../../../chunks/global.svelte.js";
import { g as goto } from "../../../../../chunks/client.js";
import { o as outerWidth, i as isAnnouncement, g as getProfile } from "../../../../../chunks/profile.svelte.js";
import { C as Context, u as useRefById, S as SPACE, E as ENTER, w as watch, q as useRovingFocus, h as getDataDisabled, r as getDataOrientation, i as getDataOpenClosed, s as getAriaDisabled, j as getAriaExpanded, a as afterTick, m as useId, b as box, n as noop, o as mergeProps, t as Presence_layer, B as Button, p as user } from "../../../../../chunks/button.js";
import { T as Toggle_group, a as Toggle_group_item } from "../../../../../chunks/toggle-group-item.js";
const ACCORDION_ROOT_ATTR = "data-accordion-root";
const ACCORDION_TRIGGER_ATTR = "data-accordion-trigger";
const ACCORDION_CONTENT_ATTR = "data-accordion-content";
const ACCORDION_ITEM_ATTR = "data-accordion-item";
const ACCORDION_HEADER_ATTR = "data-accordion-header";
class AccordionBaseState {
  opts;
  rovingFocusGroup;
  constructor(opts) {
    this.opts = opts;
    useRefById(this.opts);
    this.rovingFocusGroup = useRovingFocus({
      rootNodeId: this.opts.id,
      candidateAttr: ACCORDION_TRIGGER_ATTR,
      loop: this.opts.loop,
      orientation: this.opts.orientation
    });
  }
  #props = once(() => ({
    id: this.opts.id.current,
    "data-orientation": getDataOrientation(this.opts.orientation.current),
    "data-disabled": getDataDisabled(this.opts.disabled.current),
    [ACCORDION_ROOT_ATTR]: ""
  }));
  get props() {
    return this.#props();
  }
}
class AccordionSingleState extends AccordionBaseState {
  opts;
  isMulti = false;
  constructor(opts) {
    super(opts);
    this.opts = opts;
    this.includesItem = this.includesItem.bind(this);
    this.toggleItem = this.toggleItem.bind(this);
  }
  includesItem(item) {
    return this.opts.value.current === item;
  }
  toggleItem(item) {
    this.opts.value.current = this.includesItem(item) ? "" : item;
  }
}
class AccordionMultiState extends AccordionBaseState {
  #value;
  isMulti = true;
  constructor(props) {
    super(props);
    this.#value = props.value;
    this.includesItem = this.includesItem.bind(this);
    this.toggleItem = this.toggleItem.bind(this);
  }
  includesItem(item) {
    return this.#value.current.includes(item);
  }
  toggleItem(item) {
    if (this.includesItem(item)) {
      this.#value.current = this.#value.current.filter((v) => v !== item);
    } else {
      this.#value.current = [...this.#value.current, item];
    }
  }
}
class AccordionItemState {
  opts;
  root;
  #isActive = once(() => this.root.includesItem(this.opts.value.current));
  get isActive() {
    return this.#isActive();
  }
  #isDisabled = once(() => this.opts.disabled.current || this.root.opts.disabled.current);
  get isDisabled() {
    return this.#isDisabled();
  }
  constructor(opts) {
    this.opts = opts;
    this.root = opts.rootState;
    this.updateValue = this.updateValue.bind(this);
    useRefById({ ...opts, deps: () => this.isActive });
  }
  updateValue() {
    this.root.toggleItem(this.opts.value.current);
  }
  #props = once(() => ({
    id: this.opts.id.current,
    "data-state": getDataOpenClosed(this.isActive),
    "data-disabled": getDataDisabled(this.isDisabled),
    "data-orientation": getDataOrientation(this.root.opts.orientation.current),
    [ACCORDION_ITEM_ATTR]: ""
  }));
  get props() {
    return this.#props();
  }
}
class AccordionTriggerState {
  opts;
  itemState;
  #root;
  #isDisabled = once(() => this.opts.disabled.current || this.itemState.opts.disabled.current || this.#root.opts.disabled.current);
  constructor(opts, itemState) {
    this.opts = opts;
    this.itemState = itemState;
    this.#root = itemState.root;
    this.onkeydown = this.onkeydown.bind(this);
    this.onclick = this.onclick.bind(this);
    useRefById(opts);
  }
  onclick(e) {
    if (this.#isDisabled()) return;
    if (e.button !== 0) return e.preventDefault();
    this.itemState.updateValue();
  }
  onkeydown(e) {
    if (this.#isDisabled()) return;
    if (e.key === SPACE || e.key === ENTER) {
      e.preventDefault();
      this.itemState.updateValue();
      return;
    }
    this.#root.rovingFocusGroup.handleKeydown(this.opts.ref.current, e);
  }
  #props = once(() => ({
    id: this.opts.id.current,
    disabled: this.#isDisabled(),
    "aria-expanded": getAriaExpanded(this.itemState.isActive),
    "aria-disabled": getAriaDisabled(this.#isDisabled()),
    "data-disabled": getDataDisabled(this.#isDisabled()),
    "data-state": getDataOpenClosed(this.itemState.isActive),
    "data-orientation": getDataOrientation(this.#root.opts.orientation.current),
    [ACCORDION_TRIGGER_ATTR]: "",
    tabindex: 0,
    //
    onclick: this.onclick,
    onkeydown: this.onkeydown
  }));
  get props() {
    return this.#props();
  }
}
class AccordionContentState {
  opts;
  item;
  #originalStyles = void 0;
  #isMountAnimationPrevented = false;
  #width = 0;
  #height = 0;
  #present = once(() => this.opts.forceMount.current || this.item.isActive);
  get present() {
    return this.#present();
  }
  constructor(opts, item) {
    this.opts = opts;
    this.item = item;
    this.item = item;
    this.#isMountAnimationPrevented = this.item.isActive;
    useRefById(opts);
    watch(
      [
        () => this.present,
        () => this.opts.ref.current
      ],
      ([_, node]) => {
        if (!node) return;
        afterTick(() => {
          if (!this.opts.ref.current) return;
          this.#originalStyles = this.#originalStyles || {
            transitionDuration: node.style.transitionDuration,
            animationName: node.style.animationName
          };
          node.style.transitionDuration = "0s";
          node.style.animationName = "none";
          const rect = node.getBoundingClientRect();
          this.#height = rect.height;
          this.#width = rect.width;
          if (!this.#isMountAnimationPrevented) {
            const { animationName, transitionDuration } = this.#originalStyles;
            node.style.transitionDuration = transitionDuration;
            node.style.animationName = animationName;
          }
        });
      }
    );
  }
  #snippetProps = once(() => ({ open: this.item.isActive }));
  get snippetProps() {
    return this.#snippetProps();
  }
  #props = once(() => ({
    id: this.opts.id.current,
    "data-state": getDataOpenClosed(this.item.isActive),
    "data-disabled": getDataDisabled(this.item.isDisabled),
    "data-orientation": getDataOrientation(this.item.root.opts.orientation.current),
    [ACCORDION_CONTENT_ATTR]: "",
    style: {
      "--bits-accordion-content-height": `${this.#height}px`,
      "--bits-accordion-content-width": `${this.#width}px`
    }
  }));
  get props() {
    return this.#props();
  }
}
class AccordionHeaderState {
  opts;
  item;
  constructor(opts, item) {
    this.opts = opts;
    this.item = item;
    useRefById(opts);
  }
  #props = once(() => ({
    id: this.opts.id.current,
    role: "heading",
    "aria-level": this.opts.level.current,
    "data-heading-level": this.opts.level.current,
    "data-state": getDataOpenClosed(this.item.isActive),
    "data-orientation": getDataOrientation(this.item.root.opts.orientation.current),
    [ACCORDION_HEADER_ATTR]: ""
  }));
  get props() {
    return this.#props();
  }
}
const AccordionRootContext = new Context("Accordion.Root");
const AccordionItemContext = new Context("Accordion.Item");
function useAccordionRoot(props) {
  const { type, ...rest } = props;
  const rootState = type === "single" ? new AccordionSingleState(rest) : new AccordionMultiState(rest);
  return AccordionRootContext.set(rootState);
}
function useAccordionItem(props) {
  const rootState = AccordionRootContext.get();
  return AccordionItemContext.set(new AccordionItemState({ ...props, rootState }));
}
function useAccordionTrigger(props) {
  return new AccordionTriggerState(props, AccordionItemContext.get());
}
function useAccordionContent(props) {
  return new AccordionContentState(props, AccordionItemContext.get());
}
function useAccordionHeader(props) {
  return new AccordionHeaderState(props, AccordionItemContext.get());
}
function Accordion($$payload, $$props) {
  push();
  let {
    disabled = false,
    children,
    child,
    type,
    value = void 0,
    ref = null,
    id = useId(),
    onValueChange = noop,
    loop = true,
    orientation = "vertical",
    $$slots,
    $$events,
    ...restProps
  } = $$props;
  value === void 0 && (value = type === "single" ? "" : []);
  const rootState = useAccordionRoot({
    type,
    value: box.with(() => value, (v) => {
      value = v;
      onValueChange(v);
    }),
    id: box.with(() => id),
    disabled: box.with(() => disabled),
    loop: box.with(() => loop),
    orientation: box.with(() => orientation),
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
  bind_props($$props, { value, ref });
  pop();
}
function Accordion_item($$payload, $$props) {
  push();
  let {
    id = useId(),
    disabled = false,
    value = useId(),
    children,
    child,
    ref = null,
    $$slots,
    $$events,
    ...restProps
  } = $$props;
  const itemState = useAccordionItem({
    value: box.with(() => value),
    disabled: box.with(() => disabled),
    id: box.with(() => id),
    ref: box.with(() => ref, (v) => ref = v)
  });
  const mergedProps = mergeProps(restProps, itemState.props);
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
function Accordion_header($$payload, $$props) {
  push();
  let {
    id = useId(),
    level = 2,
    children,
    child,
    ref = null,
    $$slots,
    $$events,
    ...restProps
  } = $$props;
  const headerState = useAccordionHeader({
    id: box.with(() => id),
    level: box.with(() => level),
    ref: box.with(() => ref, (v) => ref = v)
  });
  const mergedProps = mergeProps(restProps, headerState.props);
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
function Accordion_trigger($$payload, $$props) {
  push();
  let {
    disabled = false,
    ref = null,
    id = useId(),
    children,
    child,
    $$slots,
    $$events,
    ...restProps
  } = $$props;
  const triggerState = useAccordionTrigger({
    disabled: box.with(() => disabled),
    id: box.with(() => id),
    ref: box.with(() => ref, (v) => ref = v)
  });
  const mergedProps = mergeProps(restProps, triggerState.props);
  if (child) {
    $$payload.out += "<!--[-->";
    child($$payload, { props: mergedProps });
    $$payload.out += `<!---->`;
  } else {
    $$payload.out += "<!--[!-->";
    $$payload.out += `<button${spread_attributes({ type: "button", ...mergedProps }, null)}>`;
    children?.($$payload);
    $$payload.out += `<!----></button>`;
  }
  $$payload.out += `<!--]-->`;
  bind_props($$props, { ref });
  pop();
}
function Accordion_content($$payload, $$props) {
  push();
  let {
    child,
    ref = null,
    id = useId(),
    forceMount = false,
    children,
    $$slots,
    $$events,
    ...restProps
  } = $$props;
  const contentState = useAccordionContent({
    forceMount: box.with(() => forceMount),
    id: box.with(() => id),
    ref: box.with(() => ref, (v) => ref = v)
  });
  {
    let presence = function($$payload2, { present }) {
      const mergedProps = mergeProps(restProps, contentState.props, {
        hidden: forceMount ? void 0 : !present.current
      });
      if (child) {
        $$payload2.out += "<!--[-->";
        child($$payload2, {
          props: mergedProps,
          ...contentState.snippetProps
        });
        $$payload2.out += `<!---->`;
      } else {
        $$payload2.out += "<!--[!-->";
        $$payload2.out += `<div${spread_attributes({ ...mergedProps }, null)}>`;
        children?.($$payload2);
        $$payload2.out += `<!----></div>`;
      }
      $$payload2.out += `<!--]-->`;
    };
    Presence_layer($$payload, {
      forceMount: true,
      present: contentState.present,
      id,
      presence
    });
  }
  bind_props($$props, { ref });
  pop();
}
function _layout($$payload, $$props) {
  push();
  let { children } = $$props;
  let isMobile = (outerWidth.current || 0) < 640;
  let sidebarAccordionValues = ["channels", "threads"];
  let space = g.spaces[page.params.space];
  let users = () => {
    if (!space) {
      return [];
    }
    const result = /* @__PURE__ */ new Set();
    for (const message of Object.values(space.view.messages)) {
      if (!isAnnouncement(message)) {
        result.add(message.author);
      }
    }
    const items = result.values().toArray().map((author) => {
      const profile = getProfile(author);
      return {
        value: author,
        label: profile.handle,
        category: "user"
      };
    });
    return items;
  };
  let availableThreads = space ? Object.fromEntries(Object.entries(space.view.threads).filter(([ulid2, thread]) => !thread.softDeleted)) : {};
  let contextItems = (() => {
    if (!space) {
      return [];
    }
    const items = [];
    for (const thread of Object.values(space.view.threads)) {
      if (!thread.softDeleted) {
        items.push({
          value: JSON.stringify({
            ulid,
            space: page.params.space,
            type: "thread"
          }),
          label: thread.title,
          category: "thread"
        });
      }
    }
    items.push(...Object.values(space.view.channels).map((channel) => {
      return {
        value: JSON.stringify({
          ulid,
          space: page.params.space,
          type: "channel"
        }),
        label: channel.name,
        category: "channel"
      };
    }));
    return items;
  })();
  let isAdmin = space && user.agent;
  setContext("isAdmin", {
    get value() {
      return isAdmin;
    }
  });
  setContext("space", {
    get value() {
      return space;
    }
  });
  setContext("users", {
    get value() {
      return users();
    }
  });
  setContext("contextItems", {
    get value() {
      return contextItems;
    }
  });
  let currentItemId = "";
  function openSpace() {
    if (space) return;
    g.catalog?.change((doc) => {
      doc.spaces.push({ id: page.params.space, knownMembers: [] });
    });
  }
  function channelsSidebar($$payload2, space2) {
    const each_array = ensure_array_like(space2.view.sidebarItems);
    $$payload2.out += `<div class="flex flex-col gap-4"><!--[-->`;
    for (let $$index_2 = 0, $$length = each_array.length; $$index_2 < $$length; $$index_2++) {
      let item = each_array[$$index_2];
      if (item.type == "category") {
        $$payload2.out += "<!--[-->";
        const category = space2.view.categories[item.id];
        $$payload2.out += `<!---->`;
        Accordion($$payload2, {
          type: "single",
          value: category.name,
          children: ($$payload3) => {
            $$payload3.out += `<!---->`;
            Accordion_item($$payload3, {
              value: category.name,
              children: ($$payload4) => {
                $$payload4.out += `<!---->`;
                Accordion_header($$payload4, {
                  class: "flex justify-between",
                  children: ($$payload5) => {
                    $$payload5.out += `<!---->`;
                    Accordion_trigger($$payload5, {
                      class: "flex text-sm font-semibold gap-2 items-center cursor-pointer",
                      children: ($$payload6) => {
                        Icon($$payload6, { icon: "basil:folder-solid" });
                        $$payload6.out += `<!----> ${escape_html(category.name)}`;
                      },
                      $$slots: { default: true }
                    });
                    $$payload5.out += `<!----> `;
                    {
                      $$payload5.out += "<!--[!-->";
                    }
                    $$payload5.out += `<!--]-->`;
                  },
                  $$slots: { default: true }
                });
                $$payload4.out += `<!----> <!---->`;
                {
                  let child = function($$payload5, { props, open }) {
                    if (open) {
                      $$payload5.out += "<!--[-->";
                      const each_array_1 = ensure_array_like(category.channels);
                      $$payload5.out += `<div${spread_attributes({ ...props, class: "flex flex-col gap-4 py-2" }, null)}><!--[-->`;
                      for (let $$index_1 = 0, $$length2 = each_array_1.length; $$index_1 < $$length2; $$index_1++) {
                        let channelId = each_array_1[$$index_1];
                        const channel = space2.view.channels[channelId];
                        $$payload5.out += `<!---->`;
                        Toggle_group_item($$payload5, {
                          onclick: () => goto(`/space/${page.params.space}/${channelId}`),
                          value: channelId,
                          class: "w-full cursor-pointer px-1 btn btn-ghost justify-start border border-transparent data-[state=on]:border-primary data-[state=on]:text-primary",
                          children: ($$payload6) => {
                            $$payload6.out += `<h3 class="flex justify-start items-center gap-2 px-2">`;
                            Icon($$payload6, { icon: "basil:comment-solid" });
                            $$payload6.out += `<!----> ${escape_html(channel.name)}</h3>`;
                          },
                          $$slots: { default: true }
                        });
                        $$payload5.out += `<!---->`;
                      }
                      $$payload5.out += `<!--]--></div>`;
                    } else {
                      $$payload5.out += "<!--[!-->";
                    }
                    $$payload5.out += `<!--]-->`;
                  };
                  Accordion_content($$payload4, {
                    forceMount: true,
                    child,
                    $$slots: { child: true }
                  });
                }
                $$payload4.out += `<!---->`;
              },
              $$slots: { default: true }
            });
            $$payload3.out += `<!---->`;
          },
          $$slots: { default: true }
        });
        $$payload2.out += `<!---->`;
      } else {
        $$payload2.out += "<!--[!-->";
        const channel = space2.view.channels[item.id];
        $$payload2.out += `<!---->`;
        Toggle_group_item($$payload2, {
          onclick: () => goto(`/space/${page.params.space}/${item.id}`),
          value: item.id,
          class: "w-full cursor-pointer px-1 btn btn-ghost justify-start border border-transparent data-[state=on]:border-primary data-[state=on]:text-primary",
          children: ($$payload3) => {
            $$payload3.out += `<h3 class="flex justify-start items-center gap-2 px-2">`;
            Icon($$payload3, { icon: "basil:comment-solid" });
            $$payload3.out += `<!----> ${escape_html(channel.name)}</h3>`;
          },
          $$slots: { default: true }
        });
        $$payload2.out += `<!---->`;
      }
      $$payload2.out += `<!--]-->`;
    }
    $$payload2.out += `<!--]--></div>`;
  }
  function threadsSidebar($$payload2) {
    const each_array_2 = ensure_array_like(Object.entries(availableThreads));
    $$payload2.out += `<div class="flex flex-col gap-4"><!--[-->`;
    for (let $$index_3 = 0, $$length = each_array_2.length; $$index_3 < $$length; $$index_3++) {
      let [ulid2, thread] = each_array_2[$$index_3];
      $$payload2.out += `<!---->`;
      Toggle_group_item($$payload2, {
        onclick: () => goto(`/space/${page.params.space}/thread/${ulid2}`),
        value: ulid2,
        class: "w-full cursor-pointer px-1 btn btn-ghost justify-start border border-transparent data-[state=on]:border-primary data-[state=on]:text-primary",
        children: ($$payload3) => {
          $$payload3.out += `<h3 class="flex justify-start items-center gap-2 px-2">`;
          Icon($$payload3, { icon: "material-symbols:thread-unread-rounded" });
          $$payload3.out += `<!----> ${escape_html(thread.title)}</h3>`;
        },
        $$slots: { default: true }
      });
      $$payload2.out += `<!---->`;
    }
    $$payload2.out += `<!--]--></div>`;
  }
  let $$settled = true;
  let $$inner_payload;
  function $$render_inner($$payload2) {
    if (space) {
      $$payload2.out += "<!--[-->";
      $$payload2.out += `<nav${attr_class(clsx([
        !isMobile && "max-w-[16rem] border-r-2 border-base-200",
        "px-4 py-5 flex flex-col gap-4 w-full"
      ]))}><h1 class="text-2xl font-extrabold text-base-content text-ellipsis">${escape_html(space.view.name)}</h1> <div class="divider my-0"></div> `;
      {
        $$payload2.out += "<!--[!-->";
      }
      $$payload2.out += `<!--]--> <!---->`;
      Toggle_group($$payload2, {
        type: "single",
        get value() {
          return currentItemId;
        },
        set value($$value) {
          currentItemId = $$value;
          $$settled = false;
        },
        children: ($$payload3) => {
          $$payload3.out += `<!---->`;
          Accordion($$payload3, {
            type: "multiple",
            class: "flex flex-col gap-4",
            get value() {
              return sidebarAccordionValues;
            },
            set value($$value) {
              sidebarAccordionValues = $$value;
              $$settled = false;
            },
            children: ($$payload4) => {
              $$payload4.out += `<!---->`;
              Accordion_item($$payload4, {
                value: "channels",
                children: ($$payload5) => {
                  $$payload5.out += `<!---->`;
                  Accordion_header($$payload5, {
                    children: ($$payload6) => {
                      $$payload6.out += `<!---->`;
                      Accordion_trigger($$payload6, {
                        class: "cursor-pointer flex w-full items-center justify-between mb-2 uppercase text-xs font-medium text-base-content",
                        children: ($$payload7) => {
                          $$payload7.out += `<h3>Channels</h3> `;
                          Icon($$payload7, {
                            icon: "basil:caret-up-solid",
                            class: `size-4 transition-transform duration-150 ${sidebarAccordionValues.includes("channels") && "rotate-180"}`
                          });
                          $$payload7.out += `<!---->`;
                        },
                        $$slots: { default: true }
                      });
                      $$payload6.out += `<!---->`;
                    },
                    $$slots: { default: true }
                  });
                  $$payload5.out += `<!----> <!---->`;
                  {
                    let child = function($$payload6, { open }) {
                      if (open) {
                        $$payload6.out += "<!--[-->";
                        channelsSidebar($$payload6, space);
                      } else {
                        $$payload6.out += "<!--[!-->";
                      }
                      $$payload6.out += `<!--]-->`;
                    };
                    Accordion_content($$payload5, {
                      forceMount: true,
                      child,
                      $$slots: { child: true }
                    });
                  }
                  $$payload5.out += `<!---->`;
                },
                $$slots: { default: true }
              });
              $$payload4.out += `<!----> `;
              if (Object.keys(availableThreads).length > 0) {
                $$payload4.out += "<!--[-->";
                $$payload4.out += `<div class="divider my-0"></div> <!---->`;
                Accordion_item($$payload4, {
                  value: "threads",
                  children: ($$payload5) => {
                    $$payload5.out += `<!---->`;
                    Accordion_header($$payload5, {
                      children: ($$payload6) => {
                        $$payload6.out += `<!---->`;
                        Accordion_trigger($$payload6, {
                          class: "cursor-pointer flex w-full items-center justify-between mb-2 uppercase text-xs font-medium text-base-content",
                          children: ($$payload7) => {
                            $$payload7.out += `<h3>Threads</h3> `;
                            Icon($$payload7, {
                              icon: "basil:caret-up-solid",
                              class: `size-4 transition-transform duration-150 ${sidebarAccordionValues.includes("threads") && "rotate-180"}`
                            });
                            $$payload7.out += `<!---->`;
                          },
                          $$slots: { default: true }
                        });
                        $$payload6.out += `<!---->`;
                      },
                      $$slots: { default: true }
                    });
                    $$payload5.out += `<!----> <!---->`;
                    {
                      let child = function($$payload6, { open }) {
                        if (open) {
                          $$payload6.out += "<!--[-->";
                          threadsSidebar($$payload6);
                        } else {
                          $$payload6.out += "<!--[!-->";
                        }
                        $$payload6.out += `<!--]-->`;
                      };
                      Accordion_content($$payload5, { child, $$slots: { child: true } });
                    }
                    $$payload5.out += `<!---->`;
                  },
                  $$slots: { default: true }
                });
                $$payload4.out += `<!---->`;
              } else {
                $$payload4.out += "<!--[!-->";
              }
              $$payload4.out += `<!--]-->`;
            },
            $$slots: { default: true }
          });
          $$payload3.out += `<!---->`;
        },
        $$slots: { default: true }
      });
      $$payload2.out += `<!----></nav> `;
      if (!isMobile) {
        $$payload2.out += "<!--[-->";
        $$payload2.out += `<main class="flex flex-col gap-4 rounded-lg p-4 grow min-w-0 h-full overflow-clip bg-base-100">`;
        children($$payload2);
        $$payload2.out += `<!----></main>`;
      } else if (page.params.channel || page.params.thread) {
        $$payload2.out += "<!--[1-->";
        $$payload2.out += `<main class="absolute inset-0 flex flex-col gap-4 rounded-lg p-4 h-screen overflow-clip bg-base-100">`;
        children($$payload2);
        $$payload2.out += `<!----></main>`;
      } else {
        $$payload2.out += "<!--[!-->";
      }
      $$payload2.out += `<!--]-->`;
    } else {
      $$payload2.out += "<!--[!-->";
      $$payload2.out += `<div class="flex flex-col justify-center items-center w-full"><!---->`;
      Button($$payload2, {
        onclick: openSpace,
        class: "px-4 py-2 bg-white text-black rounded-lg  active:scale-95 transition-all duration-150 flex items-center justify-center gap-2 cursor-pointer",
        children: ($$payload3) => {
          $$payload3.out += `<!---->Join Space`;
        },
        $$slots: { default: true }
      });
      $$payload2.out += `<!----></div>`;
    }
    $$payload2.out += `<!--]-->`;
  }
  do {
    $$settled = true;
    $$inner_payload = copy_payload($$payload);
    $$render_inner($$inner_payload);
  } while (!$$settled);
  assign_payload($$payload, $$inner_payload);
  pop();
}
export {
  _layout as default
};

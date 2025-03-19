import { A as once, w as push, G as spread_attributes, E as bind_props, y as pop, T as getContext, x as setContext, B as copy_payload, C as assign_payload, O as attr_class, z as escape_html, K as attr, I as ensure_array_like } from "../../../../../../chunks/index.js";
import "underscore";
import { decodeTime } from "ulidx";
import { p as page } from "../../../../../../chunks/index2.js";
import { g as goto } from "../../../../../../chunks/client.js";
import { k as AvatarImage, h as Portal } from "../../../../../../chunks/Toaster.svelte_svelte_type_style_lang.js";
import "@atproto/oauth-client-browser";
import "@atproto/api";
import "@automerge/automerge-repo-storage-indexeddb";
import "@atproto/lexicon";
import "base32-encode";
import "base32-decode";
import { P as Popover, a as Popover_trigger, b as Popover_content, C as ChatArea, g as getContentHtml, c as ChatInput } from "../../../../../../chunks/ChatInput.js";
import { o as outerWidth } from "../../../../../../chunks/profile.svelte.js";
import { I as Icon, h as html } from "../../../../../../chunks/Icon.js";
import { D as Dialog_1 } from "../../../../../../chunks/Dialog.js";
import { isToday, format } from "date-fns";
import { C as Context, y as SvelteMap, u as useRefById, q as useRovingFocus, w as watch, S as SPACE, E as ENTER, r as getDataOrientation, h as getDataDisabled, z as getAriaOrientation, c as getDisabled, D as getAriaSelected, m as useId, b as box, n as noop, o as mergeProps, B as Button } from "../../../../../../chunks/button.js";
const TABS_ROOT_ATTR = "data-tabs-root";
const TABS_LIST_ATTR = "data-tabs-list";
const TABS_TRIGGER_ATTR = "data-tabs-trigger";
class TabsRootState {
  opts;
  rovingFocusGroup;
  triggerIds = [];
  // holds the trigger ID for each value to associate it with the content
  valueToTriggerId = new SvelteMap();
  // holds the content ID for each value to associate it with the trigger
  valueToContentId = new SvelteMap();
  constructor(opts) {
    this.opts = opts;
    useRefById(opts);
    this.rovingFocusGroup = useRovingFocus({
      candidateAttr: TABS_TRIGGER_ATTR,
      rootNodeId: this.opts.id,
      loop: this.opts.loop,
      orientation: this.opts.orientation
    });
  }
  registerTrigger(id, value) {
    this.triggerIds.push(id);
    this.valueToTriggerId.set(value, id);
    return () => {
      this.triggerIds = this.triggerIds.filter((triggerId) => triggerId !== id);
      this.valueToTriggerId.delete(value);
    };
  }
  registerContent(id, value) {
    this.valueToContentId.set(value, id);
    return () => {
      this.valueToContentId.delete(value);
    };
  }
  setValue(v) {
    this.opts.value.current = v;
  }
  #props = once(() => ({
    id: this.opts.id.current,
    "data-orientation": getDataOrientation(this.opts.orientation.current),
    [TABS_ROOT_ATTR]: ""
  }));
  get props() {
    return this.#props();
  }
}
class TabsListState {
  opts;
  root;
  #isDisabled = once(() => this.root.opts.disabled.current);
  constructor(opts, root) {
    this.opts = opts;
    this.root = root;
    useRefById(opts);
  }
  #props = once(() => ({
    id: this.opts.id.current,
    role: "tablist",
    "aria-orientation": getAriaOrientation(this.root.opts.orientation.current),
    "data-orientation": getDataOrientation(this.root.opts.orientation.current),
    [TABS_LIST_ATTR]: "",
    "data-disabled": getDataDisabled(this.#isDisabled())
  }));
  get props() {
    return this.#props();
  }
}
class TabsTriggerState {
  opts;
  root;
  #isActive = once(() => this.root.opts.value.current === this.opts.value.current);
  #isDisabled = once(() => this.opts.disabled.current || this.root.opts.disabled.current);
  #tabIndex = 0;
  #ariaControls = once(() => this.root.valueToContentId.get(this.opts.value.current));
  constructor(opts, root) {
    this.opts = opts;
    this.root = root;
    useRefById(opts);
    watch(
      [
        () => this.opts.id.current,
        () => this.opts.value.current
      ],
      ([id, value]) => {
        return this.root.registerTrigger(id, value);
      }
    );
    this.onfocus = this.onfocus.bind(this);
    this.onclick = this.onclick.bind(this);
    this.onkeydown = this.onkeydown.bind(this);
  }
  #activate() {
    if (this.root.opts.value.current === this.opts.value.current) return;
    this.root.setValue(this.opts.value.current);
  }
  onfocus(_) {
    if (this.root.opts.activationMode.current !== "automatic" || this.#isDisabled()) return;
    this.#activate();
  }
  onclick(_) {
    if (this.#isDisabled()) return;
    this.#activate();
  }
  onkeydown(e) {
    if (this.#isDisabled()) return;
    if (e.key === SPACE || e.key === ENTER) {
      e.preventDefault();
      this.#activate();
      return;
    }
    this.root.rovingFocusGroup.handleKeydown(this.opts.ref.current, e);
  }
  #props = once(() => ({
    id: this.opts.id.current,
    role: "tab",
    "data-state": getTabDataState(this.#isActive()),
    "data-value": this.opts.value.current,
    "data-orientation": getDataOrientation(this.root.opts.orientation.current),
    "data-disabled": getDataDisabled(this.#isDisabled()),
    "aria-selected": getAriaSelected(this.#isActive()),
    "aria-controls": this.#ariaControls(),
    [TABS_TRIGGER_ATTR]: "",
    disabled: getDisabled(this.#isDisabled()),
    tabindex: this.#tabIndex,
    //
    onclick: this.onclick,
    onfocus: this.onfocus,
    onkeydown: this.onkeydown
  }));
  get props() {
    return this.#props();
  }
}
const TabsRootContext = new Context("Tabs.Root");
function useTabsRoot(props) {
  return TabsRootContext.set(new TabsRootState(props));
}
function useTabsTrigger(props) {
  return new TabsTriggerState(props, TabsRootContext.get());
}
function useTabsList(props) {
  return new TabsListState(props, TabsRootContext.get());
}
function getTabDataState(condition) {
  return condition ? "active" : "inactive";
}
function Tabs($$payload, $$props) {
  push();
  let {
    id = useId(),
    ref = null,
    value = "",
    onValueChange = noop,
    orientation = "horizontal",
    loop = true,
    activationMode = "automatic",
    disabled = false,
    children,
    child,
    $$slots,
    $$events,
    ...restProps
  } = $$props;
  const rootState = useTabsRoot({
    id: box.with(() => id),
    value: box.with(() => value, (v) => {
      value = v;
      onValueChange(v);
    }),
    orientation: box.with(() => orientation),
    loop: box.with(() => loop),
    activationMode: box.with(() => activationMode),
    disabled: box.with(() => disabled),
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
function Tabs_list($$payload, $$props) {
  push();
  let {
    child,
    children,
    id = useId(),
    ref = null,
    $$slots,
    $$events,
    ...restProps
  } = $$props;
  const listState = useTabsList({
    id: box.with(() => id),
    ref: box.with(() => ref, (v) => ref = v)
  });
  const mergedProps = mergeProps(restProps, listState.props);
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
function Tabs_trigger($$payload, $$props) {
  push();
  let {
    child,
    children,
    disabled = false,
    id = useId(),
    type = "button",
    value,
    ref = null,
    $$slots,
    $$events,
    ...restProps
  } = $$props;
  const triggerState = useTabsTrigger({
    id: box.with(() => id),
    disabled: box.with(() => disabled ?? false),
    value: box.with(() => value),
    ref: box.with(() => ref, (v) => ref = v)
  });
  const mergedProps = mergeProps(restProps, triggerState.props, { type });
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
function timestamp($$payload, ulid) {
  const decodedTime = decodeTime(ulid);
  const formattedDate = isToday(decodedTime) ? "Today" : format(decodedTime, "P");
  $$payload.out += `<time class="text-xs">${escape_html(formattedDate)}, ${escape_html(format(decodedTime, "pp"))}</time>`;
}
function _page($$payload, $$props) {
  push();
  let isMobile = (outerWidth.current ?? 0) < 640;
  let spaceContext = getContext("space");
  let space = spaceContext.value;
  let channel = space?.view.channels[page.params.channel];
  let users = getContext("users");
  let contextItems = getContext("contextItems");
  let relatedThreads = (() => {
    let related = {};
    if (space && channel) {
      Object.entries(space.view.threads).map(([ulid, thread]) => {
        if (!thread.softDeleted && thread.relatedChannel === page.params.channel) {
          related[ulid] = thread;
        }
      });
    }
    return related;
  })();
  let tab = "chat";
  let messageInput = {};
  let isThreading = { value: false };
  let threadTitleInput = "";
  let selectedMessages = [];
  setContext("isThreading", isThreading);
  setContext("selectMessage", (message) => {
    selectedMessages.push(message);
  });
  setContext("removeSelectedMessage", (message) => {
    selectedMessages = selectedMessages.filter((m) => m != message);
  });
  setContext("deleteMessage", (message) => {
    if (!space) {
      return;
    }
    space.change((doc) => {
      Object.values(doc.channels).forEach((x) => {
        const idx = x.timeline.indexOf(message);
        if (idx !== -1) x.timeline.splice(idx, 1);
      });
      Object.values(doc.threads).forEach((x) => {
        const idx = x.timeline.indexOf(message);
        if (idx !== -1) x.timeline.splice(idx, 1);
      });
      delete doc.messages[message];
    });
  });
  let replyingTo = void 0;
  setContext("setReplyTo", (value) => {
    replyingTo = value;
  });
  setContext("toggleReaction", (id, reaction) => {
    if (!space) return;
    space.change((doc) => {
      return;
    });
  });
  async function sendMessage() {
    if (!space) return;
    space.change((doc) => {
      return;
    });
    messageInput = {};
    replyingTo = null;
  }
  let { value: isAdmin } = getContext("isAdmin");
  let showSettingsDialog = false;
  let channelNameInput = "";
  function threadsTab($$payload2) {
    const each_array = ensure_array_like(Object.entries(relatedThreads));
    $$payload2.out += `<ul class="list w-full join join-vertical"><!--[-->`;
    for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
      let [ulid, thread] = each_array[$$index];
      $$payload2.out += `<a${attr("href", `/space/${page.params.space}/thread/${ulid}`)}><li class="list-row join-item flex items-center w-full bg-base-200"><h3 class="card-title text-xl font-medium text-primary">${escape_html(thread.title)}</h3> `;
      timestamp($$payload2, ulid);
      $$payload2.out += `<!----></li></a>`;
    }
    $$payload2.out += `<!--]--></ul>`;
  }
  function chatTab($$payload2) {
    if (space) {
      $$payload2.out += "<!--[-->";
      ChatArea($$payload2, {
        source: { type: "space", space },
        timeline: channel?.timeline ?? []
      });
      $$payload2.out += `<!----> <div class="flex items-center">`;
      if (!isMobile || !isThreading.value) {
        $$payload2.out += "<!--[-->";
        $$payload2.out += `<section class="grow flex flex-col">`;
        if (replyingTo) {
          $$payload2.out += "<!--[-->";
          $$payload2.out += `<div class="flex justify-between bg-secondary text-secondary-content rounded-t-lg px-4 py-2"><div class="flex flex-col gap-1"><h5 class="flex gap-2 items-center">Replying to `;
          AvatarImage($$payload2, {
            handle: replyingTo.authorProfile.handle,
            avatarUrl: replyingTo.authorProfile.avatarUrl,
            className: "!w-4"
          });
          $$payload2.out += `<!----> <strong>${escape_html(replyingTo.authorProfile.handle)}</strong></h5> <p class="text-gray-300 text-ellipsis italic">${html(getContentHtml(replyingTo.content))}</p></div> <!---->`;
          Button($$payload2, {
            type: "button",
            onclick: () => replyingTo = null,
            class: "btn btn-circle btn-ghost",
            children: ($$payload3) => {
              Icon($$payload3, { icon: "zondicons:close-solid" });
            },
            $$slots: { default: true }
          });
          $$payload2.out += `<!----></div>`;
        } else {
          $$payload2.out += "<!--[!-->";
        }
        $$payload2.out += `<!--]--> <div class="relative">`;
        ChatInput($$payload2, {
          users: users.value,
          context: contextItems.value,
          onEnter: sendMessage,
          get content() {
            return messageInput;
          },
          set content($$value) {
            messageInput = $$value;
            $$settled = false;
          }
        });
        $$payload2.out += `<!----></div></section>`;
      } else {
        $$payload2.out += "<!--[!-->";
      }
      $$payload2.out += `<!--]--> `;
      if (isMobile) {
        $$payload2.out += "<!--[-->";
        toolbar($$payload2);
      } else {
        $$payload2.out += "<!--[!-->";
      }
      $$payload2.out += `<!--]--></div>`;
    } else {
      $$payload2.out += "<!--[!-->";
    }
    $$payload2.out += `<!--]-->`;
  }
  function toolbar($$payload2) {
    $$payload2.out += `<menu class="relative flex items-center gap-3 px-2 w-fit justify-end"><!---->`;
    Popover($$payload2, {
      get open() {
        return isThreading.value;
      },
      set open($$value) {
        isThreading.value = $$value;
        $$settled = false;
      },
      children: ($$payload3) => {
        $$payload3.out += `<!---->`;
        Popover_trigger($$payload3, {
          children: ($$payload4) => {
            Icon($$payload4, {
              icon: "tabler:needle-thread",
              class: "text-2xl"
            });
          },
          $$slots: { default: true }
        });
        $$payload3.out += `<!----> <!---->`;
        Portal($$payload3, {
          children: ($$payload4) => {
            $$payload4.out += `<!---->`;
            Popover_content($$payload4, {
              side: "left",
              sideOffset: 8,
              interactOutsideBehavior: "ignore",
              class: "my-4 bg-base-300 rounded py-4 px-5",
              children: ($$payload5) => {
                $$payload5.out += `<form class="flex flex-col gap-4"><input type="text"${attr("value", threadTitleInput)} class="input" placeholder="Thread Title"> <button type="submit" class="btn btn-primary">Create Thread</button></form>`;
              },
              $$slots: { default: true }
            });
            $$payload4.out += `<!---->`;
          }
        });
        $$payload3.out += `<!---->`;
      },
      $$slots: { default: true }
    });
    $$payload2.out += `<!----> <!---->`;
    Button($$payload2, {
      title: "Copy invite link",
      class: "cursor-pointer hover:scale-105 active:scale-95 transition-all duration-150",
      onclick: () => {
        navigator.clipboard.writeText(`${page.url.href}`);
      },
      children: ($$payload3) => {
        Icon($$payload3, {
          icon: "icon-park-outline:copy-link",
          class: "text-2xl"
        });
      },
      $$slots: { default: true }
    });
    $$payload2.out += `<!----> `;
    if (isAdmin) {
      $$payload2.out += "<!--[-->";
      {
        let dialogTrigger = function($$payload3) {
          $$payload3.out += `<!---->`;
          Button($$payload3, {
            title: "Channel Settings",
            class: "cursor-pointer hover:scale-105 active:scale-95 transition-all duration-150 m-auto flex",
            children: ($$payload4) => {
              Icon($$payload4, { icon: "lucide:settings", class: "text-2xl" });
            },
            $$slots: { default: true }
          });
          $$payload3.out += `<!---->`;
        };
        Dialog_1($$payload2, {
          title: "Channel Settings",
          get isDialogOpen() {
            return showSettingsDialog;
          },
          set isDialogOpen($$value) {
            showSettingsDialog = $$value;
            $$settled = false;
          },
          dialogTrigger,
          children: ($$payload3) => {
            $$payload3.out += `<form class="flex flex-col gap-4 w-full"><label>Name <input${attr("value", channelNameInput)} placeholder="channel-name" class="input"></label> `;
            if (space) {
              $$payload3.out += "<!--[-->";
              const each_array_1 = ensure_array_like(Object.keys(space.view.categories));
              $$payload3.out += `<select class="select"><option${attr("value", void 0)}>None</option><!--[-->`;
              for (let $$index_1 = 0, $$length = each_array_1.length; $$index_1 < $$length; $$index_1++) {
                let categoryId = each_array_1[$$index_1];
                const category = space.view.categories[categoryId];
                $$payload3.out += `<option${attr("value", categoryId)}>${escape_html(category.name)}</option>`;
              }
              $$payload3.out += `<!--]--></select>`;
            } else {
              $$payload3.out += "<!--[!-->";
            }
            $$payload3.out += `<!--]--> <!---->`;
            Button($$payload3, {
              class: "btn btn-primary",
              children: ($$payload4) => {
                $$payload4.out += `<!---->Save Settings`;
              },
              $$slots: { default: true }
            });
            $$payload3.out += `<!----></form>`;
          },
          $$slots: { dialogTrigger: true, default: true }
        });
      }
    } else {
      $$payload2.out += "<!--[!-->";
    }
    $$payload2.out += `<!--]--></menu>`;
  }
  let $$settled = true;
  let $$inner_payload;
  function $$render_inner($$payload2) {
    $$payload2.out += `<header class="navbar"><div class="navbar-start flex gap-4">`;
    if (isMobile) {
      $$payload2.out += "<!--[-->";
      $$payload2.out += `<!---->`;
      Button($$payload2, {
        onclick: () => goto(`/space/${page.params.space}`),
        children: ($$payload3) => {
          Icon($$payload3, { icon: "uil:left" });
        },
        $$slots: { default: true }
      });
      $$payload2.out += `<!---->`;
    } else {
      $$payload2.out += "<!--[!-->";
      AvatarImage($$payload2, {
        avatarUrl: channel?.avatar,
        handle: channel?.name ?? ""
      });
    }
    $$payload2.out += `<!--]--> <h4${attr_class(`${isMobile && "line-clamp-1 overflow-hidden text-ellipsis"} text-base-content text-lg font-bold`)}>${escape_html(channel?.name)}</h4></div> <!---->`;
    Tabs($$payload2, {
      class: isMobile ? "navbar-end" : "navbar-center",
      get value() {
        return tab;
      },
      set value($$value) {
        tab = $$value;
        $$settled = false;
      },
      children: ($$payload3) => {
        $$payload3.out += `<!---->`;
        Tabs_list($$payload3, {
          class: "tabs tabs-box",
          children: ($$payload4) => {
            $$payload4.out += `<!---->`;
            Tabs_trigger($$payload4, {
              value: "chat",
              onclick: () => goto(page.url.pathname),
              class: "tab flex gap-2",
              children: ($$payload5) => {
                Icon($$payload5, { icon: "tabler:message", class: "text-2xl" });
                $$payload5.out += `<!----> `;
                if (!isMobile) {
                  $$payload5.out += "<!--[-->";
                  $$payload5.out += `<p>Chat</p>`;
                } else {
                  $$payload5.out += "<!--[!-->";
                }
                $$payload5.out += `<!--]-->`;
              },
              $$slots: { default: true }
            });
            $$payload4.out += `<!----> <!---->`;
            Tabs_trigger($$payload4, {
              value: "threads",
              class: "tab flex gap-2",
              children: ($$payload5) => {
                Icon($$payload5, {
                  icon: "material-symbols:thread-unread-rounded",
                  class: "text-2xl"
                });
                $$payload5.out += `<!----> `;
                if (!isMobile) {
                  $$payload5.out += "<!--[-->";
                  $$payload5.out += `<p>Threads</p>`;
                } else {
                  $$payload5.out += "<!--[!-->";
                }
                $$payload5.out += `<!--]-->`;
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
    $$payload2.out += `<!----> `;
    if (!isMobile) {
      $$payload2.out += "<!--[-->";
      $$payload2.out += `<div class="navbar-end">`;
      toolbar($$payload2);
      $$payload2.out += `<!----></div>`;
    } else {
      $$payload2.out += "<!--[!-->";
    }
    $$payload2.out += `<!--]--></header> <div class="divider my-0"></div> `;
    if (tab === "chat") {
      $$payload2.out += "<!--[-->";
      chatTab($$payload2);
    } else {
      $$payload2.out += "<!--[!-->";
      threadsTab($$payload2);
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
  _page as default
};

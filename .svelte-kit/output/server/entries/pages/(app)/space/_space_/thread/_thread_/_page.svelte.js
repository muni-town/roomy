import { T as getContext, x as setContext, B as copy_payload, C as assign_payload, y as pop, w as push, O as attr_class, z as escape_html, K as attr } from "../../../../../../../chunks/index.js";
import "underscore";
import { ulid } from "ulidx";
import { p as page } from "../../../../../../../chunks/index2.js";
import { g as goto } from "../../../../../../../chunks/client.js";
import { j as AvatarImage } from "../../../../../../../chunks/Toaster.svelte_svelte_type_style_lang.js";
import { u as user } from "../../../../../../../chunks/user.svelte.js";
import { C as ChatArea, g as getContentHtml, a as ChatInput, P as Popover, b as Popover_trigger, c as Popover_content } from "../../../../../../../chunks/ChatInput.js";
import { o as outerWidth } from "../../../../../../../chunks/profile.svelte.js";
import { h as html, I as Icon } from "../../../../../../../chunks/Icon.js";
import "@automerge/automerge";
import "base32-encode";
import "base32-decode";
import { B as Button, o as Portal } from "../../../../../../../chunks/button.js";
function _page($$payload, $$props) {
  push();
  let isMobile = (outerWidth.current ?? 0) < 640;
  let spaceContext = getContext("space");
  let space = spaceContext.value;
  let thread = space?.view.threads[page.params.thread];
  let users = getContext("users");
  let contextItems = getContext("contextItems");
  getContext("isAdmin");
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
      const did = user.profile.data?.did;
      if (!did) return;
      let reactions = doc.messages[id].reactions[reaction] ?? [];
      if (reactions.includes(did)) {
        if (doc.messages[id].reactions[reaction].length - 1 === 0) {
          delete doc.messages[id].reactions[reaction];
        } else {
          doc.messages[id].reactions[reaction] = reactions.filter((actor) => actor !== did);
        }
      } else {
        if (!doc.messages[id].reactions) {
          doc.messages[id].reactions = {};
        }
        doc.messages[id].reactions[reaction] = [...reactions, did];
      }
    });
  });
  async function sendMessage() {
    if (!space) return;
    space.change((doc) => {
      if (!user.agent) return;
      const id = ulid();
      doc.messages[id] = {
        author: user.agent.assertDid,
        reactions: {},
        content: JSON.stringify(messageInput),
        ...replyingTo && { replyTo: replyingTo.id }
      };
      doc.threads[page.params.thread].timeline.push(id);
    });
    messageInput = {};
    replyingTo = null;
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
                $$payload5.out += `<form class="flex flex-col gap-4"><input type="text"${attr("value", threadTitleInput)} class="input px-2 py-1" placeholder="Thread Title"> <button type="submit" class="btn btn-primary">Create Thread</button></form>`;
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
    $$payload2.out += `<!----></menu>`;
  }
  let $$settled = true;
  let $$inner_payload;
  function $$render_inner($$payload2) {
    $$payload2.out += `<header class="navbar"><div class="flex gap-4 navbar-start">`;
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
      AvatarImage($$payload2, { handle: thread?.title ?? "" });
    }
    $$payload2.out += `<!--]--> `;
    if (space && thread) {
      $$payload2.out += "<!--[-->";
      $$payload2.out += `<h4${attr_class(`${isMobile && "line-clamp-1 overflow-hidden text-ellipsis"} text-base-content text-lg font-bold`)}>${escape_html(thread.title)}</h4> <p class="text-gray-400 text-xs">></p> <a${attr("href", `/space/${page.params.space}/${thread.relatedChannel}`)} class="text-xs mention channel-mention">${escape_html(space.view.channels[thread.relatedChannel].name)}</a>`;
    } else {
      $$payload2.out += "<!--[!-->";
    }
    $$payload2.out += `<!--]--></div> `;
    if (!isMobile) {
      $$payload2.out += "<!--[-->";
      $$payload2.out += `<div class="flex navbar-end">`;
      toolbar($$payload2);
      $$payload2.out += `<!----></div>`;
    } else {
      $$payload2.out += "<!--[!-->";
    }
    $$payload2.out += `<!--]--></header> <div class="divider my-0"></div> `;
    if (space) {
      $$payload2.out += "<!--[-->";
      ChatArea($$payload2, {
        source: { type: "space", space },
        timeline: thread?.timeline ?? []
      });
      $$payload2.out += `<!----> <div class="flex">`;
      if (!isMobile || !isThreading.value) {
        $$payload2.out += "<!--[-->";
        $$payload2.out += `<section class="grow flex flex-col">`;
        if (replyingTo) {
          $$payload2.out += "<!--[-->";
          $$payload2.out += `<div class="flex justify-between bg-info text-info-content rounded-t-lg px-4 py-2"><div class="flex flex-col gap-1"><h5 class="flex gap-2 items-center">Replying to `;
          AvatarImage($$payload2, {
            handle: replyingTo.authorProfile.handle,
            avatarUrl: replyingTo.authorProfile.avatarUrl,
            className: "!w-4"
          });
          $$payload2.out += `<!----> <strong>${escape_html(replyingTo.authorProfile.handle)}</strong></h5> <p class="text-gray-300 text-ellipsis italic">${html(getContentHtml(replyingTo.content))}</p></div> <!---->`;
          Button($$payload2, {
            type: "button",
            onclick: () => replyingTo = null,
            class: "cursor-pointer hover:scale-105 active:scale-95 transition-all duration-150",
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
